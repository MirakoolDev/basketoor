// Copies the creation bytecode of the contracts the testnet deploy page needs out of Foundry's build output.
// Run after `forge build` whenever the contracts change:  node scripts/export-bytecode.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../contracts/out");
const pick = {
  Basketoor: "Basketoor.sol/Basketoor.json",
  MockUSDC: "Mocks.sol/MockUSDC.json",
  MockStock: "Mocks.sol/MockStock.json",
  MockFeed: "Mocks.sol/MockFeed.json",
  MockSwapAdapter: "Mocks.sol/MockSwapAdapter.json",
  MockSavingsVault: "Mocks.sol/MockSavingsVault.json",
};

const result = {};
for (const [name, file] of Object.entries(pick)) {
  const j = JSON.parse(readFileSync(join(out, file), "utf8"));
  if (!j.bytecode?.object || j.bytecode.object === "0x") throw new Error(`${name}: no bytecode, run forge build`);
  result[name] = j.bytecode.object;
}
const dest = join(here, "../src/deploy/bytecode.json");
writeFileSync(dest, JSON.stringify(result) + "\n");
console.log("wrote", dest);
