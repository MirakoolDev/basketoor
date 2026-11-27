import { useState } from "react";
import { useAccount } from "wagmi";
import { dcacAbi } from "./abi";
import { dep, explorer } from "./config";
import { useChainNow, useHistory, usePlan, useSend, useStocks, usd, type HistoryItem, type PlanView } from "./data";
import { countdown, date, dateTime, every, money, pct, qty, short } from "./format";
import { BottomBar, Button, Card, Pill, Row, Spinner, StockLogo, valuePlan } from "./ui";
import { go } from "./App";
import { shareLink } from "./share";

type Tab = "status" | "orders" | "settings";

export function PlanDetail({ id }: { id: bigint }) {
  const plan = usePlan(id);
  const stocks = useStocks();
  const { address } = useAccount();
  const [tab, setTab] = useState<Tab>("status");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = useSend();
  const now = useChainNow();

  if (plan.isLoading || !plan.data) return <Spinner />;
  const p = plan.data;
  if (p.owner === "0x0000000000000000000000000000000000000000") return <Card>Basket not found.</Card>;
  const v = valuePlan(p, stocks.data);
  const mine = address?.toLowerCase() === p.owner.toLowerCase();
  const yieldEarned = p.savings && p.value > p.principal ? usd(p.value - p.principal) : 0;

  const terminate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await send([{ address: dep.dcac, abi: dcacAbi, functionName: "cancelPlan", args: [p.id] }]);
      setConfirming(false);
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rise space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => go("/")} className="grid h-9 w-9 place-items-center rounded-full bg-surface transition-colors duration-150 hover:bg-line" aria-label="Back">
          ←
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="headline truncate text-[26px]">{p.name || `Basket #${p.id}`}</h1>
          <div className="text-sm text-muted">
            {p.active ? (
              <span className="text-up">● Active</span>
            ) : (
              <span>{p.buysDone >= p.maxBuys ? "Completed" : "Ended"}</span>
            )}{" "}
            · since {date(p.createdAt)}
            {p.creator !== "0x0000000000000000000000000000000000000000" && (
              <>
                {" "}· copied from <span className="font-mono">{short(p.creator)}</span>
              </>
            )}
          </div>
        </div>
        <ShareButton p={p} />
      </div>

      <Card>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm text-muted">Value</div>
            <div className="num headline mt-1 text-[36px]">{money(v.value)}</div>
            <div className={`num text-sm font-medium ${v.pnl >= 0 ? "text-up" : "text-down"}`}>
              {money(v.pnl, { sign: true })} ({pct(v.pnlPct)})
            </div>
          </div>
          {p.active && (
            <div className="text-right">
              <div className="text-sm text-muted">Next buy</div>
              <div className="num text-lg font-semibold">{countdown(p.nextRun, now)}</div>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm">
          <Stat label="Invested" value={money(v.invested)} />
          <Stat label="Buys" value={`${p.buysDone}/${p.maxBuys}`} />
          <Stat label="Budget left" value={money(p.active ? usd(p.value) : 0)} />
        </div>
      </Card>

      <div className="flex gap-1 rounded-full bg-surface p-1 ring-1 ring-line">
        {(["status", "orders", "settings"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-9 flex-1 rounded-full text-sm font-medium capitalize ${tab === t ? "bg-surface-2 text-ink ring-1 ring-line" : "text-muted"}`}
          >
            {t === "orders" ? "Order history" : t === "settings" ? "Parameters" : "Status"}
          </button>
        ))}
      </div>

      {tab === "status" && (
        <div className="space-y-3">
          {v.legs.map((l) => (
            <Card key={l.token}>
              <div className="flex items-center gap-3">
                <StockLogo symbol={l.stock?.symbol ?? "?"} token={l.stock?.token} kind={l.stock?.kind} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold">
                    {l.stock?.symbol}
                    {l.amount === 0n && <Pill>paused</Pill>}
                    {l.stock && !l.stock.usable && <Pill tone="warn">market closed</Pill>}
                    {l.stock?.pricing === "twap" && <Pill>market price</Pill>}
                  </div>
                  <div className="truncate text-xs text-muted">{l.stock?.name}</div>
                </div>
                <div className="text-right">
                  <div className="num font-semibold">{money(l.value)}</div>
                  <div className={`num text-xs ${l.pnl >= 0 ? "text-up" : "text-down"}`}>
                    {l.spentUsd > 0 ? pct(l.pnl / l.spentUsd) : "–"}
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <Stat small label="Shares" value={qty(l.shares)} />
                <Stat small label="Avg buy" value={l.avgPrice ? money(l.avgPrice) : "–"} />
                <Stat small label="Now" value={l.stock ? money(l.stock.price) : "–"} />
              </div>
            </Card>
          ))}
          {p.weights && p.legs.length > 1 && p.buysDone > 0 && <Weights p={p} symbols={v.legs.map((l) => l.stock?.symbol ?? "?")} />}
          {p.savings && (
            <Card>
              <Row label="Savings yield so far" hint="on USDC waiting to be spent">
                <span className="text-up">{money(yieldEarned, { digits: 4 })}</span>
              </Row>
            </Card>
          )}
        </div>
      )}

      {tab === "orders" && <Orders id={id} maxBuys={p.maxBuys} />}

      {tab === "settings" && (
        <Card>
          <Row label="Frequency">{every(p.interval)}</Row>
          {v.legs.map((l) => (
            <Row key={l.token} label={l.stock?.symbol ?? short(l.token)}>
              {money(usd(l.amount))} per buy
            </Row>
          ))}
          <Row label="Fee per buy">
            {(p.feeBps + (p.smart ? p.smartFeeBps : 0)) / 100}% (min {money(usd(p.minFee))})
          </Row>
          <Row label="Fees paid">{money(usd(p.totalFees))}</Row>
          <Row label="Savings">{p.savings ? "On" : "Off"}</Row>
          <Row
            label="Auto-rebalance"
            hint={`buys more of what fell behind your target mix${p.smartFeeBps ? `, +${p.smartFeeBps / 100}% fee` : ""}`}
          >
            {p.smart ? "On" : "Off"}
          </Row>
          <Row label="Skipped runs" hint="market closed or price check failed">
            {p.skippedRuns}
          </Row>
          <Row label="Basket ID">
            {explorer ? (
              <a className="text-brand-ink" href={`${explorer}/address/${dep.dcac}`} target="_blank" rel="noreferrer">
                #{p.id.toString()} ↗
              </a>
            ) : (
              `#${p.id}`
            )}
          </Row>
        </Card>
      )}

      {mine && p.active && (
        <BottomBar>
            {error && <p className="mb-2 text-center text-sm text-down">{error}</p>}
            {confirming ? (
              <div className="rounded-2xl bg-surface p-4 ring-1 ring-line">
                <div className="font-semibold">Stop this basket?</div>
                <p className="mt-1 text-sm text-muted">
                  No more buys. {money(usd(p.value))} USDC{yieldEarned > 0 ? " (with yield)" : ""} goes back to your wallet. Your shares
                  are already there.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" className="flex-1" onClick={() => setConfirming(false)} disabled={busy}>
                    Keep it
                  </Button>
                  <Button variant="danger" className="flex-1" onClick={terminate} disabled={busy}>
                    {busy ? "Stopping…" : "Stop & refund"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => go(`/plan/${p.id}/edit`)}>
                  Modify
                </Button>
                <Button variant="danger" className="flex-1" onClick={() => setConfirming(true)}>
                  Terminate
                </Button>
              </div>
            )}
        </BottomBar>
      )}
    </div>
  );
}

/// Copies a link to this basket's mix. Whoever opens a plan from it pays the basket's creator part of each buy fee:
/// the original creator if this basket was itself copied, otherwise its owner.
function ShareButton({ p }: { p: PlanView }) {
  const [done, setDone] = useState(false);
  const legs = p.legs.filter((l) => l.amount > 0n).map((l) => ({ token: l.token, usd: usd(l.amount) }));
  if (!legs.length) return null;
  const creator = p.creator !== "0x0000000000000000000000000000000000000000" ? p.creator : p.owner;
  const share = async () => {
    const url = shareLink({ creator, legs, interval: p.interval, name: p.name, smart: p.smart });
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: p.name || "DCAC basket", url });
      else await navigator.clipboard.writeText(url);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  };
  return (
    <button
      onClick={share}
      className="h-9 shrink-0 rounded-full bg-surface px-4 text-sm font-medium transition-colors duration-150 hover:bg-line"
      title="Anyone who opens a basket from this link pays its creator part of each buy fee"
    >
      {done ? "Link copied" : "Share"}
    </button>
  );
}

/// A leg further than this from its target weight is flagged.
const WEIGHT_LIMIT_BPS = 500;

/// Target mix (from the per-buy amounts) next to the mix the basket holds now, valued at the oracle price.
function Weights({ p, symbols }: { p: PlanView; symbols: string[] }) {
  const w = p.weights!;
  const total = w.valueUsd.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rows = w.targetBps.map((t, i) => ({ sym: symbols[i], target: t, now: Math.round((w.valueUsd[i] / total) * 10_000) }));
  const breached = rows.filter((r) => Math.abs(r.now - r.target) > WEIGHT_LIMIT_BPS);
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Mix</div>
        {breached.length ? (
          <Pill tone="warn">{breached.map((r) => r.sym).join(", ")} off target</Pill>
        ) : (
          <Pill tone="brand">on target</Pill>
        )}
      </div>
      <div className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.sym} className="text-sm">
            <div className="flex justify-between">
              <span className="font-medium">{r.sym}</span>
              <span className="num text-muted">
                {(r.now / 100).toFixed(1)}% <span className="text-faint">/ target {(r.target / 100).toFixed(0)}%</span>
              </span>
            </div>
            <div className="relative mt-1 h-1.5 rounded-full bg-line">
              <div
                className={`h-1.5 rounded-full ${Math.abs(r.now - r.target) > WEIGHT_LIMIT_BPS ? "bg-down" : "bg-brand"}`}
                style={{ width: `${Math.min(100, r.now / 100)}%` }}
              />
              <div className="absolute -top-0.5 h-2.5 w-0.5 bg-ink" style={{ left: `${r.target / 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        {breached.length
          ? p.smart
            ? "Auto-rebalance is on: the next buys put more into what fell behind, until you're back on target."
            : "Turn on auto-rebalance (Modify) and the next buys will put more into what fell behind. Nothing is sold."
          : `Every asset is within ${WEIGHT_LIMIT_BPS / 100} points of its target.`}
      </p>
    </Card>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={`num font-semibold ${small ? "" : "text-[15px]"}`}>{value}</div>
    </div>
  );
}

type Item = HistoryItem & { time?: number };
type Entry = { kind: "run"; tx: Item["tx"]; time?: number; run?: Extract<HistoryItem, { kind: "run" }>; legs: Item[] } | { kind: "event"; item: Item };

/// Groups everything one keeper transaction did for this basket (its buys and skips) into one run,
/// so a basket of three assets reads as one order with three fills, not three scattered rows.
function groupRuns(items: Item[]): Entry[] {
  const out: Entry[] = [];
  const runs = new Map<string, Extract<Entry, { kind: "run" }>>();
  for (const i of items) {
    if (i.kind === "buy" || i.kind === "skip" || i.kind === "run") {
      let g = runs.get(i.tx);
      if (!g) {
        g = { kind: "run", tx: i.tx, time: i.time, legs: [] };
        runs.set(i.tx, g);
        out.push(g);
      }
      if (i.kind === "run") g.run = i;
      else g.legs.unshift(i); // history is newest-first; show legs in basket order
    } else out.push({ kind: "event", item: i });
  }
  return out;
}

function Orders({ id, maxBuys }: { id: bigint; maxBuys: number }) {
  const history = useHistory(id);
  const stocks = useStocks();
  if (history.isLoading) return <Spinner />;
  const entries = groupRuns((history.data ?? []) as Item[]);
  const sym = (t: string) => stocks.data?.find((s) => s.token.toLowerCase() === t.toLowerCase());
  if (!entries.length) return <Card className="text-center text-sm text-muted">No orders yet. The keeper picks up new baskets within minutes.</Card>;
  const txLink = (tx: string) => (explorer ? `${explorer}/tx/${tx}` : undefined);

  return (
    <div className="space-y-2">
      {entries.map((e) => {
        if (e.kind === "run") {
          const bought = e.legs.filter((l) => l.kind === "buy");
          const spent = e.run?.spent ?? bought.reduce((s, l) => s + (l.kind === "buy" ? l.usdcIn : 0n), 0n);
          const title = bought.length ? `Buy ${e.run?.buyIndex ?? ""} of ${maxBuys}` : "Run skipped";
          return (
            <Card key={e.tx} className="py-3">
              <a href={txLink(e.tx)} target="_blank" rel="noreferrer" className="flex items-baseline justify-between gap-3">
                <div>
                  <div className="font-semibold">{title}</div>
                  <div className="mt-0.5 text-xs text-faint">{e.time ? dateTime(e.time) : ""}</div>
                </div>
                <div className="num text-right">
                  <div className="font-semibold">{money(usd(spent))}</div>
                  {e.run && e.run.fee > 0n && <div className="text-xs text-muted">+ {money(usd(e.run.fee))} fee</div>}
                </div>
              </a>
              <div className="mt-3 space-y-1.5 border-l border-line pl-3">
                {e.legs.map((l, n) => {
                  if (l.kind !== "buy" && l.kind !== "skip") return null;
                  const s = sym(l.token);
                  return (
                    <div key={n} className="flex items-center gap-2.5 text-sm">
                      <StockLogo symbol={s?.symbol ?? "?"} token={s?.token} kind={s?.kind} size={22} />
                      <div className="w-14 font-medium">{s?.symbol}</div>
                      {l.kind === "buy" ? (
                        <div className="num ml-auto text-right">
                          <div>
                            {qty(Number(l.amountOut) / 10 ** (s?.decimals ?? 18))} {s?.symbol}
                          </div>
                          <div className="text-xs text-muted">
                            {money(usd(l.usdcIn))} @ {money(Number(l.price) / 1e8)}
                          </div>
                        </div>
                      ) : (
                        <div className="ml-auto flex items-center gap-2 text-xs text-muted">
                          <Pill tone="warn">Skipped</Pill>
                          {l.reason === 1 ? "market closed / stale price" : "price check failed"}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        }
        const i = e.item;
        let left: React.ReactNode = null;
        let right: React.ReactNode = null;
        if (i.kind === "created") {
          left = <Pill tone="brand">Started</Pill>;
          right = <div>Deposited {money(usd(i.deposit))}</div>;
        } else if (i.kind === "updated") {
          left = <Pill>Modified</Pill>;
          right = <div>{i.pulled > 0n ? `Added ${money(usd(i.pulled))}` : i.refunded > 0n ? `Refunded ${money(usd(i.refunded))}` : "No change in budget"}</div>;
        } else if (i.kind === "closed") {
          left = <Pill>{i.cancelled ? "Stopped" : "Finished"}</Pill>;
          right = <div>Refunded {money(usd(i.refund))}</div>;
        }
        return (
          <Card key={`${i.tx}-${i.kind}`} className="py-3">
            <a href={txLink(i.tx)} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 text-sm">
              <div>
                <div className="font-medium">{left}</div>
                <div className="mt-1 text-xs text-faint">{i.time ? dateTime(i.time) : ""}</div>
              </div>
              <div className="num text-right font-medium">{right}</div>
            </a>
          </Card>
        );
      })}
    </div>
  );
}
