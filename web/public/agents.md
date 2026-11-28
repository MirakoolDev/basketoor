# DCAC for agents

> Integration guide for AI agents and bots.
> Site: https://dcac.fun · Chain: **Base (chain id 8453)** · No API key.
> MCP server: `https://dcac.fun/mcp` · REST: `https://dcac.fun/api/agents` · Skill: https://dcac.fun/skill.md

## What DCAC is

DCAC runs recurring buys (dollar-cost averaging) on Base. A person picks up to 5 assets and the dollars of each to buy every time, how often, and how many buys. They deposit the USDC once, and DCAC's keeper buys on schedule. Bought tokens go straight to the owner's wallet.

- **Assets:** Coinbase tokenized stocks (NVDA, AAPL, TSLA and more, priced by Chainlink), crypto (ETH, cbBTC), and **Bankr index tokens** listed on DCAC (one token backed by a basket of stocks and crypto).
- **Every fill is checked** against the asset's oracle price. A buy more than 1.5% worse is refused, and nothing is spent.
- **Closed markets:** if a stock can't be priced (market closed), that part of the buy is skipped and its USDC stays in the plan.
- **Savings yield:** USDC waiting to be spent earns yield in a Morpho vault (on by default).
- **Auto-rebalance (optional):** each buy is split toward the target mix (+0.25% fee).
- **Fee:** 0.5% of each buy, at least $0.10. Read live from the contract; `dcac_quote` always shows the current numbers.
- **Copy baskets:** anyone can copy a plan from its link. Whoever shared it gets part of each buy fee.
- **Stop any time:** the owner cancels and gets the unspent USDC back.

## Rules for agents

1. **Never ask for a private key or seed phrase.** Nothing here signs. Every write is an unsigned transaction or a link for the user's own wallet.
2. Prefer the **`signInApp.url`** from `dcac_build_plan`. It opens dcac.fun with the plan filled in, so the person sees the basket, the total and the fee before signing.
3. Quote before you build. Tell the person the total USDC deposit, the fee, how often and when it ends.
4. Not investment advice. Don't pick assets for someone; build what they ask for.

## MCP

Add `https://dcac.fun/mcp` as a remote MCP server (Streamable HTTP, no auth). In Claude Code:

```bash
claude mcp add --transport http dcac https://dcac.fun/mcp
```

## Tools

The same tools are served by MCP and by REST (`GET /api/agents/<tool>?...` or `POST /api/agents/<tool>` with a JSON body).

| Tool | What it does |
|---|---|
| `dcac_assets` | What DCAC can buy now: symbol, token, live price, `canBuyNow`, price source. Optional `search`. |
| `dcac_indexes` | Bankr index tokens on Base: what each holds, backing, and `recurringBuysOnDcac`. Optional `search`, `limit`. |
| `dcac_quote` | Prices a plan: per-buy amounts, fee, total deposit, last buy date. Checks every contract rule. |
| `dcac_build_plan` | A prefilled dcac.fun link plus unsigned `approve` and `createPlan` transactions. Optional `owner` checks USDC balance and approval; optional `creator` credits whoever shared the basket. |
| `dcac_plans` | All plans of an `owner` wallet: invested, holdings value, profit, next buy, budget left. |
| `dcac_plan` | One plan by `id`, with a link to copy it. |
| `dcac_build_cancel` | Unsigned `cancelPlan` transaction for plan `id`; refunds unspent USDC. |

Plan inputs (`dcac_quote`, `dcac_build_plan`):

- `mix`: `[{ "asset": "NVDA", "usd": 15 }, { "asset": "ETH", "usd": 5 }]`. `asset` is a symbol from `dcac_assets` (`NVDA` and `NVDAc` both work) or a token address. At least $1 per asset per buy, at most 5 assets.
- `every`: seconds, or `"day"`, `"week"`, `"2 weeks"`, `"month"`, `"4h"`. From 1 hour to 30 days.
- `buys`: total number of buys, e.g. `52` for a year of weekly buys.
- `rebalance` (default false), `savings` (default true), `name` (optional).

Over REST, `mix` can be `SYMBOL:usd` pairs: `mix=NVDA:15,ETH:5`.

### Examples

```
GET https://dcac.fun/api/agents/assets?search=index
GET https://dcac.fun/api/agents/quote?mix=NVDA:15,ETH:5&every=week&buys=52
GET https://dcac.fun/api/agents/build_plan?mix=AAPL:10&every=2%20weeks&buys=26&owner=0x...
GET https://dcac.fun/api/agents/plans?owner=0x...
```

`dcac_build_plan` answers with:

```json
{
  "plan": { "perBuyTotalUsd": 20, "feePerBuyUsd": 0.1, "depositUsdc": 1045.2, "every": "every week", "buys": 52, "lastBuyAround": "2027-11-20" },
  "signInApp": { "url": "https://dcac.fun/#/new?mix=...&every=604800&name=...&buys=52" },
  "transactions": [
    { "step": "Approve USDC", "to": "0x8335...2913", "value": "0", "data": "0x095ea7b3...", "chainId": 8453 },
    { "step": "Create the plan", "to": "0xC9A5...3313", "value": "0", "data": "0x...", "chainId": 8453 }
  ]
}
```

Send the transactions in order from the owner's wallet. `createPlan` pulls exactly `depositUsdc` and refuses if fees changed so that it would need more.

## Links people can open

- New plan, prefilled: `https://dcac.fun/#/new?mix=<token>:<usd>,<token>:<usd>&every=<seconds>&buys=<n>&name=<name>` (add `&rebalance=1`, `&from=<creator>`).
- A plan: `https://dcac.fun/#/plan/<id>` · copy a plan: `https://dcac.fun/#/b/<id>`.
- An index: `https://dcac.fun/#/indexes/<token>` · create an index: `https://dcac.fun/#/indexes/new`.

## Contracts (Base)

| Contract | Address |
|---|---|
| DCAC | `0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Bankr IndexFactory | `0x49a3A6D33110425099A9f070d22f576f592b46eB` |
| Bankr IndexLens | `0x0E19BDeB4EF2443413926b9Daa72E484f63BB72b` |

Reads without the API: `getAssets()`, `priceOf(token)`, `plansOf(owner)`, `getPlan(id)`, `planValue(id)`, `quoteDeposit(perBuy, buys)` on DCAC. Source: https://github.com/MirakoolDev/basketoor

Tokenized stocks are not available to US persons. Not investment advice.
