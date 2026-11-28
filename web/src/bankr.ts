import { useQuery } from "@tanstack/react-query";
import { parseAbi, type Address, type Hex } from "viem";

/// Bankr index tokens on Base: ERC-20s backed by a basket they hold, minted through their own Uniswap v4 pool
/// and redeemable for the basket at any time. DCAC creates them through Bankr's API (the user's wallet signs)
/// and buys them on a schedule once listed. Docs: https://docs.bankr.bot/token-launching/index-tokens
export const BANKR = {
  api: "https://api.bankr.bot",
  factory: "0x49a3A6D33110425099A9f070d22f576f592b46eB" as Address,
  hook: "0x2Fd0ba044Faa96A9d1B0f010C0Dac3F696aA2888" as Address,
  lens: "0x0E19BDeB4EF2443413926b9Daa72E484f63BB72b" as Address,
  poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Address,
  docs: "https://docs.bankr.bot/token-launching/index-tokens",
  launchDocs: "https://docs.bankr.bot/token-launching/index-paired-launches",
  trade: (index: string) => `https://bankr.bot/trade?out=${index}&chain=base`,
  app: "https://bankr.bot",
};

export const bankrAbi = parseAbi([
  "function isVault(address vault) view returns (bool)",
  "function navUsdE18(address vault) view returns (uint256 nav, uint256 circulating, uint256 navPerShareE18, bool complete)",
  "function feeBpsOf(address vault) view returns (uint16)",
]);

export type IndexSummary = {
  address: Address;
  name: string;
  symbol: string;
  imageUrl: string | null;
  kind: "stocks" | "tokens" | "mixed";
  componentCount: number;
  componentsPreview: { symbol: string }[];
  strengthUsd: number;
  navUsd: number;
  change24hPct: number | null;
  vol24hUsd: number;
  creator: Address;
  createdAt: string;
  tradingPaused: boolean;
};

export type IndexDetail = IndexSummary & {
  description: string | null;
  navPerShareUsd: number;
  feeBps: number;
  fees: { totalBps: number; bankrBps: number; creatorBps: number; holdersBps: number };
  rebalance: { mode: "off" | "manual" | "auto"; rule: string; driftBps: number };
  status: { buysBlocked: string | null; sellsBlocked: string | null; marketOpen: boolean; navStale: boolean };
  components: {
    address: Address;
    symbol: string;
    name: string;
    decimals: number;
    isStock: boolean;
    targetBps: number;
    currentBps: number;
    balanceRaw: string; // what the index holds, raw units
    valueUsd: number;
    priceUsd: number;
    priceSource: string; // e.g. chainlink, signed
  }[];
};

export type Component = {
  address: Address;
  symbol: string;
  name: string;
  imageUrl: string | null;
  isStock: boolean;
  depth2PctUsd: number;
  eligible: boolean;
  refusal: string | null;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BANKR.api}${path}`);
  if (!r.ok) throw new Error(`Bankr API ${r.status}`);
  return r.json() as Promise<T>;
}

export function useIndexes() {
  return useQuery({
    queryKey: ["bankr-indexes"],
    staleTime: 60_000,
    queryFn: async () => {
      const all: IndexSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const j = await get<{ items: IndexSummary[]; nextCursor?: string | null }>(
          `/indexes?chain=base&sort=strength&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        all.push(...j.items);
        if (!j.nextCursor) break;
        cursor = j.nextCursor;
      }
      return all;
    },
  });
}

export function useIndex(address: string | undefined) {
  return useQuery({
    queryKey: ["bankr-index", address],
    enabled: !!address,
    staleTime: 30_000,
    queryFn: () => get<IndexDetail>(`/indexes/${address}?chain=base`),
  });
}

export function useComponents() {
  return useQuery({
    queryKey: ["bankr-components"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [stocks, tokens] = await Promise.all([
        get<{ components: Component[] }>("/indexes/components?chain=base&kind=stocks"),
        get<{ components: Component[] }>("/indexes/components?chain=base&kind=tokens"),
      ]);
      return { stocks: stocks.components, tokens: tokens.components };
    },
  });
}

export type CreateBody = {
  account: Address;
  name: string;
  symbol: string;
  components: { address: Address; weightBps: number }[];
  rebalance: { mode: "off" | "manual" | "auto"; rule: "none" | "monthly" | "drift"; driftBps: number };
  firstBuy: { token: "stable"; amountRaw: string };
  fees: { feeBps: number; holderShareBps: number };
};

export type Blocker = { code: string; [k: string]: unknown };
export type Quote = {
  sharesOut: string;
  blockers: Blocker[];
  warnings: { code: string; [k: string]: unknown }[];
  fees: { totalBps: number; bankrBps: number; creatorBps: number; holdersBps: number };
};
export type Built = {
  transactions: { to: Address; data: Hex; value: Hex; chainId: number; description: string }[];
  indexAddress: Address;
  sharesOut: string;
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BANKR.api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !(j && (j as { blockers?: unknown }).blockers)) {
    const details = (j as { details?: { message: string }[] }).details;
    throw new Error(details?.[0]?.message ?? (j as { error?: string }).error ?? `Bankr API ${r.status}`);
  }
  return j as T;
}

export const quoteCreate = (b: CreateBody) => post<Quote>("/indexes/quote-create", { chain: "base", ...b });
export const buildCreate = (b: CreateBody) => post<Built & { blockers?: Blocker[] }>("/indexes/build-create", { chain: "base", ...b });
export const tickerFree = (symbol: string) =>
  get<{ available?: boolean; free?: boolean; reason?: string }>(`/indexes/ticker?chain=base&ticker=${encodeURIComponent(symbol)}`);

/// Plain-language text for Bankr's create blockers.
export function blockerText(b: Blocker): string {
  switch (b.code) {
    case "SEED_BELOW_FLOOR":
      return `The first buy must be worth at least $${b.floorUsd ?? 100}.`;
    case "COMPONENT_REFUSED":
      return `${b.symbol ?? "One asset"} can't go in an index yet (${String(b.refusal ?? "refused").replace(/_/g, " ")}).`;
    case "TICKER_TAKEN":
    case "SYMBOL_TAKEN":
      return "That ticker is taken.";
    default:
      return b.code
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/^./, (c) => c.toUpperCase());
  }
}
