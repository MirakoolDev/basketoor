# DCAC

**Stack stocks on autopilot.** Pick up to five tokenized stocks on Base, set how much and how often, deposit the budget once. DCAC buys on schedule, onchain, straight into your wallet.

Built for Base's *Stocks Maxxing Season*, Programmable Stock Markets track (custom portfolios).

## Live on Base

App: **https://dcac.fun**

Deployed to Base mainnet on 2026-11-27 (block 62988364) from the audited launch code. Source verified on Basescan and Sourcify.

| Contract | Address |
|---|---|
| DCAC | [`0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313`](https://basescan.org/address/0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313#code) |
| Aerodrome adapter | [`0x27826d88468904cF97C2DcE28E344A16E3693645`](https://basescan.org/address/0x27826d88468904cF97C2DcE28E344A16E3693645#code) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| Savings vault (Gauntlet USDC Prime) | [`0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`](https://basescan.org/address/0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61) |
| Keeper (KeeperHub wallet) | [`0x3DAb104D8A1338Bb728310453DeBb6f2dc9D2Ef9`](https://basescan.org/address/0x3DAb104D8A1338Bb728310453DeBb6f2dc9D2Ef9) |
| Owner | [`0x420944b441715E34Dd672AE0Eb4526A7AD7d1EEF`](https://basescan.org/address/0x420944b441715E34Dd672AE0Eb4526A7AD7d1EEF) |
| Treasury | [`0x85eb79DBCc50eB3DA0Ee10460109991E863d2666`](https://basescan.org/address/0x85eb79DBCc50eB3DA0Ee10460109991E863d2666) |

15 assets are listed, each priced by Chainlink: NVDA, GOOGL and TSLA (24/7 feeds), META, AAPL, AMZN, MSFT, MSTR, SNDK, SPCX, ANT, CRCL, INTC, ETH and cbBTC. Every token, feed and Aerodrome pool is in [`contracts/deployments/8453.json`](contracts/deployments/8453.json), and the app's About page reads them live from the contract.

Launch settings: 0.5% per buy (min $0.10), +0.25% with auto-rebalance, 50% of the fee to the creator on shared baskets, 10% of savings yield, 1.5% max slippage against Chainlink, $1 minimum per asset.

## What's onchain

Everything except the alarm clock:

| | Where |
|---|---|
| The plan: stocks, $ per stock, frequency, number of buys, name | `DCAC.createPlan` / `updatePlan` |
| The budget, escrowed, optionally earning yield in an ERC-4626 savings vault | `DCAC` |
| Each buy: due check, Chainlink price check (1.5% max slippage, stale price = market closed = skip), swap, shares to the user's wallet | `DCAC._execute` |
| Fees: per buy, max(0.5% of what filled, or 0.75% while auto-rebalance is on, and a $0.10 minimum fee), owner-set via `setFees` / `setSmartFee`; minimum buy $1 per asset (`setLimits`); nothing if every leg was skipped; 10% of savings yield | `DCAC` |
| Shared baskets: a link carries a basket's mix; a plan opened from it (`createSharedPlan`) pays the basket's creator `creatorShareBps` (50% at launch) of each buy fee, at no extra cost to the copier. Owner-set via `setCreatorShare`, fixed per plan | `DCAC` |
| Average buy price, P&L, buy count | counters per leg + `Bought` events |
| Order history | `Bought` / `LegSkipped` / `Executed` events |
| Modify (budget resized to fund exactly the remaining buys) / Terminate (full refund + yield) | `updatePlan` / `cancelPlan` |
| The trigger | a keeper calls `executeDue(n)`; only allowlisted keepers can |

The keeper can't move anyone's money: it can only trigger a buy that is due, at the plan's amounts, inside the oracle bound. Users can always cancel and withdraw themselves.

## Indexes (built on Bankr)

An index is one token backed by a basket of stocks and crypto it holds. DCAC builds these on [Bankr's index contracts](https://docs.bankr.bot/token-launching/index-tokens), live on Base, instead of writing its own:

- **Create** (`#/indexes/new`): pick 2 to 20 assets and weights, a fee (0.25% to 1% per trade) and a first buy of at least $100. Bankr's API prepares the transactions and the user's wallet signs them, so the user is the index's creator and earns the creator's share of its fee. Bankr keeps 40% of the fee.
- **Buy, sell, redeem**: through the index's own Uniswap v4 pools, whose hook buys or sells the basket. Anyone can redeem for the basket at any time.
- **Recurring buys on DCAC**: once the owner lists an index, it can go in a DCAC basket like any stock. Two small contracts do this, with no change to the deployed DCAC:
  - `BankrIndexRouter` becomes DCAC's venue. Buys of a Bankr index (recognised by Bankr's factory) go through its v4 pool; every other buy is passed unchanged to the Aerodrome adapter.
  - `BankrIndexNavFeed` gives DCAC the index's basket value per token from Bankr's IndexLens, which prices from Chainlink or Bankr's signed prices, never from the index's own pool. It answers 0 (the leg is skipped) while any basket price is missing.
  - The owner turns this on from an index's page: deploy the router and `setSwapAdapter`, then per index deploy its feed and `setAsset`. The app finds listed indexes onchain, so a listing needs no app release.
- **Launch a token on it**: Bankr lets anyone launch a token whose pool is paired with an index, so the creator's pool fees arrive as the index token.

Checked against live Base: `test/BankrIndex.t.sol` (fork, the deployed DCAC buying a crypto index and ETH in one plan) and `script/simulate-bankr-index.sh` (stock indexes, since a fork can't run stock tokens). $100 buys of MAG7, CSUITE and SPACE filled at about 99.45% of basket value, inside DCAC's 1.5% bound. An index with a fee above about 0.5% can fall outside it, so the create page says so.

## Layout

- `contracts/`: Foundry. `src/DCAC.sol`, `src/adapters/AerodromeCLAdapter.sol` (mainnet venue: Aerodrome Slipstream pools), `src/adapters/UniswapV3Adapter.sol` (alternative, unused), `src/feeds/PoolTwapFeed.sol` (pool-average price feed, unused at launch), `src/adapters/BankrIndexRouter.sol` + `src/feeds/BankrIndexNavFeed.sol` (Bankr index buys, see above), `src/mocks/` (testnet stand-ins), `test/`, `script/DeployTestnet.s.sol`, `deployments/<chainId>.json`.
- `keeper/`: Node script that calls `executeDue` and, on testnet, copies real Base mainnet Chainlink prices into the mock feeds. On mainnet a KeeperHub workflow does this instead (below).
- `web/`: Vite + React + wagmi/viem. Base Account sign-in, EIP-5792 batched approve + create, Base Builder Code attribution (`VITE_BUILDER_CODE`). `#/deploy` (dev server only) deploys everything from your own wallet through the CREATE2 deployer and writes `contracts/deployments/<chainId>.json`; that's how the mainnet deployment was made.

Web env: `VITE_CHAIN_ID` (8453 for Base), `VITE_RPC_URL` (optional; defaults to Base's public RPC), `VITE_BUILDER_CODE`.

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

Mainnet runs on a KeeperHub workflow, "DCAC Keeper (Base)", from the keeper wallet above (gas sponsored by KeeperHub):
Schedule `*/10 * * * *` → Read Contract `dueCount()` → Condition `duecount.result.n > 0` → (true) Write Contract `executeDue(3)`. Read the count from `result.n`: the step's output is an object, so comparing the whole output never fires. A normal gas estimate is enough: `executeDue` reverts unless each plan it runs has its `gasFor(id)` budget (250k + 700k per asset + 800k with savings, so up to 4.55M) left. Three plans per transaction keeps it under the per-transaction gas cap.
The same workflow works on Base Sepolia (84532); allow its wallet with `DCAC.setKeeper(<KeeperHub wallet>, true)` (the mainnet deploy did this already).

## Audits

Two audits by [imd.fun](https://imd.fun), both of `contracts/`:

| | Commit | Findings | Report |
|---|---|---|---|
| Audit | `b14b3cc` (2026-11-25) | 15: 5 medium, 7 low, 3 info | [`contracts/audit/imd-report.md`](contracts/audit/imd-report.md) |
| Re-audit | `404e0ce` (2026-11-27) | 11: 1 high, 2 medium, 5 low, 3 info | [`contracts/audit/imd-reaudit-report.md`](contracts/audit/imd-reaudit-report.md) |

Every finding is resolved in the launch commit `c260bcd`: fixed with a test, taken out of the launch, or accepted with a reason. [`contracts/AUDIT.md`](contracts/AUDIT.md) lists each one and what happened to it. The re-audit's one high finding is in the TWAP price feed for stocks without Chainlink; those stocks aren't listed at launch, so only Chainlink-priced assets can be bought.

## Notes

- Swaps go through owner-set Aerodrome Slipstream pools, where Coinbase's B20 stocks are deepest. Another venue is one more `ISwapAdapter`.
- Coinbase stocks without a Chainlink feed can be listed later with `PoolTwapFeed`; none are at launch (see the re-audit's high finding in `contracts/AUDIT.md`).
- B20 transfer policies: a blocked recipient makes that leg skip (its USDC stays in the plan).
- No timelock on owner settings yet; existing baskets keep their fee terms whatever the owner changes.
- US persons are excluded in the app; the contract itself is permissionless.
