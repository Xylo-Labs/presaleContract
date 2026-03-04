import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB");

  const network   = await ethers.provider.getNetwork();
  const isTestnet = network.chainId === 97n;

  // ============ Mock USDT (testnet only) ============
  let USDT_ADDRESS: string;
  let mockUsdtAddress: string | null = null;

  if (isTestnet) {
    console.log("\n📦 Deploying Mock USDT (testnet)...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockUsdt  = await MockERC20.deploy("Mock USDT", "USDT", 18);
    await mockUsdt.waitForDeployment();
    USDT_ADDRESS    = await mockUsdt.getAddress();
    mockUsdtAddress = USDT_ADDRESS;
    console.log("✅ Mock USDT deployed:", USDT_ADDRESS);
  } else {
    // BSC Mainnet USDT (18 decimals)
    USDT_ADDRESS = process.env.USDT_ADDRESS || "0x55d398326f99059fF775485246999027B3197955";
  }

  // ============ Stage Configuration ============
  const STAGE_CAPS: [bigint, bigint, bigint, bigint] = [
    ethers.parseEther("50000"),
    ethers.parseEther("150000"),
    ethers.parseEther("300000"),
    ethers.parseEther("500000"),
  ];
  const STAGE_PRICES: [bigint, bigint, bigint, bigint] = [
    ethers.parseEther("0.01"),
    ethers.parseEther("0.02"),
    ethers.parseEther("0.04"),
    ethers.parseEther("0.08"),
  ];
  const MIN_PER_TX = ethers.parseEther("100"); // 100 USDT

  // ============ Sale Times ============
  // 시작: 2026-03-03 11:00 KST = 2026-03-03 02:00 UTC
  // 종료: 2026-03-04 23:59 KST = 2026-03-04 14:59 UTC
  const START_TIME = Math.floor(new Date("2026-03-03T02:00:00Z").getTime() / 1000);
  const END_TIME   = Math.floor(new Date("2026-03-04T14:59:00Z").getTime() / 1000);

  // ============ Treasury ============
  const TREASURY = process.env.TREASURY_ADDRESS || deployer.address;
  console.log(`\n💰 Treasury: ${TREASURY}`);

  // ============ Deploy Presale ============
  console.log("\n📦 Deploying Presale (4-stage)...");
  const Presale = await ethers.getContractFactory("Presale");
  const presale = await Presale.deploy(
    USDT_ADDRESS, STAGE_CAPS, STAGE_PRICES, MIN_PER_TX, START_TIME, END_TIME, TREASURY
  );
  await presale.waitForDeployment();
  const presaleAddress = await presale.getAddress();
  console.log("✅ Presale deployed:", presaleAddress);

  // ============ Deploy TokenClaim ============
  console.log("\n📦 Deploying TokenClaim...");
  const TokenClaim = await ethers.getContractFactory("TokenClaim");
  const tokenClaim = await TokenClaim.deploy(presaleAddress);
  await tokenClaim.waitForDeployment();
  const tokenClaimAddress = await tokenClaim.getAddress();
  console.log("✅ TokenClaim deployed:", tokenClaimAddress);

  // ============ Link ============
  console.log("\n🔗 Linking Presale → TokenClaim...");
  await (await presale.setTokenClaimContract(tokenClaimAddress)).wait();
  console.log("✅ Linked");

  // ============ Vesting Schedule ============
  // TGE: 세일 종료 + 1일 후
  // 베스팅: +10분 / +30분 / +1시간 / +4시간 (테스트용)
  const TGE_BASE = END_TIME + 24 * 60 * 60;
  const timestamps  = [
    TGE_BASE + 10 * 60,
    TGE_BASE + 30 * 60,
    TGE_BASE + 60 * 60,
    TGE_BASE + 4 * 60 * 60,
  ];
  const percentages = [2500, 2500, 2500, 2500];

  console.log("\n📅 Setting vesting schedule...");
  await (await tokenClaim.setVestingSchedule(timestamps, percentages)).wait();
  console.log("✅ Vesting: 25% at +10m / +30m / +1h / +4h from TGE");

  // ============ Summary ============
  const networkName = isTestnet ? "bscTestnet" : "bscMainnet";
  const toKST = (ts: number) =>
    new Date(ts * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

  console.log("\n" + "=".repeat(60));
  console.log("🚀 DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`Network:       ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Treasury:      ${TREASURY}`);
  if (mockUsdtAddress) console.log(`Mock USDT:     ${mockUsdtAddress}`);
  console.log(`USDT:          ${USDT_ADDRESS}`);
  console.log(`Presale:       ${presaleAddress}`);
  console.log(`TokenClaim:    ${tokenClaimAddress}`);
  console.log(`Min/Tx:        ${ethers.formatEther(MIN_PER_TX)} USDT`);
  console.log(`Sale Start:    ${toKST(START_TIME)} KST`);
  console.log(`Sale End:      ${toKST(END_TIME)} KST`);
  console.log(`TGE Base:      ${toKST(TGE_BASE)} KST`);
  console.log("─".repeat(60));
  for (let i = 0; i < 4; i++) {
    console.log(`Stage ${i + 1}  cap=${ethers.formatEther(STAGE_CAPS[i]).padEnd(10)} price=${ethers.formatEther(STAGE_PRICES[i])} USDT/token`);
  }
  console.log("─".repeat(60));
  console.log(`\nFrontend update (contracts.ts):`);
  console.log(`  PRESALE_ADDRESS     = '${presaleAddress}'`);
  console.log(`  TOKEN_CLAIM_ADDRESS = '${tokenClaimAddress}'`);
  if (mockUsdtAddress) console.log(`  USDT_ADDRESS        = '${mockUsdtAddress}'`);
  console.log("\nVerify:");
  console.log(`npx hardhat verify --network ${networkName} ${presaleAddress} "${USDT_ADDRESS}" "[${STAGE_CAPS.join(",")}]" "[${STAGE_PRICES.join(",")}]" "${MIN_PER_TX}" "${START_TIME}" "${END_TIME}" "${TREASURY}"`);
  console.log(`npx hardhat verify --network ${networkName} ${tokenClaimAddress} "${presaleAddress}"`);
  console.log("=".repeat(60));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
