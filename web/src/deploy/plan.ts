import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import bytecode from "./bytecode.json";
import type { Deployment } from "../config";

/// The same testnet deployment as contracts/script/DeployTestnet.s.sol, as wallet calls instead of a Foundry
/// broadcast. Contracts are created through the standard CREATE2 deployer (present on Base, Base Sepolia and
/// anvil), so every address is known up front and a wallet can deploy and configure in a few batches.
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

// Keep in sync with DeployTestnet.s.sol. Seed prices are rough (8 decimals); the keeper's --sync-prices
// replaces them with Base mainnet Chainlink prices.
export const LISTINGS = [
  { symbol: "AAPL", name: "Apple", kind: "stock", decimals: 8, seed: 230e8 },
  { symbol: "AMZN", name: "Amazon", kind: "stock", decimals: 8, seed: 220e8 },
  { symbol: "GOOGL", name: "Alphabet", kind: "stock", decimals: 8, seed: 250e8 },
  { symbol: "META", name: "Meta Platforms", kind: "stock", decimals: 8, seed: 700e8 },
  { symbol: "MSFT", name: "Microsoft", kind: "stock", decimals: 8, seed: 500e8 },
  { symbol: "MSTR", name: "Strategy", kind: "stock", decimals: 8, seed: 300e8 },
  { symbol: "NVDA", name: "NVIDIA", kind: "stock", decimals: 8, seed: 180e8 },
  { symbol: "SNDK", name: "Sandisk", kind: "stock", decimals: 8, seed: 100e8 },
  { symbol: "SPCX", name: "SPCX", kind: "stock", decimals: 8, seed: 100e8 },
  { symbol: "TSLA", name: "Tesla", kind: "stock", decimals: 8, seed: 400e8 },
  { symbol: "ETH", name: "Ether", kind: "crypto", decimals: 18, seed: 2000e8 },
  { symbol: "cbBTC", name: "Coinbase Wrapped BTC", kind: "crypto", decimals: 8, seed: 60000e8 },
  { symbol: "cbETH", name: "Coinbase Wrapped Staked ETH", kind: "crypto", decimals: 18, seed: 2200e8 },
  { symbol: "AERO", name: "Aerodrome", kind: "crypto", decimals: 18, seed: 0.5e8 },
  { symbol: "LINK", name: "Chainlink", kind: "crypto", decimals: 18, seed: 10e8 },
] as const;

const ASSETS_PER_BATCH = 3;

const abi = parseAbi([
  "function setSavingsVault(address vault)",
  "function setKeeper(address keeper, bool allowed)",
  "function setAsset(address token, address feed, bool enabled)",
  "function setMinter(address minter)",
  "function setFeed(address token, address feed)",
  "function setUpdater(address who, bool allowed)",
]);

export type Call = { to: Address; data: Hex; label: string; creates?: Address };
export type Batch = { title: string; calls: Call[] };
export type Roles = { owner: Address; keeper: Address; priceUpdater: Address; treasury: Address };

export function buildDeployment(roles: Roles, salt: Hex, chainId: number) {
  const { owner, keeper, priceUpdater, treasury } = roles;
  const create = (label: string, code: string, args: Hex = "0x"): Call & { creates: Address } => {
    const s = keccak256(encodePacked(["bytes32", "string"], [salt, label]));
    const initCode = concat([code as Hex, args]);
    const creates = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: s, bytecode: initCode });
    return { to: CREATE2_DEPLOYER, data: concat([s, initCode]), label: `Deploy ${label}`, creates };
  };
  const call = (to: Address, label: string, functionName: (typeof abi)[number]["name"], args: readonly unknown[]): Call => ({
    to,
    label,
    data: encodeFunctionData({ abi, functionName, args } as never),
  });
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

  const usdc = create("test USDC", bytecode.MockUSDC);
  const venue = create("test swap venue", bytecode.MockSwapAdapter, encodeAbiParameters(parseAbiParameters("address"), [owner]));
  const vault = create("test savings vault", bytecode.MockSavingsVault, encodeAbiParameters(parseAbiParameters("address"), [usdc.creates]));
  const basketoor = create(
    "Basketoor",
    bytecode.Basketoor,
    encodeAbiParameters(parseAbiParameters("address, address, address, address"), [usdc.creates, venue.creates, treasury, owner]),
  );
  const b = basketoor.creates;

  const core: Call[] = [usdc, venue, vault, basketoor, call(b, "Use the savings vault", "setSavingsVault", [vault.creates])];
  core.push(call(b, "Allow the owner to run buys", "setKeeper", [owner, true]));
  if (!same(keeper, owner)) core.push(call(b, "Allow the keeper to run buys", "setKeeper", [keeper, true]));
  const batches: Batch[] = [{ title: "Core contracts", calls: core }];

  const stocks: Deployment["stocks"] = [];
  for (let i = 0; i < LISTINGS.length; i += ASSETS_PER_BATCH) {
    const group = LISTINGS.slice(i, i + ASSETS_PER_BATCH);
    const calls: Call[] = [];
    for (const l of group) {
      const token = create(
        `${l.symbol} token`,
        bytecode.MockStock,
        encodeAbiParameters(parseAbiParameters("string, string, uint8, address"), [l.name, l.symbol, l.decimals, owner]),
      );
      const feed = create(
        `${l.symbol} price feed`,
        bytecode.MockFeed,
        encodeAbiParameters(parseAbiParameters("uint8, int256, address"), [8, BigInt(l.seed), owner]),
      );
      calls.push(token, feed);
      if (!same(priceUpdater, owner)) calls.push(call(feed.creates, `Let the price updater set ${l.symbol}`, "setUpdater", [priceUpdater, true]));
      calls.push(
        call(token.creates, `Let the venue mint ${l.symbol}`, "setMinter", [venue.creates]),
        call(venue.creates, `Give the venue the ${l.symbol} price`, "setFeed", [token.creates, feed.creates]),
        call(b, `List ${l.symbol}`, "setAsset", [token.creates, feed.creates, true]),
      );
      stocks.push({ symbol: l.symbol, name: l.name, kind: l.kind, token: token.creates, feed: feed.creates });
    }
    batches.push({ title: group.map((l) => l.symbol).join(", "), calls });
  }

  const deployment = (startBlock: number): Deployment => ({
    chainId,
    startBlock,
    basketoor: b,
    usdc: usdc.creates,
    venue: venue.creates,
    savingsVault: vault.creates,
    keeper,
    mock: true,
    stocks,
  });
  return { batches, deployment };
}
