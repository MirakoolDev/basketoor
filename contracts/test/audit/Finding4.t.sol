// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DCAC} from "src/DCAC.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter} from "src/mocks/Mocks.sol";

/// A run where every leg is skipped moves nextRun a whole interval on, exactly like a completed buy.
/// A weekly plan opened while the market is closed is therefore attempted at the same closed-market
/// moment every week and never buys, although the price is usable on five days out of seven.
contract ProofSkippedRunIsNotRetried is Test {
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
        vm.stopPrank();
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
    }

    function test_weeklyPlanOpenedOnAClosedMarketDayEventuallyBuys() public {
        // The plan is opened on a closed-market day: the last price is 27 hours old (> maxStaleness of 26h).
        vm.prank(admin);
        feed.setUpdatedAt(t0 - 27 hours);

        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 20e6;
        vm.prank(alice);
        uint256 id = b.createPlan("weekly", tokens, amounts, 7 days, 10, false, false, type(uint256).max);

        // The keeper calls executeDue every 6 hours for four weeks. Day 0 and day 6 of each week are
        // closed-market days (price 27h old); on days 1-5 the price is fresh.
        for (uint256 k; k <= 28 * 4; ++k) {
            uint256 t = t0 + k * 6 hours;
            vm.warp(t);
            uint256 dow = ((t - t0) / 1 days) % 7;
            vm.prank(admin);
            feed.setUpdatedAt(dow >= 1 && dow <= 5 ? t : t - 27 hours);
            vm.prank(keeper);
            b.executeDue(10);
        }

        (DCAC.Plan memory p,) = b.getPlan(id);
        assertGt(p.buysDone, 0, "no buy in four weeks although the price was usable on 20 of the 28 days");
    }
}
