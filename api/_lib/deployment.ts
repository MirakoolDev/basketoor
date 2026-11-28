// Generated from contracts/deployments/8453.json by: node api/_lib/export-deployment.cjs
// The agent API reads DCAC's Base deployment from here.
export const deployment = {
  "dcac": "0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313",
  "usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "stocks": [
    {
      "symbol": "NVDA",
      "name": "NVIDIA",
      "kind": "stock",
      "token": "0xb20000000000000000000078ee7ce2fE4908108C",
      "pricing": "chainlink-24/7"
    },
    {
      "symbol": "META",
      "name": "Meta Platforms",
      "kind": "stock",
      "token": "0xb2000000000000000000008bC8786B856E61707C",
      "pricing": "chainlink"
    },
    {
      "symbol": "AAPL",
      "name": "Apple",
      "kind": "stock",
      "token": "0xb200000000000000000000C2e324d24d7eEcd1fb",
      "pricing": "chainlink"
    },
    {
      "symbol": "GOOGL",
      "name": "Alphabet",
      "kind": "stock",
      "token": "0xb2000000000000000000002D0BA3164cc74f58B7",
      "pricing": "chainlink-24/7"
    },
    {
      "symbol": "AMZN",
      "name": "Amazon",
      "kind": "stock",
      "token": "0xb200000000000000000000d9192b6B456483C2E8",
      "pricing": "chainlink"
    },
    {
      "symbol": "MSFT",
      "name": "Microsoft",
      "kind": "stock",
      "token": "0xB200000000000000000000Ab99cFa739E253872B",
      "pricing": "chainlink"
    },
    {
      "symbol": "MSTR",
      "name": "Strategy",
      "kind": "stock",
      "token": "0xb2000000000000000000004884b426556b92883d",
      "pricing": "chainlink"
    },
    {
      "symbol": "SNDK",
      "name": "Sandisk",
      "kind": "stock",
      "token": "0xb200000000000000000000397293Cb8cda9a10c5",
      "pricing": "chainlink"
    },
    {
      "symbol": "SPCX",
      "name": "SpaceX",
      "kind": "stock",
      "token": "0xb2000000000000000000007b9fcbd005511aCBd5",
      "pricing": "chainlink"
    },
    {
      "symbol": "TSLA",
      "name": "Tesla",
      "kind": "stock",
      "token": "0xb2000000000000000000001e800a7f5189430cD0",
      "pricing": "chainlink-24/7"
    },
    {
      "symbol": "ANT",
      "name": "Anthropic",
      "kind": "stock",
      "token": "0xb20000000000000000000016e38FD364d271Ba28",
      "pricing": "chainlink"
    },
    {
      "symbol": "CRCL",
      "name": "Circle Internet Group",
      "kind": "stock",
      "token": "0xB20000000000000000000019f6E7C675b73C2e4D",
      "pricing": "chainlink"
    },
    {
      "symbol": "INTC",
      "name": "Intel",
      "kind": "stock",
      "token": "0xB2000000000000000000004AFF16039bA04bdFBc",
      "pricing": "chainlink"
    },
    {
      "symbol": "ETH",
      "name": "Ether",
      "kind": "crypto",
      "token": "0x4200000000000000000000000000000000000006",
      "pricing": "chainlink"
    },
    {
      "symbol": "cbBTC",
      "name": "Coinbase Wrapped BTC",
      "kind": "crypto",
      "token": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "pricing": "chainlink"
    }
  ]
} as { dcac: string; usdc: string; stocks: { symbol: string; name: string; kind?: "stock" | "crypto" | "index"; token: string; pricing?: string }[] };
