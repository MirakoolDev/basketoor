// Regenerates api/_lib/deployment.ts from contracts/deployments/8453.json. Run from the repo root.
const d = require("../../contracts/deployments/8453.json");
const keep = { dcac: d.dcac, usdc: d.usdc, stocks: d.stocks.map((s) => ({ symbol: s.symbol, name: s.name, kind: s.kind, token: s.token, pricing: s.pricing })) };
require("fs").writeFileSync(
  require("path").join(__dirname, "deployment.ts"),
  "// Generated from contracts/deployments/8453.json by: node api/_lib/export-deployment.cjs\n// The agent API reads DCAC's Base deployment from here.\nexport const deployment = " +
    JSON.stringify(keep, null, 2) +
    ' as { dcac: string; usdc: string; stocks: { symbol: string; name: string; kind?: "stock" | "crypto" | "index"; token: string; pricing?: string }[] };\n',
);
