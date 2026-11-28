// DCAC agent tools: read-only views of DCAC on Base, plus unsigned transactions and prefilled links for the
// user's own wallet to sign. Shared by the REST API (api/agents.ts) and the MCP server (api/mcp.ts).
// No keys anywhere: nothing here signs or sends a transaction.

import { createPublicClient, encodeFunctionData, fallback, getAddress, http, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { base } from "viem/chains";
import { deployment } from "./deployment.js";

export const SITE = "https://dcac.fun";
const BANKR_API = "https://api.bankr.bot";
const BANKR_FACTORY = "0x49a3A6D33110425099A9f070d22f576f592b46eB" as Address;
const CHAIN_ID = 8453;
const DCAC = deployment.dcac as Address;
const USDC = deployment.usdc as Address;

const client = createPublicClient({
  chain: base,
  batch: { multicall: true },
  transport: fallback([...(process.env.DCAC_RPC_URL ? [http(process.env.DCAC_RPC_URL)] : []), http("https://base-rpc.publicnode.com"), http()]),
});

const dcacAbi = parseAbi([
  "struct Plan { address owner; uint64 interval; uint64 nextRun; uint64 createdAt; uint64 lastRun; uint32 buysDone; uint32 maxBuys; uint32 skippedRuns; bool active; bool savings; bool smart; uint16 feeBps; uint16 smartFeeBps; uint16 yieldFeeBps; uint64 minFee; address creator; uint16 creatorShareBps; address vault; uint256 shares; uint256 idle; uint256 principal; uint256 totalSpent; uint256 totalFees; string name; }",
  "struct Leg { address token; uint256 amount; uint256 spent; uint256 received; }",
  "function getPlan(uint256 id) view returns (Plan plan, Leg[] legs)",
  "function plansOf(address user) view returns (uint256[])",
  "function planValue(uint256 id) view returns (uint256)",
  "function priceOf(address token) view returns (uint256 price, uint256 updatedAt, bool usable)",
  "function getAssets() view returns (address[])",
  "function assets(address token) view returns (address feed, uint8 tokenDecimals, uint8 feedDecimals, bool enabled)",
  "function feeBps() view returns (uint16)",
  "function smartFeeBps() view returns (uint16)",
  "function minFee() view returns (uint64)",
  "function minLegAmount() view returns (uint256)",
  "function minInterval() view returns (uint64)",
  "function maxInterval() view returns (uint64)",
  "function createPaused() view returns (bool)",
  "function createPlan(string name, address[] tokens, uint256[] amounts, uint64 interval, uint32 maxBuys, bool savings, bool smart, uint256 maxDeposit) returns (uint256)",
  "function createSharedPlan(address creator, string name, address[] tokens, uint256[] amounts, uint64 interval, uint32 maxBuys, bool savings, bool smart, uint256 maxDeposit) returns (uint256)",
  "function cancelPlan(uint256 id)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const isVaultAbi = parseAbi(["function isVault(address vault) view returns (bool)"]);
const multiplierAbi = parseAbi(["function multiplier() view returns (uint256)"]);

export class ToolError extends Error {}
const fail = (msg: string): never => {
  throw new ToolError(msg);
};

// ---------------------------------------------------------------- assets

type Asset = {
  symbol: string;
  name: string;
  kind: "stock" | "crypto" | "index";
  token: Address;
  decimals: number;
  priceUsd: number;
  canBuyNow: boolean;
  pricing: string;
  multiplier: number;
};

async function loadAssets(): Promise<Asset[]> {
  const known = deployment.stocks.map((s) => ({ ...s, token: getAddress(s.token) }));
  const all = (await client.readContract({ address: DCAC, abi: dcacAbi, functionName: "getAssets" })) as Address[];
  const knownSet = new Set(known.map((s) => s.token.toLowerCase()));
  const extra = all.filter((a) => !knownSet.has(a.toLowerCase()));
  const indexFlags = await Promise.all(extra.map((t) => client.readContract({ address: BANKR_FACTORY, abi: isVaultAbi, functionName: "isVault", args: [t] }).catch(() => false)));
  // Listed after launch: Bankr indexes, and Coinbase stocks (0xb2000000…) priced from their own pool (#/stocks).
  const isStockToken = (t: string) => t.toLowerCase().startsWith("0xb2" + "0".repeat(20));

  const rows: { token: Address; symbol: string; name: string; kind: Asset["kind"]; pricing: string }[] = [
    ...known.map((s) => ({
      token: s.token,
      symbol: (s.kind ?? "stock") === "stock" ? `${s.symbol}c` : s.symbol, // the onchain name: NVDAc
      name: s.name,
      kind: (s.kind ?? "stock") as Asset["kind"],
      pricing: s.pricing ?? "chainlink",
    })),
    ...extra.flatMap((t, i) =>
      indexFlags[i]
        ? [{ token: t, symbol: "", name: "", kind: "index" as Asset["kind"], pricing: "bankr" }]
        : isStockToken(t)
          ? [{ token: t, symbol: "", name: "", kind: "stock" as Asset["kind"], pricing: "twap" }]
          : [],
    ),
  ];
  const out = await Promise.all(
    rows.map(async (r) => {
      const [[price, , usable], [, tokenDecimals, feedDecimals, enabled], symbol, name, mult] = await Promise.all([
        client.readContract({ address: DCAC, abi: dcacAbi, functionName: "priceOf", args: [r.token] }),
        client.readContract({ address: DCAC, abi: dcacAbi, functionName: "assets", args: [r.token] }),
        r.symbol ? r.symbol : client.readContract({ address: r.token, abi: erc20Abi, functionName: "symbol" }),
        r.name ? r.name : client.readContract({ address: r.token, abi: erc20Abi, functionName: "name" }),
        r.kind === "stock" ? client.readContract({ address: r.token, abi: multiplierAbi, functionName: "multiplier" }).catch(() => 10n ** 18n) : 10n ** 18n,
      ]);
      if (!enabled) return undefined;
      return {
        symbol,
        name,
        kind: r.kind,
        token: r.token,
        decimals: tokenDecimals,
        priceUsd: Number(price) / 10 ** feedDecimals,
        canBuyNow: usable,
        pricing: r.pricing,
        multiplier: Number(mult) / 1e18,
      } satisfies Asset;
    }),
  );
  return out.filter((a): a is Asset => !!a);
}

const PRICING: Record<string, string> = {
  chainlink: "Chainlink, market hours only",
  "chainlink-24/7": "Chainlink, 24/7",
  twap: "30-minute average of its Aerodrome pool, refused on spikes or thin liquidity",
  bankr: "basket value plus index fee (Bankr IndexLens)",
};

function publicAsset(a: Asset) {
  return {
    symbol: a.symbol,
    name: a.name,
    kind: a.kind,
    token: a.token,
    priceUsd: round(a.kind === "stock" ? a.priceUsd / a.multiplier : a.priceUsd, 6), // per share for stocks
    canBuyNow: a.canBuyNow,
    priceSource: PRICING[a.pricing] ?? a.pricing,
    ...(a.kind === "index" ? { page: `${SITE}/#/indexes/${a.token}` } : {}),
  };
}

function findAsset(assets: Asset[], q: string): Asset {
  const s = q.trim();
  if (isAddress(s)) {
    const a = assets.find((x) => x.token.toLowerCase() === s.toLowerCase());
    return a ?? fail(`${s} isn't listed on DCAC. Use dcac_assets for what can be bought.`);
  }
  const k = s.replace(/^\$/, "").toUpperCase();
  // Exact symbol first, then Coinbase's "c" suffix either way round (NVDA and NVDAc are the same stock).
  const sym = (x: Asset) => x.symbol.toUpperCase();
  const a =
    assets.find((x) => sym(x) === k) ??
    assets.find((x) => x.kind === "stock" && (sym(x) === `${k}C` || (k.endsWith("C") && sym(x) === k.slice(0, -1))));
  return (
    a ??
    fail(`No listed asset called "${q}". dcac_assets lists what DCAC can buy; Bankr indexes need to be listed on DCAC first (dcac_indexes shows which are).`)
  );
}

export async function assetsTool(args: { search?: string }) {
  const all = await loadAssets();
  const q = (args.search ?? "").trim().toLowerCase();
  const list = all.filter((a) => !q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.kind === q);
  return {
    chainId: CHAIN_ID,
    count: list.length,
    assets: list.map(publicAsset),
    note: "canBuyNow is false while a stock's market is closed or a price is stale. A plan still runs: that part is skipped and retried, its USDC stays in the plan.",
  };
}

// ---------------------------------------------------------------- Bankr indexes

type BankrIndex = {
  address: Address;
  name: string;
  symbol: string;
  kind: string;
  componentCount: number;
  componentsPreview: { symbol: string }[];
  navUsd: number;
  change24hPct: number | null;
};

export async function indexesTool(args: { search?: string; limit?: number }) {
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const [r, listed] = await Promise.all([fetch(`${BANKR_API}/indexes?chain=base&sort=strength&limit=50`), loadAssets()]);
  if (!r.ok) fail(`Bankr's index API answered ${r.status}. Try again shortly.`);
  const j = (await r.json()) as { items: BankrIndex[] };
  const on = new Set(listed.filter((a) => a.kind === "index").map((a) => a.token.toLowerCase()));
  const q = (args.search ?? "").trim().toLowerCase();
  const items = j.items
    .filter((i) => !q || i.name.toLowerCase().includes(q) || i.symbol.toLowerCase().includes(q) || i.componentsPreview.some((c) => c.symbol.toLowerCase().includes(q)))
    .slice(0, limit)
    .map((i) => ({
      symbol: i.symbol,
      name: i.name,
      token: i.address,
      kind: i.kind,
      holds: i.componentsPreview.map((c) => c.symbol),
      componentCount: i.componentCount,
      backingUsd: round(i.navUsd, 2),
      change24hPct: i.change24hPct,
      recurringBuysOnDcac: on.has(i.address.toLowerCase()),
      page: `${SITE}/#/indexes/${i.address}`,
    }));
  return {
    about: "Bankr index tokens: one ERC-20 backed by the basket it holds, redeemable for the basket any time. Only indexes with recurringBuysOnDcac can go in a DCAC plan.",
    indexes: items,
  };
}

// ---------------------------------------------------------------- quote and build

type MixIn = { asset: string; usd: number }[];
type PlanArgs = { mix: MixIn; every: string | number; buys: number; rebalance?: boolean; savings?: boolean; name?: string; creator?: string };

const WORDS: Record<string, number> = { hour: 3600, hourly: 3600, day: 86400, daily: 86400, week: 604800, weekly: 604800, fortnight: 1209600, biweekly: 1209600, month: 2592000, monthly: 2592000 };

function parseEvery(e: string | number): number {
  if (typeof e === "number") return Math.floor(e);
  const s = e.trim().toLowerCase().replace(/^every\s+/, "");
  if (/^\d+$/.test(s)) return Number(s);
  if (WORDS[s]) return WORDS[s];
  const m = s.match(/^(\d+)\s*(h|hr|hrs|hours?|d|days?|w|wk|weeks?)$/);
  if (!m) return fail(`Can't read "${e}" as a frequency. Use seconds, or words like "day", "week", "2 weeks", "4h".`);
  const n = Number(m[1]);
  return n * (m[2].startsWith("h") ? 3600 : m[2].startsWith("d") ? 86400 : 604800);
}

async function readLimits() {
  const r = (fn: "feeBps" | "smartFeeBps" | "minFee" | "minLegAmount" | "minInterval" | "maxInterval" | "createPaused") =>
    client.readContract({ address: DCAC, abi: dcacAbi, functionName: fn });
  const [feeBps, smartFeeBps, minFee, minLeg, minInterval, maxInterval, paused] = await Promise.all([
    r("feeBps"),
    r("smartFeeBps"),
    r("minFee"),
    r("minLegAmount"),
    r("minInterval"),
    r("maxInterval"),
    r("createPaused"),
  ]);
  return {
    feeBps: Number(feeBps),
    smartFeeBps: Number(smartFeeBps),
    minFee: BigInt(minFee as bigint),
    minLeg: BigInt(minLeg as bigint),
    minInterval: Number(minInterval),
    maxInterval: Number(maxInterval),
    paused: paused as boolean,
  };
}

async function shapePlan(a: PlanArgs) {
  if (!Array.isArray(a.mix) || a.mix.length === 0) fail("mix needs at least one { asset, usd }.");
  if (a.mix.length > 5) fail("A plan holds at most 5 assets.");
  const [assets, lim] = await Promise.all([loadAssets(), readLimits()]);
  if (lim.paused) fail("New plans are paused on DCAC right now.");
  const legs = a.mix.map((m) => {
    const asset = findAsset(assets, String(m.asset));
    const usd = Number(m.usd);
    if (!Number.isFinite(usd) || usd <= 0) fail(`usd for ${m.asset} must be a positive number of dollars per buy.`);
    const amount = BigInt(Math.round(usd * 1e6));
    if (amount < lim.minLeg) fail(`Each asset needs at least $${Number(lim.minLeg) / 1e6} per buy (${asset.symbol} has $${usd}).`);
    return { asset, amount };
  });
  if (new Set(legs.map((l) => l.asset.token)).size !== legs.length) fail("Each asset can appear once in a mix.");
  const interval = parseEvery(a.every);
  if (interval < lim.minInterval || interval > lim.maxInterval) fail(`Frequency must be between ${lim.minInterval / 3600} hour(s) and ${lim.maxInterval / 86400} days.`);
  const buys = Math.floor(Number(a.buys));
  if (!(buys >= 1 && buys <= 10_000)) fail("buys must be a whole number from 1 to 10000.");
  const smart = !!a.rebalance && legs.length > 1;
  const per = legs.reduce((s, l) => s + l.amount, 0n);
  const bps = BigInt(lim.feeBps + (smart ? lim.smartFeeBps : 0));
  const pct = (per * bps) / 10_000n;
  const fee = pct > lim.minFee ? pct : lim.minFee;
  const deposit = (per + fee) * BigInt(buys);
  const name = (a.name ?? "").trim().slice(0, 64) || legs.map((l) => l.asset.symbol.replace(/c$/, "")).join(" + ");
  return { legs, interval, buys, smart, savings: a.savings !== false, per, fee, deposit, name, bpsTotal: Number(bps), minFee: lim.minFee };
}

const money = (raw: bigint) => round(Number(raw) / 1e6, 2);

function summary(p: Awaited<ReturnType<typeof shapePlan>>) {
  const now = Math.floor(Date.now() / 1000);
  const closed = p.legs.filter((l) => !l.asset.canBuyNow).map((l) => l.asset.symbol);
  return {
    name: p.name,
    perBuy: p.legs.map((l) => ({ asset: l.asset.symbol, token: l.asset.token, usd: money(l.amount) })),
    perBuyTotalUsd: money(p.per),
    feePerBuyUsd: money(p.fee),
    feeRate: `${p.bpsTotal / 100}% of each buy, at least $${money(p.minFee)}`,
    every: describeEvery(p.interval),
    intervalSeconds: p.interval,
    buys: p.buys,
    depositUsdc: money(p.deposit),
    firstBuy: "within minutes of creating it",
    lastBuyAround: new Date((now + p.interval * (p.buys - 1)) * 1000).toISOString().slice(0, 10),
    autoRebalance: p.smart,
    savingsYield: p.savings ? "on: USDC waiting to be spent earns yield in a Morpho vault" : "off",
    ...(closed.length ? { note: `${closed.join(", ")} can't buy right now (market closed or price stale). Those parts are skipped and retried; their USDC stays in the plan.` } : {}),
    stopAnytime: "The owner can stop the plan any time and get the unspent USDC back.",
  };
}

function describeEvery(s: number) {
  if (s % 604800 === 0) return s === 604800 ? "every week" : `every ${s / 604800} weeks`;
  if (s % 86400 === 0) return s === 86400 ? "every day" : `every ${s / 86400} days`;
  if (s % 3600 === 0) return s === 3600 ? "every hour" : `every ${s / 3600} hours`;
  return `every ${s} seconds`;
}

export async function quoteTool(args: PlanArgs) {
  return summary(await shapePlan(args));
}

export async function buildPlanTool(args: PlanArgs & { owner?: string }) {
  const p = await shapePlan(args);
  const creator = args.creator && isAddress(args.creator) ? getAddress(args.creator) : undefined;
  const tokens = p.legs.map((l) => l.asset.token);
  const amounts = p.legs.map((l) => l.amount);
  const createData = creator
    ? encodeFunctionData({ abi: dcacAbi, functionName: "createSharedPlan", args: [creator, p.name, tokens, amounts, BigInt(p.interval), p.buys, p.savings, p.smart, p.deposit] })
    : encodeFunctionData({ abi: dcacAbi, functionName: "createPlan", args: [p.name, tokens, amounts, BigInt(p.interval), p.buys, p.savings, p.smart, p.deposit] });

  const q = new URLSearchParams({
    mix: p.legs.map((l) => `${l.asset.token}:${money(l.amount)}`).join(","),
    every: String(p.interval),
    name: p.name,
    buys: String(p.buys),
  });
  if (creator) q.set("from", creator);
  if (p.smart) q.set("rebalance", "1");

  let wallet: Record<string, unknown> | undefined;
  if (args.owner && isAddress(args.owner)) {
    const owner = getAddress(args.owner);
    const [bal, allowance] = await Promise.all([
      client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [owner, DCAC] }),
    ]);
    wallet = {
      address: owner,
      usdcBalance: money(bal),
      enoughUsdc: bal >= p.deposit,
      approvalNeeded: allowance < p.deposit,
    };
  }

  return {
    plan: summary(p),
    signInApp: {
      url: `${SITE}/#/new?${q}`,
      how: "Open this link, sign in, check the basket and press Create. Best for people: the app shows everything before they sign.",
    },
    transactions: [
      ...(wallet && wallet.approvalNeeded === false
        ? []
        : [{ step: "Approve USDC", to: USDC, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DCAC, p.deposit] }), chainId: CHAIN_ID }]),
      { step: "Create the plan", to: DCAC, value: "0", data: createData, chainId: CHAIN_ID },
    ],
    ...(wallet ? { wallet } : {}),
    notes: [
      `The create call pulls exactly ${money(p.deposit)} USDC and refuses if fees changed and it would need more.`,
      "Unsigned. Nothing happens until the owner's own wallet signs, in order.",
    ],
  };
}

export async function buildCancelTool(args: { id: number | string }) {
  const id = parseId(args.id);
  const [plan] = await client.readContract({ address: DCAC, abi: dcacAbi, functionName: "getPlan", args: [id] });
  if (plan.owner === zeroAddress) fail(`Plan ${id} doesn't exist.`);
  if (!plan.active) fail(`Plan ${id} has already ended.`);
  return {
    plan: { id: Number(id), owner: plan.owner, name: plan.name },
    signInApp: { url: `${SITE}/#/plan/${id}`, how: "Open the plan, press Terminate, then Stop & refund." },
    transactions: [{ step: "Stop the plan and refund unspent USDC", to: DCAC, value: "0", data: encodeFunctionData({ abi: dcacAbi, functionName: "cancelPlan", args: [id] }), chainId: CHAIN_ID }],
    notes: [`Only the owner (${plan.owner}) can send this. Tokens already bought stay in the owner's wallet.`],
  };
}

// ---------------------------------------------------------------- plans

function parseId(v: unknown): bigint {
  const s = String(v ?? "").replace(/^#/, "");
  if (!/^\d+$/.test(s)) return fail("id must be a plan number, e.g. 1.");
  return BigInt(s);
}

async function readPlan(id: bigint, assets: Asset[]) {
  const [[plan, legs], value] = await Promise.all([
    client.readContract({ address: DCAC, abi: dcacAbi, functionName: "getPlan", args: [id] }),
    client.readContract({ address: DCAC, abi: dcacAbi, functionName: "planValue", args: [id] }),
  ]);
  if (plan.owner === zeroAddress) return undefined;
  let holdingsUsd = 0;
  const legOut = legs.map((l) => {
    const a = assets.find((x) => x.token.toLowerCase() === l.token.toLowerCase());
    const tokens = a ? Number(l.received) / 10 ** a.decimals : 0;
    const valueUsd = a ? tokens * a.priceUsd : 0;
    holdingsUsd += valueUsd;
    return {
      asset: a?.symbol ?? l.token,
      token: l.token,
      usdPerBuy: money(l.amount),
      spentUsd: money(l.spent),
      held: round(tokens * (a?.multiplier ?? 1), 8),
      valueUsd: round(valueUsd, 2),
      canBuyNow: a?.canBuyNow ?? false,
    };
  });
  const spent = Number(plan.totalSpent) / 1e6;
  return {
    id: Number(id),
    name: plan.name,
    owner: plan.owner,
    active: plan.active,
    every: describeEvery(Number(plan.interval)),
    buysDone: plan.buysDone,
    maxBuys: plan.maxBuys,
    nextBuy: plan.active ? new Date(Number(plan.nextRun) * 1000).toISOString() : null,
    skippedRunsInARow: plan.skippedRuns,
    autoRebalance: plan.smart,
    savingsYield: plan.savings,
    copiedFrom: plan.creator === zeroAddress ? null : plan.creator,
    investedUsd: round(spent, 2),
    holdingsUsd: round(holdingsUsd, 2),
    profitUsd: round(holdingsUsd - spent, 2),
    budgetLeftUsd: money(value),
    feesPaidUsd: money(plan.totalFees),
    legs: legOut,
    page: `${SITE}/#/plan/${id}`,
    copyLink: `${SITE}/#/b/${id}`,
  };
}

export async function planTool(args: { id: number | string }) {
  const id = parseId(args.id);
  const p = await readPlan(id, await loadAssets());
  return p ?? fail(`Plan ${id} doesn't exist.`);
}

export async function plansTool(args: { owner: string }) {
  if (!args.owner || !isAddress(args.owner)) fail("owner must be a 0x wallet address.");
  const owner = getAddress(args.owner);
  const [ids, assets] = await Promise.all([client.readContract({ address: DCAC, abi: dcacAbi, functionName: "plansOf", args: [owner] }), loadAssets()]);
  const plans = (await Promise.all(ids.map((id) => readPlan(id, assets)))).filter(Boolean);
  return { owner, count: plans.length, plans };
}

// ---------------------------------------------------------------- registry

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

const mixSchema = {
  type: "array",
  description: "Up to 5 assets and the dollars of each to buy every time, e.g. [{\"asset\":\"MAG7\",\"usd\":15},{\"asset\":\"ETH\",\"usd\":5}]. asset is a symbol from dcac_assets or a token address.",
  items: { type: "object", properties: { asset: { type: "string" }, usd: { type: "number" } }, required: ["asset", "usd"] },
};
const planProps = {
  mix: mixSchema,
  every: { type: ["string", "number"], description: "How often: seconds, or \"day\", \"week\", \"2 weeks\", \"month\", \"4h\". From 1 hour to 30 days." },
  buys: { type: "integer", description: "How many buys in total, e.g. 52 for a year of weekly buys." },
  rebalance: { type: "boolean", description: "Auto-rebalance: split each buy toward the target mix (+0.25% fee). Default false." },
  savings: { type: "boolean", description: "Earn yield on USDC waiting to be spent. Default true." },
  name: { type: "string", description: "Optional plan name." },
};

export const TOOLS = [
  {
    name: "dcac_assets",
    description: "List what DCAC can buy on a schedule on Base: Coinbase tokenized stocks, crypto, and Bankr index tokens listed on DCAC, with live prices and whether each can buy right now.",
    inputSchema: { type: "object", properties: { search: { type: "string", description: "Optional symbol, name, or kind (stock, crypto, index)." } } },
    run: assetsTool,
  },
  {
    name: "dcac_indexes",
    description: "Browse Bankr index tokens on Base (one token backed by a basket of stocks and crypto). Shows what each holds and whether DCAC can buy it on a schedule.",
    inputSchema: { type: "object", properties: { search: { type: "string", description: "Optional words, e.g. 'AI', 'NVDA'." }, limit: { type: "integer", description: "Max results, default 10." } } },
    run: indexesTool,
  },
  {
    name: "dcac_quote",
    description: "Price a recurring-buy plan before creating it: dollars per buy, fee, total USDC deposit, and when it ends. Checks every rule the contract will.",
    inputSchema: { type: "object", properties: planProps, required: ["mix", "every", "buys"] },
    run: quoteTool,
  },
  {
    name: "dcac_build_plan",
    description:
      "Prepare a recurring-buy plan for the user to sign: a dcac.fun link that opens the plan prefilled, and the unsigned transactions (approve USDC, create plan). Never signs anything. Give the user the link unless they asked for raw transactions.",
    inputSchema: {
      type: "object",
      properties: {
        ...planProps,
        owner: { type: "string", description: "Optional: the wallet that will sign, to check its USDC balance and approval." },
        creator: { type: "string", description: "Optional: address of whoever shared this basket; they get part of each buy fee." },
      },
      required: ["mix", "every", "buys"],
    },
    run: buildPlanTool,
  },
  {
    name: "dcac_plans",
    description: "Every DCAC plan a wallet owns: mix, buys done, next buy, invested, holdings value, profit, budget left.",
    inputSchema: { type: "object", properties: { owner: { type: "string", description: "0x wallet address." } }, required: ["owner"] },
    run: plansTool,
  },
  {
    name: "dcac_plan",
    description: "One DCAC plan by number, with each asset's holdings, the next buy, and a link to copy the basket.",
    inputSchema: { type: "object", properties: { id: { type: ["integer", "string"], description: "Plan number." } }, required: ["id"] },
    run: planTool,
  },
  {
    name: "dcac_build_cancel",
    description: "Prepare the unsigned transaction that stops a plan and refunds its unspent USDC to the owner.",
    inputSchema: { type: "object", properties: { id: { type: ["integer", "string"], description: "Plan number." } }, required: ["id"] },
    run: buildCancelTool,
  },
] as const;

export async function runTool(name: string, args: unknown) {
  const t = TOOLS.find((x) => x.name === name || x.name === `dcac_${name}`);
  if (!t) throw new ToolError(`Unknown tool ${name}. Tools: ${TOOLS.map((x) => x.name).join(", ")}.`);
  return (t.run as (a: unknown) => Promise<unknown>)(args ?? {});
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id", "cache-control": "no-store" },
  });
