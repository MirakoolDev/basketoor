// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DCAC} from "src/DCAC.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter} from "src/mocks/Mocks.sol";

/// skippedRuns is only ever incremented. A plan that fills six runs between every fully skipped run is
/// still closed once its lifetime total of skipped runs reaches maxSkippedRuns.
contract ProofSkippedRunsNeverReset is Test {
    DCAC b;
    MockUSDC usdc;
    MockStock stock;
    MockFeed feed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    uint256 t0 = 1_760_000_000;

    function setUp() public {
        vm.warp(t0);
        vm.startPrank(admin);
        usdc = new MockUSDC();
        MockSwapAdapter venue = new MockSwapAdapter(admin);
        b = new DCAC(usdc, ISwapAdapter(address(venue)), treasury, admin);
        stock = new MockStock("Apple", "AAPLc", 8, admin);
        feed = new MockFeed(8, 200e8, admin);
        stock.setMinter(address(venue));
        venue.setFeed(address(stock), feed);
        b.setAsset(address(stock), feed, true);
        b.setKeeper(keeper, true);
        // Same rule as the default (60), scaled down so the test stays short.
        b.setExecutionParams(150, 26 hours, 3);
        vm.stopPrank();
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
    }

    function test_isolatedSkipsDoNotCloseAHealthyPlan() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10e6;
        vm.prank(alice);
        uint256 id = b.createPlan("daily", tokens, amounts, 1 days, 100, false, false, type(uint256).max);

        // One run a day for 20 days. The price is too old on days 5, 12 and 19 only.
        for (uint256 day; day < 20; ++day) {
            vm.warp(t0 + day * 1 days);
            bool stale = (day == 5 || day == 12 || day == 19);
            vm.prank(admin);
            feed.setUpdatedAt(stale ? block.timestamp - 2 days : block.timestamp);
            vm.prank(keeper);
            b.executeDue(10);
        }

        (DCAC.Plan memory p,) = b.getPlan(id);
        assertTrue(p.active, "plan was closed although it never missed two runs in a row");
    }
}
