import { useEffect, useMemo, useState } from "react";
import { maxUint256, type Address } from "viem";
import { basketoorAbi, erc20Abi } from "./abi";
import { dep, FREQUENCIES } from "./config";
import { usePlan, useProtocol, useSend, useStocks, useUsdc, usd } from "./data";
import { date, money } from "./format";
import { BottomBar, Button, Card, Pill, Row, Spinner, StockLogo } from "./ui";
import { go } from "./App";
import { useTokenList, type ListToken } from "./tokens";
import { COINBASE_STOCKS } from "./coinbaseStocks";

const MAX = 5;
const BUY_PRESETS = [7, 30, 90];

export function PlanForm({ editId }: { editId?: bigint }) {
  const stocks = useStocks();
  const protocol = useProtocol();
  const usdc = useUsdc();
  const existing = usePlan(editId ?? 0n);
  const editing = editId !== undefined;
  const plan = editing ? existing.data : undefined;
  const send = useSend();

  const [selected, setSelected] = useState<Address[]>([]);
  const [kind, setKind] = useState<"stock" | "crypto">("stock");
  const [query, setQuery] = useState("");
  const tokenList = useTokenList();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [interval, setInterval] = useState(86400);
  const [buys, setBuys] = useState("30");
  const [savings, setSavings] = useState(true);
  const [smart, setSmart] = useState(false);
  const [name, setName] = useState("");
  const [notUs, setNotUs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  // Prefill when modifying.
  useEffect(() => {
    if (!plan || loaded) return;
    setSelected(plan.legs.map((l) => l.token));
    setAmounts(Object.fromEntries(plan.legs.map((l) => [l.token, l.amount > 0n ? String(usd(l.amount)) : "0"])));
    setInterval(plan.interval);
    setBuys(String(plan.maxBuys - plan.buysDone));
    setName(plan.name);
    setSavings(plan.savings);
    setSmart(plan.smart);
    setLoaded(true);
  }, [plan, loaded]);

  const locked = new Set(plan?.legs.map((l) => l.token) ?? []); // existing legs can be set to 0, not removed

  const toggle = (t: Address) => {
    if (locked.has(t)) return;
    setSelected((s) => (s.includes(t) ? s.filter((x) => x !== t) : s.length >= MAX ? s : [...s, t]));
    setAmounts((a) => ({ ...a, [t]: a[t] ?? "5" }));
  };

  const minLeg = protocol.data ? usd(protocol.data.minLegAmount) : 1;
  const parsed = selected.map((t) => {
    const n = Number(amounts[t] ?? 0);
    return { token: t, usd: Number.isFinite(n) ? n : 0, raw: BigInt(Math.round((Number.isFinite(n) ? n : 0) * 1e6)) };
  });
  const perBuy = parsed.reduce((s, p) => s + p.raw, 0n);
  const buysN = Math.max(0, Math.floor(Number(buys) || 0));

  const feeBps = plan?.feeBps ?? protocol.data?.feeBps ?? 50;
  const minFee = plan?.minFee ?? protocol.data?.minFee ?? 100_000n;
  const feePerBuy = perBuy === 0n ? 0n : (perBuy * BigInt(feeBps)) / 10_000n > minFee ? (perBuy * BigInt(feeBps)) / 10_000n : minFee;
  const required = (perBuy + feePerBuy) * BigInt(buysN);
  const delta = editing && plan ? required - plan.principal : required; // + pull, - refund
  const effectiveFee = perBuy > 0n ? Number(feePerBuy) / Number(perBuy) : 0;
  const endsAt = Math.floor(Date.now() / 1000) + interval * Math.max(0, buysN - 1);

  const tooSmall = parsed.some((p) => p.raw > 0n && p.usd < minLeg);
  const balance = usdc.data?.balance ?? 0n;
  const needs = delta > 0n ? delta : 0n;
  const problem = !selected.length
    ? "Pick at least one asset"
    : perBuy === 0n
      ? "Set an amount"
      : tooSmall
        ? `Each asset needs at least ${money(minLeg)} per buy`
        : buysN < 1
          ? "Set the number of buys"
          : needs > balance
            ? `Not enough USDC: needs ${money(usd(needs))}`
            : !editing && !notUs
              ? "Confirm you're not a US person"
              : undefined;

  const stockBy = useMemo(() => new Map(stocks.data?.map((s) => [s.token, s])), [stocks.data]);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const tokens = parsed.map((p) => p.token);
      const amts = parsed.map((p) => p.raw);
      const calls = [];
      if (needs > 0n && (usdc.data?.allowance ?? 0n) < needs)
        calls.push({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [dep.basketoor, maxUint256] as const });
      if (editing && plan) {
        calls.push({
          address: dep.basketoor,
          abi: basketoorAbi,
          functionName: "updatePlan",
          args: [plan.id, name, tokens, amts, BigInt(interval), plan.buysDone + buysN, needs] as const, // never pull more than shown
        });
        if (smart !== plan.smart)
          calls.push({ address: dep.basketoor, abi: basketoorAbi, functionName: "setSmartBuys", args: [plan.id, smart] as const });
      } else {
        calls.push({
          address: dep.basketoor,
          abi: basketoorAbi,
          functionName: "createPlan",
          args: [name || defaultName(tokens.map((t) => stockBy.get(t)?.symbol ?? "")), tokens, amts, BigInt(interval), buysN, savings, smart, needs] as const, // never pull more than shown
        });
      }
      await send(calls as never);
      go(editing ? `/plan/${editId}` : "/");
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const isAddr = /^0x[0-9a-f]{40}$/.test(q);
  const matches = (sym: string, nm: string, addr: string) =>
    isAddr ? addr.toLowerCase() === q : sym.toLowerCase().includes(q) || nm.toLowerCase().includes(q);
  const listedMatches = q ? (stocks.data ?? []).filter((x) => matches(x.symbol, x.name, x.token)) : [];
  const unlistedMatches = useMemo(() => {
    if (!q || !tokenList.data) return [];
    // Coinbase stocks are shown in their own list below, listed or not.
    const listedAddrs = new Set([...(stocks.data ?? []).map((x) => x.token), ...COINBASE_STOCKS.map((x) => x[2])].map((a) => a.toLowerCase()));
    return tokenList.data.tokens
      .filter((t) => !listedAddrs.has(t.address.toLowerCase()) && matches(t.symbol, t.name, t.address))
      .sort((a, b) => rank(a, q) - rank(b, q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tokenList.data, stocks.data]);
  // Coinbase stocks that exist on Base but have no onchain market deep enough to buy through yet.
  const untradable = useMemo(() => {
    if (!q || kind !== "stock") return [];
    const listed = new Set((stocks.data ?? []).map((x) => x.symbol));
    return COINBASE_STOCKS.filter(([sym, nm, addr]) => !listed.has(sym) && matches(sym, nm, addr))
      .sort((a, b) => rank({ symbol: a[0], name: a[1] }, q) - rank({ symbol: b[0], name: b[1] }, q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, stocks.data]);

  if (editing && !plan) return <Spinner />;

  return (
    <div className="rise space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => history.back()} className="grid h-9 w-9 place-items-center rounded-full bg-surface transition-colors duration-150 hover:bg-line" aria-label="Back">
          ←
        </button>
        <h1 className="headline text-[26px]">{editing ? "Modify basket" : "New basket"}</h1>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-line">
            {(["stock", "crypto"] as const).map((k) => {
              const n = selected.filter((t) => stockBy.get(t)?.kind === k).length;
              return (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`h-8 rounded-md px-3 text-sm font-medium transition-colors duration-150 ${
                    kind === k ? "bg-surface text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {k === "stock" ? "Stocks" : "Crypto"}
                  {n > 0 && <span className="ml-1.5 text-brand-ink">{n}</span>}
                </button>
              );
            })}
          </div>
          <div className="font-mono text-xs text-muted">
            {selected.length}/{MAX} picked
          </div>
        </div>
        <div className="mb-3 flex h-10 items-center gap-2 rounded-lg bg-bg px-3 ring-1 ring-line focus-within:ring-brand-ink">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-faint" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, ticker or paste an address"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-sm text-muted hover:text-ink" aria-label="Clear search">
              ✕
            </button>
          )}
        </div>
        {stocks.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {(q ? listedMatches : stocks.data?.filter((s) => s.kind === kind))
              ?.map((s) => {
                const on = selected.includes(s.token);
                const full = !on && selected.length >= MAX;
                return (
                  <button
                    key={s.token}
                    onClick={() => toggle(s.token)}
                    disabled={full || !s.usable}
                    className={`flex items-center gap-2.5 rounded-lg bg-surface-2 p-2.5 text-left transition duration-150 ${
                      on ? "ring-2 ring-brand-ink" : "ring-1 ring-line hover:ring-faint"
                    } disabled:cursor-not-allowed disabled:text-faint`}
                  >
                    <StockLogo symbol={s.symbol} token={s.token} kind={s.kind} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{s.symbol}</div>
                      <div className="num truncate text-xs text-muted">
                        {s.usable ? money(s.price, { digits: s.price < 1 ? 4 : 2 }) : "Market closed"}
                        {s.pricing === "twap" && <span className="text-faint" title="Priced from its Aerodrome market, not Chainlink"> · market price</span>}
                      </div>
                    </div>
                    {on && <span className="text-brand-ink">✓</span>}
                  </button>
                );
              })}
          </div>
        )}
        {untradable.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-xs font-medium text-muted">Coinbase stocks · not tradable on Base yet</div>
            <div className="divide-y divide-line rounded-lg bg-surface-2 ring-1 ring-line">
              {untradable.map(([sym, nm, addr]) => (
                <div key={addr} className="flex items-center gap-2.5 p-2.5 text-faint">
                  <StockLogo symbol={sym} token={addr} kind="stock" size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{sym}</div>
                    <div className="truncate text-xs">{nm}</div>
                  </div>
                  <Pill>soon</Pill>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-faint">
              Coinbase has issued these on Base, but no onchain market holds enough USDC to buy them at a fair price yet. They get listed
              once one does.
            </p>
          </div>
        )}
        {q && listedMatches.length === 0 && unlistedMatches.length === 0 && untradable.length === 0 && (
          <p className="py-3 text-center text-sm text-muted">
            {tokenList.isLoading ? "Searching Base tokens…" : "No Base token matches that."}
          </p>
        )}
        {q && unlistedMatches.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-xs font-medium text-muted">Other tokens on Base · not buyable yet</div>
            <div className="divide-y divide-line rounded-lg bg-surface-2 ring-1 ring-line">
              {unlistedMatches.map((t) => (
                <UnlistedRow key={t.address} t={t} />
              ))}
            </div>
            <p className="mt-2 text-xs text-faint">
              Basketoor only buys assets it can check every fill against: a Chainlink feed, or a time-weighted price from a deep
              onchain market. These tokens aren't listed yet.
            </p>
          </div>
        )}
        {!q && kind === "stock" && (
          <p className="mt-3 text-xs text-faint">Tokenized stocks by Coinbase. Stocks marked "market price" have no Chainlink feed: they're priced from a 30-minute average of their own Aerodrome market, which can drift from the stock's exchange price. A buy that can't happen (market closed) is retried an hour later. If only part of a basket can buy, say crypto on a weekend, that run still counts as one of your buys and the skipped part's USDC is refunded at the end.</p>
        )}
      </Card>

      {selected.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <div className="font-semibold">Amount per buy</div>
            <div className="num text-sm text-muted">Total {money(usd(perBuy))}</div>
          </div>
          <div className="space-y-2">
            {selected.map((t) => {
              const s = stockBy.get(t);
              return (
                <div key={t} className="flex items-center gap-3 rounded-xl bg-surface-2 p-2 pl-3 ring-1 ring-line">
                  <StockLogo symbol={s?.symbol ?? "?"} token={s?.token} kind={s?.kind} size={26} />
                  <div className="w-14 text-sm font-semibold">{s?.symbol}</div>
                  <div className="flex flex-1 items-center rounded-lg bg-bg px-3 ring-1 ring-line focus-within:ring-brand-ink">
                    <span className="text-muted">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={amounts[t] ?? ""}
                      onChange={(e) => setAmounts((a) => ({ ...a, [t]: e.target.value }))}
                      className="num h-10 w-full bg-transparent pl-1 outline-none"
                      aria-label={`USDC per buy for ${s?.symbol}`}
                    />
                  </div>
                  {!locked.has(t) ? (
                    <button onClick={() => toggle(t)} className="px-1 text-faint hover:text-ink" aria-label="Remove">
                      ✕
                    </button>
                  ) : (
                    <span className="w-4" />
                  )}
                </div>
              );
            })}
          </div>
          {editing && <p className="mt-2 text-xs text-faint">Set a stock to $0 to pause it.</p>}
        </Card>
      )}

      <Card>
        <div className="mb-3 font-semibold">Buy every</div>
        <div className="grid grid-cols-3 gap-2">
          {FREQUENCIES.map((f) => (
            <button
              key={f.seconds}
              onClick={() => setInterval(f.seconds)}
              className={`h-10 rounded-lg text-sm font-medium ring-1 ${
                interval === f.seconds ? "bg-surface-2 text-ink ring-2 ring-brand-ink" : "bg-surface-2 text-muted ring-line"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="mt-5 mb-3 flex items-center justify-between">
          <div className="font-semibold">{editing ? "Buys left" : "Number of buys"}</div>
          {buysN > 0 && <div className="text-xs text-muted">last buy ≈ {date(endsAt)}</div>}
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={buys}
            onChange={(e) => setBuys(e.target.value)}
            className="num h-10 w-24 rounded-lg bg-bg px-3 ring-1 ring-line outline-none focus:ring-brand-ink"
            aria-label="Number of buys"
          />
          {BUY_PRESETS.map((n) => (
            <button
              key={n}
              onClick={() => setBuys(String(n))}
              className={`h-10 flex-1 rounded-lg text-sm ring-1 ${buysN === n ? "bg-surface-2 ring-2 ring-brand-ink" : "bg-surface-2 text-muted ring-line"}`}
            >
              {n}
            </button>
          ))}
        </div>
      </Card>

      <Card className="space-y-4">
        {!editing && (
          <label className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                Savings <Pill tone="brand">earns yield</Pill>
              </div>
              <div className="mt-0.5 text-sm text-muted">
                USDC waiting for its turn sits in a savings vault. Basketoor keeps {(protocol.data?.yieldFeeBps ?? 1000) / 100}% of the
                yield.
              </div>
            </div>
            <input
              type="checkbox"
              checked={savings && !!protocol.data?.savingsAvailable}
              disabled={!protocol.data?.savingsAvailable}
              onChange={(e) => setSavings(e.target.checked)}
              className="mt-1 h-5 w-5 accent-brand"
            />
          </label>
        )}
        {selected.length > 1 && (
          <label className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                Smart buys <Pill tone="brand">keeps your mix</Pill>
              </div>
              <div className="mt-0.5 text-sm text-muted">
                Your amounts set the mix you want. When one asset runs ahead, each buy puts more into the ones that fell behind, same
                total per buy. It never sells.
              </div>
            </div>
            <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} className="mt-1 h-5 w-5 accent-brand" />
          </label>
        )}
        <div>
          <div className="mb-2 font-semibold">Name</div>
          <input
            value={name}
            maxLength={40}
            placeholder={defaultName(selected.map((t) => stockBy.get(t)?.symbol ?? ""))}
            onChange={(e) => setName(e.target.value)}
            className="h-10 w-full rounded-lg bg-bg px-3 ring-1 ring-line outline-none focus:ring-brand-ink"
          />
        </div>
      </Card>

      <Card>
        <Row label="Per buy">{money(usd(perBuy))}</Row>
        <Row label="Fee per buy" hint={`${feeBps / 100}% or ${money(usd(minFee))}, whichever is higher`}>
          {money(usd(feePerBuy))}
          {effectiveFee > 0 && <span className="ml-1 text-xs text-muted">({(effectiveFee * 100).toFixed(2)}%)</span>}
        </Row>
        <Row label={editing ? "Buys left" : "Buys"}>{buysN}</Row>
        <div className="my-2 border-t border-line" />
        <Row label={editing ? "Still to invest" : "Total invested"}>{money(usd(perBuy * BigInt(buysN)))}</Row>
        <Row label="Total fees" hint={buysN > 0 ? `${money(usd(feePerBuy))} × ${buysN} buys, only on buys that happen` : undefined}>
          {money(usd(feePerBuy * BigInt(buysN)))}
        </Row>
        {editing ? (
          <Row label={delta >= 0n ? "You add" : "You get back"}>{money(usd(delta >= 0n ? delta : -delta))}</Row>
        ) : (
          <Row label="Total deposit">
            <span className="text-base font-semibold">{money(usd(required))}</span>
          </Row>
        )}
        <p className="mt-2 text-xs leading-relaxed text-faint">
          Each buy is checked against the Chainlink price; anything worse than {(protocol.data?.maxSlippageBps ?? 150) / 100}% or a
          closed market skips that stock and keeps its USDC in the basket. Unspent USDC comes back when the basket ends or you stop
          it.
        </p>
      </Card>

      {!editing && (
        <label className="flex items-start gap-3 px-1 text-sm text-muted">
          <input type="checkbox" checked={notUs} onChange={(e) => setNotUs(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand" />
          I'm not a US person, and tokenized stocks are allowed where I live.
        </label>
      )}

      <BottomBar>
          {error && <p className="mb-2 text-center text-sm text-down">{error}</p>}
          <Button className="w-full" disabled={!!problem || busy} onClick={submit}>
            {busy ? "Confirm in wallet…" : (problem ?? (editing ? "Save changes" : `Start basket · ${money(usd(required))}`))}
          </Button>
        </BottomBar>
    </div>
  );
}

function defaultName(symbols: string[]) {
  const s = symbols.filter(Boolean);
  if (!s.length) return "My basket";
  return s.length <= 3 ? s.join(" + ") : `${s.slice(0, 2).join(" + ")} +${s.length - 2}`;
}

/// Exact ticker first, then ticker prefix, then name matches.
function rank(t: Pick<ListToken, "symbol" | "name">, q: string) {
  const sym = t.symbol.toLowerCase();
  if (sym === q) return 0;
  if (sym.startsWith(q)) return 1;
  if (t.name.toLowerCase().startsWith(q)) return 2;
  return 3;
}

function UnlistedRow({ t }: { t: ListToken }) {
  return (
    <div className="flex items-center gap-3 p-2.5">
      <StockLogo symbol={t.symbol} src={t.logoURI} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{t.symbol}</div>
        <div className="truncate text-xs text-muted">{t.name}</div>
      </div>
      <a
        href={`https://basescan.org/token/${t.address}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs text-muted hover:text-ink"
      >
        {t.address.slice(0, 6)}…{t.address.slice(-4)}
      </a>
    </div>
  );
}
