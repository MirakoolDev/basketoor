// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Basketoor} from "../src/Basketoor.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter, MockSavingsVault} from "../src/mocks/Mocks.sol";

/// @notice Deploys Basketoor with test USDC, mocks of the ten Coinbase tokenized stocks and five Base crypto
/// tokens, Chainlink-style feeds, a mock venue and a savings vault. Works on Base Sepolia and on a local anvil.
///
///   forge script script/DeployTestnet.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_KEY
///
/// Env: KEEPER (address allowed to run buys; default: the deployer), TREASURY (default: the deployer).
/// Writes deployments/<chainId>.json, which the frontend and the keeper read.
contract DeployTestnet is Script {
    struct Listing {
        string symbol;
        string name;
        string kind; // "stock" | "crypto"
        uint8 decimals;
        int256 seed; // rough USD price, 8 decimals; keeper/sync-prices replaces it with Base mainnet Chainlink
    }

    function listings() internal pure returns (Listing[] memory l) {
        l = new Listing[](15);
        l[0] = Listing("AAPL", "Apple", "stock", 8, 230e8);
        l[1] = Listing("AMZN", "Amazon", "stock", 8, 220e8);
        l[2] = Listing("GOOGL", "Alphabet", "stock", 8, 250e8);
        l[3] = Listing("META", "Meta Platforms", "stock", 8, 700e8);
        l[4] = Listing("MSFT", "Microsoft", "stock", 8, 500e8);
        l[5] = Listing("MSTR", "Strategy", "stock", 8, 300e8);
        l[6] = Listing("NVDA", "NVIDIA", "stock", 8, 180e8);
        l[7] = Listing("SNDK", "Sandisk", "stock", 8, 100e8);
        l[8] = Listing("SPCX", "SPCX", "stock", 8, 100e8);
        l[9] = Listing("TSLA", "Tesla", "stock", 8, 400e8);
        l[10] = Listing("ETH", "Ether", "crypto", 18, 2000e8);
        l[11] = Listing("cbBTC", "Coinbase Wrapped BTC", "crypto", 8, 60000e8);
        l[12] = Listing("cbETH", "Coinbase Wrapped Staked ETH", "crypto", 18, 2200e8);
        l[13] = Listing("AERO", "Aerodrome", "crypto", 18, 0.5e8);
        l[14] = Listing("LINK", "Chainlink", "crypto", 18, 10e8);
    }

    function run() external {
        address deployer = msg.sender;
        address keeper = vm.envOr("KEEPER", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        Listing[] memory l = listings();

        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        MockSwapAdapter venue = new MockSwapAdapter(deployer);
        MockSavingsVault vault = new MockSavingsVault(usdc);
        Basketoor b = new Basketoor(usdc, ISwapAdapter(address(venue)), treasury, deployer);
        b.setSavingsVault(IERC4626(address(vault)));
        b.setKeeper(keeper, true);
        if (keeper != deployer) b.setKeeper(deployer, true);

        string memory assetsJson = "[";
        for (uint256 i; i < l.length; ++i) {
            MockStock token = new MockStock(l[i].name, l[i].symbol, l[i].decimals, deployer);
            MockFeed feed = new MockFeed(8, l[i].seed, deployer);
            if (keeper != deployer) feed.setUpdater(keeper, true);
            token.setMinter(address(venue));
            venue.setFeed(address(token), feed);
            b.setAsset(address(token), feed, true);
            assetsJson = string.concat(
                assetsJson,
                i == 0 ? "" : ",",
                '{"symbol":"',
                l[i].symbol,
                '","name":"',
                l[i].name,
                '","kind":"',
                l[i].kind,
                '","token":"',
                vm.toString(address(token)),
                '","feed":"',
                vm.toString(address(feed)),
                '"}'
            );
        }
        vm.stopBroadcast();
        assetsJson = string.concat(assetsJson, "]");

        string memory json = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"startBlock":',
            vm.toString(block.number),
            ',"basketoor":"',
            vm.toString(address(b)),
            '","usdc":"',
            vm.toString(address(usdc)),
            '","venue":"',
            vm.toString(address(venue)),
            '","savingsVault":"',
            vm.toString(address(vault)),
            '","keeper":"',
            vm.toString(keeper),
            '","mock":true,"stocks":',
            assetsJson,
            "}"
        );
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
        console.log("Basketoor", address(b));
        console.log("wrote", path);
    }
}
