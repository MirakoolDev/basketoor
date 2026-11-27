import { lazy, Suspense, useEffect, useState } from "react";
import { Wordmark } from "./Wordmark";
import { useAccount, useDisconnect } from "wagmi";
import { CHAIN_ID, dep } from "./config";
import { short } from "./format";
import { Card, Spinner, ThemeToggle } from "./ui";
import { Landing } from "./Landing";
import { CreateIndex, IndexPage, Indexes } from "./Indexes";
import { About } from "./About";
import { Explore } from "./Explore";
import { Home } from "./Home";
import { PlanForm } from "./PlanForm";
import { PlanDetail } from "./PlanDetail";

// Loaded only when opened: it carries the contracts' bytecode.
const Deploy = lazy(() => import("./Deploy").then((m) => ({ default: m.Deploy })));

export type Route = { page: "indexes" } | { page: "index-new" } | { page: "index"; address: `0x${string}` } | { page: "home" } | { page: "about" } | { page: "deploy" } | { page: "new" } | { page: "copy"; id: bigint } | { page: "explore" } | { page: "plan"; id: bigint } | { page: "edit"; id: bigint };

function parse(hash: string): Route {
  const [, a, b, c] = hash.replace(/^#/, "").split("?")[0].split("/");
  if (a === "new") return { page: "new" };
  if (a === "about") return { page: "about" };
  if (a === "explore") return { page: "explore" };
  if (a === "indexes" && b === "new") return { page: "index-new" };
  if (a === "indexes" && b && /^0x[0-9a-fA-F]{40}$/.test(b)) return { page: "index", address: b as `0x${string}` };
  if (a === "indexes") return { page: "indexes" };
  if (a === "b" && b && /^\d+$/.test(b)) return { page: "copy", id: BigInt(b) };
  if (a === "deploy") return { page: "deploy" };
  if (a === "plan" && b && /^\d+$/.test(b)) return c === "edit" ? { page: "edit", id: BigInt(b) } : { page: "plan", id: BigInt(b) };
  return { page: "home" };
}

export const go = (path: string) => {
  window.location.hash = path;
  window.scrollTo(0, 0);
};

export function App() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const { isConnected } = useAccount();

  if (route.page === "deploy")
    return (
      <Shell>
        <Suspense fallback={<Spinner />}>
          <Deploy />
        </Suspense>
      </Shell>
    );

  if (!dep)
    return (
      <Shell>
        <Card>
          No deployment found for chain {CHAIN_ID}.{" "}
          <a href="#/deploy" className="underline underline-offset-2">
            Deploy one
          </a>{" "}
          or run the deploy script in contracts/.
        </Card>
      </Shell>
    );

  if (route.page === "about") return <About />;
  if (route.page === "explore") return <Explore />;
  if (route.page === "indexes") return <Indexes />;
  if (route.page === "index") return <IndexPage key={route.address} address={route.address} />;
  if (route.page === "index-new") return <CreateIndex />;
  // Shared basket links open without a wallet, so people see the mix before they sign in.
  const sharedLink = route.page === "copy" || (route.page === "new" && window.location.hash.includes("?"));
  if (!isConnected && !sharedLink) return <Landing />;

  return (
    <Shell>
      {route.page === "new" ? (
        <PlanForm key={window.location.hash} /> // a new shared-basket link starts a fresh form
      ) : route.page === "copy" ? (
        <PlanForm key={`copy-${route.id}`} copyId={route.id} />
      ) : route.page === "edit" ? (
        <PlanForm key={route.id.toString()} editId={route.id} />
      ) : route.page === "plan" ? (
        <PlanDetail id={route.id} />
      ) : (
        <Home />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-md px-4 pb-6">
      <Header />
      {children}
      <footer className="mt-10 text-center text-xs leading-relaxed text-faint">
        DCAC on {CHAIN_ID === 8453 ? "Base" : CHAIN_ID === 84532 ? "Base Sepolia" : "a local chain"}.
        {dep?.mock && " Test assets priced from Base mainnet Chainlink feeds."}
{" "}
        <a href="#/about" className="underline underline-offset-2 hover:text-ink">
          Contracts & details
        </a>
        <br />
        Tokenized stocks aren't available to US persons. Not investment advice.
      </footer>
    </div>
  );
}

function Header() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  return (
    <header className="sticky top-0 z-10 -mx-4 mb-4 flex h-16 items-center justify-between bg-bg px-4">
      <button onClick={() => go("/")} className="flex items-center gap-2">
        <Wordmark className="h-7 w-auto" />
      </button>
      <div className="flex items-center gap-2">
        <a href="#/explore" className="px-1 text-sm text-muted transition-colors duration-150 hover:text-ink">
          Explore
        </a>
        <a href="#/indexes" className="px-1 text-sm text-muted transition-colors duration-150 hover:text-ink">
          Indexes
        </a>
        <a href="#/about" className="px-1 text-sm text-muted transition-colors duration-150 hover:text-ink">
          About
        </a>
        <ThemeToggle />
        {isConnected && address && (
          <button
            onClick={() => disconnect()}
            title="Disconnect"
            className="h-9 rounded-full bg-surface px-3 font-mono text-[13px] text-muted transition-colors duration-150 hover:text-ink"
          >
            {short(address)}
          </button>
        )}
      </div>
    </header>
  );
}
