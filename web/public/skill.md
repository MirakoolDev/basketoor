---
name: dcac
description: Set up and check recurring buys (DCA) of tokenized stocks, crypto and Bankr index tokens on Base with DCAC. Use when someone wants to buy a stock, index or crypto every day/week/month, see what DCAC can buy, price a plan, check their DCAC plans, or stop one. Prepares links and unsigned transactions; never signs.
---

# DCAC

DCAC (https://dcac.fun) buys a basket of up to 5 assets on a schedule on Base. The owner deposits USDC once; DCAC's keeper buys each period and sends the tokens to the owner's wallet. Assets: Coinbase tokenized stocks (Chainlink-priced), ETH, cbBTC, and Bankr index tokens listed on DCAC.

## How to call it

Use the DCAC MCP tools if they are connected (`https://dcac.fun/mcp`). Otherwise call the REST API, which has the same tools:

```
GET https://dcac.fun/api/agents/<tool>?<params>
POST https://dcac.fun/api/agents/<tool>   (JSON body)
```

| Tool | Use it to |
|---|---|
| `dcac_assets` | See what can be bought and whether it can buy right now (`search` optional). |
| `dcac_indexes` | Browse Bankr index tokens and see which DCAC can buy on a schedule. |
| `dcac_quote` | Price a plan: `mix`, `every`, `buys` (plus `rebalance`, `savings`, `name`). |
| `dcac_build_plan` | Get a prefilled dcac.fun link and unsigned approve + create transactions. |
| `dcac_plans` | List a wallet's plans (`owner`). |
| `dcac_plan` | One plan (`id`). |
| `dcac_build_cancel` | Unsigned transaction to stop a plan and refund unspent USDC (`id`). |

`mix` is a list like `[{"asset":"NVDA","usd":15},{"asset":"ETH","usd":5}]` (REST also takes `mix=NVDA:15,ETH:5`). `every` is seconds or words like `day`, `week`, `2 weeks`, `month`. `buys` is the total number of buys.

## Workflow

1. If the person names assets, check them with `dcac_assets`. For an index, check `dcac_indexes` and make sure `recurringBuysOnDcac` is true.
2. Run `dcac_quote`. Tell them the per-buy amounts, the fee, the total USDC deposit, how often, and the date of the last buy. Mention any asset that can't buy right now.
3. When they confirm, run `dcac_build_plan` and give them `signInApp.url`. They open it, sign in, check and press Create.
4. Only if they want raw transactions (an agent wallet they control), give `transactions` in order: approve, then create.

## Rules

- Never ask for or accept a private key or seed phrase. You only prepare; the person signs.
- Build what they ask for. Don't recommend assets. Not investment advice.
- Tokenized stocks aren't available to US persons; say so if it comes up.
- Full guide: https://dcac.fun/agents.md
