// Smoke test of the agent tools against live Base (reads only): npx tsx api/_smoke.mts
import { runTool } from "./_lib/dcac";
import { POST } from "./mcp";
const show = async (n: string, a: unknown) => { try { const r = await runTool(n, a); console.log("##", n, JSON.stringify(r).slice(0, 900)); } catch (e) { console.log("##", n, "ERR", (e as Error).message); } };
await show("dcac_assets", { search: "nvda" });
await show("dcac_indexes", { limit: 3 });
await show("dcac_quote", { mix: [{ asset: "NVDA", usd: 15 }, { asset: "ETH", usd: 5 }], every: "week", buys: 52 });
await show("dcac_build_plan", { mix: [{ asset: "AAPLc", usd: 10 }], every: "2 weeks", buys: 4, owner: "0x3DAb104D8A1338Bb728310453DeBb6f2dc9D2Ef9" });
await show("dcac_quote", { mix: [{ asset: "MAG7", usd: 10 }], every: "week", buys: 4 });
await show("dcac_quote", { mix: [{ asset: "NVDA", usd: 0.5 }], every: "week", buys: 4 });
await show("dcac_plan", { id: 1 });
await show("dcac_build_cancel", { id: 99 });
const r = await POST(new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
console.log("## mcp", r.status, (await r.text()).slice(0, 200));
const r2 = await POST(new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
console.log("## notif", r2.status);
