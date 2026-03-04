# Presale Contract

BSC Chain 기반 4단계 USDT 프리세일 + 베스팅 클레임 컨트랙트

---

## 컨트랙트 구조

```
contracts/
├── Presale.sol       — 4단계 USDT 프리세일 (단계별 자동 분할 구매)
├── TokenClaim.sol    — TGE 후 베스팅 기반 토큰 클레임
└── mocks/
    └── MockERC20.sol — 테스트넷 전용 Faucet 토큰
```

---

## Presale.sol

### 핵심 기능

| 기능 | 설명 |
|------|------|
| 4단계 가격 | Stage 1→4로 갈수록 가격 상승 |
| 자동 분할 구매 | 구매액이 단계 경계를 넘으면 각 단계 가격으로 분리 계산 |
| treasury 즉시 전송 | 구매 USDT가 컨트랙트를 거치지 않고 treasury로 직행 |
| 하드캡 자동 조절 | 하드캡 도달 시 잔여분만 청구 (환불 불필요) |
| 화이트리스트 | 선택적 화이트리스트 모드 |

### 단계 구성 예시

| Stage | Cap (누적 USDT) | Price (USDT/token) |
|-------|----------------|--------------------|
| 1     | 50,000         | 0.01               |
| 2     | 150,000        | 0.02               |
| 3     | 300,000        | 0.04               |
| 4     | 500,000        | 0.08               |

### 주요 함수

```solidity
// 구매
buyTokens(uint256 _usdtAmount)

// 조회
getSaleInfo()                        // 세일 전체 정보
getAllStages()                        // 4단계 cap/price 배열
contributions(address)               // 유저 USDT 총 기여액
tokenAllocations(address)            // 유저 토큰 총 배정량
getUserStageInfo(address)            // 유저 스테이지별 기여 내역

// 오너
setSaleTimes(startTime, endTime)     // 세일 시간 변경
setTreasury(address)                 // treasury 주소 변경
setStage(index, cap, price)          // 미래 단계 수정
setMinPerTx(amount)                  // 최소 구매액 변경
withdrawFunds()                      // 잘못 입금된 USDT 회수
pause() / unpause()                  // 긴급 중지
```

### 이벤트

```solidity
TokensPurchased(buyer, totalUsdt, totalTokens, stageFills[])
StageAdvanced(newStage, raisedAtTransition)
SaleTimesUpdated(startTime, endTime)
TreasuryUpdated(treasury)
```

---

## TokenClaim.sol

### 핵심 기능

| 기능 | 설명 |
|------|------|
| 베스팅 스케줄 | 타임스탬프 + 비율(basis points) 배열로 설정 |
| 누적 클레임 | 여러 트랜치가 지난 경우 한 번에 수령 가능 |
| Presale 참조 | Presale 컨트랙트의 tokenAllocations를 직접 읽음 |
| 긴급 토큰 회수 | 클레임 토큰을 제외한 잘못 입금된 토큰 회수 |

### 베스팅 예시 (배포 스크립트 기본값)

| 트랜치 | TGE 기준 | 비율 |
|--------|---------|------|
| 1      | +10분   | 25%  |
| 2      | +30분   | 25%  |
| 3      | +1시간  | 25%  |
| 4      | +4시간  | 25%  |

### 주요 함수

```solidity
// 클레임
claim()

// 조회
getUserClaimInfo(address)    // 배정량 / 언락량 / 클레임량 / 클레임가능량
getClaimableAmount(address)  // 현재 클레임 가능 수량
getUnlockedAmount(address)   // 현재까지 언락된 수량
getVestingSchedules()        // 전체 베스팅 스케줄
getVestingProgress()         // 완료 스케줄 수 / 언락 퍼센트

// 오너
setToken(address)                          // 클레임 토큰 설정 (1회)
setVestingSchedule(timestamps, percentages) // 베스팅 스케줄 설정
enableClaim()                              // 클레임 활성화
disableClaim()                             // 클레임 비활성화 (긴급)
emergencyWithdraw(token, amount)           // 잘못 입금된 토큰 회수
```

---

## 설치 및 실행

```bash
npm install
cp .env.example .env   # 환경변수 설정
```

### 테스트

```bash
npm test
# 65 passing
```

### 컴파일

```bash
npm run compile
```

### 배포

```bash
# BSC 테스트넷
npm run deploy:testnet

# BSC 메인넷
npm run deploy:mainnet
```

---

## 환경변수 (.env)

```env
PRIVATE_KEY=0x...              # 배포자 지갑 프라이빗 키
ETHERSCAN_API_KEY=...          # BSCScan API 키 (컨트랙트 검증용)
TREASURY_ADDRESS=0x...         # USDT 수취 주소 (미설정 시 배포자 주소)
USDT_ADDRESS=                  # 메인넷 USDT 주소 (미설정 시 기본값 사용)
```

---

## 컨트랙트 검증 (BSCScan)

배포 완료 후 출력되는 verify 커맨드를 그대로 실행:

```bash
npx hardhat verify --network bscTestnet <PRESALE_ADDRESS> \
  "<USDT>" "[caps...]" "[prices...]" "<minPerTx>" "<startTime>" "<endTime>" "<treasury>"

npx hardhat verify --network bscTestnet <TOKEN_CLAIM_ADDRESS> "<PRESALE_ADDRESS>"
```

---

## 보안 설계

- **ReentrancyGuard** — 재진입 공격 방어
- **SafeERC20** — non-standard ERC20 (USDT) 대응
- **Pausable** — 긴급 중지
- **Ownable** — 오너 전용 관리 함수
- **treasury 직접 전송** — 컨트랙트에 USDT 미보관으로 해킹 리스크 최소화
- **하드캡 deadzone 수정** — 잔여 하드캡 < minPerTx일 때 면제 처리

---

## 네트워크

| 네트워크 | Chain ID | RPC |
|---------|----------|-----|
| BSC Mainnet | 56 | https://bsc-dataseed1.binance.org |
| BSC Testnet | 97 | https://data-seed-prebsc-1-s1.binance.org:8545 |
