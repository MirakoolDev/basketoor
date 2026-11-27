import { useState } from "react";
import { useAccount } from "wagmi";
import { erc20Abi } from "./abi";
import { dep } from "./config";
import { useChainNow, useCreatorEarned, useMyPlans, useSend, useStocks, useUsdc, usd, type PlanView, type StockInfo } from "./data";
import { countdown, every, money, pct } from "./format";
import { Button, Card, LogoStack, Pill, Spinner, valuePlan } from "./ui";
import { go } from "./App";

export function Home() {
  const earned = useCreatorEarned();
  const plans = useMyPlans();
  const stocks = useStocks();
  const usdc = useUsdc();
  const { address } = useAccount();
  const send = useSend();
  const [busy, setBusy] = useState(false);

  const all = plans.data ?? [];
  const totals = all.reduce(
    (t, p) => {
      const v = valuePlan(p, stocks.data);
      return {
        value: t.value + v.value,
        invested: t.invested + v.invested,
        budget: t.budget + (p.active ? usd(p.value) : 0),
      };
    },
    { value: 0, invested: 0, budget: 0 },
  );
  const pnl = totals.value - totals.invested;

  const faucet = async () => {
    setBusy(true);
    try {
      await send([{ address: dep.usdc, abi: erc20Abi, functionName: "faucet", args: [address, 1_000_000_000n] }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rise space-y-4">
      <Card>
        <div className="text-sm text-muted">Holdings value</div>
        <div className="num headline mt-2 text-[44px]">{money(totals.value)}</div>
        <div className={`num mt-1 text-sm font-medium ${pnl >= 0 ? "text-up" : "text-down"}`}>
          {money(pnl, { sign: true })} {totals.invested > 0 && `(${pct(pnl / totals.invested)})`} all time
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm">
          <div>
            <div className="text-muted">In baskets</div>
            <div className="num font-semibold">{money(totals.budget)}</div>
          </div>
          <div>
            <div className="text-muted">Wallet USDC</div>
            <div className="num font-semibold">{usdc.data ? money(usd(usdc.data.balance)) : "–"}</div>
          </div>
        </div>
      </Card>

      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => go("/new")}>
          + New basket
        </Button>
        {dep.mock && (
          <Button variant="ghost" onClick={faucet} disabled={busy}>
            {busy ? "Minting…" : "Get test USDC"}
          </Button>
        )}
      </div>

      {(earned.data ?? 0n) > 0n && (
        <Card className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold">From your shared baskets</div>
            <p className="text-sm text-muted">Your share of the buy fees on baskets people opened from your links.</p>
          </div>
          <div className="num text-lg font-semibold text-up">{money(usd(earned.data!))}</div>
        </Card>
      )}

      <div className="flex items-center justify-between pt-2">
        <h2 className="text-lg font-semibold">Your baskets</h2>
        {plans.isFetching && <Spinner />}
      </div>

      {plans.isLoading ? (
        <Card className="h-24 animate-pulse" />
      ) : all.length === 0 ? (
        <Card className="py-10 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto h-10 w-10" />
          <div className="mt-2 font-semibold">No baskets yet</div>
          <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
            Make one: choose a few stocks, a frequency and a budget. The first buy happens within minutes.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {all.map((p) => (
            <PlanCard key={p.id.toString()} plan={p} stocks={stocks.data} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan, stocks }: { plan: PlanView; stocks?: StockInfo[] }) {
  const now = useChainNow(15_000);
  const v = valuePlan(plan, stocks);
  const assets = v.legs.filter((l) => l.amount > 0n || l.received > 0n).map((l) => l.stock);
  const perBuy = plan.legs.reduce((s, l) => s + l.amount, 0n);
  return (
    <button onClick={() => go(`/plan/${plan.id}`)} className="block w-full text-left">
      <Card className="transition-colors hover:bg-surface-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{plan.name || `Basket #${plan.id}`}</div>
            <div className="mt-0.5 text-sm text-muted">
              {money(usd(perBuy))} {every(plan.interval)}
            </div>
          </div>
          {plan.active ? (
            <Pill tone="up">● Active</Pill>
          ) : (
            <Pill>{plan.buysDone >= plan.maxBuys ? "Completed" : "Ended"}</Pill>
          )}
        </div>
        <div className="mt-4 flex items-end justify-between">
          <LogoStack assets={assets} />
          <div className="text-right">
            <div className="num font-semibold">{money(v.value)}</div>
            <div className={`num text-xs ${v.pnl >= 0 ? "text-up" : "text-down"}`}>
              {money(v.pnl, { sign: true })} ({pct(v.pnlPct)})
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-between border-t border-line pt-3 text-xs text-muted">
          <span>
            {plan.buysDone}/{plan.maxBuys} buys
          </span>
          <span>{plan.active ? `Next buy in ${countdown(plan.nextRun, now)}` : `Invested ${money(v.invested)}`}</span>
        </div>
      </Card>
    </button>
  );
}
