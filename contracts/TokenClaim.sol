// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IPresale {
    function contributions(address user) external view returns (uint256);
    function getUserTokenAmount(address user) external view returns (uint256);
}

/**
 * @title TokenClaim
 * @notice TGE 후 베스팅 기반 단계별 토큰 클레임 컨트랙트
 * @dev Presale 컨트랙트의 기여 데이터를 참조하여 토큰 배분
 * 
 * 베스팅 예시:
 *   - TGE: 20% 즉시 클레임
 *   - 1개월 후: 20%
 *   - 2개월 후: 20%
 *   - 3개월 후: 20%
 *   - 4개월 후: 20%
 */
contract TokenClaim is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct VestingSchedule {
        uint256 timestamp;      // 클레임 가능 시점
        uint256 percentage;     // 해제 비율 (basis points, 10000 = 100%)
    }

    // ============ State Variables ============

    IERC20 public token;                    // 배분할 토큰
    IPresale public immutable presale;      // Presale 컨트랙트 참조

    VestingSchedule[] public vestingSchedules;  // 베스팅 스케줄 배열
    uint256 public tgeTime;                      // TGE 시간
    bool public claimEnabled;                    // 클레임 활성화 여부

    mapping(address => uint256) public claimedAmount;     // 유저별 클레임한 토큰량

    // ============ Events ============

    event TokensClaimed(address indexed user, uint256 amount);
    event ClaimEnabled(address token, uint256 tgeTime);
    event VestingScheduleSet(uint256 totalSchedules);
    event TokenSet(address indexed token);
    event EmergencyWithdraw(address indexed token, uint256 amount);

    // ============ Errors ============

    error ClaimNotEnabled();
    error NothingToClaim();
    error NoContribution();
    error InvalidSchedule();
    error TokenAlreadySet();
    error InvalidPercentageTotal();
    error ClaimsAlreadyStarted();
    error CannotWithdrawClaimToken();

    // ============ Constructor ============

    /**
     * @param _presale Presale 컨트랙트 주소
     */
    constructor(address _presale) Ownable(msg.sender) {
        require(_presale != address(0), "Invalid presale address");
        presale = IPresale(_presale);
    }

    // ============ Core Functions ============

    /**
     * @notice 베스팅 스케줄에 따라 토큰 클레임
     * @dev 클레임 가능한 모든 미클레임 단계를 한번에 처리
     */
    function claim() external nonReentrant whenNotPaused {
        if (!claimEnabled) revert ClaimNotEnabled();

        uint256 totalAllocation = presale.getUserTokenAmount(msg.sender);
        if (totalAllocation == 0) revert NoContribution();

        uint256 claimable = getClaimableAmount(msg.sender);
        if (claimable == 0) revert NothingToClaim();

        // 상태 업데이트
        claimedAmount[msg.sender] += claimable;

        // 토큰 전송
        token.safeTransfer(msg.sender, claimable);

        emit TokensClaimed(msg.sender, claimable);
    }

    // ============ View Functions ============

    /**
     * @notice 유저가 현재 클레임 가능한 토큰 수량
     */
    function getClaimableAmount(address _user) public view returns (uint256) {
        if (!claimEnabled) return 0;

        uint256 totalAllocation = presale.getUserTokenAmount(_user);
        if (totalAllocation == 0) return 0;

        uint256 totalUnlocked = getUnlockedAmount(_user);
        uint256 alreadyClaimed = claimedAmount[_user];

        return totalUnlocked > alreadyClaimed ? totalUnlocked - alreadyClaimed : 0;
    }

    /**
     * @notice 베스팅 스케줄 기준 현재까지 언락된 총 토큰량
     */
    function getUnlockedAmount(address _user) public view returns (uint256) {
        uint256 totalAllocation = presale.getUserTokenAmount(_user);
        if (totalAllocation == 0) return 0;

        uint256 unlockedPercentage = 0;
        for (uint256 i = 0; i < vestingSchedules.length; i++) {
            if (block.timestamp >= vestingSchedules[i].timestamp) {
                unlockedPercentage += vestingSchedules[i].percentage;
            } else {
                break; // 스케줄은 시간순이므로 이후는 체크 불필요
            }
        }

        return (totalAllocation * unlockedPercentage) / 10000;
    }

    /**
     * @notice 유저 클레임 정보 일괄 조회 (프론트엔드용)
     */
    function getUserClaimInfo(address _user) external view returns (
        uint256 totalAllocation,
        uint256 totalUnlocked,
        uint256 totalClaimed,
        uint256 claimable,
        uint256 nextUnlockTime,
        uint256 nextUnlockPercentage
    ) {
        totalAllocation = presale.getUserTokenAmount(_user);
        totalUnlocked = getUnlockedAmount(_user);
        totalClaimed = claimedAmount[_user];
        claimable = getClaimableAmount(_user);

        // 다음 언락 시점 찾기
        for (uint256 i = 0; i < vestingSchedules.length; i++) {
            if (block.timestamp < vestingSchedules[i].timestamp) {
                nextUnlockTime = vestingSchedules[i].timestamp;
                nextUnlockPercentage = vestingSchedules[i].percentage;
                break;
            }
        }
    }

    /**
     * @notice 전체 베스팅 스케줄 조회
     */
    function getVestingSchedules() external view returns (VestingSchedule[] memory) {
        return vestingSchedules;
    }

    /**
     * @notice 베스팅 스케줄 개수
     */
    function getVestingScheduleCount() external view returns (uint256) {
        return vestingSchedules.length;
    }

    /**
     * @notice 전체 진행 상황 (프론트엔드 프로그레스 바용)
     */
    function getVestingProgress() external view returns (
        uint256 totalSchedules,
        uint256 completedSchedules,
        uint256 unlockedPercentage
    ) {
        totalSchedules = vestingSchedules.length;
        for (uint256 i = 0; i < vestingSchedules.length; i++) {
            if (block.timestamp >= vestingSchedules[i].timestamp) {
                completedSchedules++;
                unlockedPercentage += vestingSchedules[i].percentage;
            }
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice 토큰 주소 설정
     */
    function setToken(address _token) external onlyOwner {
        if (address(token) != address(0)) revert TokenAlreadySet();
        require(_token != address(0), "Invalid token");
        token = IERC20(_token);
        emit TokenSet(_token);
    }

    /**
     * @notice 베스팅 스케줄 설정
     * @param _timestamps 각 단계별 클레임 가능 시점 배열
     * @param _percentages 각 단계별 해제 비율 배열 (basis points)
     * @dev 합계가 10000 (100%)이어야 함
     */
    function setVestingSchedule(
        uint256[] calldata _timestamps,
        uint256[] calldata _percentages
    ) external onlyOwner {
        if (claimEnabled) revert ClaimsAlreadyStarted();
        require(_timestamps.length == _percentages.length, "Length mismatch");
        require(_timestamps.length > 0, "Empty schedule");

        // 기존 스케줄 삭제
        delete vestingSchedules;

        uint256 totalPercentage = 0;
        uint256 prevTimestamp = 0;

        for (uint256 i = 0; i < _timestamps.length; i++) {
            require(_timestamps[i] > prevTimestamp, "Not chronological");
            require(_percentages[i] > 0, "Zero percentage");

            vestingSchedules.push(VestingSchedule({
                timestamp: _timestamps[i],
                percentage: _percentages[i]
            }));

            totalPercentage += _percentages[i];
            prevTimestamp = _timestamps[i];
        }

        if (totalPercentage != 10000) revert InvalidPercentageTotal();

        emit VestingScheduleSet(_timestamps.length);
    }

    /**
     * @notice 클레임 활성화 (토큰 + 스케줄 설정 후)
     */
    function enableClaim() external onlyOwner {
        require(address(token) != address(0), "Token not set");
        require(vestingSchedules.length > 0, "No vesting schedule");
        
        claimEnabled = true;
        tgeTime = block.timestamp;

        emit ClaimEnabled(address(token), tgeTime);
    }

    /**
     * @notice 클레임 비활성화 (긴급 시)
     */
    function disableClaim() external onlyOwner {
        claimEnabled = false;
    }

    // ============ Emergency ============

    /**
     * @notice 긴급 토큰 회수
     */
    function emergencyWithdraw(address _token, uint256 _amount) external onlyOwner {
        if (_token == address(token)) revert CannotWithdrawClaimToken();
        IERC20(_token).safeTransfer(owner(), _amount);
        emit EmergencyWithdraw(_token, _amount);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
