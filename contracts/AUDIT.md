# DCAC: audit scope and notes

Launch commit: `c260bcd` (2026-11-27). Solidity 0.8.28, via-IR, OpenZeppelin 5.4.

Deployed from that code to Base: DCAC `0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313`, Aerodrome adapter `0x27826d88468904cF97C2DcE28E344A16E3693645`. Both are verified on Basescan and Sourcify as exact matches of this source.

Audits: imd.fun audit of `b14b3cc` (2026-11-25) and re-audit of `404e0ce` (2026-11-27), both below. Every finding from both is fixed, taken out of the launch or accepted with a reason; see the tables at the end.

## Scope

| File | Lines | What |
|---|---|---|
| `src/DCAC.sol` | 933 | Everything: plans, escrow, savings vault accounting, execution, smart buys (auto-rebalance) allocation, fees, admin |
| `src/adapters/AerodromeCLAdapter.sol` | 100 | Mainnet venue: swaps directly against owner-set Aerodrome Slipstream pools (where Coinbase stocks are deepest), checks `minOut`, refuses partial fills |
| `src/adapters/UniswapV3Adapter.sol` | 50 | Alternative venue (SwapRouter02 `exactInput`). Untested, not planned for launch |
| `src/feeds/PoolTwapFeed.sol` | 82 | Chainlink-shaped price feed from a 30-minute TWAP of an Aerodrome Slipstream pool, for Coinbase stocks without a Chainlink feed |
| `src/lib/TickMath.sol` | 78 | Uniswap v3 tick math, ported to 0.8 (used by the TWAP feed) |
| `src/interfaces/*.sol` | 22 | `ISwapAdapter`, the slice of Chainlink's `AggregatorV3Interface` used |

Out of scope: `src/mocks/` (testnet only), `script/`, the keeper and the frontend.

Tests: `forge test` (68 tests, including `SmartBuys.t.sol`, `SharedBaskets.t.sol` and `PoolTwapFeed.t.sol`). Smart buys and their 0.25% fee premium (`smartFeeBps`, resized budgets on toggle), shared baskets (`createSharedPlan`: the plan's `creator` gets `creatorShareBps` of each buy fee, paid through `_pay` so a blocked creator can't stall the keeper; sharing with yourself records no creator), the TWAP feed and the raised gas budget were added after the first imd.fun audit and covered by the re-audit of `404e0ce`. Coverage of `DCAC.sol`: 83% lines, 52% branches. The adapter has none.

## Roles and trust

- **Plan owner**: creates, updates, cancels their own plan. Can always cancel and receive everything unspent (plus yield minus the yield fee). No dependency on the keeper or the owner to exit.
- **Keeper** (`keepers[addr]`): only `executeDue` / `executeMany`. Can choose *when* within a due window and the order of plans, nothing else: amounts, recipient and the price bound are fixed by the plan and the oracle.
- **Owner** (Ownable2Step): lists assets and their feeds, sets the swap adapter, savings vault (new plans only), treasury, fees (bounded; snapshotted per plan), slippage/staleness bounds, keepers, pause of new plans. The owner **cannot** withdraw plan funds directly, but chooses the adapter and the feeds, which is the real trust surface (see below).

## Intended invariants

1. For every active plan, `planValue(id) >= principal` absent vault losses and ERC-4626 rounding (a few wei per deposit/withdraw, absorbed by the last buy's fee), and `principal` = deposits − spent − fees.
2. The contract's loose USDC balance equals `totalOwed` between transactions (all USDC is either `idle` of some plan or vault shares of some plan). `test_fullLifecycleSpendsBudgetExactly` checks this for one plan.
3. A leg is recorded as bought only if the recipient's balance rose by at least `minOut`, where `minOut` is derived from the Chainlink price minus `maxSlippageBps`.
4. Fees are charged only on USDC actually spent; a run where every leg is skipped charges nothing.
5. After `updatePlan`, the budget funds exactly `(maxBuys − buysDone) × (perBuy + fee)`.
6. A closed plan holds nothing and is not in `_active`.

## Known issues and things I'd look at first

1. **Owner-chosen adapter and feeds are trusted.** A malicious adapter is bounded by the oracle check (it can take at most `maxSlippageBps` of value per leg), but a malicious or wrong *feed* set via `setAsset` makes that bound meaningless. Mitigation idea: timelock `setAsset` / `setSwapAdapter`.
2. **Keeper MEV within the bound.** The keeper (or anyone who sees its tx) can sandwich a buy up to the slippage bound (1.5% default). Private mempool / tighter bound per asset would help.
3. **No L2 sequencer-uptime check.** Chainlink recommends checking the Base sequencer uptime feed before using prices on an L2. Not implemented.
4. ~~**Vault rounding can underflow `p.shares`.**~~ Fixed after the imd.fun audit (finding 1): `_take` redeems `min(shares, previewWithdraw)` and never asks for more than the plan holds.
5. **`UnderDelivered` reverts the whole batch.** If the adapter reports success but the recipient received less than `minOut`, the entire keeper transaction reverts (deliberate: it signals a broken adapter), but it also stalls every other due plan.
6. **`duePlans` / `dueCount` are O(active plans).** With many active plans, `executeDue` gas grows with the total number of plans, not just the due ones. Needs a cursor or an off-chain id list (`executeMany`) at scale.
7. **Stock-market hours.** Stock feeds hold the last close on weekends with a 24h heartbeat; `maxStaleness = 26h` means a Saturday buy can still use Friday's close (bounded by slippage). Crypto feeds share the same staleness setting.
8. **B20 specifics not modelled.** Transfer policies: a blocked recipient makes the swap revert, so that leg is skipped; after `maxSkippedRuns` failed runs in a row (retried hourly) the plan closes. Corporate-action multiplier changes: the Chainlink stock price is per token (it includes the multiplier), so `minOut` stays right, but `received` is in raw token units, not shares.
9. **Fee-on-transfer / rebasing assets** are not supported; the balance-diff check would reject under-delivery but `leg.received` assumes plain ERC-20s.
10. **Adapter testing.** Coinbase stocks are B20 *precompiles* that Foundry's fork mode can't execute, so `AerodromeCLAdapter` is checked with `script/simulate-aerodrome.sh`: an `eth_call` against a live Base node with state overrides. On 2026-11-23 a $100 buy filled at 100.36% (NVDAc) and 100.23% (AAPLc) of the Chainlink-implied amount. The callback trusts only the pool set for the swap in progress (transient storage). `UniswapV3Adapter` remains untested.
11. **B20 decimals.** Coinbase stocks use 8 decimals onchain (AAPLc, NVDAc checked); the testnet mocks now match.

## imd.fun audit (2026-11-25)

Audit of commit `b14b3cc` by imd.fun ([job](https://explorer.imd.fun/jobs/9a020ffc-afdb-41b8-b89d-89c302c28bce)); full report in [`audit/imd-report.md`](audit/imd-report.md). 15 findings: 5 medium, 7 low, 3 info. The auditor's proof tests for findings 1-4 are in `test/audit/Finding{1..4}.t.sol` (only change: the new `maxDeposit` argument); the other fixes are tested in `test/audit/AuditFixes.t.sol`.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | Savings rounding drops the last funded buy, or reverts the batch on the fee | Fixed: buy needs only `per`; `_take` redeems `min(shares, previewWithdraw)` and returns what it got; the fee is taken from what is left |
| 2 | Medium | An illiquid savings vault reverts the whole batch and blocks cancel | Fixed: vault calls are `try`'d; the run is retried, a failed re-deposit stays idle, and close hands the owner the vault shares if `redeem` fails |
| 3 | Medium | `skippedRuns` never resets, so weekend skips close healthy plans | Fixed: reset on every buy; counts failed runs in a row (default limit 168) |
| 4 | Medium | A fully skipped run waits a whole interval: weekly plans opened on a closed market never buy | Fixed: a run that buys nothing is retried after `RETRY_DELAY` (1 hour) |
| 5 | Medium | `GAS_PER_RUN` too low; under-gassed calls quietly do one plan | Fixed: per-plan `gasFor(id)` (250k + 450k per leg + 300k with savings), checked before every plan with `InsufficientGas`, so a gas estimate covers the whole batch. Keeper default `maxRuns` lowered to 5 |
| 6 | Low | `yieldFeeBps` applied at close, not snapshotted | Fixed: snapshotted per plan |
| 7 | Low | A blocklisted owner's refund reverts the keeper batch | Fixed: failed payouts go to `owed[to]`, withdrawn with `claim(to)` |
| 8 | Low | A blocked or zero treasury blocks exits and buys | Fixed: fees paid through the same fallback; the constructor rejects a zero treasury |
| 9 | Low | A new interval only applies after the old schedule's next run | Fixed: next run = last buy + new interval (or now) |
| 10 | Low | A donation-inflated vault can mint 0 shares for a deposit | Fixed: new deposits must mint shares worth the deposit within 0.01% |
| 11 | Low | A partly filled run uses a buy for every leg (mixed stock + crypto on weekends) | **Open, by design for now.** Documented in the app. Per-leg buy counting changes how fees are budgeted; revisit after the hackathon |
| 12 | Low | No maximum on what `createPlan` pulls | Fixed: `maxDeposit` on `createPlan`, `maxPull` on `updatePlan`; the app passes the amount it shows |
| 13 | Info | `updatePlan` tops up while new plans are paused, at old fees | Partly: top-ups revert while paused. Plans keep their creation-time fees (intended) |
| 14 | Info | Adapter address unchecked | Fixed: must have code (constructor and setter) |
| 15 | Info | Adapter owner is an unlisted trust root; `setPool` accepts any contract | Fixed: `Ownable2Step`, and `setPool` checks the pool with the Slipstream factory. Listed under Roles: the adapter owner should be the same key as DCAC's |

Tests: `forge test` runs 31 tests (15 original, 5 auditor proofs, 11 fix tests). `script/simulate-aerodrome.sh` still fills on live Base state (2026-11-25: NVDAc 99.62%, AAPLc 100.17% of the Chainlink-implied amount).

## imd.fun re-audit (2026-11-27)

Re-audit of commit `404e0ce` by imd.fun ([job](https://explorer.imd.fun/jobs/2b372e3c-5c92-4c05-b62c-ebaaa402a9e2)): four specialists (economics, flow, math, permissions), then a judge who reproduced, merged and ranked their findings. Full report in [`audit/imd-reaudit-report.md`](audit/imd-reaudit-report.md): 11 findings, 1 high, 2 medium, 5 low, 3 info.

**Every finding is resolved in commit `c260bcd`: fixed, taken out of the launch, or accepted with the reason below. No further audit was run on the fixes.** Each fix has a test in [`test/audit/ReAuditFixes.t.sol`](test/audit/ReAuditFixes.t.sol), which includes the auditors' own proofs for findings 3 and 4 as they wrote them; all 68 tests pass. The mainnet dry run (deploy, three 5-asset baskets with savings and auto-rebalance, one of them a shared copy, run in one `executeDue(3)` at 6.16M gas, then cancelled with a full refund) passes on the fixed code.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | `PoolTwapFeed`: one 30-minute mean tick with no outlier, spot or depth check; a few seconds at an extreme tick in a thin pool moves the price bound for TWAP-priced stocks by 10% or more | **Not in the launch.** Mainnet lists only the 15 Chainlink-priced assets (`MAINNET_ASSETS` in `web/src/deploy/mainnet.ts`). No `PoolTwapFeed` is deployed. It stays in the code for later, behind the check the report suggests (median of sub-windows or short vs long mean, plus a minimum in-range liquidity) and a new review |
| 2 | Medium | `createSharedPlan`: a user takes back `creatorShareBps` of their own fees by naming a second address as creator | **Accepted by design.** It works as a referral discount: the copier never pays more than the normal fee, and the treasury gets at least half of it. If it is abused, the owner lowers the share for new plans with `setCreatorShare` |
| 3 | Medium | `executeDue` always scans from the front, and runs that buy nothing are free and come back after an hour, so ~180 $1.10 plans on a stale-feed stock starve every later plan | **Fixed.** `executeDue` scans `_active` round robin from a stored cursor (`_due`), and changing the interval of a plan waiting out a retry no longer pulls it forward. Tests: the auditor's proof, `test_scanResumesWhereItStopped`, `test_intervalChangeKeepsRetryWait` |
| 4 | Low | Creator = the DCAC contract strands the creator's cut | **Fixed.** DCAC itself and the USDC token count as no creator. Tests: the auditor's proof, `test_usdcAsCreatorIsNoCreator` |
| 5 | Low | The smart-buys premium is charged on runs that fell back to the plain split | **Fixed.** `_allocate` reports whether it rebalanced; a fallback run pays the base fee and the rest of its budget stays in the plan. Tests: `test_noPremiumWhenSmartFellBack`, `test_premiumWhenRebalanced` |
| 6 | Low | `PoolTwapFeed` doesn't check the pool keeps a window's worth of observations | **Not in the launch** (see 1) |
| 7 | Low | No yield fee when the vault can't pay out at close | **Accepted.** The owner loses at most 10% of that plan's yield; the user is never charged more |
| 8 | Low | A sub-cent top-up into a savings plan reverts with `BadVaultDeposit` | **Fixed.** Amounts under $0.01 stay idle in the plan instead of going to the vault. Test: `test_subCentTopUpIntoSavingsPlan` |
| 9 | Info | The $0.10 minimum fee absorbs the smart-buys premium on baskets up to ~$13 a buy | **Accepted.** Small baskets already pay more than 0.75% through the minimum fee |
| 10 | Info | `AerodromeCLAdapter.MAX_SQRT_RATIO` is not the pool's constant | **Fixed.** Set to `1461446703485210103287273052203988822378723970342` |
| 11 | Info | `GAS_VAULT` (400k) is below what the mainnet savings vault costs | **Fixed.** Raised to 800k: worst case 4.55M gas per plan, 13.65M for `executeDue(3)` |
