import { writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/// Dev server only: lets the deploy page (#/deploy) save what it deployed to contracts/deployments/<chainId>.json,
/// where the app and the keeper read it.
function saveDeployments(): Plugin {
  return {
    name: "save-deployments",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__deployments", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const d = JSON.parse(body);
            const addr = /^0x[0-9a-fA-F]{40}$/;
            if (!Number.isInteger(d.chainId) || d.chainId <= 0 || !addr.test(d.dcac) || !Array.isArray(d.stocks)) throw new Error("bad");
            writeFileSync(new URL(`../contracts/deployments/${d.chainId}.json`, import.meta.url), JSON.stringify(d, null, 2) + "\n");
            res.end("ok");
          } catch {
            res.statusCode = 400;
            res.end("bad deployment");
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), saveDeployments()],
  // deployments/*.json live in ../contracts
  server: { fs: { allow: [".."] }, port: 5173 },
});
