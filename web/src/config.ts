import { createConfig, fallback, http } from "wagmi";
import { base, baseSepolia, foundry } from "wagmi/chains";
import { baseAccount, injected, mock } from "wagmi/connectors";
import type { Address, Hex } from "viem";
import { Attribution } from "ox/erc8021";

export type Stock = {
  symbol: string;
  name: string;
  kind?: "stock" | "crypto" | "index";
  token: Address;
  feed: Address;
  pricing?: "chainlink" | "chainlink-24/7" | "twap" | "bankr"; // mainnet: where the price comes from
  pool?: Address; // mainnet: the Aerodrome pool it is bought through
};
export type Deployment = {
  chainId: number;
  startBlock: number;
  dcac: Address;
  usdc: Address;
  venue: Address;
  savingsVault: Address;
  keeper: Address;
  mock: boolean;
  stocks: Stock[];
};

const deployments = import.meta.glob("../../contracts/deployments/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Deployment>;

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
export const chain = { 31337: foundry, 84532: baseSepolia, 8453: base }[CHAIN_ID] ?? foundry;
export const dep = Object.values(deployments).find((d) => d.chainId === CHAIN_ID) as Deployment;
export const isLocal = CHAIN_ID === 31337;
export const explorer =
  CHAIN_ID === 8453 ? "https://basescan.org" : CHAIN_ID === 84532 ? "https://sepolia.basescan.org" : "";

// Base Builder Code (dashboard.base.org): attributes DCAC's transactions via an ERC-8021 data suffix.
const builderCode = import.meta.env.VITE_BUILDER_CODE as string | undefined;
export const dataSuffix: Hex | undefined = builderCode
  ? Attribution.toDataSuffix({ codes: [builderCode] })
  : undefined;

// Local dev: anvil's second default account, unlocked, so the app is usable without a wallet extension.
const DEV_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    baseAccount({ appName: "DCAC", appLogoUrl: undefined }),
    injected(),
    ...(isLocal ? [mock({ accounts: [DEV_ACCOUNT], features: { reconnect: true } })] : []),
  ],
  transports: { [chain.id]: fallback(rpcs().map((u) => http(u))) } as never,
});

/// RPCs to try in order. Base's own public RPC refuses eth_getLogs ("request limit reached"), which left order
/// history empty, so on Base mainnet a public RPC that serves logs goes first.
function rpcs(): (string | undefined)[] {
  const own = import.meta.env.VITE_RPC_URL as string | undefined;
  const list: (string | undefined)[] = own ? [own] : [];
  if (CHAIN_ID === 8453) list.push("https://base-rpc.publicnode.com");
  list.push(undefined); // the chain's default RPC
  return list;
}


export const FREQUENCIES = [
  { label: "1 hr", seconds: 3600 },
  { label: "4 hrs", seconds: 4 * 3600 },
  { label: "12 hrs", seconds: 12 * 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 7 * 86400 },
  { label: "2 weeks", seconds: 14 * 86400 },
];
