import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbi, type Address, type PublicClient } from "viem";
import { basketoorAbi, erc20Abi } from "./abi";
import { CHAIN_ID, dep, explorer } from "./config";
import { useStocks } from "./data";
import { dateTime, every, money, short } from "./format";
import { SiteFooter, SiteNav } from "./Landing";
import { Spinner, StockLogo } from "./ui";

const chainName = CHAIN_ID === 8453 ? "Base" : CHAIN_ID === 84532 ? "Base Sepolia" : "Local (Anvil)";
const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function name() view returns (string)",
]);

/// Everything readable about the live deployment, straight from the chain.
function useDeployment() {
  const pc = usePublicClient() as PublicClient;
  return useQuery({
    queryKey: ["about"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const r = <T,>(functionName: string, args: unknown[] = []) =>
        pc.readContract({ address: dep.basketoor, abi: basketoorAbi, functionName, args } as never) as Promise<T>;
      const [owner, treasury, adapter, vault, feeBps, minFee, yieldFeeBps, slip, stale, minI, maxI, maxSkip, minLeg, paused, nextId, due] =
        await Promise.all([
          r<Address>("owner"),
          r<Address>("treasury"),
          r<Address>("swapAdapter"),
          r<Address>("savingsVault"),
          r<number>("feeBps"),
          r<bigint>("minFee"),
          r<number>("yieldFeeBps"),
          r<number>("maxSlippageBps"),
          r<bigint>("maxStaleness"),
          r<bigint>("minInterval"),
          r<bigint>("maxInterval"),
          r<number>("maxSkippedRuns"),
          r<bigint>("minLegAmount"),
          r<boolean>("createPaused"),
          r<bigint>("nextPlanId"),
          r<bigint>("dueCount"),
        ]);
      const keeperOk = dep.keeper ? await r<boolean>("keepers", [dep.keeper]) : false;
      const idle = await pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [dep.basketoor] });
      let saved = 0n;
      if (vault !== "0x0000000000000000000000000000000000000000") {
        const shares = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [dep.basketoor] });
        saved = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
      }
      return {
        owner, treasury, adapter, vault, feeBps, minFee, yieldFeeBps, slip, paused, keeperOk,
        stale: Number(stale), minI: Number(minI), maxI: Number(maxI), maxSkip, minLeg,
        plans: Number(nextId) - 1, due: Number(due), held: Number(idle + saved) / 1e6,
      };
    },
  });
}

const SECTIONS = [
  ["overview", "Overview"],
  ["contracts", "Contracts"],
  ["assets", "Assets & price feeds"],
  ["parameters", "Live parameters"],
  ["flow", "How a buy works"],
  ["trust", "Roles & trust"],
  ["mainnet", "Mainnet integration"],
  ["risks", "Known limitations"],
] as const;

export function About() {
  const d = useDeployment();
  const stocks = useStocks();
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="min-h-dvh">
      <SiteNav />
      <main className="mx-auto max-w-5xl px-4 py-10 md:grid md:grid-cols-[180px_1fr] md:gap-10">
        <aside className="hidden md:block">
          <nav className="sticky top-24 space-y-1 text-sm">
            {SECTIONS.map(([id, label]) => (
              <button key={id} onClick={() => jump(id)} className="block py-1 text-left text-muted transition-colors duration-150 hover:text-ink">
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="rise min-w-0 space-y-14">
          <Section id="overview" eyebrow="ABOUT BASKETOOR" title="How it works, in the open">
            <p className="text-[17px] leading-[1.5] text-muted">
              Basketoor is a recurring-buy ("DCA") protocol on Base. You build a basket of up to five tokenized stocks and tokens,
              deposit the USDC for every buy up front, and an automated keeper executes each buy on schedule. All accounting, price
              checks and fees live in one contract. Everything on this page is read from the chain right now.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Network" value={chainName} />
              <Stat label="Baskets created" value={d.data ? String(d.data.plans) : "…"} />
              <Stat label="USDC held for baskets" value={d.data ? money(d.data.held) : "…"} />
              <Stat label="Baskets due now" value={d.data ? String(d.data.due) : "…"} />
            </div>
          </Section>

          <Section id="contracts" title="Contracts">
            <p className="mb-4 text-sm text-muted">
              {dep.mock
                ? "This deployment uses test tokens: test USDC, test stock tokens priced by copies of the real Base mainnet Chainlink feeds, a test swap venue and a test savings vault."
                : "Production deployment on Base."}
            </p>
            {!d.data ? (
              <Spinner />
            ) : (
              <Table>
                <AddrRow label="Basketoor" what="Plans, escrow, price checks, execution, fees" addr={dep.basketoor} />
                <AddrRow label={dep.mock ? "USDC (test)" : "USDC"} what="What baskets are funded in" addr={dep.usdc} />
                <AddrRow label="Swap adapter" what={dep.mock ? "Test venue: fills at the oracle price minus 0.2%" : "Aerodrome concentrated-liquidity pools"} addr={d.data.adapter} />
                <AddrRow label="Savings vault" what="ERC-4626 vault for USDC waiting its turn" addr={d.data.vault} />
                {dep.keeper && (
                  <AddrRow label="Keeper" what={d.data.keeperOk ? "Authorized to run due baskets" : "Not authorized"} addr={dep.keeper} />
                )}
                <AddrRow label="Owner" what="Admin (two-step ownership transfer)" addr={d.data.owner} />
                <AddrRow label="Treasury" what="Receives fees" addr={d.data.treasury} />
              </Table>
            )}
          </Section>

          <Section id="assets" title="Assets & price feeds">
            <p className="mb-4 text-sm text-muted">
              Only assets the owner has listed with a Chainlink feed can be bought. The feed is what every fill is checked against.
            </p>
            {!stocks.data ? (
              <Spinner />
            ) : (
              <Table>
                {stocks.data.map((s) => {
                  const feed = dep.stocks.find((x) => x.token === s.token)?.feed;
                  return (
                    <div key={s.token} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                      <div className="flex items-center gap-3">
                        <StockLogo symbol={s.symbol} token={s.token} kind={s.kind} size={28} />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold">
                            {s.symbol} <span className="font-normal text-muted">{s.name}</span>
                          </div>
                          <div className="num text-xs text-muted">
                            {s.usable ? money(s.price, { digits: s.price < 1 ? 4 : 2 }) : "Stale: buys skip"} · updated{" "}
                            {s.updatedAt ? dateTime(s.updatedAt) : "never"} · {s.decimals} decimals
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 sm:items-end">
                        <Addr label="token" addr={s.token} />
                        {feed && <Addr label="feed" addr={feed} />}
                      </div>
                    </div>
                  );
                })}
              </Table>
            )}
          </Section>

          <Section id="parameters" title="Live parameters">
            {!d.data ? (
              <Spinner />
            ) : (
              <Table>
                <KV k="Fee per buy" v={`${d.data.feeBps / 100}% or ${money(Number(d.data.minFee) / 1e6)}, whichever is higher`} note="Capped at 2% in the contract. Locked per basket when it's created." />
                <KV k="Savings yield fee" v={`${d.data.yieldFeeBps / 100}% of yield`} note="Capped at 30%. Only on yield, never on principal." />
                <KV k="Max slippage vs Chainlink" v={`${d.data.slip / 100}%`} note="Capped at 10%. Worse fills are skipped." />
                <KV k="Max price age" v={every(d.data.stale).replace(/^every /i, "")} note="Older prices (e.g. a closed market) skip that asset." />
                <KV k="Buy frequency" v={`${every(d.data.minI).replace(/^every /i, "")} to ${every(d.data.maxI).replace(/^every /i, "")}`} />
                <KV k="Minimum per asset per buy" v={money(Number(d.data.minLeg) / 1e6)} />
                <KV k="Auto-close after" v={`${d.data.maxSkip} fully skipped runs`} note="Refunds the basket if it can't buy for that long." />
                <KV k="New baskets" v={d.data.paused ? "Paused" : "Open"} note="Pausing never blocks existing baskets or withdrawals." />
              </Table>
            )}
          </Section>

          <Section id="flow" title="How a buy works">
            <ol className="space-y-3">
              {[
                ["Create", "You approve USDC and call createPlan in one confirmation (batched with Base Account). The contract pulls (per-buy amount + fee) × number of buys. The first buy is due immediately."],
                ["Wait", "Unspent USDC sits in the contract, or, with savings on, in the ERC-4626 savings vault, tracked per basket by its shares."],
                ["Trigger", "An automated keeper (KeeperHub) checks dueCount() on a schedule and calls executeDue(). Only authorized keepers can call it, and they can only run baskets that are due."],
                ["Price", "For each asset the contract reads Chainlink. A stale or unusable price skips that asset this round."],
                ["Swap", "The asset's USDC goes to the swap adapter, which buys on Aerodrome and sends the tokens straight to your wallet."],
                ["Verify", "The contract measures your wallet's balance before and after. Less than the oracle price minus the slippage bound and the buy doesn't count."],
                ["Charge", "The fee is taken only on USDC actually spent. Unused USDC goes back into the basket and the next buy is scheduled."],
                ["Finish", "After the last buy, or when you stop it, the basket closes: vault shares are redeemed, 10% of any yield goes to the treasury, and everything else is sent back to you."],
              ].map(([t, dsc], i) => (
                <li key={t} className="flex gap-4 rounded-xl bg-surface p-4">
                  <div className="font-doto w-6 shrink-0 text-sm font-bold text-faint">{String(i + 1).padStart(2, "0")}</div>
                  <div>
                    <div className="font-semibold">{t}</div>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{dsc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="trust" title="Roles & trust">
            <div className="grid gap-3 md:grid-cols-3">
              <Role
                who="You"
                can={["Create, change and stop your baskets", "Get all unspent USDC back at any time", "Receive bought assets directly"]}
                cant={["Touch anyone else's basket"]}
              />
              <Role
                who="Keeper"
                can={["Run baskets that are due", "Choose the order and the moment within a due window"]}
                cant={["Change amounts or recipients", "Bypass the price check", "Withdraw funds"]}
              />
              <Role
                who="Owner"
                can={["List assets and their price feeds", "Set the swap adapter and savings vault", "Set fees within hard caps", "Pause new baskets"]}
                cant={["Withdraw basket funds", "Raise fees on existing baskets", "Block you from stopping a basket"]}
              />
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              The owner choosing price feeds and the swap adapter is the main trust assumption: a wrong feed would make the price
              check meaningless. A timelock on those settings is planned before mainnet.
            </p>
          </Section>

          <Section id="mainnet" title="Mainnet integration">
            <p className="mb-4 text-sm leading-relaxed text-muted">
              Coinbase's tokenized stocks are B20 tokens on Base (8 decimals), 1:1 backed by shares held in regulated custody. The
              deepest liquidity is in Aerodrome's concentrated-liquidity pools, so the mainnet adapter swaps directly against those.
              A simulation against live Base state on Nov 23, 2026 filled a $100 buy at 100.36% (NVDA) and 100.23% (AAPL) of the
              Chainlink-implied amount.
            </p>
            <Table>
              {[
                ["NVDAc", "0xb20000000000000000000078ee7ce2fE4908108C", "0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC", "0x04689a41629776563E6822F76f2e57D148d28513"],
                ["AAPLc", "0xb200000000000000000000C2e324d24d7eEcd1fb", "0xF5FCB9CDAFcE67d50AfEf298F88E709d2B946BA6", "0x787f13dEa48Db0897CbCDD985de77809D837F988"],
              ].map(([sym, token, pool, feed]) => (
                <div key={sym} className="grid gap-2 py-3 sm:grid-cols-[100px_1fr] sm:items-center">
                  <div className="text-sm font-semibold">{sym}</div>
                  <div className="flex flex-col gap-1">
                    <Addr label="token" addr={token as Address} base="https://basescan.org" />
                    <Addr label="Aerodrome pool" addr={pool as Address} base="https://basescan.org" />
                    <Addr label="Chainlink feed" addr={feed as Address} base="https://basescan.org" />
                  </div>
                </div>
              ))}
            </Table>
          </Section>

          <Section id="risks" title="Known limitations">
            <ul className="space-y-2 text-sm leading-relaxed text-muted">
              {[
                "Not audited by a third party yet. The contracts have a test suite and written self-review notes; an external review is in progress.",
                "Swaps can be sandwiched up to the slippage bound (1.5%). The price check caps the damage; it doesn't remove it.",
                "There's no Base sequencer-uptime check yet; a stale price during an outage is still bounded by the max price age.",
                "Stock prices don't move while markets are closed. A weekend buy can use Friday's close, within the max price age.",
                "Fee-on-transfer and rebasing tokens aren't supported.",
                "Tokenized stocks aren't available to US persons. Nothing here is investment advice.",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
                  {t}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      {eyebrow && <div className="font-doto mb-3 text-sm font-bold tracking-wider text-muted">{eyebrow}</div>}
      <h2 className="headline mb-5 text-[30px] md:text-[36px]">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface p-3">
      <div className="num truncate font-semibold tracking-[-0.02em]">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function Table({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line rounded-xl bg-surface px-4">{children}</div>;
}

function KV({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <div>
        <div className="text-sm">{k}</div>
        {note && <div className="text-xs text-faint">{note}</div>}
      </div>
      <div className="num text-sm font-medium sm:text-right">{v}</div>
    </div>
  );
}

function AddrRow({ label, what, addr }: { label: string; what: string; addr: Address }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
      <div>
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-muted">{what}</div>
      </div>
      <Addr addr={addr} />
    </div>
  );
}

/// An address with copy and (where there's an explorer) a link.
function Addr({ addr, label, base = explorer }: { addr: Address; label?: string; base?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
      {label && <span className="text-faint">{label}</span>}
      {base ? (
        <a href={`${base}/address/${addr}`} target="_blank" rel="noreferrer" className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink">
          <span className="hidden lg:inline">{addr}</span>
          <span className="lg:hidden">{short(addr)}</span>
        </a>
      ) : (
        <span className="text-ink">
          <span className="hidden lg:inline">{addr}</span>
          <span className="lg:hidden">{short(addr)}</span>
        </span>
      )}
      <button onClick={copy} className="text-muted transition-colors duration-150 hover:text-ink" aria-label={`Copy ${addr}`}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function Role({ who, can, cant }: { who: string; can: string[]; cant: string[] }) {
  return (
    <div className="rounded-xl bg-surface p-4">
      <div className="font-semibold">{who}</div>
      <div className="mt-3 text-xs font-medium text-muted">Can</div>
      <ul className="mt-1 space-y-1 text-sm">
        {can.map((c) => (
          <li key={c} className="flex gap-2">
            <span className="text-up">+</span>
            {c}
          </li>
        ))}
      </ul>
      <div className="mt-3 text-xs font-medium text-muted">Can't</div>
      <ul className="mt-1 space-y-1 text-sm">
        {cant.map((c) => (
          <li key={c} className="flex gap-2">
            <span className="text-down">−</span>
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}
