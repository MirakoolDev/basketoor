import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { CHAIN_ID, chain, explorer } from "./config";
import { devWallet } from "./data";
import { Button, Card, Pill, Spinner } from "./ui";
import { Connect } from "./Landing";
import { buildDeployment, buildMainnetDeployment, CREATE2_DEPLOYER, type Batch } from "./deploy/plan";
import { MAINNET_ASSETS } from "./deploy/mainnet";

const MAINNET = CHAIN_ID === 8453;

type Saved = { salt: Hex; keeper: string; priceUpdater: string; treasury: string; startBlock?: number; done: number[] };
type Status = { batch: number; step: string } | null;

const storageKey = (owner: string) => `dcac:deploy:${CHAIN_ID}:${owner.toLowerCase()}`;
const newSalt = () => keccak256(toHex(`${Date.now()}-${Math.random()}`));
function load(owner: string): Saved | undefined {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    return raw ? (JSON.parse(raw) as Saved) : undefined;
  } catch {
    return undefined;
  }
}
function store(owner: string, s: Saved) {
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(s));
  } catch {
    /* private window: progress just isn't remembered */
  }
}

/// Deploys DCAC from the connected wallet, which stays the owner. On testnets and anvil: test USDC, the mock
/// venue and savings vault, and fifteen test assets with their price feeds. On Base mainnet: the Aerodrome adapter,
/// DCAC on real USDC with the Gauntlet savings vault, and the mainnet listing (see deploy/mainnet.ts).
export function Deploy() {
  const { address, connector, isConnected } = useAccount();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Deploy to {chain.name}</h1>
        {MAINNET ? (
          <p className="mt-1 text-sm text-muted">
            Deploys DCAC on real USDC, the Aerodrome swap adapter and {MAINNET_ASSETS.length} assets:{" "}
            {MAINNET_ASSETS.filter((a) => a.chainlink).length} priced by Chainlink and {MAINNET_ASSETS.filter((a) => !a.chainlink).length} by a
            30-minute Aerodrome TWAP feed deployed here. Savings go to Gauntlet USDC Prime. Your wallet signs everything, owns every contract and
            pays the gas (a few dollars at today's Base fees).
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">
            Sets up DCAC with test USDC, a test swap venue, a test savings vault and 15 test assets with price feeds. Your wallet signs
            everything and owns every contract.
          </p>
        )}
      </div>
      {!isConnected || !address ? (
        <Card>
          <p className="mb-4 text-sm text-muted">Connect the wallet that should own the deployment.</p>
          <Connect />
        </Card>
      ) : (
        <Deployer key={address} owner={address} mock={connector?.id === "mock"} />
      )}
    </div>
  );
}

function Deployer({ owner, mock }: { owner: Address; mock: boolean }) {
  const { data: connected } = useWalletClient();
  const wallet = mock && devWallet ? devWallet : connected;
  const pc = usePublicClient();
  const [saved, setSaved] = useState<Saved>(() => load(owner) ?? { salt: newSalt(), keeper: owner, priceUpdater: owner, treasury: owner, done: [] });
  const [status, setStatus] = useState<Status>(null);
  const [error, setError] = useState<string>();
  const [hasDeployer, setHasDeployer] = useState<boolean>();
  const update = (s: Saved) => {
    setSaved(s);
    store(owner, s);
  };

  useEffect(() => {
    pc?.getCode({ address: CREATE2_DEPLOYER }).then((c) => setHasDeployer(!!c && c !== "0x"));
  }, [pc]);

  const started = saved.done.length > 0;
  const valid = [saved.keeper, saved.priceUpdater, saved.treasury].every((a) => isAddress(a));
  const plan = useMemo(
    () =>
      !valid
        ? undefined
        : MAINNET
          ? buildMainnetDeployment({ owner, keeper: saved.keeper as Address, treasury: saved.treasury as Address }, saved.salt)
          : buildDeployment(
              { owner, keeper: saved.keeper as Address, priceUpdater: saved.priceUpdater as Address, treasury: saved.treasury as Address },
              saved.salt,
              CHAIN_ID,
            ),
    [owner, saved.keeper, saved.priceUpdater, saved.treasury, saved.salt, valid],
  );
  const finished = !!plan && saved.done.length === plan.batches.length;
  const busy = status !== null;

  async function runBatch(i: number, batch: Batch): Promise<number | undefined> {
    if (!wallet || !pc) throw new Error("Connect a wallet first");
    // Skip contracts that already exist (a retry after a half-finished batch). Settings are safe to send twice.
    const calls = [];
    for (const c of batch.calls) {
      if (c.creates) {
        const code = await pc.getCode({ address: c.creates });
        if (code && code !== "0x") continue;
      }
      calls.push(c);
    }
    if (!calls.length) return undefined;

    const caps = await wallet.getCapabilities({ chainId: wallet.chain.id }).catch(() => undefined);
    const atomic = (caps as { atomic?: { status?: string } } | undefined)?.atomic?.status;
    if (atomic === "supported" || atomic === "ready") {
      setStatus({ batch: i, step: `Confirm ${calls.length} steps in your wallet` });
      const { id } = await wallet.sendCalls({ calls: calls.map((c) => ({ to: c.to, data: c.data })) } as never);
      setStatus({ batch: i, step: "Waiting for the batch to land" });
      const res = await wallet.waitForCallsStatus({ id, timeout: 300_000 });
      if (res.status !== "success") throw new Error(`${batch.title}: the batch failed`);
      return res.receipts?.[0] ? Number(res.receipts[0].blockNumber) : undefined;
    }
    // One transaction per step. Each waits for the previous one: a setting can't be estimated before its contract exists.
    let first: number | undefined;
    for (const [n, c] of calls.entries()) {
      setStatus({ batch: i, step: `${c.label} (${n + 1} of ${calls.length})` });
      const hash = await (wallet.sendTransaction as (a: unknown) => Promise<Hex>)({ to: c.to, data: c.data, account: wallet.account, chain: wallet.chain });
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`${c.label} reverted`);
      first ??= Number(rcpt.blockNumber);
    }
    return first;
  }

  async function deploy() {
    if (!plan) return;
    setError(undefined);
    let s = saved;
    try {
      for (const [i, batch] of plan.batches.entries()) {
        if (s.done.includes(i)) continue;
        const block = await runBatch(i, batch);
        s = { ...s, done: [...s.done, i], startBlock: s.startBlock ?? block };
        update(s);
      }
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string; code?: number };
      setError(err.code === 4001 ? "You rejected the request. Press Deploy to carry on from here." : (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]);
    } finally {
      setStatus(null);
    }
  }

  const field = (label: string, hint: string, key: "keeper" | "priceUpdater" | "treasury") => (
    <label className="block">
      <div className="text-sm font-medium">{label}</div>
      <div className="mb-1.5 text-xs text-muted">{hint}</div>
      <input
        value={saved[key]}
        disabled={started || busy}
        onChange={(e) => update({ ...saved, [key]: e.target.value.trim() })}
        spellCheck={false}
        className={`h-11 w-full rounded-xl bg-surface px-3 font-mono text-[13px] outline-none ring-1 transition focus:ring-brand disabled:text-muted ${
          isAddress(saved[key]) ? "ring-line" : "ring-down"
        }`}
      />
    </label>
  );

  return (
    <>
      {hasDeployer === false && (
        <Card className="text-sm text-down">This chain has no CREATE2 deployer at {CREATE2_DEPLOYER}, so the page can't deploy here.</Card>
      )}

      <Card className="space-y-4">
        <div>
          <div className="text-sm font-medium">Owner</div>
          <div className="mb-1.5 text-xs text-muted">Your connected wallet. Lists assets, sets fees and keepers.</div>
          <div className="h-11 truncate rounded-xl bg-surface px-3 font-mono text-[13px] leading-[44px] text-muted">{owner}</div>
        </div>
        {field("Keeper", "Runs the scheduled buys, e.g. your KeeperHub wallet. You can add more later.", "keeper")}
        {!MAINNET && field("Price updater", "Copies Base mainnet Chainlink prices onto the test feeds (keeper/index.mjs --sync-prices).", "priceUpdater")}
        {field("Treasury", MAINNET ? "Receives the fees, and tops up the keeper's gas. A multisig is safest." : "Receives the fees.", "treasury")}
        {started && <p className="text-xs text-faint">Addresses are locked once the first batch is on chain.</p>}
      </Card>

      <Card className="space-y-1">
        {plan?.batches.map((b, i) => {
          const done = saved.done.includes(i);
          const active = status?.batch === i;
          return (
            <div key={i} className="flex items-center gap-3 py-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-medium text-muted">
                {active ? <Spinner /> : done ? "✓" : i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{b.title}</div>
                <div className="truncate text-xs text-muted">{active ? status.step : `${b.calls.length} steps`}</div>
              </div>
              {done && <Pill tone="up">Done</Pill>}
            </div>
          );
        })}
      </Card>

      {error && <Card className="text-sm text-down">{error}</Card>}

      {!finished ? (
        <>
          <Button className="w-full" onClick={deploy} disabled={!plan || busy || hasDeployer === false}>
            {busy ? "Deploying…" : started ? "Continue deploying" : "Deploy"}
          </Button>
          <p className="text-center text-xs text-faint">
            Wallets that batch (Base Account) confirm once per group. Other wallets confirm every step. You can stop and carry on later.
          </p>
        </>
      ) : (
        plan && <Result json={plan.deployment(saved.startBlock ?? 0)} />
      )}

      {started && !busy && (
        <button
          className="mx-auto block text-xs text-muted underline underline-offset-2 hover:text-ink"
          onClick={() => {
            if (confirm("Start a fresh deployment at new addresses? The contracts already deployed stay on chain but this page forgets them."))
              update({ salt: newSalt(), keeper: saved.keeper, priceUpdater: saved.priceUpdater, treasury: saved.treasury, done: [] });
          }}
        >
          Start over at new addresses
        </button>
      )}
    </>
  );
}

function Result({ json }: { json: ReturnType<ReturnType<typeof buildDeployment>["deployment"]> }) {
  const text = JSON.stringify(json, null, 2);
  const [saved, setSaved] = useState<string>();
  const file = `contracts/deployments/${json.chainId}.json`;

  async function save() {
    try {
      const res = await fetch("/__deployments", { method: "POST", headers: { "content-type": "application/json" }, body: text });
      setSaved(res.ok ? `Saved to ${file}. The app now uses this deployment.` : `Couldn't save (${res.status}). Download it instead.`);
    } catch {
      setSaved("Couldn't reach the dev server. Download it instead.");
    }
  }
  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text + "\n"], { type: "application/json" }));
    a.download = `${json.chainId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card className="space-y-4">
      <div>
        <div className="font-semibold">Deployed</div>
        <p className="mt-1 text-sm text-muted">
          DCAC is at{" "}
          {explorer ? (
            <a className="font-mono underline underline-offset-2" href={`${explorer}/address/${json.dcac}`} target="_blank" rel="noreferrer">
              {json.dcac}
            </a>
          ) : (
            <span className="font-mono">{json.dcac}</span>
          )}
          . Save the deployment so the app and the keeper can find it at {file}. Saving reloads the app on the new contracts; restart the keeper
          so it picks them up too.
        </p>
      </div>
      <div className="flex gap-2">
        {import.meta.env.DEV && (
          <Button className="flex-1" onClick={save}>
            Save to project
          </Button>
        )}
        <Button variant="ghost" className="flex-1" onClick={download}>
          Download JSON
        </Button>
      </div>
      {saved && <p className="text-sm text-muted">{saved}</p>}
      <pre className="max-h-64 overflow-auto rounded-xl bg-surface p-3 font-mono text-[11px] leading-relaxed text-muted">{text}</pre>
    </Card>
  );
}
