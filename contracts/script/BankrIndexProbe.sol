// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {BankrIndexRouter} from "../src/adapters/BankrIndexRouter.sol";
import {BankrIndexNavFeed} from "../src/feeds/BankrIndexNavFeed.sol";
import {IIndexFactory, IIndexHook, IIndexLens, IPoolManager} from "../src/interfaces/IBankrIndex.sol";

/// Run as an eth_call creation (script/simulate-bankr-index.sh): deploys the router and feed, buys $100 of
/// `index` with USDC the call gives this contract through a state override, and returns
/// (shares received, NAV per share in 8 decimals) as the "deployed code".
contract BankrIndexProbe {
    constructor(address index, address venue) {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        BankrIndexRouter router = new BankrIndexRouter(
            ISwapAdapter(venue),
            IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b),
            IIndexFactory(0x49a3A6D33110425099A9f070d22f576f592b46eB),
            IIndexHook(0x2Fd0ba044Faa96A9d1B0f010C0Dac3F696aA2888),
            usdc
        );
        BankrIndexNavFeed feed = new BankrIndexNavFeed(IIndexLens(0x0E19BDeB4EF2443413926b9Daa72E484f63BB72b), index);
        IERC20(usdc).approve(address(router), 100e6);
        uint256 out = router.swap(usdc, index, 100e6, 0, address(this));
        (, int256 nav,,,) = feed.latestRoundData();
        assembly {
            mstore(0, out)
            mstore(32, nav)
            return(0, 64)
        }
    }
}
