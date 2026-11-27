import { useConnect } from "wagmi";
import { Wordmark } from "./Wordmark";
import { CHAIN_ID, dep, isLocal } from "./config";
import { useStocks, type StockInfo } from "./data";
import { money } from "./format";
import { Button, LogoStack, Spinner, StockLogo, ThemeToggle } from "./ui";

/// The public page people land on before connecting.
export function Landing() {
  const stocks = useStocks();
  const pick = (syms: string[]) => syms.map((s) => stocks.data?.find((x) => x.symbol === s));

  return (
    <div className="min-h-dvh">
      <SiteNav landing />

      <main className="mx-auto max-w-5xl px-4">
        {/* Hero */}
        <section id="start" className="rise grid scroll-mt-20 items-center gap-10 py-12 md:grid-cols-[1.1fr_1fr] md:py-20">
          <div>
            <div className="font-doto text-sm font-bold tracking-wider text-muted">RECURRING BUYS · ON BASE</div>
            <h1 className="headline mt-4 text-[44px] md:text-[64px]">
              Stocks and crypto,
              <br />
              bought on autopilot.
            </h1>
            <p className="mt-5 max-w-md text-[17px] leading-[1.45] text-muted">
              Build a basket of up to five tokenized stocks and tokens. Pick how much and how often. DCAC buys them
              onchain, on schedule, straight into your wallet, and checks every fill against Chainlink.
            </p>
            <div className="mt-8 max-w-sm">
              <Connect />
            </div>
          </div>
          <HeroBasket assets={pick(["NVDA", "AAPL", "ETH"])} loading={stocks.isLoading} />
        </section>

        {/* Live assets */}
        <section className="border-y border-line py-6">
          <div className="mb-4 flex items-baseline justify-between">
            <div className="text-sm font-medium">What you can buy</div>
            <div className="font-mono text-xs text-faint">live Chainlink prices</div>
          </div>
          {stocks.isLoading ? (
            <Spinner />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
              {stocks.data?.map((s) => (
                <div key={s.token} className="flex items-center gap-2.5 rounded-lg bg-surface p-2.5">
                  <StockLogo symbol={s.symbol} token={s.token} kind={s.kind} size={28} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{s.symbol}</div>
                    <div className="num truncate text-xs text-muted">
                      {s.usable ? money(s.price, { digits: s.price < 1 ? 4 : 2 }) : "Market closed"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-faint">
            Coinbase tokenized stocks (1:1 backed by shares in regulated custody) and Base's major tokens.
          </p>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-20 py-16">
          <h2 className="headline text-[32px] md:text-[40px]">How it works</h2>
          <div className="mt-8 grid gap-3 md:grid-cols-3">
            {[
              ["01", "Build a basket", "Choose up to five assets and a USDC amount for each. Mix NVDA with ETH if you like."],
              ["02", "Set the schedule", "Every hour, day or week, for as many buys as you want. You deposit the whole budget once."],
              ["03", "DCAC buys", "Each buy runs automatically onchain. Shares land in your wallet; unspent USDC can earn yield meanwhile."],
            ].map(([n, t, d]) => (
              <div key={n} className="rounded-xl bg-surface p-5">
                <div className="font-doto text-sm font-bold text-faint">{n}</div>
                <div className="mt-6 text-lg font-semibold tracking-[-0.02em]">{t}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Shared baskets */}
        <section className="pb-16">
          <div className="rounded-2xl bg-surface p-6 md:p-10">
            <div className="font-doto text-sm font-bold tracking-wider text-muted">SHARED BASKETS</div>
            <h2 className="headline mt-3 max-w-xl text-[32px] md:text-[40px]">Build an index. Earn when it's copied.</h2>
            <p className="mt-3 max-w-xl text-muted">
              Every basket has a link. When someone starts their own basket from yours, you get half of the fee on each of their
              buys, paid in USDC as it happens. It costs them nothing extra.
            </p>
            <div className="mt-6 grid gap-3 md:grid-cols-3">
              {[
                ["Your mix, their schedule", "Copiers keep your weights and pick their own amount and frequency. It's their basket, in their wallet."],
                ["Paid on every buy", "50% of each buy fee goes to the basket's creator, onchain, for as long as the copy runs."],
                ["A public track record", "Baskets with three or more buys show up on Explore, ranked by return so far."],
              ].map(([t, d]) => (
                <div key={t} className="rounded-xl bg-bg p-5 ring-1 ring-line">
                  <div className="font-semibold tracking-[-0.01em]">{t}</div>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
              <a href="#/explore" className="underline-offset-4 hover:underline">Explore baskets →</a>
              <a href="#start" className="underline-offset-4 hover:underline">Build your own →</a>
            </div>
          </div>
        </section>

        {/* Why */}
        <section className="pb-16">
          <h2 className="headline text-[32px] md:text-[40px]">Built to be trusted with a schedule</h2>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {[
              [
                "Every fill is price-checked",
                "Before a buy is accepted, the contract compares it with the Chainlink price. Anything more than 1.5% worse is skipped and the USDC stays in your basket.",
              ],
              [
                "Your keys, your shares",
                "Bought assets go straight to your wallet. Unspent USDC sits in the contract, and only you can withdraw it: stop anytime and get it all back.",
              ],
              [
                "Idle cash earns yield",
                "Optionally park the USDC waiting for its turn in a savings vault. You keep 90% of what it earns.",
              ],
              [
                "One tap with Base Account",
                "Approve and start a basket in a single confirmation. No gas token juggling, no extensions needed.",
              ],
            ].map(([t, d]) => (
              <div key={t} className="rounded-xl bg-surface p-5">
                <div className="font-semibold tracking-[-0.01em]">{t}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-20 pb-16">
          <h2 className="headline text-[32px] md:text-[40px]">Simple pricing</h2>
          <div className="mt-8 grid gap-3 md:grid-cols-3">
            <Price big="0.5%" label="per buy" note="Or $0.10, whichever is higher. +0.25% with auto-rebalance on. Only charged on USDC actually spent." />
            <Price big="10%" label="of savings yield" note="Only if you turn savings on. Taken when the basket ends." />
            <Price big="$0" label="subscription" note="No monthly plan, no exit fee. Stop anytime and get unspent USDC back." />
          </div>
        </section>

        {/* FAQ */}
        <section className="pb-16">
          <h2 className="headline text-[32px] md:text-[40px]">Questions</h2>
          <div className="mt-6 divide-y divide-line border-y border-line">
            {[
              [
                "Who presses the buy button?",
                "An automated keeper runs every due basket on schedule. It can only trigger buys that are due; amounts, recipient and the price check are fixed by your basket and the contract.",
              ],
              [
                "What if the stock market is closed?",
                "The Chainlink price goes stale, so that stock is skipped for this round and its USDC stays in your basket. The rest of the basket still buys.",
              ],
              [
                "Can I change or stop a basket?",
                "Yes. Change amounts, frequency or the number of buys, or stop it and get every unspent dollar back in the same transaction.",
              ],
              [
                "Who can use it?",
                "Anyone outside the US. Tokenized stocks aren't available to US persons, and DCAC isn't investment advice.",
              ],
            ].map(([q, a]) => (
              <details key={q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {q}
                  <span className="text-muted transition-transform duration-200 group-open:rotate-45">+</span>
                </summary>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="mb-16 rounded-2xl bg-surface p-6 md:flex md:items-center md:justify-between md:p-10">
          <div>
            <h2 className="headline text-[32px]">Stop timing the market.</h2>
            <p className="mt-2 text-muted">Pick your stocks once. DCAC does the buying. It takes about a minute.</p>
          </div>
          <a
            href="#start"
            className="mt-6 inline-grid h-12 place-items-center rounded-xl bg-brand px-6 text-[15px] font-medium text-white transition duration-150 active:scale-[0.98] md:mt-0"
          >
            Launch app
          </a>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

/// Top bar shared by the public pages (landing and about).
export function SiteNav({ landing = false }: { landing?: boolean }) {
  const link = "hidden px-3 text-sm text-muted transition-colors duration-150 hover:text-ink sm:block";
  return (
    <nav className="sticky top-0 z-20 border-b border-line bg-bg">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
        <a href="#/" className="flex items-center gap-2">
          <Wordmark className="h-7 w-auto" />
        </a>
        <div className="flex items-center gap-2">
          {landing && (
            <>
              <a href="#how" className={link}>How it works</a>
              <a href="#pricing" className={link}>Pricing</a>
            </>
          )}
          <a href="#/explore" className="px-2 text-sm text-muted transition-colors duration-150 hover:text-ink sm:px-3">
            Explore
          </a>
          <a href="#/about" className="hidden px-2 text-sm text-muted transition-colors duration-150 hover:text-ink sm:block sm:px-3">
            About
          </a>
          <ThemeToggle />
          <a
            href={landing ? "#start" : "#/"}
            className="grid h-9 place-items-center rounded-full bg-ink px-4 text-sm font-medium text-bg transition-opacity duration-150 hover:opacity-90"
          >
            Launch app
          </a>
        </div>
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs text-faint sm:flex-row sm:justify-between">
        <div>
          DCAC on {CHAIN_ID === 8453 ? "Base" : CHAIN_ID === 84532 ? "Base Sepolia" : "a local chain"}.
          {dep?.mock && " Test assets priced from Base mainnet Chainlink feeds."}{" "}
          <a href="#/about" className="underline underline-offset-2 hover:text-ink">Contracts & details</a>
        </div>
        <div>Tokenized stocks aren't available to US persons. Not investment advice.</div>
      </div>
    </footer>
  );
}

function Price({ big, label, note }: { big: string; label: string; note: string }) {
  return (
    <div className="rounded-xl bg-surface p-5">
      <div className="flex items-baseline gap-2">
        <span className="headline text-[40px]">{big}</span>
        <span className="text-sm text-muted">{label}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">{note}</p>
    </div>
  );
}

/// An illustrative basket built from live prices, styled like the app's own cards.
function HeroBasket({ assets, loading }: { assets: (StockInfo | undefined)[]; loading: boolean }) {
  const legs: [StockInfo | undefined, number][] = [
    [assets[0], 25],
    [assets[1], 15],
    [assets[2], 10],
  ];
  return (
    <div className="rounded-2xl bg-surface p-5 ring-1 ring-line">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">Core 3</div>
          <div className="text-sm text-muted">$50 every week · 52 buys</div>
        </div>
        <LogoStack assets={assets} />
      </div>
      <div className="mt-5 space-y-2">
        {legs.map(([s, amt], i) => (
          <div key={s?.token ?? i} className="flex items-center gap-3 rounded-xl bg-bg p-3">
            {s ? <StockLogo symbol={s.symbol} token={s.token} kind={s.kind} size={30} /> : <div className="h-[30px] w-[30px]" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{s?.symbol ?? (loading ? "…" : "")}</div>
              <div className="num text-xs text-muted">{s?.usable ? money(s.price) : "Market closed"}</div>
            </div>
            <div className="num text-right text-sm font-medium">{money(amt)}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-4 text-sm">
        <span className="text-muted">Next buy</span>
        <span className="num font-medium">Monday, 14:00</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-sm">
        <span className="text-muted">Savings yield</span>
        <span className="num font-medium text-up">earning</span>
      </div>
    </div>
  );
}

/// Wallet options; the first is the primary action.
export function Connect() {
  const { connectors, connect, isPending, error } = useConnect();
  const label = (id: string, name: string) =>
    id === "baseAccount" ? "Sign in with Base" : id === "mock" ? "Use dev wallet (local)" : id === "injected" ? "Browser wallet" : name;
  const ordered = [...connectors]
    .filter((c) => !(isLocal && c.id === "baseAccount"))
    .sort((a, b) => (a.id === "mock" ? -1 : b.id === "mock" ? 1 : 0));
  return (
    <div className="flex flex-col gap-3">
      {ordered.map((c, i) => (
        <Button key={c.uid} variant={i === 0 ? "primary" : "ghost"} onClick={() => connect({ connector: c })} disabled={isPending}>
          {label(c.id, c.name)}
        </Button>
      ))}
      {error && <p className="text-sm text-down">{error.message.split("\n")[0]}</p>}
    </div>
  );
}
