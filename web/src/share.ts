import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { PlanView } from "./data";

/// A shared basket travels in the link: who made it, the mix (each asset's dollars per buy in the original, which
/// sets the proportions), how often, and its name. Nothing about it is stored onchain until someone opens a plan
/// from it, and then only the creator's address, so they get their share of that plan's buy fees.
export type SharedBasket = { creator: Address; legs: { token: Address; usd: number }[]; interval: number; name: string; smart: boolean; buys?: number };

/// The short link to copy basket #id: the app reads its mix from the chain.
export const basketLink = (id: bigint) => `${window.location.origin}${window.location.pathname}#/b/${id}`;

/// A plan as a basket to copy. Its creator is whoever made the mix: the original maker if this plan was itself
/// copied, otherwise its owner.
export function basketOf(p: PlanView): SharedBasket {
  return {
    creator: p.creator !== zeroAddress ? p.creator : p.owner,
    legs: p.legs.filter((l) => l.amount > 0n).map((l) => ({ token: l.token, usd: Number(l.amount) / 1e6 })),
    interval: p.interval,
    name: p.name,
    smart: p.smart,
  };
}

/// The long form, carrying the whole mix in the link. Still read (see `readShared`); `basketLink` is what the app hands out.
export function shareLink(b: SharedBasket): string {
  const q = new URLSearchParams({
    from: b.creator,
    mix: b.legs.map((l) => `${l.token}:${+l.usd.toFixed(2)}`).join(","),
    every: String(b.interval),
    name: b.name,
  });
  if (b.smart) q.set("rebalance", "1");
  return `${window.location.origin}${window.location.pathname}#/new?${q}`;
}

/// The shared basket in the current link, if it is one and it parses.
export function readShared(hash = window.location.hash): SharedBasket | undefined {
  const i = hash.indexOf("?");
  if (i < 0) return undefined;
  const q = new URLSearchParams(hash.slice(i + 1));
  const from = q.get("from") ?? "";
  const legs = (q.get("mix") ?? "")
    .split(",")
    .map((part) => {
      const [t, v] = part.split(":");
      const usd = Number(v);
      return isAddress(t ?? "") && Number.isFinite(usd) && usd > 0 ? { token: getAddress(t), usd } : undefined;
    })
    .filter((l): l is { token: Address; usd: number } => !!l)
    .slice(0, 5);
  if (!legs.length) return undefined;
  const interval = Number(q.get("every"));
  const buys = Math.floor(Number(q.get("buys"))); // set by agent-built links; people pick their own otherwise
  return {
    creator: isAddress(from) ? getAddress(from) : zeroAddress,
    legs,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 86400,
    name: (q.get("name") ?? "").slice(0, 64),
    smart: q.get("rebalance") === "1",
    buys: buys > 0 && buys <= 10_000 ? buys : undefined,
  };
}
