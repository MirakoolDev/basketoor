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
import { MAINNET, MAINNET_ASSETS, type MainnetAsset } from "./mainnet";

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
  const dcac = create(
    "DCAC",
    bytecode.DCAC,
    encodeAbiParameters(parseAbiParameters("address, address, address, address"), [usdc.creates, venue.creates, treasury, owner]),
  );
  const b = dcac.creates;

  const core: Call[] = [usdc, venue, vault, dcac, call(b, "Use the savings vault", "setSavingsVault", [vault.creates])];
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
    dcac: b,
    usdc: usdc.creates,
    venue: venue.creates,
    savingsVault: vault.creates,
    keeper,
    mock: true,
    stocks,
  });
  return { batches, deployment };
}

const mainnetAbi = parseAbi([
  "function setSavingsVault(address vault)",
  "function setKeeper(address keeper, bool allowed)",
  "function setAsset(address token, address feed, bool enabled)",
  "function setPool(address tokenIn, address tokenOut, address pool)",
  "function setFees(uint16 feeBps, uint64 minFee, uint16 yieldFeeBps)",
]);
const MAINNET_ASSETS_PER_BATCH = 5;

/// Base mainnet: the Aerodrome swap adapter, DCAC on real USDC with the Gauntlet USDC Prime savings vault,
/// and every listed asset routed through its Aerodrome pool and priced from Chainlink, or from a 30-minute
/// pool TWAP feed deployed here when Chainlink has none.
export function buildMainnetDeployment(roles: Omit<Roles, "priceUpdater">, salt: Hex, assets: MainnetAsset[] = MAINNET_ASSETS) {
  const { owner, keeper, treasury } = roles;
  const create = (label: string, code: string, args: Hex = "0x"): Call & { creates: Address } => {
    const s = keccak256(encodePacked(["bytes32", "string"], [salt, label]));
    const initCode = concat([code as Hex, args]);
    const creates = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: s, bytecode: initCode });
    return { to: CREATE2_DEPLOYER, data: concat([s, initCode]), label: `Deploy ${label}`, creates };
  };
  const call = (to: Address, label: string, functionName: (typeof mainnetAbi)[number]["name"], args: readonly unknown[]): Call => ({
    to,
    label,
    data: encodeFunctionData({ abi: mainnetAbi, functionName, args } as never),
  });
  const p = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);

  const adapter = create("Aerodrome adapter", bytecode.AerodromeCLAdapter, p("address, address", [MAINNET.aerodromeClFactory, owner]));
  const dcac = create("DCAC", bytecode.DCAC, p("address, address, address, address", [MAINNET.usdc, adapter.creates, treasury, owner]));
  const b = dcac.creates;
  const core: Call[] = [
    adapter,
    dcac,
    call(b, "Use Gauntlet USDC Prime for savings", "setSavingsVault", [MAINNET.savingsVault]),
    call(b, `Set fees: ${MAINNET.fees.feeBps / 100}% per buy, $${Number(MAINNET.fees.minFee) / 1e6} minimum`, "setFees", [
      MAINNET.fees.feeBps,
      MAINNET.fees.minFee,
      MAINNET.fees.yieldFeeBps,
    ]),
    call(b, "Allow the owner to run buys", "setKeeper", [owner, true]),
  ];
  if (keeper.toLowerCase() !== owner.toLowerCase()) core.push(call(b, "Allow the keeper to run buys", "setKeeper", [keeper, true]));
  const batches: Batch[] = [{ title: "Core contracts", calls: core }];

  const stocks: Deployment["stocks"] = [];
  for (let i = 0; i < assets.length; i += MAINNET_ASSETS_PER_BATCH) {
    const group = assets.slice(i, i + MAINNET_ASSETS_PER_BATCH);
    const calls: Call[] = [];
    for (const a of group) {
      let feed = a.chainlink;
      if (!feed) {
        const twap = create(
          `${a.symbol} TWAP feed`,
          bytecode.PoolTwapFeed,
          p("address, address, address, uint8, uint8, uint32", [a.pool, a.token, MAINNET.usdc, a.decimals, 6, MAINNET.twapWindow]),
        );
        calls.push(twap);
        feed = twap.creates;
      }
      calls.push(
        call(adapter.creates, `Route ${a.symbol} through its Aerodrome pool`, "setPool", [MAINNET.usdc, a.token, a.pool]),
        call(b, `List ${a.symbol}`, "setAsset", [a.token, feed, true]),
      );
      stocks.push({
        symbol: a.symbol,
        name: a.name,
        kind: a.kind,
        token: a.token,
        feed,
        pool: a.pool,
        pricing: !a.chainlink ? "twap" : a.allHours ? "chainlink-24/7" : "chainlink",
      });
    }
    batches.push({ title: group.map((a) => a.symbol).join(", "), calls });
  }

  const deployment = (startBlock: number): Deployment => ({
    chainId: 8453,
    startBlock,
    dcac: b,
    usdc: MAINNET.usdc,
    venue: adapter.creates,
    savingsVault: MAINNET.savingsVault,
    keeper,
    mock: false,
    stocks,
  });
  return { batches, deployment };
}
