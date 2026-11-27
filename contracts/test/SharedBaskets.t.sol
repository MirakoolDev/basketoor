// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DCAC} from "../src/DCAC.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter} from "../src/mocks/Mocks.sol";

/// Shared baskets: a plan opened from someone's shared basket pays them a share of each buy fee.
contract SharedBasketsTest is Test {
    DCAC b;
    MockUSDC usdc;
    MockSwapAdapter venue;
    MockStock nvda;
    MockStock tsla;
    MockFeed nvdaFeed;
    MockFeed tslaFeed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address carol = makeAddr("carol"); // shares a basket

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.startPrank(admin);
        usdc = new MockUSDC();
        venue = new MockSwapAdapter(admin);
        b = new DCAC(usdc, ISwapAdapter(address(venue)), treasury, admin);
        nvda = new MockStock("NVIDIA", "NVDA", 8, admin);
        tsla = new MockStock("Tesla", "TSLA", 8, admin);
        nvdaFeed = new MockFeed(8, 100e8, admin);
        tslaFeed = new MockFeed(8, 100e8, admin);
        nvda.setMinter(address(venue));
        tsla.setMinter(address(venue));
        venue.setFeed(address(nvda), nvdaFeed);
        venue.setFeed(address(tsla), tslaFeed);
        b.setAsset(address(nvda), nvdaFeed, true);
        b.setAsset(address(tsla), tslaFeed, true);
        b.setKeeper(keeper, true);
        vm.stopPrank();
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
    }

    function _legs() internal view returns (address[] memory t, uint256[] memory a) {
        t = new address[](2);
        t[0] = address(nvda);
        t[1] = address(tsla);
        a = new uint256[](2);
        a[0] = 60e6;
        a[1] = 40e6;
    }

    function _shared(address creator, bool smart) internal returns (uint256) {
        (address[] memory t, uint256[] memory a) = _legs();
        vm.prank(alice);
        return b.createSharedPlan(creator, "copy", t, a, 1 days, 10, false, smart, type(uint256).max);
    }

    function _run() internal {
        vm.prank(keeper);
        b.executeDue(10);
    }

    function test_creatorGetsHalfOfEachBuyFee() public {
        uint256 id = _shared(carol, false);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.creator, carol);
        assertEq(p.creatorShareBps, 5_000);
        assertEq(p.principal, 10 * 100.5e6); // same deposit as an unshared plan
        _run();
        // $100 buy, $0.50 fee: $0.25 each
        assertEq(usdc.balanceOf(carol), 0.25e6);
        assertEq(usdc.balanceOf(treasury), 0.25e6);
        assertEq(b.creatorEarned(carol), 0.25e6);
        (p,) = b.getPlan(id);
        assertEq(p.totalFees, 0.5e6);
    }

    function test_splitIncludesPremiumAndMinFee() public {
        _shared(carol, true); // 0.75% of $100
        _run();
        assertEq(usdc.balanceOf(carol), 0.375e6);
        assertEq(usdc.balanceOf(treasury), 0.375e6);
    }

    function test_selfShareIsNoCreator() public {
        uint256 id = _shared(alice, false);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.creator, address(0));
        _run();
        assertEq(usdc.balanceOf(treasury), 0.5e6);
        assertEq(b.creatorEarned(alice), 0);
    }

    function test_zeroCreatorIsPlainPlan() public {
        uint256 id = _shared(address(0), false);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.creator, address(0));
        assertEq(p.creatorShareBps, 0);
    }

    function test_plainCreatePlanHasNoCreator() public {
        (address[] memory t, uint256[] memory a) = _legs();
        vm.prank(alice);
        uint256 id = b.createPlan("own", t, a, 1 days, 10, false, false, type(uint256).max);
        _run();
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.creator, address(0));
        assertEq(usdc.balanceOf(treasury), 0.5e6);
    }

    function test_shareIsSnapshotted() public {
        uint256 id = _shared(carol, false);
        vm.prank(admin);
        b.setCreatorShare(10_000);
        _run();
        assertEq(usdc.balanceOf(carol), 0.25e6); // still half: fixed when the plan was opened
        (DCAC.Plan memory p,) = b.getPlan(_shared(carol, false));
        assertEq(p.creatorShareBps, 10_000);
    }

    function test_setCreatorShareBounds() public {
        vm.prank(admin);
        vm.expectRevert(DCAC.BadConfig.selector);
        b.setCreatorShare(10_001);
        vm.prank(alice);
        vm.expectRevert();
        b.setCreatorShare(1);
    }

    function test_noFeeNoCutWhenEverythingSkipped() public {
        vm.prank(admin);
        nvdaFeed.setUpdatedAt(block.timestamp - 30 hours);
        vm.prank(admin);
        tslaFeed.setUpdatedAt(block.timestamp - 30 hours);
        _shared(carol, false);
        _run();
        assertEq(usdc.balanceOf(carol), 0);
        assertEq(b.creatorEarned(carol), 0);
    }

    function test_cancelRefundsAndCreatorKeepsWhatWasPaid() public {
        uint256 id = _shared(carol, false);
        _run();
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        b.cancelPlan(id);
        assertEq(usdc.balanceOf(alice) - before, 9 * 100.5e6);
        assertEq(usdc.balanceOf(carol), 0.25e6);
        assertEq(usdc.balanceOf(address(b)), 0);
    }
}
