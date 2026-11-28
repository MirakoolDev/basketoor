// GET  /api/agents                 -> the tool list
// GET  /api/agents/<tool>?a=b      -> run a tool with query parameters (mix as JSON or "MAG7:15,ETH:5")
// POST /api/agents/<tool> {json}   -> run a tool with a JSON body
// Vercel rewrites /api/agents/<tool> to /api/agents?tool=<tool> (vercel.json).

import { json, runTool, ToolError, TOOLS } from "./_lib/dcac.js";

function fromQuery(q: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of q) {
    if (k === "tool") continue;
    if (k === "mix") {
      out.mix = v.trim().startsWith("[")
        ? JSON.parse(v)
        : v.split(",").map((p) => {
            const [asset, usd] = p.split(":");
            return { asset, usd: Number(usd) };
          });
    } else if (v === "true" || v === "false") out[k] = v === "true";
    else out[k] = v;
  }
  return out;
}

async function handle(req: Request) {
  const url = new URL(req.url);
  const tool = url.searchParams.get("tool") ?? url.pathname.split("/").filter(Boolean)[2];
  if (!tool) {
    return json({
      name: "DCAC agent API",
      about: "Recurring buys of tokenized stocks, crypto and Bankr index tokens on Base. Read-only, plus unsigned transactions for the user's wallet to sign.",
      guide: "https://dcac.fun/agents.md",
      mcp: "https://dcac.fun/mcp",
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input: t.inputSchema })),
    });
  }
  try {
    const args = req.method === "POST" ? await req.json().catch(() => ({})) : fromQuery(url.searchParams);
    return json(await runTool(tool, args));
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, 400);
    if (e instanceof SyntaxError) return json({ error: "mix must be JSON or SYMBOL:usd pairs, e.g. MAG7:15,ETH:5" }, 400);
    console.error(e);
    return json({ error: "Couldn't read Base right now. Try again shortly." }, 502);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = () => json({});
