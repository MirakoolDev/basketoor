import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { getAddress, parseAbi, type PublicClient } from "viem";
import { dcacAbi } from "./abi";
import { dep, explorer } from "./config";
import { useSend, useSendTxs } from "./data";
import { money } from "./format";
import { Button, Card, Pill, Spinner, StockLogo } from "./ui";
import { SiteFooter, SiteNav } from "./Landing";
import { create2 } from "./Indexes";
import bytecode from "./deploy/bytecode.json";
import { CREATE2_DEPLOYER, twapFeedArgs } from "./deploy/plan";
import { ALL_MAINNET_ASSETS, MAINNET, type MainnetAsset } from "./deploy/mainnet";

/// Coinbase stocks with no Chainlink feed, priced instead by PoolTwapFeed from their own Aerodrome pool. This page
/// runs the feed's checks against each pool live, and lets DCAC's owner list a stock that passes: grow the pool's
/// price history if needed, deploy its feed, route it through the pool, and enable it on DCAC.
export const CANDIDATES = ALL_MAINNET_ASSETS.filter((a) => !a.chainlink && a.kind === "stock");

const T = MAINNET.twap;
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
]);
const adapterAbi = parseAbi(["function pools(address tokenIn, address tokenOut) view returns (address)", "function setPool(address tokenIn, address tokenOut, address pool)"]);

export const twapFeed = (a: MainnetAsset) => create2(`twap-feed:${a.token.toLowerCase()}`, bytecode.PoolTwapFeed, twapFeedArgs(a));

type Check = "ok" | "no-history" | "unsteady" | "spot-away" | "thin";
type Row = { a: MainnetAsset; listed: boolean; price: number; depth: number; check: Check; observations: number; routed: boolean };

const CHECK_TEXT: Record<Check, string> = {
  ok: "Passes",
  "no-history": "Pool can't report 30 minutes yet",
  unsteady: "Price moved too much in the last 30 min",
  "spot-away": "Pool price now is off its average",
  thin: `Under ${money(Number(T.minDepthUsdc) / 1e6, { digits: 0 })} to move 1%`,
};

const floorDiv = (a: bigint, b: bigint) => (a < 0n && a % b !== 0n ? a / b - 1n : a / b);

/// The same checks PoolTwapFeed makes, computed here so they can be shown before a feed exists.
async function checkPool(pc: PublicClient, a: MainnetAsset): Promise<Omit<Row, "a" | "listed" | "routed">> {
  const step = T.window / T.slices;
  const ago = Array.from({ length: T.slices + 1 }, (_, i) => T.window - i * step);
  const [slot0, L, token0, observed] = await Promise.all([
    pc.readContract({ address: a.pool, abi: poolAbi, functionName: "slot0" }),
    pc.readContract({ address: a.pool, abi: poolAbi, functionName: "liquidity" }),
    pc.readContract({ address: a.pool, abi: poolAbi, functionName: "token0" }),
    pc.readContract({ address: a.pool, abi: poolAbi, functionName: "observe", args: [ago] }).catch(() => undefined),
  ]);
  const [sqrtP, spot, , , cardNext] = slot0;
  const usdcIs0 = token0.toLowerCase() === MAINNET.usdc.toLowerCase();
  const sq = Number(sqrtP) / 2 ** 96;
  const depth = ((usdcIs0 ? Number(L) / sq : Number(L) * sq) * 0.004988) / 1e6;
  const priceAt = (tick: number) => {
    const raw = 1.0001 ** tick; // token1 per token0, raw units
    return usdcIs0 ? (1 / raw) * 10 ** (a.decimals - 6) : raw * 10 ** (a.decimals - 6);
  };
  if (!observed) return { price: priceAt(spot), depth, check: "no-history", observations: cardNext };
  const cum = observed[0];
  const means = Array.from({ length: T.slices }, (_, i) => Number(floorDiv(cum[i + 1] - cum[i], BigInt(step))));
  const median = [...means].sort((x, y) => x - y)[Math.floor((means.length - 1) / 2)];
  const far = (t: number) => Math.abs(t - median) > T.maxDeviationTicks;
  const check: Check = means.some(far) ? "unsteady" : far(spot) ? "spot-away" : depth * 1e6 < Number(T.minDepthUsdc) ? "thin" : "ok";
  return { price: priceAt(median), depth, check, observations: cardNext };
}

function useRows() {
  const pc = usePublicClient();
  return useQuery({
    queryKey: ["twap-candidates"],
    enabled: !!pc,
    refetchInterval: 60_000,
    queryFn: async (): Promise<Row[]> =>
      Promise.all(
        CANDIDATES.map(async (a) => {
          const [asset, route, c] = await Promise.all([
            pc!.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "assets", args: [a.token] }),
            pc!.readContract({ address: dep.venue, abi: adapterAbi, functionName: "pools", args: [MAINNET.usdc, a.token] }),
            checkPool(pc as PublicClient, a),
          ]);
          return { a, listed: asset[3], routed: getAddress(route) === getAddress(a.pool), ...c };
        }),
      ),
  });
}

export function ListStocks() {
  const rows = useRows();
  const { address } = useAccount();
  const owner = useReadContract({ address: dep.dcac, abi: dcacAbi, functionName: "owner" });
  const isOwner = !!address && !!owner.data && address.toLowerCase() === (owner.data as string).toLowerCase();
  const data = rows.data ?? [];
  const order: Record<Check, number> = { ok: 0, thin: 1, unsteady: 2, "spot-away": 3, "no-history": 4 };
  const sorted = [...data].sort((x, y) => Number(x.listed) - Number(y.listed) || order[x.check] - order[y.check] || y.depth - x.depth);
  const ready = data.filter((r) => !r.listed && r.check === "ok").length;

  return (
    <div className="min-h-dvh">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <div className="mb-1 font-mono text-xs tracking-widest text-faint uppercase">More stocks</div>
        <h1 className="headline text-[34px]">Stocks priced from their own market</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          These Coinbase stocks have no Chainlink feed. DCAC can price them from a 30-minute average of their Aerodrome pool, but only when that
          average can be trusted: every 5-minute slice and the price now within about 1.5% of the median, and at least{" "}
          {money(Number(T.minDepthUsdc) / 1e6, { digits: 0 })} needed to move the pool 1%. A stock that fails a check at buy time is skipped and
          retried; its USDC stays in the basket. The price is the token's onchain market price, which can drift from the exchange.
        </p>

        {rows.isLoading ? (
          <Spinner />
        ) : rows.error ? (
          <Card className="mt-6">Couldn't read the pools on Base. Try again in a moment.</Card>
        ) : (
          <>
            <div className="mt-6 text-sm text-muted">
              {data.filter((r) => r.listed).length} listed · {ready} ready to list · {data.length} in all
            </div>
            <div className="mt-3 space-y-2">
              {sorted.map((r) => (
                <StockRow key={r.a.token} r={r} isOwner={isOwner} onDone={() => rows.refetch()} />
              ))}
            </div>
          </>
        )}
        <p className="mt-6 text-xs text-faint">
          Checks run live in your browser against Base, the same way the price contract runs them on every buy. Contract:{" "}
          <a className="underline underline-offset-2" href="https://github.com/MirakoolDev/basketoor/blob/main/contracts/src/feeds/PoolTwapFeed.sol" target="_blank" rel="noreferrer">
            PoolTwapFeed.sol
          </a>
          . Not audited since the fix for the re-audit's findings 1 and 6.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function StockRow({ r, isOwner, onDone }: { r: Row; isOwner: boolean; onDone: () => void }) {
  const send = useSend();
  const sendTxs = useSendTxs();
  const pc = usePublicClient();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const feed = twapFeed(r.a);

  /// Owner only. Each step is skipped when it's already done, so a half-finished listing can be resumed.
  async function list() {
    setError(undefined);
    try {
      if (r.observations < T.observations) {
        setBusy("Growing price history…");
        await send([{ address: r.a.pool, abi: poolAbi, functionName: "increaseObservationCardinalityNext", args: [T.observations] }]);
      }
      const code = await pc?.getCode({ address: feed.address });
      if (!code || code === "0x") {
        setBusy("Deploying price feed…");
        await sendTxs([{ to: CREATE2_DEPLOYER, data: feed.data }]);
      }
      if (!r.routed) {
        setBusy("Routing through its pool…");
        await send([{ address: dep.venue, abi: adapterAbi, functionName: "setPool", args: [MAINNET.usdc, r.a.token, r.a.pool] }]);
      }
      setBusy("Listing…");
      await send([{ address: dep.dcac, abi: dcacAbi, functionName: "setAsset", args: [r.a.token, feed.address, true] }]);
      onDone();
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0]);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <StockLogo symbol={r.a.symbol} token={r.a.token} kind="stock" size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-semibold">
            {r.a.symbol}c
            {r.listed ? <Pill tone="up">● listed</Pill> : r.check === "ok" ? <Pill tone="brand">ready</Pill> : <Pill>{CHECK_TEXT[r.check]}</Pill>}
          </div>
          <div className="truncate text-xs text-muted">{r.a.name}</div>
        </div>
        <div className="num w-24 text-right text-sm">
          <div className="font-semibold">{money(r.price)}</div>
          <div className="text-[11px] text-faint">pool price</div>
        </div>
        <div className="num w-28 text-right text-sm">
          <div className={r.depth * 1e6 >= Number(T.minDepthUsdc) ? "" : "text-muted"}>{money(r.depth, { digits: 0 })}</div>
          <div className="text-[11px] text-faint">to move it 1%</div>
        </div>
        {isOwner && !r.listed && (
          <Button className="w-full sm:w-auto" onClick={list} disabled={!!busy || r.check !== "ok"}>
            {busy ?? "List"}
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      {isOwner && !r.listed && r.check === "ok" && (
        <p className="mt-2 text-[11px] text-faint">
          {[
            r.observations < T.observations && `grow the pool's history to ${T.observations} (one transaction, the pool's own function)`,
            "deploy its price feed",
            !r.routed && "route it through its pool",
            "enable it on DCAC",
          ]
            .filter(Boolean)
            .join(" → ")}
          {explorer && (
            <>
              {" · "}
              <a className="underline underline-offset-2" href={`${explorer}/address/${r.a.pool}`} target="_blank" rel="noreferrer">
                pool ↗
              </a>
            </>
          )}
        </p>
      )}
    </Card>
  );
}

