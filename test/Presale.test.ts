import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Presale, TokenClaim, MockERC20 } from "../typechain-types";

// ─── Stage config ────────────────────────────────────────────────
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

// helpers
const tokens = (usdt: bigint, priceIdx: number) =>
  (usdt * 10n ** 18n) / STAGE_PRICES[priceIdx];

describe("Presale (4-stage)", () => {
  let presale: Presale;
  let tokenClaim: TokenClaim;
  let usdt: MockERC20;
  let owner: any, buyer: any, buyer2: any;
  let startTime: number, endTime: number;

  beforeEach(async () => {
    [owner, buyer, buyer2] = await ethers.getSigners();

    // Deploy mock USDT
    const Mock = await ethers.getContractFactory("MockERC20");
    usdt = await Mock.deploy("Mock USDT", "USDT", 18) as MockERC20;

    const now = await time.latest();
    startTime = now + 100;
    endTime   = startTime + 7 * 24 * 60 * 60;

    // Deploy Presale (no maxPerUser)
    const PresaleFactory = await ethers.getContractFactory("Presale");
    presale = await PresaleFactory.deploy(
      await usdt.getAddress(),
      [...STAGE_CAPS],
      [...STAGE_PRICES],
      MIN_PER_TX,
      startTime,
      endTime,
      owner.address  // treasury = owner (테스트용)
    ) as Presale;

    // Deploy TokenClaim
    const TCFactory = await ethers.getContractFactory("TokenClaim");
    tokenClaim = await TCFactory.deploy(await presale.getAddress()) as TokenClaim;

    await presale.setTokenClaimContract(await tokenClaim.getAddress());

    // Fund buyers with USDT (large amount since no maxPerUser)
    await usdt.mint(buyer.address,  ethers.parseEther("600000"));
    await usdt.mint(buyer2.address, ethers.parseEther("600000"));
    await usdt.connect(buyer).approve(await presale.getAddress(),  ethers.MaxUint256);
    await usdt.connect(buyer2).approve(await presale.getAddress(), ethers.MaxUint256);

    await time.increaseTo(startTime + 1);
  });

  // ── Deployment ─────────────────────────────────────────────────
  describe("Deployment", () => {
    it("Should set correct stage caps and prices", async () => {
      const stages = await presale.getAllStages();
      for (let i = 0; i < 4; i++) {
        expect(stages[i].cap).to.equal(STAGE_CAPS[i]);
        expect(stages[i].price).to.equal(STAGE_PRICES[i]);
      }
    });

    it("Should start at stage 0", async () => {
      expect(await presale.currentStage()).to.equal(0);
    });

    it("Should set correct minPerTx", async () => {
      expect(await presale.minPerTx()).to.equal(MIN_PER_TX);
    });

    it("Should reject descending caps", async () => {
      const PresaleFactory = await ethers.getContractFactory("Presale");
      await expect(
        PresaleFactory.deploy(
          await usdt.getAddress(),
          [STAGE_CAPS[1], STAGE_CAPS[0], STAGE_CAPS[2], STAGE_CAPS[3]],
          [...STAGE_PRICES],
          MIN_PER_TX, startTime, endTime, owner.address
        )
      ).to.be.revertedWith("Caps must be ascending");
    });
  });

  // ── Helper: 랜덤 지갑으로 목표 금액까지 채우기 ─────────────────
  async function fillUpTo(targetRaised: bigint) {
    let current = await presale.totalRaised();
    const chunk = ethers.parseEther("9000");

    while (current < targetRaised) {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);

      await ethers.provider.send("hardhat_setBalance", [
        wallet.address,
        "0x" + ethers.parseEther("1").toString(16),
      ]);

      const remaining = targetRaised - current;
      const amt = remaining < chunk ? remaining : chunk;

      await usdt.mint(wallet.address, amt);
      await usdt.connect(wallet).approve(await presale.getAddress(), ethers.MaxUint256);
      await presale.connect(wallet).buyTokens(amt);
      current += amt;
    }
  }

  // ── Single Stage Purchase ───────────────────────────────────────
  describe("Single Stage Purchase", () => {
    it("Should buy within Stage 0 correctly", async () => {
      const buyAmount = ethers.parseEther("1000");
      await presale.connect(buyer).buyTokens(buyAmount);

      expect(await presale.contributions(buyer.address)).to.equal(buyAmount);
      expect(await presale.tokenAllocations(buyer.address)).to.equal(tokens(buyAmount, 0));
      expect(await presale.totalRaised()).to.equal(buyAmount);
      expect(await presale.currentStage()).to.equal(0);
      expect(await presale.contributorCount()).to.equal(1);
    });

    it("Should record stage-level contributions", async () => {
      const buyAmount = ethers.parseEther("1000");
      await presale.connect(buyer).buyTokens(buyAmount);

      const info = await presale.getUserStageInfo(buyer.address);
      expect(info.usdtPerStage[0]).to.equal(buyAmount);
      expect(info.tokensPerStage[0]).to.equal(tokens(buyAmount, 0));
      expect(info.usdtPerStage[1]).to.equal(0n);
      expect(info.tokensPerStage[1]).to.equal(0n);
    });
  });

  // ── Cross-Stage Purchase (분할 계산) ───────────────────────────
  describe("Cross-Stage Purchase (split)", () => {
    it("Should split across Stage 0→1 correctly", async () => {
      await fillUpTo(ethers.parseEther("49000"));

      const stage0Fill = ethers.parseEther("1000");
      const stage1Fill = ethers.parseEther("4000");
      const expectedTokens = tokens(stage0Fill, 0) + tokens(stage1Fill, 1);

      await presale.connect(buyer).buyTokens(ethers.parseEther("5000"));

      expect(await presale.tokenAllocations(buyer.address)).to.equal(expectedTokens);
      expect(await presale.totalRaised()).to.equal(ethers.parseEther("54000"));
      expect(await presale.currentStage()).to.equal(1);
    });

    it("Should record stage-level split correctly", async () => {
      await fillUpTo(ethers.parseEther("49000"));

      const stage0Fill = ethers.parseEther("1000");
      const stage1Fill = ethers.parseEther("4000");

      await presale.connect(buyer).buyTokens(ethers.parseEther("5000"));

      const info = await presale.getUserStageInfo(buyer.address);
      expect(info.usdtPerStage[0]).to.equal(stage0Fill);
      expect(info.tokensPerStage[0]).to.equal(tokens(stage0Fill, 0));
      expect(info.usdtPerStage[1]).to.equal(stage1Fill);
      expect(info.tokensPerStage[1]).to.equal(tokens(stage1Fill, 1));
    });

    it("Should emit StageAdvanced when crossing boundary", async () => {
      await fillUpTo(ethers.parseEther("49000"));

      await expect(presale.connect(buyer).buyTokens(ethers.parseEther("5000")))
        .to.emit(presale, "StageAdvanced")
        .withArgs(1, STAGE_CAPS[0]);
    });

    it("Should split across Stage 1→2 correctly", async () => {
      await fillUpTo(ethers.parseEther("149000"));
      expect(await presale.currentStage()).to.equal(1);

      const stage1Fill = ethers.parseEther("1000");
      const stage2Fill = ethers.parseEther("4000");
      const expectedTokens = tokens(stage1Fill, 1) + tokens(stage2Fill, 2);

      await presale.connect(buyer).buyTokens(ethers.parseEther("5000"));
      expect(await presale.tokenAllocations(buyer.address)).to.equal(expectedTokens);
      expect(await presale.currentStage()).to.equal(2);
    });

    it("Should handle exact boundary purchase (no split)", async () => {
      await fillUpTo(STAGE_CAPS[0]);
      expect(await presale.currentStage()).to.equal(1);
      expect(await presale.totalRaised()).to.equal(STAGE_CAPS[0]);
    });
  });

  // ── No maxPerUser — 하드캡까지 단일 유저 구매 가능 ─────────────
  describe("No maxPerUser limit", () => {
    it("Should allow a single user to buy large amounts (up to hardcap)", async () => {
      // 단일 유저가 50,000 USDT 구매 (Stage 0 전체)
      const buyAmount = ethers.parseEther("50000");
      await presale.connect(buyer).buyTokens(buyAmount);

      expect(await presale.contributions(buyer.address)).to.equal(buyAmount);
      expect(await presale.currentStage()).to.equal(1);
    });

    it("Should allow multiple large purchases from same user", async () => {
      await presale.connect(buyer).buyTokens(ethers.parseEther("50000"));
      await presale.connect(buyer).buyTokens(ethers.parseEther("100000"));

      expect(await presale.contributions(buyer.address)).to.equal(ethers.parseEther("150000"));
    });
  });

  // ── Hardcap Partial Fill ────────────────────────────────────────
  describe("Hardcap partial fill", () => {
    it("Should only charge remaining amount when hardcap is reached", async () => {
      await fillUpTo(ethers.parseEther("499000"));

      const beforeBalance = await usdt.balanceOf(buyer.address);
      await presale.connect(buyer).buyTokens(ethers.parseEther("5000"));
      const afterBalance = await usdt.balanceOf(buyer.address);

      const charged = beforeBalance - afterBalance;
      expect(charged).to.equal(ethers.parseEther("1000"));
      expect(await presale.totalRaised()).to.equal(ethers.parseEther("500000"));
    });

    it("Should allow purchase below minPerTx when hardcap remainder < minPerTx (deadzone fix)", async () => {
      // 하드캡까지 50 USDT만 남김 (minPerTx=100보다 작음)
      await fillUpTo(ethers.parseEther("499950"));

      const beforeBalance = await usdt.balanceOf(buyer.address);
      // 100 USDT 요청하지만 50만 소비됨 — minPerTx 면제
      await presale.connect(buyer).buyTokens(ethers.parseEther("100"));
      const afterBalance = await usdt.balanceOf(buyer.address);

      const charged = beforeBalance - afterBalance;
      expect(charged).to.equal(ethers.parseEther("50"));
      expect(await presale.totalRaised()).to.equal(ethers.parseEther("500000"));
    });

    it("Should still enforce minPerTx when hardcap remainder >= minPerTx", async () => {
      // 하드캡까지 200 USDT 남김 (minPerTx=100보다 큼)
      await fillUpTo(ethers.parseEther("499800"));

      await expect(
        presale.connect(buyer).buyTokens(ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(presale, "BelowMinimum");
    });
  });

  // ── Validation ─────────────────────────────────────────────────
  describe("Validation", () => {
    it("Should revert BelowMinimum on first purchase", async () => {
      await expect(
        presale.connect(buyer).buyTokens(ethers.parseEther("99"))
      ).to.be.revertedWithCustomError(presale, "BelowMinimum");
    });

    it("Should revert BelowMinimum on second purchase below min too", async () => {
      await presale.connect(buyer).buyTokens(ethers.parseEther("100"));
      await expect(
        presale.connect(buyer).buyTokens(ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(presale, "BelowMinimum");
    });

    it("Should allow second purchase at exactly minPerTx", async () => {
      await presale.connect(buyer).buyTokens(ethers.parseEther("100"));
      await expect(
        presale.connect(buyer).buyTokens(ethers.parseEther("100"))
      ).to.not.be.reverted;
    });

    it("Should revert SaleNotActive after endTime", async () => {
      await time.increaseTo(endTime + 1);
      await expect(
        presale.connect(buyer).buyTokens(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(presale, "SaleNotActive");
    });

    it("Should revert EnforcedPause when paused", async () => {
      await presale.pause();
      await expect(
        presale.connect(buyer).buyTokens(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(presale, "EnforcedPause");
    });

    it("Should revert ZeroAmount", async () => {
      await expect(
        presale.connect(buyer).buyTokens(0n)
      ).to.be.revertedWithCustomError(presale, "ZeroAmount");
    });
  });

  // ── Stage Admin ─────────────────────────────────────────────────
  describe("Stage Admin (setStage)", () => {
    it("Should allow owner to modify a future stage", async () => {
      const newCap   = ethers.parseEther("200000");
      const newPrice = ethers.parseEther("0.05");

      await expect(presale.setStage(2, newCap, newPrice))
        .to.emit(presale, "StageUpdated")
        .withArgs(2, newCap, newPrice);

      const stages = await presale.getAllStages();
      expect(stages[2].cap).to.equal(newCap);
      expect(stages[2].price).to.equal(newPrice);
    });

    it("Should revert when modifying current stage (0)", async () => {
      await expect(
        presale.setStage(0, ethers.parseEther("60000"), ethers.parseEther("0.015"))
      ).to.be.revertedWithCustomError(presale, "CannotModifyActiveOrPastStage");
    });

    it("Should revert when new price does not exceed previous stage", async () => {
      await expect(
        presale.setStage(2, ethers.parseEther("200000"), ethers.parseEther("0.015"))
      ).to.be.revertedWith("Price must exceed previous stage");
    });

    it("Should revert when modifying past stage after advancement", async () => {
      await fillUpTo(STAGE_CAPS[0]);

      expect(await presale.currentStage()).to.equal(1);

      await expect(
        presale.setStage(0, ethers.parseEther("60000"), ethers.parseEther("0.015"))
      ).to.be.revertedWithCustomError(presale, "CannotModifyActiveOrPastStage");

      await expect(
        presale.setStage(1, ethers.parseEther("160000"), ethers.parseEther("0.025"))
      ).to.be.revertedWithCustomError(presale, "CannotModifyActiveOrPastStage");

      await expect(
        presale.setStage(2, ethers.parseEther("250000"), ethers.parseEther("0.05"))
      ).to.not.be.reverted;
    });
  });

  // ── getSaleInfo ─────────────────────────────────────────────────
  describe("getSaleInfo", () => {
    it("Should return correct stage info", async () => {
      const info = await presale.getSaleInfo();
      expect(info._currentStage).to.equal(0);
      expect(info._currentPrice).to.equal(STAGE_PRICES[0]);
      expect(info._currentStageCap).to.equal(STAGE_CAPS[0]);
      expect(info._hardCap).to.equal(STAGE_CAPS[3]);
      expect(info._isActive).to.equal(true);
      expect(info._minPerTx).to.equal(MIN_PER_TX);
    });

    it("Should update currentStage in getSaleInfo after stage advance", async () => {
      await fillUpTo(STAGE_CAPS[0]);

      const info = await presale.getSaleInfo();
      expect(info._currentStage).to.equal(1);
      expect(info._currentPrice).to.equal(STAGE_PRICES[1]);
      expect(info._currentStageCap).to.equal(STAGE_CAPS[1]);
    });
  });

  // ── TokenClaim Integration ──────────────────────────────────────
  describe("TokenClaim integration", () => {
    it("Should read tokenAllocations via getUserTokenAmount", async () => {
      const buyAmount = ethers.parseEther("1000");
      await presale.connect(buyer).buyTokens(buyAmount);

      const allocated = await presale.getUserTokenAmount(buyer.address);
      expect(allocated).to.equal(tokens(buyAmount, 0));

      const claimInfo = await tokenClaim.getUserClaimInfo(buyer.address);
      expect(claimInfo.totalAllocation).to.equal(allocated);
    });
  });

  // ── withdrawFunds ───────────────────────────────────────────────
  describe("withdrawFunds", () => {
    it("USDT goes directly to treasury on purchase (no contract balance)", async () => {
      const treasuryBefore = await usdt.balanceOf(owner.address);
      await presale.connect(buyer).buyTokens(ethers.parseEther("100"));
      const treasuryAfter = await usdt.balanceOf(owner.address);

      // treasury(=owner)가 즉시 수령
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("100"));
      // 컨트랙트 잔액은 0
      expect(await usdt.balanceOf(await presale.getAddress())).to.equal(0n);
    });

    it("withdrawFunds: recovers accidentally sent USDT to treasury", async () => {
      // 실수로 컨트랙트에 직접 USDT 전송
      await usdt.mint(await presale.getAddress(), ethers.parseEther("200"));

      const treasuryBefore = await usdt.balanceOf(owner.address);
      await presale.withdrawFunds();
      const treasuryAfter = await usdt.balanceOf(owner.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("200"));
    });
  });

  // ── Security (High fixes) ───────────────────────────────────────
  describe("Security", () => {
    it("setToken: should revert on second call (TokenAlreadySet)", async () => {
      const mock2 = await (await ethers.getContractFactory("MockERC20"))
        .deploy("T2", "T2", 18);
      await tokenClaim.setToken(await mock2.getAddress());
      await expect(
        tokenClaim.setToken(await mock2.getAddress())
      ).to.be.revertedWithCustomError(tokenClaim, "TokenAlreadySet");
    });

    it("setVestingSchedule: should revert after claim enabled", async () => {
      const mock2 = await (await ethers.getContractFactory("MockERC20"))
        .deploy("T2", "T2", 18);
      await tokenClaim.setToken(await mock2.getAddress());
      const now2 = await time.latest();
      await tokenClaim.setVestingSchedule([now2 + 100], [10000]);
      await tokenClaim.enableClaim();
      await expect(
        tokenClaim.setVestingSchedule([now2 + 200], [10000])
      ).to.be.revertedWithCustomError(tokenClaim, "ClaimsAlreadyStarted");
    });

    it("emergencyWithdraw: should revert for claim token", async () => {
      const mock2 = await (await ethers.getContractFactory("MockERC20"))
        .deploy("T2", "T2", 18);
      const addr = await mock2.getAddress();
      await tokenClaim.setToken(addr);
      await expect(
        tokenClaim.emergencyWithdraw(addr, 0n)
      ).to.be.revertedWithCustomError(tokenClaim, "CannotWithdrawClaimToken");
    });

    it("emergencyWithdraw: should allow non-claim token", async () => {
      const mock2 = await (await ethers.getContractFactory("MockERC20"))
        .deploy("T2", "T2", 18);
      await tokenClaim.setToken(await mock2.getAddress());
      const other = await (await ethers.getContractFactory("MockERC20"))
        .deploy("OTHER", "OTH", 18);
      const otherAddr = await other.getAddress();
      await other.mint(await tokenClaim.getAddress(), ethers.parseEther("100"));
      await expect(
        tokenClaim.emergencyWithdraw(otherAddr, ethers.parseEther("100"))
      ).to.not.be.reverted;
    });
  });

  // ── Stage-level verification ────────────────────────────────────
  describe("Stage-level verification", () => {
    it("Should accumulate stage contributions across multiple buys", async () => {
      await presale.connect(buyer).buyTokens(ethers.parseEther("1000"));
      await presale.connect(buyer).buyTokens(ethers.parseEther("2000"));

      const info = await presale.getUserStageInfo(buyer.address);
      expect(info.usdtPerStage[0]).to.equal(ethers.parseEther("3000"));
      expect(info.tokensPerStage[0]).to.equal(tokens(ethers.parseEther("3000"), 0));
    });

    it("Should verify USDT/token ratio per stage is consistent", async () => {
      await fillUpTo(ethers.parseEther("49000"));
      await presale.connect(buyer).buyTokens(ethers.parseEther("5000"));

      const info = await presale.getUserStageInfo(buyer.address);

      // Stage 0: 1000 USDT @ 0.01 = 100,000 tokens
      const expectedTokens0 = (info.usdtPerStage[0] * 10n ** 18n) / STAGE_PRICES[0];
      expect(info.tokensPerStage[0]).to.equal(expectedTokens0);

      // Stage 1: 4000 USDT @ 0.02 = 200,000 tokens
      const expectedTokens1 = (info.usdtPerStage[1] * 10n ** 18n) / STAGE_PRICES[1];
      expect(info.tokensPerStage[1]).to.equal(expectedTokens1);
    });

    it("Should have stage totals equal overall totals", async () => {
      await fillUpTo(ethers.parseEther("49000"));
      await presale.connect(buyer).buyTokens(ethers.parseEther("5000"));

      const info = await presale.getUserStageInfo(buyer.address);
      const totalContrib = await presale.contributions(buyer.address);
      const totalAlloc   = await presale.tokenAllocations(buyer.address);

      const sumUsdt   = info.usdtPerStage[0] + info.usdtPerStage[1] + info.usdtPerStage[2] + info.usdtPerStage[3];
      const sumTokens = info.tokensPerStage[0] + info.tokensPerStage[1] + info.tokensPerStage[2] + info.tokensPerStage[3];

      expect(sumUsdt).to.equal(totalContrib);
      expect(sumTokens).to.equal(totalAlloc);
    });
  });
});
