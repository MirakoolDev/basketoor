import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useAccount, useConfig, useSwitchChain } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { zeroAddress, type Abi, type Address, type ContractFunctionReturnType, type Hex, type PublicClient } from "viem";
import { dcacAbi, erc20Abi } from "./abi";
import { BANKR, bankrAbi } from "./bankr";
import { createWalletClient, http as httpTransport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, dep, dataSuffix, isLocal } from "./config";
import { useNow } from "./ui";

/// "Now" on the chain's clock, ticking every `intervalMs`. Countdowns compare against block timestamps, which
/// can run ahead of the browser's clock (a local chain that was fast-forwarded, or a skewed device clock).
export function useChainNow(intervalMs = 1000) {
  const now = useNow(intervalMs);
  const pc = client();
  const offset = useQuery({
    queryKey: ["chainClockOffset"],
    refetchInterval: 60_000,
    queryFn: async () => Number((await pc.getBlock()).timestamp) - Math.floor(Date.now() / 1000),
  });
  return now + (offset.data ?? 0);
}

// Anvil's public default account #1 (local chain only).
export const devWallet = isLocal
  ? createWalletClient({
      chain,
      transport: httpTransport(),
      account: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
    })
  : undefined;

export type StockInfo = {
  symbol: string;
  name: string;
  kind: "stock" | "crypto" | "index";
  token: Address;
  decimals: number;
  price: number; // USD
  updatedAt: number;
  usable: boolean;
  pricing: "chainlink" | "chainlink-24/7" | "twap" | "bankr"; // twap: its own Aerodrome pool; bankr: an index's basket value
};

export type LegView = {
  token: Address;
  amount: bigint;
  spent: bigint;
  received: bigint;
};

export type PlanView = {
  id: bigint;
  owner: Address;
  name: string;
  interval: number;
  nextRun: number;
  createdAt: number;
  buysDone: number;
  maxBuys: number;
  skippedRuns: number;
  active: boolean;
  savings: boolean;
  smart: boolean; // smart buys: each buy steers toward the target weights
  feeBps: number;
  smartFeeBps: number; // extra fee per buy while smart buys are on
  minFee: bigint;
  creator: Address; // who shared the basket this copies; zero address = none
  principal: bigint;
  totalSpent: bigint;
  totalFees: bigint;
  value: bigint; // USDC held for the plan now
  legs: LegView[];
  weights?: { valueUsd: number[]; targetBps: number[]; driftBps: number }; // from weightsOf; absent on old deployments
};

export const usd = (raw: bigint) => Number(raw) / 1e6;

function client() {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const c = usePublicClient();
  if (!c) throw new Error("no public client");
  return c as PublicClient;
}

export function useStocks() {
  const pc = client();
  return useQuery({
    queryKey: ["stocks"],
    refetchInterval: 30_000,
    queryFn: async (): Promise<StockInfo[]> => {
      const price = (token: Address) => pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "priceOf", args: [token] });
      const listed = await Promise.all(
        dep.stocks.map(async (s) => {
          const [[p, updatedAt, usable], decimals] = await Promise.all([
            price(s.token),
            pc.readContract({ address: s.token, abi: erc20Abi, functionName: "decimals" }),
          ]);
          return {
            symbol: s.symbol,
            name: s.name,
            kind: s.kind ?? "stock",
            token: s.token,
            decimals,
            price: Number(p) / 1e8,
            updatedAt: Number(updatedAt),
            usable,
            pricing: s.pricing ?? "chainlink",
          } satisfies StockInfo;
        }),
      );
      return [...listed, ...(await listedIndexes(pc, new Set(dep.stocks.map((s) => s.token.toLowerCase()))))];
    },
  });
}

/// Bankr index tokens the owner listed on DCAC after launch (anything in DCAC's asset list that isn't in the
/// deployment file and that Bankr's factory recognises). Read from the chain so a new listing needs no app release.
async function listedIndexes(pc: PublicClient, known: Set<string>): Promise<StockInfo[]> {
  if (dep.mock) return [];
  const all = (await pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "getAssets" }).catch(() => [])) as Address[];
  const extra = all.filter((a) => !known.has(a.toLowerCase()));
  const out = await Promise.all(
    extra.map(async (token): Promise<StockInfo | undefined> => {
      const isIndex = await pc.readContract({ address: BANKR.factory, abi: bankrAbi, functionName: "isVault", args: [token] }).catch(() => false);
      if (!isIndex) return undefined;
      const [[p, updatedAt, usable], symbol, name, decimals] = await Promise.all([
        pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "priceOf", args: [token] }),
        pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
        pc.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
        pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      ]);
      const [, , , enabled] = await pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "assets", args: [token] });
      if (!enabled) return undefined;
      return {
        symbol,
        name,
        kind: "index",
        token,
        decimals,
        price: Number(p) / 1e8,
        updatedAt: Number(updatedAt),
        usable,
        pricing: "bankr",
      } satisfies StockInfo;
    }),
  );
  return out.filter((x): x is StockInfo => !!x);
}

export function useProtocol() {
  const pc = client();
  return useQuery({
    queryKey: ["protocol"],
    staleTime: Infinity,
    queryFn: async () => {
      const read = (functionName: "feeBps" | "smartFeeBps" | "creatorShareBps" | "minFee" | "yieldFeeBps" | "minLegAmount" | "maxSlippageBps" | "savingsVault") =>
        pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName });
      const [feeBps, smartFeeBps, creatorShareBps, minFee, yieldFeeBps, minLegAmount, maxSlippageBps, savingsVault] = await Promise.all([
        read("feeBps"),
        read("smartFeeBps").catch(() => 0), // older deployments have no premium
        read("creatorShareBps").catch(() => 0), // older deployments have no shared baskets
        read("minFee"),
        read("yieldFeeBps"),
        read("minLegAmount"),
        read("maxSlippageBps"),
        read("savingsVault"),
      ]);
      return {
        feeBps: Number(feeBps),
        smartFeeBps: Number(smartFeeBps),
        creatorShareBps: Number(creatorShareBps),
        minFee: minFee as bigint,
        yieldFeeBps: Number(yieldFeeBps),
        minLegAmount: minLegAmount as bigint,
        maxSlippageBps: Number(maxSlippageBps),
        savingsAvailable: (savingsVault as Address) !== "0x0000000000000000000000000000000000000000",
      };
    },
  });
}

async function loadPlan(pc: PublicClient, id: bigint): Promise<PlanView> {
  const [[p, legs], value, w] = await Promise.all([
    pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "getPlan", args: [id] }),
    pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "planValue", args: [id] }),
    pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "weightsOf", args: [id] }).catch(() => undefined),
  ]);
  return toView(id, p, legs, value, w);
}

type GetPlan = ContractFunctionReturnType<typeof dcacAbi, "view", "getPlan">;
type Plan = GetPlan[0];
type Leg = GetPlan[1][number];

function toView(
  id: bigint,
  p: Plan,
  legs: readonly Leg[],
  value: bigint,
  w?: readonly [readonly bigint[], readonly bigint[], bigint],
): PlanView {
  return {
    id,
    owner: p.owner,
    name: p.name,
    interval: Number(p.interval),
    nextRun: Number(p.nextRun),
    createdAt: Number(p.createdAt),
    buysDone: p.buysDone,
    maxBuys: p.maxBuys,
    skippedRuns: p.skippedRuns,
    active: p.active,
    savings: p.savings,
    smart: p.smart,
    feeBps: p.feeBps,
    smartFeeBps: p.smartFeeBps,
    minFee: p.minFee,
    creator: p.creator,
    principal: p.principal,
    totalSpent: p.totalSpent,
    totalFees: p.totalFees,
    value,
    legs: legs.map((l) => ({ token: l.token, amount: l.amount, spent: l.spent, received: l.received })),
    weights: w && { valueUsd: w[0].map(usd), targetBps: w[1].map(Number), driftBps: Number(w[2]) },
  };
}

export function useMyPlans() {
  const pc = client();
  const { address } = useAccount();
  return useQuery({
    queryKey: ["plans", address],
    enabled: !!address,
    refetchInterval: 15_000,
    queryFn: async () => {
      const ids = await pc.readContract({
        address: dep.dcac,
        abi: dcacAbi,
        functionName: "plansOf",
        args: [address!],
      });
      const plans = await Promise.all([...ids].reverse().map((id) => loadPlan(pc, id)));
      return plans;
    },
  });
}

/// USDC the connected wallet has earned from plans opened from its shared baskets.
export function useCreatorEarned() {
  const pc = client();
  const { address } = useAccount();
  return useQuery({
    queryKey: ["creatorEarned", address],
    enabled: !!address,
    refetchInterval: 60_000,
    queryFn: () =>
      pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "creatorEarned", args: [address!] }).catch(() => 0n),
  });
}

/// A basket on Explore: an original (not a copy) with enough buys to judge, and how many plans copied it.
export type ExploreBasket = { plan: PlanView; copies: number };

/// Every plan, read straight from the contract (no indexer). Originals with at least `minBuys` buys are listed;
/// a copy counts toward the basket it came from: same maker, same set of assets.
export function useExplore(minBuys = 3) {
  const pc = client();
  return useQuery({
    queryKey: ["explore", minBuys],
    refetchInterval: 60_000,
    queryFn: async (): Promise<ExploreBasket[]> => {
      const next = await pc.readContract({ address: dep.dcac, abi: dcacAbi, functionName: "nextPlanId" });
      const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
      const read = (id: bigint) => ({ address: dep.dcac, abi: dcacAbi, functionName: "getPlan", args: [id] }) as const;
      const raw: (readonly [Plan, readonly Leg[]])[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        if (pc.chain?.contracts?.multicall3) {
          const res = await pc.multicall({ contracts: batch.map(read), allowFailure: false });
          raw.push(...(res as never as (readonly [Plan, readonly Leg[]])[]));
        } else raw.push(...(await Promise.all(batch.map((id) => pc.readContract(read(id))))));
      }
      const plans = raw.map(([p, legs], i) => toView(ids[i], p, legs, 0n));
      const key = (v: PlanView) => v.legs.map((l) => l.token.toLowerCase()).sort().join();
      const copies = new Map<string, number>();
      for (const v of plans)
        if (v.creator !== zeroAddress) copies.set(`${v.creator.toLowerCase()}|${key(v)}`, (copies.get(`${v.creator.toLowerCase()}|${key(v)}`) ?? 0) + 1);
      return plans
        .filter((v) => v.creator === zeroAddress && v.buysDone >= minBuys && v.legs.some((l) => l.amount > 0n))
        .map((plan) => ({ plan, copies: copies.get(`${plan.owner.toLowerCase()}|${key(plan)}`) ?? 0 }));
    },
  });
}

export function usePlan(id: bigint) {
  const pc = client();
  return useQuery({ queryKey: ["plan", id.toString()], refetchInterval: 10_000, queryFn: () => loadPlan(pc, id) });
}

export function useUsdc() {
  const pc = client();
  const { address } = useAccount();
  return useQuery({
    queryKey: ["usdc", address],
    enabled: !!address,
    refetchInterval: 15_000,
    queryFn: async () => {
      const [balance, allowance, eth] = await Promise.all([
        pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "allowance", args: [address!, dep.dcac] }),
        pc.getBalance({ address: address! }),
      ]);
      return { balance, allowance, eth };
    },
  });
}

export type HistoryItem =
  | { kind: "buy"; block: bigint; tx: Hex; buyIndex: number; token: Address; usdcIn: bigint; amountOut: bigint; price: bigint }
  | { kind: "skip"; block: bigint; tx: Hex; token: Address; reason: number }
  | { kind: "run"; block: bigint; tx: Hex; buyIndex: number; spent: bigint; fee: bigint }
  | { kind: "created"; block: bigint; tx: Hex; deposit: bigint }
  | { kind: "updated"; block: bigint; tx: Hex; pulled: bigint; refunded: bigint }
  | { kind: "closed"; block: bigint; tx: Hex; refund: bigint; yieldEarned: bigint; yieldFee: bigint; cancelled: boolean };

const CHUNK = 9_000n;

export function useHistory(id: bigint) {
  const pc = client();
  return useQuery({
    queryKey: ["history", id.toString()],
    refetchInterval: 15_000,
    queryFn: async () => {
      const latest = await pc.getBlockNumber();
      const logs = [];
      for (let from = BigInt(dep.startBlock); from <= latest; from += CHUNK) {
        const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
        const chunk = await pc.getContractEvents({
          address: dep.dcac,
          abi: dcacAbi,
          args: { id } as never,
          fromBlock: from,
          toBlock: to,
        });
        logs.push(...chunk);
      }
      const items: (HistoryItem & { time?: number })[] = [];
      for (const l of logs) {
        const a = l.args as Record<string, never>;
        const base = { block: l.blockNumber!, tx: l.transactionHash! };
        if (a.id !== undefined && (a.id as bigint) !== id) continue;
        switch (l.eventName) {
          case "Bought":
            items.push({ kind: "buy", ...base, buyIndex: Number(a.buyIndex), token: a.token, usdcIn: a.usdcIn, amountOut: a.amountOut, price: a.price });
            break;
          case "LegSkipped":
            items.push({ kind: "skip", ...base, token: a.token, reason: Number(a.reason) });
            break;
          case "Executed":
            items.push({ kind: "run", ...base, buyIndex: Number(a.buyIndex), spent: a.spent, fee: a.fee });
            break;
          case "PlanCreated":
            items.push({ kind: "created", ...base, deposit: a.deposit });
            break;
          case "PlanUpdated":
            items.push({ kind: "updated", ...base, pulled: a.pulled, refunded: a.refunded });
            break;
          case "PlanClosed":
            items.push({ kind: "closed", ...base, refund: a.refund, yieldEarned: a.yieldEarned, yieldFee: a.yieldFee, cancelled: a.cancelled });
            break;
        }
      }
      const blocks = [...new Set(items.map((i) => i.block))];
      const times = new Map<bigint, number>();
      await Promise.all(
        blocks.map(async (b) => times.set(b, Number((await pc.getBlock({ blockNumber: b })).timestamp))),
      );
      for (const i of items) i.time = times.get(i.block);
      return items.reverse();
    },
  });
}

/// Sends calls in one batch when the wallet supports EIP-5792 (Base Account does: approve + create in one
/// confirmation), otherwise one transaction at a time.
function useSigner() {
  const config = useConfig();
  const { connector, isConnected, chainId: walletChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const pc = usePublicClient({ chainId: chain.id });
  const qc = useQueryClient();

  /// The signer on this app's chain. A wallet on another network is asked to switch first; without this the
  /// wallet client for this chain is missing and every send looked like "no wallet".
  async function signer() {
    // wagmi's mock connector drops `from`, so the local dev wallet signs with anvil's test key itself.
    if (connector?.id === "mock" && devWallet) return devWallet;
    if (!isConnected) throw new Error("Connect a wallet first");
    if (walletChain !== chain.id) {
      try {
        await switchChainAsync({ chainId: chain.id });
      } catch {
        throw new Error(`Your wallet is on another network. Switch it to ${chain.name} and try again.`);
      }
    }
    return getWalletClient(config, { chainId: chain.id });
  }
  return { pc, qc, signer };
}

/// Sends prepared transactions (calldata someone else built, like Bankr's index creation) one by one.
export function useSendTxs() {
  const { pc, qc, signer } = useSigner();
  return async (txs: { to: Address; data: Hex; value?: bigint }[], onStep?: (i: number) => void) => {
    if (!pc) throw new Error(`Can't reach ${chain.name} right now. Try again in a moment.`);
    const wallet = await signer();
    for (const [i, t] of txs.entries()) {
      onStep?.(i);
      const hash = await (wallet as { sendTransaction: (a: unknown) => Promise<Hex> }).sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0n });
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error("Transaction reverted");
    }
    await qc.invalidateQueries();
  };
}

export function useSend() {
  const { pc, qc, signer } = useSigner();

  return async (calls: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint }[]) => {
    if (!pc) throw new Error(`Can't reach ${chain.name} right now. Try again in a moment.`);
    const wallet = await signer();
    const finish = () => qc.invalidateQueries();
    if (calls.length > 1) {
      try {
        const caps = await wallet.getCapabilities({ chainId: wallet.chain.id }).catch(() => undefined);
        const atomic = (caps as { atomic?: { status?: string } } | undefined)?.atomic?.status;
        if (atomic === "supported" || atomic === "ready") {
          const { id } = await wallet.sendCalls({
            calls: calls.map((c) => ({ to: c.address, abi: c.abi, functionName: c.functionName, args: c.args, value: c.value })) as never,
            capabilities: dataSuffix ? { dataSuffix: { value: dataSuffix, optional: true } } : undefined,
          });
          const res = await wallet.waitForCallsStatus({ id });
          if (res.status !== "success") throw new Error("Batch failed");
          await finish();
          return;
        }
      } catch (e) {
        if ((e as { code?: number }).code === 4001) throw e; // user rejected
      }
    }
    for (const c of calls) {
      const hash = await wallet.writeContract({ ...c, dataSuffix } as never);
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error("Transaction reverted");
    }
    await finish();
  };
}
