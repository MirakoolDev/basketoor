# DCAC for Hermes Agent

Ask Hermes to set up recurring buys on Base: "Buy $15 of NVDA and $5 of ETH every week for a year." Hermes checks the assets, prices the plan and hands back a dcac.fun link that opens it prefilled. You sign in your own wallet.

| Tool | What it does |
|---|---|
| `dcac_assets` | What DCAC can buy now, with live prices. |
| `dcac_indexes` | Bankr index tokens on Base and whether DCAC buys them on a schedule. |
| `dcac_quote` | Per-buy amounts, fee, total deposit and last buy date for a plan. |
| `dcac_build_plan` | A prefilled link plus unsigned approve and create transactions. |
| `dcac_plans` / `dcac_plan` | A wallet's plans, or one plan, with holdings and profit. |
| `dcac_build_cancel` | Unsigned transaction to stop a plan and refund unspent USDC. |

## Install

Copy this folder to `~/.hermes/plugins/dcac/` and run `hermes plugins enable dcac`. No API key, no configuration, standard library only.

## Safety

- No keys. The plugin never asks for, stores or uses a private key. Writes come back as a link or unsigned transactions (`to`, `value`, `data`, `chainId`) for your own wallet.
- Network calls go only to `https://dcac.fun/api/agents`, which reads Base. Wallet addresses you ask about are sent there.

Other agents: the same tools are an MCP server at `https://dcac.fun/mcp`. Guide: https://dcac.fun/agents.md
