import { useMemo, useState } from "react";
import { useExplore, useStocks, usd, type ExploreBasket } from "./data";
import { date, every, money, pct, short } from "./format";
import { Card, Spinner, StockLogo, valuePlan } from "./ui";
import { SiteFooter, SiteNav } from "./Landing";

const MIN_BUYS = 3;
type Sort = "return" | "copies" | "new";
const SORTS: [Sort, string][] = [
  ["return", "Top return"],
  ["copies", "Most copied"],
  ["new", "Newest"],
];

/// Baskets people run on DCAC, to copy. Read from the contract: every plan is public onchain.
export function Explore() {
  const list = useExplore(MIN_BUYS);
  const stocks = useStocks();
  const [sort, setSort] = useState<Sort>("return");

  const rows = useMemo(() => {
    const r = (list.data ?? []).map((b) => ({ ...b, v: valuePlan(b.plan, stocks.data) }));
    return r.sort((a, b) =>
      sort === "return" ? b.v.pnlPct - a.v.pnlPct : sort === "copies" ? b.copies - a.copies || b.v.pnlPct - a.v.pnlPct : Number(b.plan.id - a.plan.id),
    );
  }, [list.data, stocks.data, sort]);

  return (
    <div className="min-h-dvh">
      <SiteNav />
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div className="mb-1 font-mono text-xs tracking-widest text-faint uppercase">Explore</div>
        <h1 className="headline text-[34px]">Baskets to copy</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Baskets other people are running. Copy one and set your own amount: you get the same mix on your own schedule, in your own
          wallet, and its maker gets part of the fee on each of your buys, out of the fee you'd pay anyway.
        </p>

        <div className="mt-6 flex gap-1 rounded-lg bg-surface-2 p-1 ring-1 ring-line sm:w-fit">
          {SORTS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={`h-8 flex-1 whitespace-nowrap rounded-md px-2 text-sm font-medium sm:px-3 transition-colors duration-150 ${sort === k ? "bg-surface text-ink" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {list.isLoading || stocks.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <Card>Couldn't load baskets. Try again in a moment.</Card>
          ) : rows.length === 0 ? (
            <Card className="py-10 text-center">
              <div className="font-semibold">No baskets to show yet</div>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                A basket shows up here after its {MIN_BUYS}rd buy, so there's a track record to look at.
              </p>
              <a href="#/new" className="mt-4 inline-grid h-10 place-items-center rounded-full bg-ink px-5 text-sm font-medium text-bg">
                Start one
              </a>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {rows.map((r) => (
                <BasketCard key={r.plan.id.toString()} b={r} v={r.v} />
              ))}
            </div>
          )}
        </div>

        <p className="mt-6 text-xs text-faint">
          Every basket on DCAC is public onchain. Baskets appear here after {MIN_BUYS} buys; copies aren't listed separately. Return is the
          value now of what a basket has bought, at current prices, against the USDC it spent: what following it has returned so far,
          not a promise about what it will do. Not investment advice.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function BasketCard({ b, v }: { b: ExploreBasket; v: ReturnType<typeof valuePlan> }) {
  const p = b.plan;
  const live = p.legs.filter((l) => l.amount > 0n);
  const perBuy = live.reduce((s, l) => s + l.amount, 0n);
  const up = v.pnl >= 0;
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{p.name || `Basket #${p.id}`}</div>
          <div className="mt-0.5 text-xs text-muted">
            by <span className="font-mono">{short(p.owner)}</span> · {every(p.interval)} · since {date(p.createdAt)}
          </div>
        </div>
        <div className="text-right">
          <div className={`num text-lg font-semibold ${up ? "text-up" : "text-down"}`}>{pct(v.pnlPct)}</div>
          <div className="text-[11px] text-faint">return so far</div>
        </div>
      </div>

      <div className="mt-4 space-y-1.5">
        {live.map((l) => {
          const leg = v.legs.find((x) => x.token === l.token);
          const w = perBuy > 0n ? Number((l.amount * 10_000n) / perBuy) / 100 : 0;
          return (
            <div key={l.token} className="flex items-center gap-2 text-sm">
              <StockLogo symbol={leg?.stock?.symbol ?? "?"} token={l.token} kind={leg?.stock?.kind} size={20} />
              <span className="w-14 font-medium">{leg?.stock?.symbol ?? short(l.token)}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-brand-ink" style={{ width: `${w}%` }} />
              </div>
              <span className="num w-12 text-right text-xs text-muted">{w.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
        <span className="num">
          {p.buysDone} buys · {money(v.invested)} invested{p.smart ? " · auto-rebalance" : ""}
          {b.copies > 0 && ` · copied ${b.copies}×`}
        </span>
        <a
          href={`#/b/${p.id}`}
          className="grid h-9 shrink-0 place-items-center rounded-full bg-ink px-4 text-sm font-medium text-bg transition-opacity duration-150 hover:opacity-90"
          title={`Copy at your own amount (the original buys ${money(usd(perBuy))} ${every(p.interval)})`}
        >
          Copy
        </a>
      </div>
    </Card>
  );
}
