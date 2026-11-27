import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbiParameters, toHex, type Address, type Hex } from "viem";
import { dcacAbi } from "./abi";
import { dep } from "./config";
import { useSend, useSendTxs, useStocks, useUsdc, usd } from "./data";
import { money, pct, short } from "./format";
import { Button, Card, Pill, Spinner, StockLogo } from "./ui";
import { Connect, SiteFooter, SiteNav } from "./Landing";
import { go } from "./App";
import bytecode from "./deploy/bytecode.json";
import { CREATE2_DEPLOYER } from "./deploy/plan";
import {
  BANKR,
  blockerText,
  buildCreate,
  quoteCreate,
  tickerFree,
  useComponents,
  useIndex,
  useIndexes,
  type Component,
  type CreateBody,
  type IndexSummary,
  type Quote,
} from "./bankr";

// ---------------------------------------------------------------- owner wiring (CREATE2, so addresses are known)

const create2 = (label: string, code: string, args: Hex) => {
  const salt = keccak256(toHex(`dcac:${label}`));
  const initCode = concat([code as Hex, args]);
  return { address: getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode }), data: concat([salt, initCode]) };
};
const ROUTER = create2(
  "bankr-index-router",
  bytecode.BankrIndexRouter,
  encodeAbiParameters(parseAbiParameters("address, address, address, address, address"), [dep.venue, BANKR.poolManager, BANKR.factory, BANKR.hook, dep.usdc]),
);
const navFeed = (index: Address) =>
  create2(`bankr-index-feed:${index.toLowerCase()}`, bytecode.BankrIndexNavFeed, encodeAbiParameters(parseAbiParameters("address, address"), [BANKR.lens, index]));

/// DCAC's owner, whether the index router is DCAC's venue yet, and which tokens are listed.
function useOwnerState() {
  const { address } = useAccount();
  const owner = useReadContract({ address: dep.dcac, abi: dcacAbi, functionName: "owner" });
  const adapter = useReadContract({ address: dep.dcac, abi: dcacAbi, functionName: "swapAdapter" });
  const isOwner = !!address && !!owner.data && address.toLowerCase() === (owner.data as string).toLowerCase();
  const routerOn = !!adapter.data && (adapter.data as string).toLowerCase() === ROUTER.address.toLowerCase();
  return { isOwner, routerOn, refetch: adapter.refetch };
}

function useListed() {
  const stocks = useStocks();
  return useMemo(() => new Set((stocks.data ?? []).filter((s) => s.kind === "index").map((s) => s.token.toLowerCase())), [stocks.data]);
}

const sendRaw = (to: Address, data: Hex) => ({ to, data });

// ---------------------------------------------------------------- list

/// Index tokens on Base, built on Bankr: one token backed by a basket of stocks and crypto it holds, redeemable
/// for that basket at any time. Create one here, buy any listed one on a schedule, or launch a token paired with it.
export function Indexes() {
  const list = useIndexes();
  const listed = useListed();
  const [kind, setKind] = useState<"all" | "stocks" | "tokens" | "mixed">("all");
  const rows = (list.data ?? []).filter((i) => kind === "all" || i.kind === kind);

  return (
    <div className="min-h-dvh">
      <SiteNav />
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div className="mb-1 font-mono text-xs tracking-widest text-faint uppercase">Indexes</div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="headline text-[34px]">One token. A whole basket.</h1>
          <a href="#/indexes/new" className="grid h-10 place-items-center rounded-full bg-ink px-5 text-sm font-medium text-bg transition-opacity duration-150 hover:opacity-90">
            Create an index
          </a>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          An index is a token backed by the stocks and crypto it holds. Buying it buys the basket; anyone can redeem it for the basket at any time. Create
          one and earn a share of its trading fee, buy one on a schedule with DCAC, or launch your own token paired with it on Bankr. Indexes run on{" "}
          <a href={BANKR.docs} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            Bankr's index contracts
          </a>
          .
        </p>

        <div className="mt-6 flex gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-line sm:w-fit">
          {(["all", "stocks", "mixed", "tokens"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`h-8 flex-1 whitespace-nowrap rounded-md px-3 text-sm font-medium capitalize transition-colors duration-150 ${kind === k ? "bg-surface text-ink" : "text-muted hover:text-ink"}`}
            >
              {k === "tokens" ? "Crypto" : k}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {list.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <Card>Couldn't load indexes from Bankr. Try again in a moment.</Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {rows.map((i) => (
                <IndexCard key={i.address} i={i} onDcac={listed.has(i.address.toLowerCase())} />
              ))}
            </div>
          )}
        </div>
        <p className="mt-6 text-xs text-faint">
          Indexes are created and held through Bankr's contracts; DCAC doesn't custody them. Backing is the basket's value at Bankr's prices. Not
          available to US persons. Not investment advice.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function IndexCard({ i, onDcac }: { i: IndexSummary; onDcac: boolean }) {
  return (
    <button onClick={() => go(`/indexes/${i.address}`)} className="text-left">
      <Card className="h-full transition-shadow duration-150 hover:ring-faint">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <IndexIcon i={i} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{i.name}</div>
              <div className="font-mono text-xs text-muted">${i.symbol}</div>
            </div>
          </div>
          <div className="text-right">
            <div className={`num text-sm font-semibold ${(i.change24hPct ?? 0) >= 0 ? "text-up" : "text-down"}`}>{pct((i.change24hPct ?? 0) / 100)}</div>
            <div className="text-[11px] text-faint">24h</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {i.componentsPreview.map((c) => (
            <span key={c.symbol} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted ring-1 ring-line">
              {c.symbol}
            </span>
          ))}
          {i.componentCount > i.componentsPreview.length && <span className="px-1 text-[11px] text-faint">+{i.componentCount - i.componentsPreview.length}</span>}
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
          <span className="num">{money(i.navUsd)} backing</span>
          {onDcac ? <Pill tone="brand">Recurring buys on DCAC</Pill> : <span className="capitalize text-faint">{i.kind === "tokens" ? "crypto" : i.kind}</span>}
        </div>
      </Card>
    </button>
  );
}

function IndexIcon({ i }: { i: { imageUrl: string | null; symbol: string } }) {
  const [bad, setBad] = useState(false);
  return i.imageUrl && !bad ? (
    <img src={i.imageUrl} alt="" onError={() => setBad(true)} className="h-10 w-10 shrink-0 rounded-full object-cover" />
  ) : (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 font-mono text-xs font-semibold ring-1 ring-line">{i.symbol.slice(0, 4)}</div>
  );
}

// ---------------------------------------------------------------- one index

export function IndexPage({ address }: { address: Address }) {
  const ix = useIndex(address);
  const listed = useListed();
  const onDcac = listed.has(address.toLowerCase());
  const own = useOwnerState();
  const send = useSend();
  const sendTxs = useSendTxs();
  const pc = usePublicClient();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  /// Deploys through the CREATE2 deployer unless the contract is already there.
  const ensure = async (c: { address: Address; data: Hex }) => {
    const code = await pc?.getCode({ address: c.address });
    if (!code || code === "0x") await sendTxs([sendRaw(CREATE2_DEPLOYER, c.data)]);
  };

  const i = ix.data;
  const recurring = () => {
    const q = new URLSearchParams({ mix: `${getAddress(address)}:10`, every: String(7 * 86400), name: `${i?.symbol ?? "Index"} weekly` });
    go(`/new?${q}`);
  };

  /// Owner only: deploy this index's price feed (if needed) and list it on DCAC; turns on the router first.
  async function list() {
    setError(undefined);
    try {
      if (!own.routerOn) {
        setBusy("Turning on index buys…");
        await ensure(ROUTER);
        await send([{ address: dep.dcac, abi: dcacAbi, functionName: "setSwapAdapter", args: [ROUTER.address] }]);
        await own.refetch();
      }
      setBusy("Listing…");
      const feed = navFeed(address);
      await ensure(feed);
      await send([{ address: dep.dcac, abi: dcacAbi, functionName: "setAsset", args: [address, feed.address, true] }]);
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="min-h-dvh">
      <SiteNav />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <a href="#/indexes" className="text-sm text-muted hover:text-ink">
          ← Indexes
        </a>
        {ix.isLoading ? (
          <Spinner />
        ) : !i ? (
          <Card className="mt-4">Index not found.</Card>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-4">
              <IndexIcon i={i} />
              <div className="min-w-0">
                <h1 className="headline truncate text-[30px]">{i.name}</h1>
                <div className="font-mono text-sm text-muted">
                  ${i.symbol} · by {short(i.creator)}
                </div>
              </div>
            </div>
            {i.description && <p className="text-sm text-muted">{i.description}</p>}

            <div className="grid grid-cols-3 gap-2">
              <Stat label="Price" value={money(i.navPerShareUsd, { digits: i.navPerShareUsd < 1 ? 4 : 2 })} />
              <Stat label="Backing" value={money(i.navUsd)} />
              <Stat label="Fee per trade" value={`${(i.feeBps / 100).toFixed(2)}%`} />
            </div>

            <Card>
              <div className="mb-3 text-sm font-semibold">Basket</div>
              <div className="space-y-2">
                {i.components.map((c) => (
                  <div key={c.address} className="flex items-center gap-2 text-sm">
                    <StockLogo symbol={c.symbol.replace(/c$/, "")} token={c.address} kind={c.isStock ? "stock" : "crypto"} size={22} />
                    <span className="w-20 truncate font-medium">{c.symbol}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-brand-ink" style={{ width: `${c.currentBps / 100}%` }} />
                    </div>
                    <span className="num w-24 text-right text-xs text-muted">
                      {(c.currentBps / 100).toFixed(1)}% <span className="text-faint">/ {(c.targetBps / 100).toFixed(0)}%</span>
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-faint">
                Now / target weight. Rebalancing: {i.rebalance.mode === "auto" ? (i.rebalance.rule === "monthly" ? "automatic, monthly" : "automatic, on drift") : i.rebalance.mode}.
              </p>
            </Card>

            <div className="grid gap-2 sm:grid-cols-3">
              {onDcac ? (
                <Button onClick={recurring}>Buy every week</Button>
              ) : own.isOwner ? (
                <Button onClick={list} disabled={!!busy}>
                  {busy ?? "List on DCAC"}
                </Button>
              ) : (
                <Button disabled variant="ghost">
                  Recurring buys soon
                </Button>
              )}
              <a href={BANKR.trade(i.address)} target="_blank" rel="noreferrer" className="grid h-11 place-items-center rounded-full bg-surface text-sm font-medium ring-1 ring-line hover:ring-faint">
                Buy or sell on Bankr ↗
              </a>
              <a href={BANKR.launchDocs} target="_blank" rel="noreferrer" className="grid h-11 place-items-center rounded-full bg-surface text-sm font-medium ring-1 ring-line hover:ring-faint">
                Launch a token on it ↗
              </a>
            </div>
            {error && <p className="text-sm text-down">{error}</p>}
            <p className="text-xs text-faint">
              Launching a token paired with this index makes its pool trade against the index, so the creator's pool fees arrive as {i.symbol}. On Bankr:
              Launch a token → Pool Pairing → Indexes. Recurring buys go through the index's own pool, at its basket value plus its fee.
            </p>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="py-3">
      <div className="text-[11px] text-faint">{label}</div>
      <div className="num mt-0.5 font-semibold">{value}</div>
    </Card>
  );
}

// ---------------------------------------------------------------- create

const FEES = [25, 50, 75, 100];

/// Create a Bankr index from the connected wallet: Bankr's API prepares the approval and the create call, the
/// wallet signs them, and the wallet becomes the index's creator (it earns the creator's share of the fee).
export function CreateIndex() {
  const { address: account, isConnected } = useAccount();
  const comps = useComponents();
  const usdc = useUsdc();
  const sendTxs = useSendTxs();

  const [tab, setTab] = useState<"stocks" | "tokens">("stocks");
  const [picked, setPicked] = useState<Address[]>([]);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [feeBps, setFeeBps] = useState(50);
  const [rebalance, setRebalance] = useState<"auto" | "off">("auto");
  const [firstBuy, setFirstBuy] = useState("105");
  const [quote, setQuote] = useState<Quote>();
  const [symbolOk, setSymbolOk] = useState<boolean>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const all = useMemo(() => [...(comps.data?.stocks ?? []), ...(comps.data?.tokens ?? [])], [comps.data]);
  const byAddr = useMemo(() => new Map(all.map((c) => [c.address.toLowerCase(), c])), [all]);
  const toggle = (a: Address) => {
    setPicked((p) => (p.includes(a) ? p.filter((x) => x !== a) : p.length >= 20 ? p : [...p, a]));
  };
  const even = () => {
    const n = picked.length;
    if (!n) return;
    const base = Math.floor(100 / n);
    setWeights(Object.fromEntries(picked.map((a, k) => [a, String(k === 0 ? 100 - base * (n - 1) : base)])));
  };
  useEffect(even, [picked.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const bps = picked.map((a) => Math.round(Number(weights[a] || 0) * 100));
  const total = bps.reduce((s, x) => s + x, 0);
  const firstRaw = BigInt(Math.round(Number(firstBuy || 0) * 1e6));
  const body: CreateBody | undefined =
    account && picked.length >= 2 && total === 10_000 && name.trim() && /^[A-Za-z0-9]{2,10}$/.test(symbol)
      ? {
          account,
          name: name.trim(),
          symbol: symbol.toUpperCase(),
          components: picked.map((a, k) => ({ address: a, weightBps: bps[k] })),
          rebalance: rebalance === "auto" ? { mode: "auto", rule: "monthly", driftBps: 0 } : { mode: "off", rule: "none", driftBps: 0 },
          firstBuy: { token: "stable", amountRaw: firstRaw.toString() },
          fees: { feeBps, holderShareBps: 0 },
        }
      : undefined;
  const key = JSON.stringify(body ?? null);

  useEffect(() => {
    setQuote(undefined);
    if (!body) return;
    const t = setTimeout(() => quoteCreate(body).then(setQuote, (e) => setError((e as Error).message)), 500);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSymbolOk(undefined);
    if (!/^[A-Za-z0-9]{2,10}$/.test(symbol)) return;
    const t = setTimeout(() => tickerFree(symbol.toUpperCase()).then((r) => setSymbolOk(r.available ?? r.free ?? true), () => undefined), 400);
    return () => clearTimeout(t);
  }, [symbol]);

  const balance = usdc.data?.balance ?? 0n;
  const problem = !picked.length
    ? "Pick at least two assets"
    : picked.length < 2
      ? "Pick at least two assets"
      : picked.some((_, k) => bps[k] < 100)
        ? "Each asset needs at least 1%"
        : total !== 10_000
          ? `Weights add up to ${total / 100}%, not 100%`
          : !name.trim()
            ? "Name your index"
            : !/^[A-Za-z0-9]{2,10}$/.test(symbol)
              ? "Ticker: 2 to 10 letters or digits"
              : symbolOk === false
                ? "That ticker is taken"
                : firstRaw < 100_000_000n
                  ? "The first buy must be at least $100"
                  : firstRaw + 2_000_000n > balance
                    ? `Not enough USDC: needs about ${money(usd(firstRaw + 2_000_000n))}`
                    : quote?.blockers.length
                      ? blockerText(quote.blockers[0])
                      : !quote
                        ? "Checking with Bankr…"
                        : undefined;

  async function submit() {
    if (!body) return;
    setError(undefined);
    try {
      setBusy("Preparing…");
      const built = await buildCreate(body);
      if (built.blockers?.length) throw new Error(blockerText(built.blockers[0]));
      await sendTxs(
        built.transactions.map((t) => ({ to: t.to, data: t.data, value: BigInt(t.value || "0x0") })),
        (k) => setBusy(k === 0 && built.transactions.length > 1 ? "Approve USDC in your wallet…" : "Create the index in your wallet…"),
      );
      go(`/indexes/${built.indexAddress}`);
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(undefined);
    }
  }

  const shown = (tab === "stocks" ? comps.data?.stocks : comps.data?.tokens)?.filter((c) => c.eligible && c.symbol !== "USDC") ?? [];

  return (
    <div className="min-h-dvh">
      <SiteNav />
      <main className="mx-auto max-w-md px-4 py-10">
        <a href="#/indexes" className="text-sm text-muted hover:text-ink">
          ← Indexes
        </a>
        <h1 className="headline mt-3 text-[30px]">Create an index</h1>
        <p className="mt-1 text-sm text-muted">
          Pick 2 to 20 assets and their weights. Your index becomes a token anyone can buy, sell or redeem for the basket, and you earn a share of
          its fee on every trade.
        </p>

        {!isConnected ? (
          <Card className="mt-4">
            <p className="mb-4 text-sm text-muted">Sign in with the wallet that will create the index.</p>
            <Connect />
          </Card>
        ) : (
          <div className="mt-4 space-y-4">
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-line">
                  {(["stocks", "tokens"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setTab(k)}
                      className={`h-8 rounded-md px-3 text-sm font-medium transition-colors duration-150 ${tab === k ? "bg-surface text-ink" : "text-muted hover:text-ink"}`}
                    >
                      {k === "stocks" ? "Stocks" : "Crypto"}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-xs text-muted">{picked.length}/20</span>
              </div>
              {comps.isLoading ? (
                <Spinner />
              ) : (
                <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
                  {shown.map((c) => (
                    <Pick key={c.address} c={c} on={picked.includes(c.address)} onClick={() => toggle(c.address)} />
                  ))}
                </div>
              )}
            </Card>

            {picked.length > 0 && (
              <Card>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold">Weights</div>
                  <button onClick={even} className="text-xs text-muted hover:text-ink">
                    Split evenly
                  </button>
                </div>
                <div className="space-y-2">
                  {picked.map((a) => {
                    const c = byAddr.get(a.toLowerCase());
                    return (
                      <div key={a} className="flex items-center gap-2">
                        <StockLogo symbol={(c?.symbol ?? "?").replace(/c$/, "")} token={a} kind={c?.isStock ? "stock" : "crypto"} size={22} />
                        <span className="flex-1 truncate text-sm font-medium">{c?.symbol}</span>
                        <input
                          value={weights[a] ?? ""}
                          onChange={(e) => setWeights((w) => ({ ...w, [a]: e.target.value.replace(/[^\d.]/g, "") }))}
                          inputMode="decimal"
                          className="num h-9 w-16 rounded-lg bg-bg px-2 text-right text-sm ring-1 ring-line outline-none focus:ring-brand-ink"
                        />
                        <span className="text-sm text-muted">%</span>
                      </div>
                    );
                  })}
                </div>
                <div className={`mt-2 text-right text-xs ${total === 10_000 ? "text-muted" : "text-down"}`}>Total {total / 100}%</div>
              </Card>
            )}

            <Card className="space-y-3">
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} placeholder="AI Chips" className={inputCls} />
              </Field>
              <Field label="Ticker" hint={symbolOk === false ? "Taken" : symbolOk ? "Available" : undefined}>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase())} placeholder="CHIPS" className={`${inputCls} font-mono`} />
              </Field>
              <Field label="Fee per trade" hint="Bankr keeps 40% of it; the rest is yours. DCAC's recurring buys need 0.50% or less.">
                <div className="flex gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-line">
                  {FEES.map((f) => (
                    <button key={f} onClick={() => setFeeBps(f)} className={`h-8 flex-1 rounded-md text-sm font-medium ${feeBps === f ? "bg-surface text-ink" : "text-muted hover:text-ink"}`}>
                      {(f / 100).toFixed(2)}%
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Rebalancing" hint={rebalance === "auto" ? "Brought back to your weights every month, through public auctions." : "Weights drift with prices."}>
                <div className="flex gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-line">
                  {(["auto", "off"] as const).map((r) => (
                    <button key={r} onClick={() => setRebalance(r)} className={`h-8 flex-1 rounded-md text-sm font-medium ${rebalance === r ? "bg-surface text-ink" : "text-muted hover:text-ink"}`}>
                      {r === "auto" ? "Monthly" : "Off"}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Your first buy (USDC)" hint="At least $100. Your own index tokens are locked for 24 hours.">
                <input value={firstBuy} onChange={(e) => setFirstBuy(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className={`${inputCls} num`} />
              </Field>
            </Card>

            {quote && !quote.blockers.length && (
              <Card className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">You get</span>
                  <span className="num">
                    {(Number(quote.sharesOut) / 1e18).toFixed(2)} {symbol}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Your share of each trade</span>
                  <span className="num">{(quote.fees.creatorBps / 100).toFixed(2)}%</span>
                </div>
                {quote.warnings.map((w) => (
                  <p key={w.code} className="text-xs text-warn">
                    {blockerText(w)}
                  </p>
                ))}
              </Card>
            )}

            {error && <p className="text-center text-sm text-down">{error}</p>}
            <Button className="w-full" disabled={!!problem || !!busy} onClick={submit}>
              {busy ?? problem ?? `Create ${symbol} · ${money(usd(firstRaw))}`}
            </Button>
            <p className="text-center text-xs text-faint">Created through Bankr's index contracts. Your wallet signs; DCAC never holds your funds.</p>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

const inputCls = "h-10 w-full rounded-lg bg-bg px-3 text-sm ring-1 ring-line outline-none placeholder:text-faint focus:ring-brand-ink";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-faint">{hint}</div>}
    </label>
  );
}

function Pick({ c, on, onClick }: { c: Component; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg bg-surface-2 p-2 text-left transition duration-150 ${on ? "ring-2 ring-brand-ink" : "ring-1 ring-line hover:ring-faint"}`}
    >
      <StockLogo symbol={c.symbol.replace(/c$/, "")} token={c.address} kind={c.isStock ? "stock" : "crypto"} src={c.imageUrl ?? undefined} size={26} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{c.symbol}</div>
        <div className="truncate text-[11px] text-muted">{c.name}</div>
      </div>
      {on && <span className="text-brand-ink">✓</span>}
    </button>
  );
}
