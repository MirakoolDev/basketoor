# DCAC

**Stack stocks on autopilot.** Pick up to five tokenized stocks on Base, set how much and how often, deposit the budget once. DCAC buys on schedule, onchain, straight into your wallet.

Built for Base's *Stocks Maxxing Season*, Programmable Stock Markets track (custom portfolios).

## What's onchain

Everything except the alarm clock:

| | Where |
|---|---|
| The plan: stocks, $ per stock, frequency, number of buys, name | `DCAC.createPlan` / `updatePlan` |
| The budget, escrowed, optionally earning yield in an ERC-4626 savings vault | `DCAC` |
| Each buy: due check, Chainlink price check (1.5% max slippage, stale price = market closed = skip), swap, shares to the user's wallet | `DCAC._execute` |
| Fees: per buy, max(0.5% of what filled, or 0.75% while auto-rebalance is on, and a $0.10 minimum fee), owner-set via `setFees` / `setSmartFee`; minimum buy $1 per asset (`setLimits`); nothing if every leg was skipped; 10% of savings yield | `DCAC` |
| Average buy price, P&L, buy count | counters per leg + `Bought` events |
| Order history | `Bought` / `LegSkipped` / `Executed` events |
| Modify (budget resized to fund exactly the remaining buys) / Terminate (full refund + yield) | `updatePlan` / `cancelPlan` |
| The trigger | a keeper calls `executeDue(n)`; only allowlisted keepers can |

The keeper can't move anyone's money: it can only trigger a buy that is due, at the plan's amounts, inside the oracle bound. Users can always cancel and withdraw themselves.

## Layout

- `contracts/`: Foundry. `src/DCAC.sol`, `src/adapters/UniswapV3Adapter.sol` (mainnet venue), `src/mocks/` (testnet stand-ins), `test/`, `script/DeployTestnet.s.sol`.
- `keeper/`: Node script that calls `executeDue` and, on testnet, copies real Base mainnet Chainlink prices into the mock feeds.
- `web/`: Vite + React + wagmi/viem. Base Account sign-in, EIP-5792 batched approve + create, Base Builder Code attribution (`VITE_BUILDER_CODE`).

## Run locally

```bash
anvil                                                   # terminal 1
cd contracts && forge test
forge script script/DeployTestnet.s.sol --rpc-url local --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cd ../keeper && npm i
KEEPER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 INTERVAL_SEC=10 node index.mjs --sync-prices
cd ../web && npm i && npm run dev                       # http://localhost:5173, "Use dev wallet"
```

## Base Sepolia

```bash
cd contracts
KEEPER=<keeper address> forge script script/DeployTestnet.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_KEY
cd ../keeper && CHAIN_ID=84532 KEEPER_KEY=... node index.mjs --sync-prices
cd ../web && VITE_CHAIN_ID=84532 npm run dev
```

There are no tokenized stocks on Base Sepolia, so the script deploys the ten Coinbase tickers as mocks with Chainlink-style feeds, a mock venue that fills at the feed price minus 0.2%, test USDC with a faucet and a savings vault. The keeper keeps the mock prices equal to Base mainnet Chainlink.

### Hosted keeper (KeeperHub)

Instead of running `keeper/`: a KeeperHub workflow on Base Sepolia (84532) or Base (8453):
Schedule `*/5 * * * *` → Read Contract `dueCount()` → Condition `> 0` → Write Contract `executeDue(3)`. A normal gas estimate is enough: `executeDue` reverts unless each plan it runs has its `gasFor(id)` budget (250k + 700k per asset + 400k with savings, so up to 4.15M) left. Three plans per transaction keeps it under the per-transaction gas cap.
Then allow the workflow's wallet: `DCAC.setKeeper(<KeeperHub wallet>, true)`.

## Mainnet: still open

- Which DEX pools hold Coinbase's B20 stocks, and their depth. `UniswapV3Adapter` takes an owner-set path per stock; another venue is one more `ISwapAdapter`.
- B20 transfer policies: a blocked recipient makes that leg skip (its USDC stays in the plan).
- US persons are excluded in the app; the contract itself is permissionless.
