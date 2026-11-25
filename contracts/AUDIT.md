# Basketoor: audit scope and notes

Commit: the first commit on `main` (2026-11-25). Solidity 0.8.28, via-IR, OpenZeppelin 5.4.

## Scope

| File | Lines | What |
|---|---|---|
| `src/Basketoor.sol` | 578 | Everything: plans, escrow, savings vault accounting, execution, fees, admin |
| `src/adapters/AerodromeCLAdapter.sol` | 95 | Mainnet venue: swaps directly against owner-set Aerodrome Slipstream pools (where Coinbase stocks are deepest), checks `minOut`, refuses partial fills |
| `src/adapters/UniswapV3Adapter.sol` | 50 | Alternative venue (SwapRouter02 `exactInput`). Untested, not planned for launch |
| `src/interfaces/*.sol` | 22 | `ISwapAdapter`, the slice of Chainlink's `AggregatorV3Interface` used |

Out of scope: `src/mocks/` (testnet only), `script/`, the keeper and the frontend.

Tests: `forge test` (15 tests). Coverage of `Basketoor.sol`: 83% lines, 52% branches. The adapter has none.

## Roles and trust

- **Plan owner**: creates, updates, cancels their own plan. Can always cancel and receive everything unspent (plus yield minus the yield fee). No dependency on the keeper or the owner to exit.
- **Keeper** (`keepers[addr]`): only `executeDue` / `executeMany`. Can choose *when* within a due window and the order of plans, nothing else: amounts, recipient and the price bound are fixed by the plan and the oracle.
- **Owner** (Ownable2Step): lists assets and their feeds, sets the swap adapter, savings vault (new plans only), treasury, fees (bounded; snapshotted per plan), slippage/staleness bounds, keepers, pause of new plans. The owner **cannot** withdraw plan funds directly, but chooses the adapter and the feeds, which is the real trust surface (see below).

## Intended invariants

1. For every active plan, `planValue(id) >= principal` absent vault losses, and `principal` = deposits − spent − fees.
2. The contract's loose USDC balance is 0 between transactions (all USDC is either `idle` of some plan or vault shares of some plan). `test_fullLifecycleSpendsBudgetExactly` checks this for one plan.
3. A leg is recorded as bought only if the recipient's balance rose by at least `minOut`, where `minOut` is derived from the Chainlink price minus `maxSlippageBps`.
4. Fees are charged only on USDC actually spent; a run where every leg is skipped charges nothing.
5. After `updatePlan`, the budget funds exactly `(maxBuys − buysDone) × (perBuy + fee)`.
6. A closed plan holds nothing and is not in `_active`.

## Known issues and things I'd look at first

1. **Owner-chosen adapter and feeds are trusted.** A malicious adapter is bounded by the oracle check (it can take at most `maxSlippageBps` of value per leg), but a malicious or wrong *feed* set via `setAsset` makes that bound meaningless. Mitigation idea: timelock `setAsset` / `setSwapAdapter`.
2. **Keeper MEV within the bound.** The keeper (or anyone who sees its tx) can sandwich a buy up to the slippage bound (1.5% default). Private mempool / tighter bound per asset would help.
3. **No L2 sequencer-uptime check.** Chainlink recommends checking the Base sequencer uptime feed before using prices on an L2. Not implemented.
4. **Vault rounding can underflow `p.shares`.** `_take` calls `vault.withdraw(amount)`, which burns `previewWithdraw` shares (rounded up), and subtracts from the plan's shares. If a plan's value is within rounding of the amount (e.g. after a vault loss), `p.shares -= burned` underflows and the **whole `executeDue` batch reverts**, blocking other plans until that one is cancelled. Fix idea: clamp, or withdraw via `redeem` of `min(shares, previewWithdraw)`.
5. **`UnderDelivered` reverts the whole batch.** If the adapter reports success but the recipient received less than `minOut`, the entire keeper transaction reverts (deliberate: it signals a broken adapter), but it also stalls every other due plan.
6. **`duePlans` / `dueCount` are O(active plans).** With many active plans, `executeDue` gas grows with the total number of plans, not just the due ones. Needs a cursor or an off-chain id list (`executeMany`) at scale.
7. **Stock-market hours.** Stock feeds hold the last close on weekends with a 24h heartbeat; `maxStaleness = 26h` means a Saturday buy can still use Friday's close (bounded by slippage). Crypto feeds share the same staleness setting.
8. **B20 specifics not modelled.** Transfer policies: a blocked recipient makes the swap revert, so that leg is skipped; after `maxSkippedRuns` the plan closes. Corporate-action multiplier changes: the Chainlink stock price is per token (it includes the multiplier), so `minOut` stays right, but `received` is in raw token units, not shares.
9. **Fee-on-transfer / rebasing assets** are not supported; the balance-diff check would reject under-delivery but `leg.received` assumes plain ERC-20s.
10. **Adapter testing.** Coinbase stocks are B20 *precompiles* that Foundry's fork mode can't execute, so `AerodromeCLAdapter` is checked with `script/simulate-aerodrome.sh`: an `eth_call` against a live Base node with state overrides. On 2026-11-23 a $100 buy filled at 100.36% (NVDAc) and 100.23% (AAPLc) of the Chainlink-implied amount. The callback trusts only the pool set for the swap in progress (transient storage). `UniswapV3Adapter` remains untested.
11. **B20 decimals.** Coinbase stocks use 8 decimals onchain (AAPLc, NVDAc checked); the testnet mocks now match.
