import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { CHAIN_ID, dep } from "./config";
import { short } from "./format";
import { Card, ThemeToggle } from "./ui";
import { Landing } from "./Landing";
import { About } from "./About";
import { Home } from "./Home";
import { PlanForm } from "./PlanForm";
import { PlanDetail } from "./PlanDetail";

export type Route = { page: "home" } | { page: "about" } | { page: "new" } | { page: "plan"; id: bigint } | { page: "edit"; id: bigint };

function parse(hash: string): Route {
  const [, a, b, c] = hash.replace(/^#/, "").split("/");
  if (a === "new") return { page: "new" };
  if (a === "about") return { page: "about" };
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

  if (!dep)
    return (
      <Shell>
        <Card>No deployment found for chain {CHAIN_ID}. Run the deploy script in contracts/ first.</Card>
      </Shell>
    );

  if (route.page === "about") return <About />;
  if (!isConnected) return <Landing />;

  return (
    <Shell>
      {route.page === "new" ? (
        <PlanForm />
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
        Basketoor on {CHAIN_ID === 8453 ? "Base" : CHAIN_ID === 84532 ? "Base Sepolia" : "a local chain"}.
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
        <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-full ring-1 ring-line" />
        <span className="text-lg font-semibold tracking-[-0.02em]">basketoor</span>
      </button>
      <div className="flex items-center gap-2">
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
