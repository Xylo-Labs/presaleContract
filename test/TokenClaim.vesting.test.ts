import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Presale, TokenClaim, MockERC20 } from "../typechain-types";

// ─── 프리세일 설정 ─────────────────────────────────────────────
const STAGE_CAPS   = [
  ethers.parseEther("50000"),
  ethers.parseEther("150000"),
  ethers.parseEther("300000"),
  ethers.parseEther("500000"),
] as const;
const STAGE_PRICES = [
  ethers.parseEther("0.01"),
  ethers.parseEther("0.02"),
  ethers.parseEther("0.04"),
  ethers.parseEther("0.08"),
] as const;
const MIN_PER_TX = ethers.parseEther("100");

// ─── 베스팅 시간 상수 ──────────────────────────────────────────
const MIN_10  = 10 * 60;      //   600 s
const MIN_30  = 30 * 60;      // 1,800 s
const HOUR_1  = 60 * 60;      // 3,600 s
const HOUR_4  = 4 * 60 * 60;  // 14,400 s

// 베스팅 4단계: 각 25% (합 = 100%)
const VESTING_PCT = [2500, 2500, 2500, 2500];

// 구매 데이터
const BUY_USDT     = ethers.parseEther("1000");           // 1,000 USDT
const TOTAL_TOKENS = (BUY_USDT * 10n ** 18n) / STAGE_PRICES[0]; // 100,000 TOKEN
const PER_TRANCHE  = (TOTAL_TOKENS * 2500n) / 10000n;    // 25,000 TOKEN

/** n개 트랜치 언락 시 총 수령량 */
function unlocked(n: number): bigint {
  return (TOTAL_TOKENS * BigInt(n * 2500)) / 10000n;
}

describe("TokenClaim — Vesting Time Test (10m / 30m / 1h / 4h)", () => {
  let presale:    Presale;
  let tokenClaim: TokenClaim;
  let usdt:       MockERC20;
  let claimToken: MockERC20;
  let buyer:      any;
  let owner:      any;

  // 베스팅 스케줄 타임스탬프 (절대값)
  let ts10: number, ts30: number, ts60: number, ts4h: number;

  // ── 공용 setup: 배포 → 구매 → 세일 종료 → 스케줄 설정 → enableClaim ──
  beforeEach(async () => {
    [owner, buyer] = await ethers.getSigners();

    const Mock  = await ethers.getContractFactory("MockERC20");
    usdt        = await Mock.deploy("Mock USDT", "USDT", 18) as MockERC20;
    claimToken  = await Mock.deploy("XYLO Token", "XYLO", 18) as MockERC20;

    const now        = await time.latest();
    const saleStart  = now + 60;
    const saleEnd    = saleStart + HOUR_1;

    // Deploy
    const PF = await ethers.getContractFactory("Presale");
    presale = await PF.deploy(
      await usdt.getAddress(),
      [...STAGE_CAPS], [...STAGE_PRICES],
      MIN_PER_TX, saleStart, saleEnd,
      owner.address  // treasury = owner (테스트용)
    ) as Presale;

    const TCF = await ethers.getContractFactory("TokenClaim");
    tokenClaim = await TCF.deploy(await presale.getAddress()) as TokenClaim;
    await presale.setTokenClaimContract(await tokenClaim.getAddress());
    await tokenClaim.setToken(await claimToken.getAddress());

    // 구매
    await usdt.mint(buyer.address, BUY_USDT);
    await usdt.connect(buyer).approve(await presale.getAddress(), ethers.MaxUint256);
    await time.increaseTo(saleStart + 1);
    await presale.connect(buyer).buyTokens(BUY_USDT);

    // 세일 종료
    await time.increaseTo(saleEnd + 1);

    // 베스팅 스케줄: saleEnd+1 기준으로 +10m / +30m / +1h / +4h
    const base = saleEnd + 1;
    ts10 = base + MIN_10;
    ts30 = base + MIN_30;
    ts60 = base + HOUR_1;
    ts4h = base + HOUR_4;

    await tokenClaim.setVestingSchedule(
      [ts10, ts30, ts60, ts4h],
      VESTING_PCT
    );
    await tokenClaim.enableClaim();

    // 클레임 컨트랙트에 토큰 지급
    await claimToken.mint(await tokenClaim.getAddress(), TOTAL_TOKENS);
  });

  // ─────────────────────────────────────────────────────────────
  // A. TGE 직후 (0분) — 아직 10분 미경과
  // ─────────────────────────────────────────────────────────────
  describe("Before 10 min — nothing claimable", () => {
    it("getClaimableAmount = 0", async () => {
      expect(await tokenClaim.getClaimableAmount(buyer.address)).to.equal(0n);
    });

    it("claim() reverts NothingToClaim", async () => {
      await expect(tokenClaim.connect(buyer).claim())
        .to.be.revertedWithCustomError(tokenClaim, "NothingToClaim");
    });

    it("getVestingProgress: 0 schedules completed", async () => {
      const p = await tokenClaim.getVestingProgress();
      expect(p.completedSchedules).to.equal(0n);
      expect(p.unlockedPercentage).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // B. 10분 후 — 25% 클레임
  // ─────────────────────────────────────────────────────────────
  describe("At 10 min — 25% (tranche 1)", () => {
    beforeEach(() => time.increaseTo(ts10 + 1));

    it("getClaimableAmount = 25%", async () => {
      expect(await tokenClaim.getClaimableAmount(buyer.address)).to.equal(PER_TRANCHE);
    });

    it("claim() transfers exactly 25% tokens to buyer", async () => {
      const before = await claimToken.balanceOf(buyer.address);
      await tokenClaim.connect(buyer).claim();
      expect(await claimToken.balanceOf(buyer.address) - before).to.equal(PER_TRANCHE);
    });

    it("claimedAmount = 25% after claim", async () => {
      await tokenClaim.connect(buyer).claim();
      expect(await tokenClaim.claimedAmount(buyer.address)).to.equal(PER_TRANCHE);
    });

    it("double claim() reverts NothingToClaim", async () => {
      await tokenClaim.connect(buyer).claim();
      await expect(tokenClaim.connect(buyer).claim())
        .to.be.revertedWithCustomError(tokenClaim, "NothingToClaim");
    });

    it("getUserClaimInfo: allocation=100k, unlocked=25k, claimed=0, claimable=25k", async () => {
      const info = await tokenClaim.getUserClaimInfo(buyer.address);
      expect(info.totalAllocation).to.equal(TOTAL_TOKENS);
      expect(info.totalUnlocked).to.equal(PER_TRANCHE);
      expect(info.totalClaimed).to.equal(0n);
      expect(info.claimable).to.equal(PER_TRANCHE);
    });

    it("getVestingProgress: 1 schedule completed, 25%", async () => {
      const p = await tokenClaim.getVestingProgress();
      expect(p.completedSchedules).to.equal(1n);
      expect(p.unlockedPercentage).to.equal(2500n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // C. 30분 후 — 50% 클레임 (한 번에 또는 분할)
  // ─────────────────────────────────────────────────────────────
  describe("At 30 min — 50% (tranche 1+2)", () => {
    beforeEach(() => time.increaseTo(ts30 + 1));

    it("getClaimableAmount = 50% (no prior claim)", async () => {
      expect(await tokenClaim.getClaimableAmount(buyer.address)).to.equal(unlocked(2));
    });

    it("claim() transfers 50% in one call", async () => {
      const before = await claimToken.balanceOf(buyer.address);
      await tokenClaim.connect(buyer).claim();
      expect(await claimToken.balanceOf(buyer.address) - before).to.equal(unlocked(2));
    });

    it("getVestingProgress: 2 schedules completed, 50%", async () => {
      const p = await tokenClaim.getVestingProgress();
      expect(p.completedSchedules).to.equal(2n);
      expect(p.unlockedPercentage).to.equal(5000n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // C-seq. 10분 → 30분 순차 클레임 (독립 시간 제어)
  // ─────────────────────────────────────────────────────────────
  describe("Sequential: claim @10min then @30min", () => {
    it("10min(25%) + 30min(+25%) = total 50%", async () => {
      // 10분 클레임
      await time.increaseTo(ts10 + 1);
      await tokenClaim.connect(buyer).claim();
      expect(await tokenClaim.claimedAmount(buyer.address)).to.equal(PER_TRANCHE);
      expect(await claimToken.balanceOf(buyer.address)).to.equal(PER_TRANCHE);

      // 30분 클레임 (추가 25%)
      await time.increaseTo(ts30 + 1);
      await tokenClaim.connect(buyer).claim();
      expect(await tokenClaim.claimedAmount(buyer.address)).to.equal(unlocked(2));
      expect(await claimToken.balanceOf(buyer.address)).to.equal(unlocked(2));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // D. 1시간 후 — 75% 클레임
  // ─────────────────────────────────────────────────────────────
  describe("At 1 hour — 75% (tranche 1+2+3)", () => {
    beforeEach(() => time.increaseTo(ts60 + 1));

    it("getClaimableAmount = 75%", async () => {
      expect(await tokenClaim.getClaimableAmount(buyer.address)).to.equal(unlocked(3));
    });

    it("claim() transfers 75% in one call", async () => {
      const before = await claimToken.balanceOf(buyer.address);
      await tokenClaim.connect(buyer).claim();
      expect(await claimToken.balanceOf(buyer.address) - before).to.equal(unlocked(3));
    });

    it("claimedAmount = 75% after claim", async () => {
      await tokenClaim.connect(buyer).claim();
      expect(await tokenClaim.claimedAmount(buyer.address)).to.equal(unlocked(3));
    });

    it("getVestingProgress: 3 schedules completed, 75%", async () => {
      const p = await tokenClaim.getVestingProgress();
      expect(p.completedSchedules).to.equal(3n);
      expect(p.unlockedPercentage).to.equal(7500n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // E. 4시간 후 — 100% 클레임
  // ─────────────────────────────────────────────────────────────
  describe("At 4 hours — 100% (all tranches)", () => {
    beforeEach(() => time.increaseTo(ts4h + 1));

    it("getClaimableAmount = 100%", async () => {
      expect(await tokenClaim.getClaimableAmount(buyer.address)).to.equal(TOTAL_TOKENS);
    });

    it("claim() transfers 100% in one call", async () => {
      const before = await claimToken.balanceOf(buyer.address);
      await tokenClaim.connect(buyer).claim();
      expect(await claimToken.balanceOf(buyer.address) - before).to.equal(TOTAL_TOKENS);
    });

    it("contract token balance = 0 after full claim", async () => {
      await tokenClaim.connect(buyer).claim();
      expect(await claimToken.balanceOf(await tokenClaim.getAddress())).to.equal(0n);
    });

    it("totalClaimed == totalAllocation after full claim", async () => {
      await tokenClaim.connect(buyer).claim();
      const info = await tokenClaim.getUserClaimInfo(buyer.address);
      expect(info.totalClaimed).to.equal(info.totalAllocation);
    });

    it("getVestingProgress: 4 schedules completed, 100%", async () => {
      const p = await tokenClaim.getVestingProgress();
      expect(p.completedSchedules).to.equal(4n);
      expect(p.unlockedPercentage).to.equal(10000n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F. 매 트랜치마다 순차 클레임 — 수량 누적 검증
  // ─────────────────────────────────────────────────────────────
  describe("Sequential claim at each tranche — cumulative amount", () => {
    it("4회 순차 클레임: 각 25%, 총합 100% 정확히 일치", async () => {
      const timestamps = [ts10, ts30, ts60, ts4h];
      let totalReceived = 0n;

      for (let i = 0; i < timestamps.length; i++) {
        await time.increaseTo(timestamps[i] + 1);

        const claimable = await tokenClaim.getClaimableAmount(buyer.address);
        expect(claimable).to.equal(PER_TRANCHE, `Tranche ${i + 1}: claimable 불일치`);

        const before = await claimToken.balanceOf(buyer.address);
        await tokenClaim.connect(buyer).claim();
        const received = await claimToken.balanceOf(buyer.address) - before;

        expect(received).to.equal(PER_TRANCHE, `Tranche ${i + 1}: 수령량 불일치`);
        totalReceived += received;

        expect(await tokenClaim.claimedAmount(buyer.address))
          .to.equal(totalReceived, `Tranche ${i + 1}: claimedAmount 불일치`);
      }

      expect(totalReceived).to.equal(TOTAL_TOKENS, "최종 총합이 TOTAL_TOKENS와 불일치");
    });

    it("PER_TRANCHE × 4 = TOTAL_TOKENS (dust 없음)", async () => {
      expect(PER_TRANCHE * 4n).to.equal(TOTAL_TOKENS);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // G. 엣지케이스
  // ─────────────────────────────────────────────────────────────
  describe("Edge cases", () => {
    it("claimEnabled=false 상태에서 claim() revert", async () => {
      await time.increaseTo(ts4h + 1);
      await tokenClaim.disableClaim();
      await expect(tokenClaim.connect(buyer).claim())
        .to.be.revertedWithCustomError(tokenClaim, "ClaimNotEnabled");
    });

    it("기여 없는 주소에서 claim() revert (NoContribution)", async () => {
      await time.increaseTo(ts60 + 1);
      const [, , stranger] = await ethers.getSigners();
      await expect(tokenClaim.connect(stranger).claim())
        .to.be.revertedWithCustomError(tokenClaim, "NoContribution");
    });

    it("부분 클레임 후 getUnlockedAmount - claimedAmount = claimable", async () => {
      // 10분 클레임
      await time.increaseTo(ts10 + 1);
      await tokenClaim.connect(buyer).claim();

      // 30분으로 이동
      await time.increaseTo(ts30 + 1);
      const unlockAmt  = await tokenClaim.getUnlockedAmount(buyer.address);
      const claimedAmt = await tokenClaim.claimedAmount(buyer.address);
      const claimable  = await tokenClaim.getClaimableAmount(buyer.address);

      expect(unlockAmt).to.equal(unlocked(2));   // 50%
      expect(claimedAmt).to.equal(PER_TRANCHE);  // 25% 기 클레임
      expect(claimable).to.equal(PER_TRANCHE);   // 추가 25%
      expect(unlockAmt - claimedAmt).to.equal(claimable); // 항등식
    });
  });
});
