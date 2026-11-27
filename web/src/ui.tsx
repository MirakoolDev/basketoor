import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { coinbaseStockLogo, logoAddressFor, useTokenList } from "./tokens";
import { LOGOS } from "./logos";
import type { PlanView, StockInfo } from "./data";

/// An asset's logo, trying in order:
///  1. the explicit `src` (e.g. a token-list logo for an unlisted token),
///  2. the CoinGecko Base token list logo for its (mainnet) address,
///  3. Coinbase's official tokenized-stock logo, for stocks,
///  4. a bundled one-color brand mark,
///  5. the ticker.
export function StockLogo({
  symbol,
  token,
  kind,
  src,
  size = 32,
}: {
  symbol: string;
  token?: Address;
  kind?: "stock" | "crypto" | "index";
  src?: string;
  size?: number;
}) {
  const list = useTokenList();
  const sources = useMemo(() => {
    const s: string[] = [];
    if (src) s.push(src);
    if (token) {
      const t = list.data?.byAddress.get(logoAddressFor(symbol, token).toLowerCase());
      if (t?.logoURI && kind !== "stock") s.push(t.logoURI);
    }
    if (kind === "stock") s.push(coinbaseStockLogo(symbol));
    return s;
  }, [src, token, kind, symbol, list.data]);
  const [failed, setFailed] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setFailed(0);
    setLoaded(false);
  }, [sources]);
  const current = sources[failed];
  const path = LOGOS[symbol];
  const box = { width: size, height: size };

  return (
    <div style={{ ...box, fontSize: size * 0.28 }} className="relative grid shrink-0 place-items-center" title={symbol}>
      {!loaded && (
        <div
          style={box}
          className="grid place-items-center rounded-full bg-surface-2 font-semibold tracking-tight text-ink ring-1 ring-line"
        >
          {path ? (
            <svg viewBox="0 0 24 24" width={size * 0.52} height={size * 0.52} fill="currentColor" aria-hidden>
              <path d={path} />
            </svg>
          ) : (
            symbol.slice(0, symbol.length > 4 ? 3 : 4)
          )}
        </div>
      )}
      {current && (
        <img
          key={current}
          src={current}
          alt=""
          style={box}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setFailed((f) => f + 1);
          }}
          className={`${loaded ? "" : "absolute inset-0 opacity-0"} rounded-full bg-white object-cover ring-1 ring-line`}
        />
      )}
    </div>
  );
}

export function LogoStack({ assets, size = 26 }: { assets: (StockInfo | undefined)[]; size?: number }) {
  return (
    <div className="flex">
      {assets.map((s, i) => (
        <div key={s?.token ?? i} style={{ marginLeft: i === 0 ? 0 : -size * 0.3 }} className="rounded-full ring-2 ring-surface">
          <StockLogo symbol={s?.symbol ?? "?"} token={s?.token} kind={s?.kind} size={size} />
        </div>
      ))}
    </div>
  );
}

export function Card({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <div className={`rounded-xl bg-surface p-4 ${className}`}>{children}</div>;
}

type Theme = "system" | "light" | "dark";

/// Follows the system theme until the viewer picks one; the pick is remembered on this device.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("dcac-theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("dcac-theme");
      else localStorage.setItem("dcac-theme", theme);
    } catch {
      /* storage blocked: the choice just won't persist */
    }
  }, [theme]);
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const label = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" }[theme];
  return (
    <button
      onClick={() => setTheme(next[theme])}
      title={label}
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-full bg-surface text-muted transition-colors duration-150 hover:text-ink"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {theme === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : theme === "dark" ? (
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
          </>
        )}
      </svg>
    </button>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
  className?: string;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-brand text-white disabled:bg-surface disabled:text-faint",
    ghost: "bg-surface text-ink hover:bg-line disabled:text-faint",
    danger: "bg-surface text-down hover:bg-line disabled:text-faint",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`h-12 rounded-xl px-5 text-[15px] font-medium transition duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "up" | "down" | "brand" | "warn" }) {
  const styles = {
    neutral: "text-muted ring-1 ring-line",
    up: "text-up ring-1 ring-line",
    down: "text-down ring-1 ring-line",
    brand: "text-brand-ink ring-1 ring-line",
    warn: "bg-warn text-[#0a0b0d]",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="text-sm text-muted">
        {label}
        {hint && <div className="text-xs text-faint">{hint}</div>}
      </div>
      <div className="num text-right text-sm font-medium">{children}</div>
    </div>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Spinner() {
  return <div className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand-ink" />;
}

/// Value of a plan's holdings at today's oracle prices.
export function valuePlan(plan: PlanView, stocks: StockInfo[] | undefined) {
  let value = 0;
  const legs = plan.legs.map((l) => {
    const s = stocks?.find((x) => x.token.toLowerCase() === l.token.toLowerCase());
    const shares = s ? Number(l.received) / 10 ** s.decimals : 0;
    const spent = Number(l.spent) / 1e6;
    const legValue = s ? shares * s.price : 0;
    value += legValue;
    return {
      ...l,
      stock: s,
      shares,
      spentUsd: spent,
      value: legValue,
      avgPrice: shares > 0 ? spent / shares : 0,
      pnl: legValue - spent,
    };
  });
  const invested = Number(plan.totalSpent) / 1e6;
  return { legs, value, invested, pnl: value - invested, pnlPct: invested > 0 ? (value - invested) / invested : 0 };
}

/// An action bar pinned to the bottom of the screen. It reserves its own height in the page flow, so
/// nothing (like the last card) ever ends up hidden behind it, whatever the bar holds.
export function BottomBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(96);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <>
      <div aria-hidden style={{ height: h }} />
      <div
        ref={ref}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]"
      >
        <div className="pointer-events-auto mx-auto max-w-md">{children}</div>
      </div>
    </>
  );
}
