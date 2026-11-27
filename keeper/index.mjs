// DCAC keeper: runs due buys, and on testnet keeps the mock stock prices in line with Base mainnet.
//
// Env:
//   KEEPER_KEY      private key of an address allowed by DCAC.setKeeper (required to execute)
//   CHAIN_ID        31337 (local anvil, default), 84532 (Base Sepolia) or 8453 (Base)
//   RPC_URL         defaults per chain
//   INTERVAL_SEC    how often to check (default 60)
//   MAX_RUNS        plans per transaction (default 3; each needs up to 4.55M gas, see gasFor). If the gas
//                   estimate fails (e.g. over the per-transaction gas cap) it retries with fewer.
//
// Flags: --once (one pass and exit), --sync-prices (testnet: drip savings yield at YIELD_APY, copy Chainlink prices from Base mainnet into the mock
// feeds; testnet deployments only), --no-execute (skip running buys).
//
// In production the same call can come from a hosted scheduler instead: e.g. a KeeperHub workflow
// "Schedule every 5 min -> Read dueCount() -> Condition > 0 -> Write executeDue(3)", with its wallet
// allowed via setKeeper.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const syncPrices = args.has("--sync-prices");
const execute = !args.has("--no-execute");

const chainId = Number(process.env.CHAIN_ID ?? 31337);
const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});
const chain = { 31337: anvil, 84532: baseSepolia, 8453: base }[chainId];
if (!chain) throw new Error(`unsupported CHAIN_ID ${chainId}`);

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(join(here, "../contracts/deployments", `${chainId}.json`), "utf8"));

const transport = http(process.env.RPC_URL ?? chain.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain, transport });
const key = process.env.KEEPER_KEY;
const account = key ? privateKeyToAccount(key) : undefined;
const wallet = account ? createWalletClient({ chain, transport, account }) : undefined;

const dcacAbi = parseAbi([
  "function dueCount() view returns (uint256)",
  "function executeDue(uint256 maxRuns) returns (uint256)",
]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function setPrice(int256 answer)",
]);

// Chainlink feeds for Coinbase tokenized stocks on Base mainnet (docs.base.org, list tokenized stocks).
const MAINNET_FEEDS = {
  AAPL: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  AMZN: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  META: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA: "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
  SPCX: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
  // Crypto (Chainlink on Base mainnet; checked with description() on 2026-11-23)
  ETH: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  cbBTC: "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D",
  cbETH: "0xd7818272B9e248357d13057AAb0B417aF31E817d",
  AERO: "0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0",
  LINK: "0x17CAb8FE31E32f08326e5E27412894e49B0f9D65",
};
const mainnet = createPublicClient({ chain: base, transport: http(process.env.MAINNET_RPC_URL ?? "https://mainnet.base.org") });

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function syncMockPrices() {
  if (!dep.mock) return log("not a mock deployment; skipping price sync");
  if (!wallet) return log("KEEPER_KEY not set; can't sync prices");
  for (const s of dep.stocks) {
    const src = MAINNET_FEEDS[s.symbol];
    if (!src) continue;
    try {
      const [, real] = await mainnet.readContract({ address: src, abi: feedAbi, functionName: "latestRoundData" });
      const hash = await wallet.writeContract({ address: s.feed, abi: feedAbi, functionName: "setPrice", args: [real] });
      await pub.waitForTransactionReceipt({ hash });
      log(`price ${s.symbol} = $${(Number(real) / 1e8).toFixed(2)}`);
    } catch (e) {
      log(`price ${s.symbol} failed: ${e.shortMessage ?? e.message}`);
    }
  }
}

const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)", "function accrueAmount(uint256)"]);
const APY = Number(process.env.YIELD_APY ?? 5) / 100;
let lastAccrue = Date.now();

/// Testnet only: the mock savings vault has no real borrowers, so drip yield into it at YIELD_APY (default 5%,
/// in line with Base USDC vaults like Morpho's Steakhouse USDC).
async function accrueMockYield() {
  if (!dep.mock || !dep.savingsVault || !wallet) return;
  const assets = await pub.readContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "totalAssets" });
  const elapsed = (Date.now() - lastAccrue) / 1000;
  const amount = BigInt(Math.floor(Number(assets) * APY * (elapsed / (365 * 86400))));
  if (amount < 1n) return;
  const hash = await wallet.writeContract({ address: dep.savingsVault, abi: vaultAbi, functionName: "accrueAmount", args: [amount] });
  await pub.waitForTransactionReceipt({ hash });
  lastAccrue = Date.now();
  log(`yield +$${(Number(amount) / 1e6).toFixed(6)} on $${(Number(assets) / 1e6).toFixed(2)} saved (${APY * 100}% APY)`);
}

async function runDue() {
  const due = await pub.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "dueCount" });
  if (due === 0n) return log("nothing due");
  if (!wallet) return log(`${due} plan(s) due, but KEEPER_KEY not set`);
  // executeDue reverts unless every plan it runs has its gasFor() budget left, so the normal gas estimate
  // covers all of them. Several 5-asset baskets can need more gas than one transaction may use, so on a failed
  // estimate try again with fewer plans.
  let maxRuns = BigInt(process.env.MAX_RUNS ?? 3);
  let sim;
  for (;;) {
    try {
      sim = await pub.simulateContract({ account, address: dep.dcac, abi: dcacAbi, functionName: "executeDue", args: [maxRuns] });
      break;
    } catch (e) {
      if (maxRuns <= 1n) throw e;
      maxRuns = maxRuns / 2n;
      log(`estimate failed, retrying with ${maxRuns} plan(s): ${e.shortMessage ?? e.message}`);
    }
  }
  const { request, result } = sim;
  const hash = await wallet.writeContract(request);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  log(`ran ${result} of ${due} due plan(s): ${hash} (gas ${rcpt.gasUsed})`);
}

let lastSync = 0;
async function tick() {
  try {
    if (syncPrices && Date.now() - lastSync > 10 * 60_000) {
      await syncMockPrices();
      lastSync = Date.now();
    }
    if (syncPrices) await accrueMockYield();
    if (execute) await runDue();
  } catch (e) {
    log("error:", e.shortMessage ?? e.message);
  }
}

log(`keeper on chain ${chainId}, DCAC ${dep.dcac}, as ${account?.address ?? "(read-only)"}`);
await tick();
if (!once) setInterval(tick, Number(process.env.INTERVAL_SEC ?? 60) * 1000);
