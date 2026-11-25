export const money = (n: number, opts: { sign?: boolean; digits?: number } = {}) => {
  const d = opts.digits ?? 2;
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = n < 0 ? "-" : opts.sign && n > 0 ? "+" : "";
  return `${sign}$${s}`;
};

export const pct = (n: number) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;

export const qty = (n: number) => {
  if (n === 0) return "0";
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};

export const every = (seconds: number) => {
  if (seconds % (7 * 86400) === 0) return seconds === 7 * 86400 ? "every week" : `every ${seconds / (7 * 86400)} weeks`;
  if (seconds % 86400 === 0) return seconds === 86400 ? "every day" : `every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "every hour" : `every ${seconds / 3600} hrs`;
  return `every ${Math.round(seconds / 60)} min`;
};

export const countdown = (target: number, now: number) => {
  let s = Math.max(0, target - now);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "any moment";
};

export const dateTime = (t: number) =>
  new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const date = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
