// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Presale
 * @notice 4-stage BSC presale — 단계별 가격 상승, 경계 초과 구매 자동 분할
 *
 * 단계 전환: 누적 모금액(totalRaised)이 각 단계의 cap에 도달하면 자동 전환
 * 분할 구매: 구매 금액이 단계 경계를 넘으면 각 단계 가격으로 분리 계산
 * 미래 단계: 아직 도달하지 않은 단계의 cap/price는 오너가 수정 가능
 */
contract Presale is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint8 public constant STAGE_COUNT = 4;

    // ============ Structs ============

    struct Stage {
        uint256 cap;    // 이 단계가 끝나는 누적 totalRaised (USDT, 18 dec)
        uint256 price;  // 토큰 1개당 USDT 가격 (18 dec)
    }

    /// @notice 구매 시 스테이지별 분할 내역 (이벤트용)
    struct StageFill {
        uint8   stageIndex;
        uint256 usdtAmount;
        uint256 tokenAmount;
    }

    // ============ State Variables ============

    IERC20 public immutable usdt;

    Stage[4] public stages;
    uint8 public currentStage;        // 0 ~ 3

    uint256 public minPerTx;          // 트랜잭션당 최소 구매액 (USDT)
    uint256 public totalRaised;       // 누적 모금액
    uint256 public contributorCount;  // 기여자 수

    uint256 public startTime;
    uint256 public endTime;

    address public tokenClaimContract;
    address public treasury;             // USDT 수취 주소

    mapping(address => uint256) public contributions;    // 유저별 USDT 총 지불액
    mapping(address => uint256) public tokenAllocations; // 유저별 토큰 총 배정량

    /// @notice 유저별 스테이지별 USDT 지불액
    mapping(address => mapping(uint8 => uint256)) public stageContributions;
    /// @notice 유저별 스테이지별 토큰 배정량
    mapping(address => mapping(uint8 => uint256)) public stageTokenAllocations;

    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;

    // ============ Events ============

    event TokensPurchased(
        address indexed buyer,
        uint256 totalUsdtAmount,
        uint256 totalTokenAmount,
        StageFill[] stageFills
    );
    event StageAdvanced(uint8 indexed newStage, uint256 raisedAtTransition);
    event StageUpdated(uint8 indexed stageIndex, uint256 newCap, uint256 newPrice);
    event SaleTimesUpdated(uint256 startTime, uint256 endTime);
    event FundsWithdrawn(address indexed to, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event TokenClaimContractSet(address indexed claimContract);
    event WhitelistUpdated(address indexed account, bool status);
    event WhitelistToggled(bool enabled);

    // ============ Errors ============

    error SaleNotActive();
    error HardCapReached();
    error BelowMinimum();
    error ZeroAmount();
    error InvalidTimeRange();
    error NotWhitelisted();
    error SaleStillActive();
    error InvalidStageIndex();
    error CannotModifyActiveOrPastStage();
    error ZeroTokenAllocation();

    // ============ Constructor ============

    /**
     * @param _usdt        USDT 토큰 주소
     * @param _stageCaps   각 단계 종료 시 누적 모금액 [cap0, cap1, cap2, cap3] — 오름차순
     * @param _stagePrices 각 단계 토큰 가격 [p0, p1, p2, p3] — 오름차순
     * @param _minPerTx    트랜잭션당 최소 구매액
     * @param _startTime   세일 시작 timestamp
     * @param _endTime     세일 종료 timestamp
     * @param _treasury    USDT 즉시 수취 주소
     */
    constructor(
        address _usdt,
        uint256[4] memory _stageCaps,
        uint256[4] memory _stagePrices,
        uint256 _minPerTx,
        uint256 _startTime,
        uint256 _endTime,
        address _treasury
    ) Ownable(msg.sender) {
        require(_usdt != address(0), "Invalid USDT address");
        require(_treasury != address(0), "Invalid treasury address");
        require(_minPerTx > 0, "Invalid minPerTx");
        require(_startTime < _endTime, "Invalid time range");

        for (uint8 i = 0; i < 4; i++) {
            require(_stagePrices[i] > 0, "Invalid price");
            if (i > 0) {
                require(_stageCaps[i] > _stageCaps[i - 1], "Caps must be ascending");
                require(_stagePrices[i] > _stagePrices[i - 1], "Prices must be ascending");
            }
            stages[i] = Stage(_stageCaps[i], _stagePrices[i]);
        }

        usdt = IERC20(_usdt);
        minPerTx = _minPerTx;
        startTime = _startTime;
        endTime = _endTime;
        treasury = _treasury;
    }

    // ============ Modifiers ============

    modifier saleActive() {
        if (block.timestamp < startTime || block.timestamp > endTime) revert SaleNotActive();
        if (totalRaised >= stages[3].cap) revert HardCapReached();
        _;
    }

    // ============ Core Functions ============

    /**
     * @notice USDT로 토큰 구매. 단계 경계를 넘으면 자동 분할 계산.
     * @param _usdtAmount 지불할 USDT (18 dec). 하드캡 도달 시 실제 지불액은 적을 수 있음.
     *
     * 분할 예시:
     *   totalRaised=48,000 / Stage0 cap=50,000 / 구매요청 5,000 USDT
     *   → 2,000 USDT @ Stage0 price + 3,000 USDT @ Stage1 price
     */
    function buyTokens(uint256 _usdtAmount) external nonReentrant whenNotPaused saleActive {
        if (_usdtAmount == 0) revert ZeroAmount();
        if (whitelistEnabled && !whitelist[msg.sender]) revert NotWhitelisted();

        // ── 단계 분할 계산 ──
        uint256 remaining   = _usdtAmount;
        uint256 totalUsdt   = 0;
        uint256 totalTokens = 0;
        uint256 raisedAccum = totalRaised;
        uint8   stageIdx    = currentStage;

        // 최대 4개 스테이지 분할 기록
        StageFill[] memory fills = new StageFill[](STAGE_COUNT);
        uint8 fillCount = 0;

        while (remaining > 0 && stageIdx < STAGE_COUNT) {
            uint256 stageAvailable = stages[stageIdx].cap - raisedAccum;

            if (stageAvailable == 0) {
                stageIdx++;
                continue;
            }

            uint256 fillAmount = remaining < stageAvailable ? remaining : stageAvailable;
            uint256 tokens     = (fillAmount * 1e18) / stages[stageIdx].price;

            fills[fillCount] = StageFill({
                stageIndex: stageIdx,
                usdtAmount: fillAmount,
                tokenAmount: tokens
            });
            fillCount++;

            totalUsdt   += fillAmount;
            totalTokens += tokens;
            remaining   -= fillAmount;
            raisedAccum += fillAmount;

            if (raisedAccum >= stages[stageIdx].cap && stageIdx < 3) {
                stageIdx++;
            } else {
                break;
            }
        }

        if (totalUsdt == 0) revert HardCapReached();
        if (totalTokens == 0) revert ZeroTokenAllocation();

        // ── 검증: 매 트랜잭션 최소 구매액 (하드캡 잔여분 < minPerTx이면 면제) ──
        uint256 remainingToHardCap = stages[3].cap - totalRaised;
        if (totalUsdt < minPerTx && remainingToHardCap >= minPerTx) revert BelowMinimum();

        // ── USDT 즉시 treasury로 전송 ──
        usdt.safeTransferFrom(msg.sender, treasury, totalUsdt);

        // ── 상태 업데이트 ──
        if (contributions[msg.sender] == 0) contributorCount++;
        contributions[msg.sender]    += totalUsdt;
        tokenAllocations[msg.sender] += totalTokens;
        totalRaised                  += totalUsdt;

        // ── 스테이지별 기록 업데이트 ──
        for (uint8 i = 0; i < fillCount; i++) {
            stageContributions[msg.sender][fills[i].stageIndex]    += fills[i].usdtAmount;
            stageTokenAllocations[msg.sender][fills[i].stageIndex] += fills[i].tokenAmount;
        }

        // ── 단계 전환 이벤트 ──
        uint8 prevStage = currentStage;
        if (stageIdx != prevStage) {
            currentStage = stageIdx;
            for (uint8 s = prevStage; s < stageIdx; s++) {
                emit StageAdvanced(s + 1, stages[s].cap);
            }
        }

        // ── 스테이지별 분할 이벤트 (정확한 길이로 복사) ──
        StageFill[] memory trimmed = new StageFill[](fillCount);
        for (uint8 i = 0; i < fillCount; i++) {
            trimmed[i] = fills[i];
        }
        emit TokensPurchased(msg.sender, totalUsdt, totalTokens, trimmed);
    }

    // ============ View Functions ============

    /// @notice 유저의 토큰 배정량 (단계별 분할 계산 반영)
    function getUserTokenAmount(address _user) external view returns (uint256) {
        return tokenAllocations[_user];
    }

    /// @notice 유저의 스테이지별 기여 내역 조회
    function getUserStageInfo(address _user) external view returns (
        uint256[4] memory usdtPerStage,
        uint256[4] memory tokensPerStage
    ) {
        for (uint8 i = 0; i < STAGE_COUNT; i++) {
            usdtPerStage[i]   = stageContributions[_user][i];
            tokensPerStage[i] = stageTokenAllocations[_user][i];
        }
    }

    /// @notice 현재 단계 토큰 가격
    function getCurrentPrice() external view returns (uint256) {
        return stages[currentStage].price;
    }

    /// @notice 하드캡 (4단계 cap)
    function getHardCap() external view returns (uint256) {
        return stages[3].cap;
    }

    function isSaleActive() external view returns (bool) {
        return block.timestamp >= startTime
            && block.timestamp <= endTime
            && totalRaised < stages[3].cap;
    }

    function getRemainingCap() external view returns (uint256) {
        uint256 hardCap = stages[3].cap;
        return hardCap > totalRaised ? hardCap - totalRaised : 0;
    }

    function getContributorCount() external view returns (uint256) {
        return contributorCount;
    }

    /**
     * @notice 세일 전체 정보 (프론트엔드용)
     */
    function getSaleInfo() external view returns (
        uint256 _hardCap,
        uint256 _totalRaised,
        uint256 _minPerTx,
        uint8   _currentStage,
        uint256 _currentPrice,
        uint256 _currentStageCap,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _contributorCount,
        bool    _isActive
    ) {
        uint256 hardCap = stages[3].cap;
        return (
            hardCap,
            totalRaised,
            minPerTx,
            currentStage,
            stages[currentStage].price,
            stages[currentStage].cap,
            startTime,
            endTime,
            contributorCount,
            block.timestamp >= startTime && block.timestamp <= endTime && totalRaised < hardCap
        );
    }

    /// @notice 전체 단계 정보 배열 반환
    function getAllStages() external view returns (Stage[4] memory) {
        return stages;
    }

    // ============ Admin Functions ============

    /**
     * @notice 미래 단계 cap/price 수정 (현재 단계 이전은 수정 불가)
     * @param _stageIndex 수정할 단계 인덱스 (반드시 currentStage 초과)
     */
    function setStage(uint8 _stageIndex, uint256 _cap, uint256 _price) external onlyOwner {
        if (_stageIndex >= 4) revert InvalidStageIndex();
        if (_stageIndex <= currentStage) revert CannotModifyActiveOrPastStage();
        require(_price > stages[_stageIndex - 1].price, "Price must exceed previous stage");
        require(_cap > stages[_stageIndex - 1].cap, "Cap must exceed previous stage cap");
        if (_stageIndex < 3) require(_cap < stages[_stageIndex + 1].cap, "Cap must be below next stage cap");

        stages[_stageIndex] = Stage(_cap, _price);
        emit StageUpdated(_stageIndex, _cap, _price);
    }

    function setTokenClaimContract(address _claimContract) external onlyOwner {
        require(_claimContract != address(0), "Invalid address");
        tokenClaimContract = _claimContract;
        emit TokenClaimContractSet(_claimContract);
    }

    function setSaleTimes(uint256 _startTime, uint256 _endTime) external onlyOwner {
        if (_startTime >= _endTime) revert InvalidTimeRange();
        startTime = _startTime;
        endTime = _endTime;
        emit SaleTimesUpdated(_startTime, _endTime);
    }

    function setMinPerTx(uint256 _min) external onlyOwner {
        require(_min > 0, "Invalid min");
        minPerTx = _min;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice 컨트랙트에 잘못 입금된 USDT 회수 (정상 구매는 treasury로 직행)
    function withdrawFunds() external onlyOwner {
        uint256 balance = usdt.balanceOf(address(this));
        require(balance > 0, "No funds");
        usdt.safeTransfer(treasury, balance);
        emit FundsWithdrawn(treasury, balance);
    }

    // ============ Whitelist ============

    function toggleWhitelist(bool _enabled) external onlyOwner {
        whitelistEnabled = _enabled;
        emit WhitelistToggled(_enabled);
    }

    function addToWhitelist(address[] calldata _accounts) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            whitelist[_accounts[i]] = true;
            emit WhitelistUpdated(_accounts[i], true);
        }
    }

    function removeFromWhitelist(address[] calldata _accounts) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            whitelist[_accounts[i]] = false;
            emit WhitelistUpdated(_accounts[i], false);
        }
    }

    // ============ Emergency ============

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
