// DCAC's MCP server (Streamable HTTP, stateless JSON responses), served at https://dcac.fun/mcp.
// Add it to Claude, Cursor or any MCP client as a remote server. No auth: every tool reads public chain data
// or returns unsigned transactions.

import { json, runTool, ToolError, TOOLS } from "./_lib/dcac.js";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const PROTOCOL = "2025-06-18";
const INSTRUCTIONS =
  "DCAC runs recurring buys (DCA) of Coinbase tokenized stocks, crypto and Bankr index tokens on Base. " +
  "To set up a plan: dcac_assets (or dcac_indexes) to find assets, dcac_quote to price it, then dcac_build_plan. " +
  "Give the user the signInApp link from dcac_build_plan; only hand over raw transactions if they ask. " +
  "Nothing here can sign. Never ask for a private key or seed phrase. Not investment advice.";

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function one(m: Rpc) {
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dcac", title: "DCAC", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      try {
        const out = await runTool(name, m.params?.arguments ?? {});
        const text = JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
        return ok(m.id, { content: [{ type: "text", text }], structuredContent: out });
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : "Couldn't read Base right now. Try again shortly.";
        if (!(e instanceof ToolError)) console.error(e);
        return ok(m.id, { content: [{ type: "text", text: msg }], isError: true });
      }
    }
    default:
      if (m.id === undefined || m.method.startsWith("notifications/")) return undefined; // notifications get no reply
      return err(m.id, -32601, `Method not found: ${m.method}`);
  }
}

export async function POST(req: Request) {
  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return json(err(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(one))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await one(body);
  return out ? json(out) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
}

// No server-to-client stream: this server only answers requests.
export const GET = () =>
  new Response(JSON.stringify({ name: "DCAC MCP server", transport: "streamable-http", endpoint: "https://dcac.fun/mcp", guide: "https://dcac.fun/agents.md" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST", "access-control-allow-origin": "*" },
  });
export const DELETE = () => new Response(null, { status: 405, headers: { allow: "POST" } });
export const OPTIONS = () => json({});
