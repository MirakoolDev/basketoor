# DCAC contracts

Foundry project for DCAC. Solidity 0.8.28, via-IR, OpenZeppelin 5.4.

Live on Base at [`0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313`](https://basescan.org/address/0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313#code), with the Aerodrome adapter at [`0x27826d88468904cF97C2DcE28E344A16E3693645`](https://basescan.org/address/0x27826d88468904cF97C2DcE28E344A16E3693645#code). Both are verified on Basescan and Sourcify. Every address is in [`deployments/8453.json`](deployments/8453.json).

| | |
|---|---|
| `src/DCAC.sol` | Plans, escrow, savings vault accounting, execution, auto-rebalance, shared baskets, fees, admin |
| `src/adapters/AerodromeCLAdapter.sol` | Mainnet swap venue: owner-set Aerodrome Slipstream pools |
| `src/adapters/UniswapV3Adapter.sol` | Alternative venue, unused |
| `src/feeds/PoolTwapFeed.sol` | 30-minute pool-average price feed, unused at launch |
| `src/mocks/` | Testnet stand-ins |
| `test/` | `forge test` (68 tests) |
| `script/DeployTestnet.s.sol` | Local / Base Sepolia deploy with mocks |

Audits and how each finding was resolved: [`AUDIT.md`](AUDIT.md).

```shell
forge build
forge test
```

To verify a new deployment, pass the constructor arguments: DCAC takes `(usdc, adapter, treasury, owner)`, the adapter `(aerodromeClFactory, owner)`.

```shell
forge verify-contract <address> src/DCAC.sol:DCAC --chain 8453 --verifier sourcify --constructor-args <abi-encoded args>
```
