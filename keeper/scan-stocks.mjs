// Scans Coinbase tokenized stocks on Base mainnet for USDC pools on Aerodrome Slipstream and Uniswap v3,
// and how much USDC each pool holds. Input: "SYM:suffix" pairs (address = 0xb2 + 20 zeros + suffix).
//   node scan-stocks.mjs stocks.txt > scan.json
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";

const pub = createPublicClient({ chain: base, transport: http(process.env.MAINNET_RPC_URL ?? "https://mainnet.base.org"), batch: { multicall: { batchSize: 4096 } } });
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO = "0x9CB220581b91b0C83223012FE69688b92aD07a76";
const UNI = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const abi = parseAbi([
  "function getPool(address,address,int24) view returns (address)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
const uniAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);

const stocks = readFileSync(process.argv[2], "utf8").trim().split(/\s+/).map((p) => {
  const [sym, suf] = p.split(":");
  return { sym, token: getAddress("0xb2" + "0".repeat(20) + suf) };
});
const call = (c) => pub.readContract(c).catch(() => undefined);

for (const s of stocks.filter((s) => s.sym === "?")) s.sym = (await call({ address: s.token, abi, functionName: "symbol" })) ?? "?";

const queries = [];
for (const s of stocks) {
  for (const ts of [1, 10, 50, 100, 200, 2000]) queries.push({ s, venue: "aerodrome", param: ts, c: { address: AERO, abi, functionName: "getPool", args: [s.token, USDC, ts] } });
  for (const fee of [100, 500, 3000, 10000]) queries.push({ s, venue: "uniswap-v3", param: fee, c: { address: UNI, abi: uniAbi, functionName: "getPool", args: [s.token, USDC, fee] } });
}
const pools = [];
for (let i = 0; i < queries.length; i += 400) {
  const chunk = queries.slice(i, i + 400);
  const res = await Promise.all(chunk.map((q) => call(q.c)));
  chunk.forEach((q, k) => {
    const a = res[k];
    if (a && !/^0x0{40}$/.test(a)) pools.push({ symbol: q.s.sym, token: q.s.token, venue: q.venue, param: q.param, pool: a });
  });
}
const bals = await Promise.all(pools.map((p) => call({ address: USDC, abi, functionName: "balanceOf", args: [p.pool] })));
pools.forEach((p, i) => (p.usdc = Number(bals[i] ?? 0n) / 1e6));
console.log(JSON.stringify({ scannedAt: new Date().toISOString(), stocks, pools }, null, 1));
