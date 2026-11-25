import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { dep } from "./config";

/// A token from CoinGecko's Base token list (2,800+ tokens, CORS-enabled, refreshed every 30 min).
export type ListToken = { address: Address; symbol: string; name: string; decimals: number; logoURI?: string };

const TOKEN_LIST_URL = "https://tokens.coingecko.com/base/all.json";

export function useTokenList() {
  return useQuery({
    queryKey: ["tokenlist"],
    staleTime: 30 * 60_000,
    gcTime: Infinity,
    retry: 2,
    queryFn: async () => {
      const res = await fetch(TOKEN_LIST_URL);
      if (!res.ok) throw new Error(`token list ${res.status}`);
      const json = (await res.json()) as { tokens: ListToken[] };
      const byAddress = new Map<string, ListToken>();
      for (const t of json.tokens) {
        // CoinGecko "thumb" is 25px; "small" is 64px and stays crisp at our sizes.
        const logo = t.logoURI?.replace("/thumb/", "/small/");
        byAddress.set(t.address.toLowerCase(), { ...t, logoURI: logo });
      }
      return { tokens: [...byAddress.values()], byAddress };
    },
  });
}

/// On testnet the assets are mocks; logos and names come from the real Base mainnet token.
const MAINNET_EQUIVALENT: Record<string, Address> = {
  ETH: "0x4200000000000000000000000000000000000006", // WETH
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  LINK: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196",
};

/// The address whose logo/metadata represents a listed asset.
export function logoAddressFor(symbol: string, token: Address): Address {
  return dep?.mock ? (MAINNET_EQUIVALENT[symbol] ?? token) : token;
}

/// Coinbase's official tokenized-stock logos (Base Tokenized Stocks API).
export const coinbaseStockLogo = (symbol: string) => `https://api.coinbase.com/v1/tokenized-stocks/images/${symbol}`;
