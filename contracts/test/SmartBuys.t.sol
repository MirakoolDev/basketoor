// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {DCAC} from "../src/DCAC.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter} from "../src/mocks/Mocks.sol";

/// Smart buys: each buy steers the same USDC toward the stocks that are under their target weight.
contract SmartBuysTest is Test {
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
    address bob = makeAddr("bob");

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

    function _create(uint256 nvdaAmt, uint256 tslaAmt, bool smart) internal returns (uint256) {
        address[] memory t = new address[](2);
        t[0] = address(nvda);
        t[1] = address(tsla);
        uint256[] memory a = new uint256[](2);
        a[0] = nvdaAmt;
        a[1] = tslaAmt;
        vm.prank(alice);
        return b.createPlan("smart", t, a, 1 days, 10, false, smart, type(uint256).max);
    }

    function _price(MockFeed f, int256 p) internal {
        vm.prank(admin);
        f.setPrice(p);
    }

    function _nextRun() internal {
        vm.warp(block.timestamp + 1 days);
        _price(nvdaFeed, nvdaFeed.answer()); // refresh both feeds
        _price(tslaFeed, tslaFeed.answer());
        vm.prank(keeper);
        b.executeDue(10);
    }

    function _spent(uint256 id) internal view returns (uint256 n, uint256 t) {
        (, DCAC.Leg[] memory legs) = b.getPlan(id);
        return (legs[0].spent, legs[1].spent);
    }

    function test_firstBuyUsesTargets() public {
        uint256 id = _create(10e6, 10e6, true);
        vm.prank(keeper);
        b.executeDue(10);
        (uint256 n, uint256 t) = _spent(id);
        assertEq(n, 10e6);
        assertEq(t, 10e6);
    }

    function test_steersTowardUnderweight() public {
        uint256 id = _create(10e6, 10e6, true);
        vm.prank(keeper);
        b.executeDue(10); // $10 each
        _price(nvdaFeed, 200e8); // NVDA doubles: holdings $20 NVDA / $10 TSLA
        _nextRun();
        // after this buy the basket is $50, so $25 each: NVDA needs $5, TSLA $15
        (uint256 n, uint256 t) = _spent(id);
        assertApproxEqAbs(n, 15e6, 0.02e6); // the mock venue keeps a small fee, so holdings sit a hair under
        assertApproxEqAbs(t, 25e6, 0.02e6);
        // the buy still spends exactly the per-buy amount; the fee is 0.5% + the 0.25% premium of $20 = $0.15
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.totalSpent, 40e6);
        assertEq(p.totalFees, 2 * 150_000);
    }

    function test_overweightLegGetsNothing() public {
        uint256 id = _create(10e6, 10e6, true);
        vm.prank(keeper);
        b.executeDue(10);
        _price(nvdaFeed, 300e8); // NVDA $30 vs TSLA $10: basket after buy $60, $30 each, NVDA already there
        _nextRun();
        (uint256 n, uint256 t) = _spent(id);
        assertEq(n, 10e6);
        assertEq(t, 30e6);
    }

    function test_dustShareGoesToMostUnderweight() public {
        uint256 id = _create(10e6, 10e6, true);
        vm.prank(keeper);
        b.executeDue(10);
        // NVDA $19.5, TSLA $10. Basket after buy $49.5, $24.75 each: NVDA needs $5.25, TSLA $14.75
        _price(nvdaFeed, 195e8);
        _nextRun();
        (uint256 n, uint256 t) = _spent(id);
        assertGt(n - 10e6, 1e6);
        // now make NVDA's share less than $1: holdings NVDA ~$20.0x vs TSLA $24.75 after a price cut
        _price(nvdaFeed, 136e8); // NVDA holdings ~= $20.88
        (n, t) = _spent(id);
        _nextRun();
        (uint256 n2, uint256 t2) = _spent(id);
        assertEq(n2 + t2 - n - t, 20e6);
    }

    function test_plainPlanIgnoresWeights() public {
        uint256 id = _create(10e6, 10e6, false);
        vm.prank(keeper);
        b.executeDue(10);
        _price(nvdaFeed, 200e8);
        _nextRun();
        (uint256 n, uint256 t) = _spent(id);
        assertEq(n, 20e6);
        assertEq(t, 20e6);
    }

    function test_unpricedLegFallsBackToAmounts() public {
        uint256 id = _create(10e6, 10e6, true);
        vm.prank(keeper);
        b.executeDue(10);
        _price(nvdaFeed, 200e8);
        vm.warp(block.timestamp + 1 days);
        _price(nvdaFeed, 200e8); // only NVDA is fresh: TSLA is stale (> 26h old)
        vm.warp(block.timestamp + 2 days);
        _price(nvdaFeed, 200e8);
        vm.prank(keeper);
        b.executeDue(10);
        (uint256 n, uint256 t) = _spent(id);
        assertEq(n, 20e6); // NVDA bought its plain amount even though it is overweight
        assertEq(t, 10e6); // TSLA skipped
    }

    function test_unevenTargets() public {
        uint256 id = _create(30e6, 10e6, true); // 75% / 25%
        vm.prank(keeper);
        b.executeDue(10);
        _price(tslaFeed, 300e8); // TSLA triples: $30 NVDA / $30 TSLA
        _nextRun();
        // basket after buy $100: targets $75 / $25. NVDA needs $45, TSLA is over: all $40 to NVDA
        (uint256 n, uint256 t) = _spent(id);
        assertEq(n, 70e6);
        assertEq(t, 10e6);
        (, uint256[] memory targets, uint256 drift) = b.weightsOf(id);
        assertEq(targets[0], 7_500);
        assertEq(targets[1], 2_500);
        // holdings: NVDA $70, TSLA $30 -> 70% / 30%, 5% over on TSLA
        assertApproxEqAbs(drift, 500, 1);
    }

    function test_toggle() public {
        uint256 id = _create(10e6, 10e6, false);
        vm.prank(bob);
        vm.expectRevert(DCAC.NotPlanOwner.selector);
        b.setSmartBuys(id, true, type(uint256).max);
        vm.prank(alice);
        b.setSmartBuys(id, true, type(uint256).max);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertTrue(p.smart);
    }

    // ---------------------------------------------------------------- premium

    function test_premiumOnlyOnSmartPlans() public {
        uint256 plain = _create(50e6, 50e6, false);
        uint256 smart = _create(50e6, 50e6, true);
        (DCAC.Plan memory pp,) = b.getPlan(plain);
        (DCAC.Plan memory ps,) = b.getPlan(smart);
        // $100 per buy, 10 buys: 0.5% = $0.50 a buy plain, 0.75% = $0.75 with smart buys
        assertEq(pp.principal, 10 * 100.5e6);
        assertEq(ps.principal, 10 * 100.75e6);
        vm.prank(keeper);
        b.executeDue(10);
        (pp,) = b.getPlan(plain);
        (ps,) = b.getPlan(smart);
        assertEq(pp.totalFees, 0.5e6);
        assertEq(ps.totalFees, 0.75e6);
        assertEq(usdc.balanceOf(treasury), 1.25e6);
    }

    function test_minFeeStillAppliesToSmallSmartPlans() public {
        uint256 id = _create(5e6, 5e6, true); // 0.75% of $10 = $0.075, under the $0.10 minimum
        vm.prank(keeper);
        b.executeDue(10);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.totalFees, 100_000);
    }

    function test_toggleResizesBudget() public {
        uint256 id = _create(50e6, 50e6, false);
        uint256 before = usdc.balanceOf(alice);
        // on: 10 buys left need 10 x $0.25 more in fees
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DCAC.DepositTooHigh.selector, 2.5e6));
        b.setSmartBuys(id, true, 2.5e6 - 1);
        vm.prank(alice);
        b.setSmartBuys(id, true, 2.5e6);
        assertEq(usdc.balanceOf(alice), before - 2.5e6);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.principal, 10 * 100.75e6);
        // one smart buy, then off: the 9 buys left get their premium back
        vm.prank(keeper);
        b.executeDue(10);
        vm.prank(alice);
        b.setSmartBuys(id, false, 0);
        assertEq(usdc.balanceOf(alice), before - 2.5e6 + 9 * 0.25e6);
        (p,) = b.getPlan(id);
        assertEq(p.principal, 9 * 100.5e6);
        assertEq(p.totalFees, 0.75e6);
    }

    function test_updatePlanCanToggleSmart() public {
        uint256 id = _create(50e6, 50e6, false);
        address[] memory t = new address[](2);
        t[0] = address(nvda);
        t[1] = address(tsla);
        uint256[] memory a = new uint256[](2);
        a[0] = 50e6;
        a[1] = 50e6;
        vm.prank(alice);
        b.updatePlan(id, "smart", t, a, 1 days, 10, true, 2.5e6);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertTrue(p.smart);
        assertEq(p.principal, 10 * 100.75e6);
    }

    function test_premiumIsSnapshotted() public {
        uint256 id = _create(50e6, 50e6, false);
        vm.prank(admin);
        b.setSmartFee(100); // 1% for new plans
        vm.prank(alice);
        b.setSmartBuys(id, true, type(uint256).max); // this plan keeps its 0.25%
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.smartFeeBps, 25);
        assertEq(p.principal, 10 * 100.75e6);
    }

    function test_feeCapIncludesPremium() public {
        vm.startPrank(admin);
        vm.expectRevert(DCAC.BadConfig.selector);
        b.setSmartFee(151); // 0.5% + 1.51% > 2%
        b.setSmartFee(150);
        vm.expectRevert(DCAC.BadConfig.selector);
        b.setFees(51, 100_000, 1_000);
        vm.expectRevert();
        vm.stopPrank();
        vm.prank(alice);
        b.setSmartFee(10);
    }

    function testFuzz_allocationSpendsExactlyPerBuy(uint256 nvdaAmt, uint256 tslaAmt, uint64 pn, uint64 pt) public {
        nvdaAmt = bound(nvdaAmt, 1e6, 400e6);
        tslaAmt = bound(tslaAmt, 1e6, 400e6);
        uint256 id = _create(nvdaAmt, tslaAmt, true);
        vm.prank(keeper);
        b.executeDue(10);
        _price(nvdaFeed, int256(uint256(bound(pn, 1e8, 10_000e8))));
        _price(tslaFeed, int256(uint256(bound(pt, 1e8, 10_000e8))));
        _nextRun();
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.totalSpent, 2 * (nvdaAmt + tslaAmt));
        (uint256 n, uint256 t) = _spent(id);
        assertEq(n + t, p.totalSpent);
    }
}
