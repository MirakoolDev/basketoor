import type { Address } from "viem";

/// Base mainnet listing: every Coinbase tokenized stock with an Aerodrome Slipstream USDC pool holding at least
/// $10k (scanned Nov 2026 with keeper/scan-stocks.mjs), plus ETH and cbBTC. Assets with a Chainlink feed are
/// priced from it (NVDA, GOOGL and TSLA from Chainlink's 24/7 feeds, so they buy on weekends too). The rest are
/// priced from a 30-minute TWAP of their own Aerodrome pool (PoolTwapFeed): the onchain market price.
export type MainnetAsset = {
  symbol: string;
  name: string;
  kind: "stock" | "crypto";
  decimals: number;
  token: Address;
  pool: Address; // Aerodrome Slipstream pool against USDC: the swap route, and the price source when there's no Chainlink feed
  chainlink: Address | null;
  allHours?: boolean; // a Chainlink 24/7 feed
};

export const MAINNET = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  aerodromeClFactory: "0x9CB220581b91b0C83223012FE69688b92aD07a76",
  savingsVault: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", // Gauntlet USDC Prime (Morpho)
  twapWindow: 1800, // seconds
} as const;

export const MAINNET_ASSETS: MainnetAsset[] = [
  { symbol: "NVDA", name: "NVIDIA", kind: "stock", decimals: 8, token: "0xb20000000000000000000078ee7ce2fE4908108C", pool: "0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC", chainlink: "0x48D9731AF6cc55b879FE76a4Bd1A6c2C0bDaf944", allHours: true },
  { symbol: "META", name: "Meta Platforms", kind: "stock", decimals: 8, token: "0xb2000000000000000000008bC8786B856E61707C", pool: "0xd072410fa13D242e1d53721Bcf7AF02e3455DC96", chainlink: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D" },
  { symbol: "AAPL", name: "Apple", kind: "stock", decimals: 8, token: "0xb200000000000000000000C2e324d24d7eEcd1fb", pool: "0xF5FCB9CDAFcE67d50AfEf298F88E709d2B946BA6", chainlink: "0x787f13dEa48Db0897CbCDD985de77809D837F988" },
  { symbol: "GOOGL", name: "Alphabet", kind: "stock", decimals: 8, token: "0xb2000000000000000000002D0BA3164cc74f58B7", pool: "0x16c70F04C3080a127486Cdf5a4C33c066bBF47C3", chainlink: "0xdD9b9EC942477AA672a15adF91AC5089BD86cD85", allHours: true },
  { symbol: "AMZN", name: "Amazon", kind: "stock", decimals: 8, token: "0xb200000000000000000000d9192b6B456483C2E8", pool: "0x532e0F46d1e528507FC9454d5847C231f23bDDf6", chainlink: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295" },
  { symbol: "MSFT", name: "Microsoft", kind: "stock", decimals: 8, token: "0xB200000000000000000000Ab99cFa739E253872B", pool: "0x2740C0faAb738F6e346e545fDE02aEF9B1A01ee7", chainlink: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c" },
  { symbol: "MSTR", name: "Strategy", kind: "stock", decimals: 8, token: "0xb2000000000000000000004884b426556b92883d", pool: "0x66DCd42E6314B287110922AE36cB2a8bdEECc153", chainlink: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a" },
  { symbol: "SNDK", name: "Sandisk", kind: "stock", decimals: 8, token: "0xb200000000000000000000397293Cb8cda9a10c5", pool: "0x2836e062a3fe75943a7F4A552E2365b98E414E75", chainlink: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA" },
  { symbol: "SPCX", name: "SpaceX", kind: "stock", decimals: 8, token: "0xb2000000000000000000007b9fcbd005511aCBd5", pool: "0x880dB7Dda4407D99508574E680d067D1164B3cFE", chainlink: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68" },
  { symbol: "TSLA", name: "Tesla", kind: "stock", decimals: 8, token: "0xb2000000000000000000001e800a7f5189430cD0", pool: "0x7A33000372f3F028f074182CCb9d16cBEEfBF920", chainlink: "0xa5Ccd0315346b9A8A1D0AFEcD7Cc4e820e405e96", allHours: true },
  { symbol: "ANT", name: "Anthropic", kind: "stock", decimals: 8, token: "0xb20000000000000000000016e38FD364d271Ba28", pool: "0x599C4225FE90214795a0be228D20d7680f8CED15", chainlink: "0xeEDc7412E991a3F2BD693eb2aC7fB0F27d4660dA" },
  { symbol: "CRCL", name: "Circle Internet Group", kind: "stock", decimals: 8, token: "0xB20000000000000000000019f6E7C675b73C2e4D", pool: "0x294666AD6a415E8C33Af801225c04079BB4f1133", chainlink: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33" },
  { symbol: "INTC", name: "Intel", kind: "stock", decimals: 8, token: "0xB2000000000000000000004AFF16039bA04bdFBc", pool: "0x3D384288fA79B51De882B06B617aB7989CcAd4f3", chainlink: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB" },
  { symbol: "AAOI", name: "Applied Optoelectronics", kind: "stock", decimals: 8, token: "0xb200000000000000000000cf36D05963A3E2205c", pool: "0xfb35D41801893197b5A4d477D0Bf6737D2AD6106", chainlink: null },
  { symbol: "ADBE", name: "Adobe", kind: "stock", decimals: 8, token: "0xB20000000000000000000034533Ed3961f222Cd4", pool: "0x80997E422e1d03f8d41Fe831A306df674128050d", chainlink: null },
  { symbol: "AMD", name: "Advanced Micro Devices", kind: "stock", decimals: 8, token: "0xB2000000000000000000000d8Ce462E99ee7A47B", pool: "0x138Cb591C4A7D854D796E1906af8228d84CB7642", chainlink: null },
  { symbol: "AVGO", name: "Broadcom", kind: "stock", decimals: 8, token: "0xB200000000000000000000Fc737aeA6196aB5a4c", pool: "0x086A1447D0851F0aeA9D09D6c547fEC8E97be413", chainlink: null },
  { symbol: "BE", name: "Bloom Energy", kind: "stock", decimals: 8, token: "0xb20000000000000000000016f9dfe862feBA122b", pool: "0xDe2BfE5409aD9e825cdB3562A06EDaFb9d753DFc", chainlink: null },
  { symbol: "BRK.B", name: "Berkshire Hathaway", kind: "stock", decimals: 8, token: "0xb20000000000000000000024170488e788CBbCb4", pool: "0xBc5682De77d729397739982a577b7963eF2f6556", chainlink: null },
  { symbol: "CRWV", name: "CoreWeave", kind: "stock", decimals: 8, token: "0xB200000000000000000000F111184A74720787E6", pool: "0x4D942B4239e0894E5a80ca2b3944e3467F4Ee464", chainlink: null },
  { symbol: "GME", name: "GameStop", kind: "stock", decimals: 8, token: "0xb2000000000000000000007790ed6E48e06eD935", pool: "0xe1199A8B3cC490e2538AdBD24c4853f78Cbcaa07", chainlink: null },
  { symbol: "HIMS", name: "Hims & Hers Health", kind: "stock", decimals: 8, token: "0xB20000000000000000000043a599976181Bcf336", pool: "0x41D7793FAa4Ca181B6f021423fF3F9015C00b2ff", chainlink: null },
  { symbol: "HOOD", name: "Robinhood Markets", kind: "stock", decimals: 8, token: "0xb2000000000000000000006F944897540579D3f2", pool: "0x25B45fF27bd03dAfa0C0bf458762FFD0911fA9de", chainlink: null },
  { symbol: "KO", name: "Coca-Cola", kind: "stock", decimals: 8, token: "0xb200000000000000000000ffef181DB6dC5ed6A3", pool: "0x59C7a81E752fCa11b89E29Fa98E56A6f2eAD5fb3", chainlink: null },
  { symbol: "LITE", name: "Lumentum", kind: "stock", decimals: 8, token: "0xB200000000000000000000eDA6C2c6F11E0F838f", pool: "0x16B8228cD097865d8F5A534B95e42e17D84551b0", chainlink: null },
  { symbol: "LLY", name: "Eli Lilly", kind: "stock", decimals: 8, token: "0xB200000000000000000000f1a0F91e34892E4718", pool: "0x2b7ee4623ec6AfbC1e587b2668c0ED8F3ff44949", chainlink: null },
  { symbol: "MCD", name: "McDonald's", kind: "stock", decimals: 8, token: "0xb200000000000000000000d2f4cf2f7DEBB244BB", pool: "0x743f16eE460aB7401321e7F35c3FD187Eff7d711", chainlink: null },
  { symbol: "MRNA", name: "Moderna", kind: "stock", decimals: 8, token: "0xB200000000000000000000e215e9B76ecBA02468", pool: "0x4ae3780242F43ef63C471Fb8c2E9D30ec5fd5821", chainlink: null },
  { symbol: "MRVL", name: "Marvell Technology", kind: "stock", decimals: 8, token: "0xB200000000000000000000eC3c4c7395Cc609813", pool: "0x611ab290422d534D9595b01e648911fefA963137", chainlink: null },
  { symbol: "MU", name: "Micron Technology", kind: "stock", decimals: 8, token: "0xb200000000000000000000Fd2f87532B90095211", pool: "0x41e21950362B1014bC629252ecFFF8fcA5F1646C", chainlink: null },
  { symbol: "NFLX", name: "Netflix", kind: "stock", decimals: 8, token: "0xb20000000000000000000058B8c947e44011dFE6", pool: "0x67Ba8dBeDC6D7f93f0F5967Aa2420715f1edC756", chainlink: null },
  { symbol: "NOW", name: "ServiceNow", kind: "stock", decimals: 8, token: "0xB20000000000000000000082Cd2C7801305808Df", pool: "0xe2935CD42271a31afDeDAEebc1e491214202E6b0", chainlink: null },
  { symbol: "ORCL", name: "Oracle", kind: "stock", decimals: 8, token: "0xb200000000000000000000347AFbA223D7B6b63C", pool: "0x62B5452E80E50B047dcF6dd3Fb6a1D266C678eB5", chainlink: null },
  { symbol: "PLTR", name: "Palantir Technologies", kind: "stock", decimals: 8, token: "0xb2000000000000000000007d16372840dF4dAbbe", pool: "0xA0473ceD0cd1bfB857e3E04B5FA4b6aF18C5e44d", chainlink: null },
  { symbol: "SNOW", name: "Snowflake", kind: "stock", decimals: 8, token: "0xB2000000000000000000004AcDC9A922FCfBCc7f", pool: "0x20812d6c78D972EeA8DF85319eC721DB1e67B31F", chainlink: null },
  { symbol: "TTWO", name: "Take-Two Interactive Software", kind: "stock", decimals: 8, token: "0xB200000000000000000000f720C26062Bc3067Da", pool: "0x18907cAE5a9c7b45F85c5d2e1F7508C27c134f83", chainlink: null },
  { symbol: "UBER", name: "Uber Technologies", kind: "stock", decimals: 8, token: "0xb200000000000000000000cAE20cb1446462e24c", pool: "0x10658504d00D3D65610c0FD72a81B6926109117A", chainlink: null },
  { symbol: "WDC", name: "Western Digital", kind: "stock", decimals: 8, token: "0xb2000000000000000000008fde21a1F5c69FeC0b", pool: "0x8468bFD8A3c5bB04C44dabF3329D7902F340B12b", chainlink: null },
  { symbol: "ETH", name: "Ether", kind: "crypto", decimals: 18, token: "0x4200000000000000000000000000000000000006", pool: "0x4A7af46bC8aBc00048c6c7920a1488DAF568366c", chainlink: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
  { symbol: "cbBTC", name: "Coinbase Wrapped BTC", kind: "crypto", decimals: 8, token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", pool: "0x42609aA1E58C5dD7E5a012DC74118fFf975F0Eac", chainlink: "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D" },
];
