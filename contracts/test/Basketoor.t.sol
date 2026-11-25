// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Basketoor} from "../src/Basketoor.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter, MockSavingsVault} from "../src/mocks/Mocks.sol";

contract BasketoorTest is Test {
    Basketoor b;
    MockUSDC usdc;
    MockSwapAdapter venue;
    MockSavingsVault vault;
    MockStock nvda;
    MockStock tsla;
    MockFeed nvdaFeed;
    MockFeed tslaFeed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.startPrank(admin);
        usdc = new MockUSDC();
        venue = new MockSwapAdapter(admin);
        b = new Basketoor(usdc, ISwapAdapter(address(venue)), treasury, admin);
        vault = new MockSavingsVault(usdc);

        nvda = new MockStock("NVIDIA", "NVDA", 18, admin);
        tsla = new MockStock("Tesla", "TSLA", 18, admin);
        nvdaFeed = new MockFeed(8, 180e8, admin); // $180
        tslaFeed = new MockFeed(8, 400e8, admin); // $400
        nvda.setMinter(address(venue));
        tsla.setMinter(address(venue));
        venue.setFeed(address(nvda), nvdaFeed);
        venue.setFeed(address(tsla), tslaFeed);
        b.setAsset(address(nvda), nvdaFeed, true);
        b.setAsset(address(tsla), tslaFeed, true);
        b.setKeeper(keeper, true);
        b.setSavingsVault(IERC4626(address(vault)));
        vm.stopPrank();

        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
    }

    function _create(uint256 nvdaAmt, uint256 tslaAmt, uint32 buys, bool savings) internal returns (uint256) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(tsla);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = nvdaAmt;
        amounts[1] = tslaAmt;
        vm.prank(alice);
        return b.createPlan("tech", tokens, amounts, 1 days, buys, savings, type(uint256).max);
    }

    function _refreshPrices() internal {
        vm.startPrank(admin);
        nvdaFeed.setPrice(nvdaFeed.answer());
        tslaFeed.setPrice(tslaFeed.answer());
        vm.stopPrank();
    }

    function _run() internal returns (uint256) {
        vm.prank(keeper);
        return b.executeDue(50);
    }

    function test_createPullsExactBudget() public {
        // $10 + $10 per buy = $20; fee max(0.5% * 20 = $0.10, $0.10) = $0.10; 5 buys
        uint256 before = usdc.balanceOf(alice);
        uint256 id = _create(10e6, 10e6, 5, false);
        assertEq(before - usdc.balanceOf(alice), 5 * 20.1e6);
        assertEq(b.planValue(id), 5 * 20.1e6);
        assertEq(b.quoteDeposit(20e6, 5), 5 * 20.1e6);
    }

    function test_firstBuyIsImmediateAndSharesGoToWallet() public {
        uint256 id = _create(10e6, 10e6, 5, false);
        assertEq(_run(), 1);

        // $10 of NVDA at $180, minus the venue's 0.2% spread
        uint256 expected = uint256(10e6) * 1e18 * 1e8 / (180e8 * 1e6) * 9980 / 10000;
        assertEq(nvda.balanceOf(alice), expected);
        assertGt(tsla.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(treasury), 0.1e6);

        (Basketoor.Plan memory p, Basketoor.Leg[] memory legs) = b.getPlan(id);
        assertEq(p.buysDone, 1);
        assertEq(p.totalSpent, 20e6);
        assertEq(legs[0].spent, 10e6);
        assertEq(legs[0].received, expected);
        assertEq(p.nextRun, block.timestamp + 1 days);
    }

    function test_notDueUntilInterval() public {
        _create(10e6, 10e6, 5, false);
        _run();
        vm.warp(block.timestamp + 23 hours);
        assertEq(_run(), 0);
        vm.warp(block.timestamp + 1 hours);
        _refreshPrices();
        assertEq(_run(), 1);
    }

    function test_fullLifecycleSpendsBudgetExactly() public {
        uint256 id = _create(10e6, 10e6, 3, false);
        uint256 t = block.timestamp; // via_ir caches block.timestamp in tests, so track time locally
        for (uint256 i; i < 3; ++i) {
            _refreshPrices();
            _run();
            t += 1 days;
            vm.warp(t);
        }
        (Basketoor.Plan memory p,) = b.getPlan(id);
        assertFalse(p.active);
        assertEq(p.buysDone, 3);
        assertEq(usdc.balanceOf(treasury), 0.3e6);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(usdc.balanceOf(alice), 10_000e6 - 3 * 20.1e6);
        assertEq(b.activePlans().length, 0);
    }

    function test_staleFeedSkipsLegAndOnlyChargesForWhatFilled() public {
        uint256 id = _create(10e6, 10e6, 2, false);
        vm.prank(admin);
        tslaFeed.setUpdatedAt(block.timestamp - 3 days); // market closed
        _run();

        assertEq(tsla.balanceOf(alice), 0);
        assertGt(nvda.balanceOf(alice), 0);
        // fee on $10 spent: max($0.05, $0.10) = $0.10
        assertEq(usdc.balanceOf(treasury), 0.1e6);
        (Basketoor.Plan memory p,) = b.getPlan(id);
        assertEq(p.totalSpent, 10e6);
        // the $10 TSLA leg stays in the plan
        assertEq(b.planValue(id), 2 * 20.1e6 - 10.1e6);
    }

    function test_allLegsSkippedChargesNothingAndDoesNotCountABuy() public {
        uint256 id = _create(10e6, 10e6, 2, false);
        vm.startPrank(admin);
        nvdaFeed.setUpdatedAt(block.timestamp - 3 days);
        tslaFeed.setUpdatedAt(block.timestamp - 3 days);
        vm.stopPrank();
        assertEq(_run(), 1);

        (Basketoor.Plan memory p,) = b.getPlan(id);
        assertEq(p.buysDone, 0);
        assertEq(p.skippedRuns, 1);
        assertTrue(p.active);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(b.planValue(id), 2 * 20.1e6);
    }

    function test_venueWorseThanSlippageIsSkipped() public {
        vm.prank(admin);
        venue.setSpread(500); // 5% worse than the oracle, limit is 1.5%
        uint256 id = _create(10e6, 10e6, 2, false);
        _run();
        assertEq(nvda.balanceOf(alice), 0);
        assertEq(b.planValue(id), 2 * 20.1e6);
    }

    function test_cancelRefundsUnspent() public {
        uint256 id = _create(10e6, 10e6, 5, false);
        _run();
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        b.cancelPlan(id);
        assertEq(usdc.balanceOf(alice) - before, 4 * 20.1e6);
        assertEq(usdc.balanceOf(address(b)), 0);
    }

    function test_savingsEarnYieldAndProtocolKeepsItsCut() public {
        uint256 id = _create(10e6, 10e6, 5, true);
        assertEq(usdc.balanceOf(address(b)), 0);
        assertEq(usdc.balanceOf(address(vault)), 5 * 20.1e6);

        vault.accrue(100); // +1%
        _run();

        uint256 value = b.planValue(id);
        (Basketoor.Plan memory p,) = b.getPlan(id);
        uint256 yieldEarned = value - p.principal;
        assertGt(yieldEarned, 0);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(alice);
        b.cancelPlan(id);
        uint256 cut = usdc.balanceOf(treasury) - treasuryBefore;
        assertApproxEqAbs(cut, yieldEarned / 10, 2);
        assertApproxEqAbs(usdc.balanceOf(alice) - aliceBefore, value - cut, 2);
    }

    function test_updateResizesBudget() public {
        uint256 id = _create(10e6, 10e6, 5, false);
        _run(); // 4 buys left, 4 * 20.1 held

        address[] memory tokens = new address[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(tsla);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 20e6;
        amounts[1] = 0; // pause TSLA

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        b.updatePlan(id, "nvda only", tokens, amounts, 1 days, 11, type(uint256).max); // 10 buys left of $20 + $0.10
        assertEq(before - usdc.balanceOf(alice), 10 * 20.1e6 - 4 * 20.1e6);
        assertEq(b.planValue(id), 10 * 20.1e6);

        vm.prank(alice);
        b.updatePlan(id, "nvda only", tokens, amounts, 1 days, 3, type(uint256).max); // 2 left
        assertEq(b.planValue(id), 2 * 20.1e6);
    }

    function test_onlyKeeperRuns() public {
        _create(10e6, 10e6, 5, false);
        vm.prank(alice);
        vm.expectRevert(Basketoor.NotKeeper.selector);
        b.executeDue(10);
    }

    function test_onlyOwnerCancels() public {
        uint256 id = _create(10e6, 10e6, 5, false);
        vm.prank(keeper);
        vm.expectRevert(Basketoor.NotPlanOwner.selector);
        b.cancelPlan(id);
    }

    function test_rejectsUnlistedAndDuplicateStocks() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(nvda);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 5e6;
        amounts[1] = 5e6;
        vm.prank(alice);
        vm.expectRevert(Basketoor.BadLegs.selector);
        b.createPlan("dup", tokens, amounts, 1 days, 3, false, type(uint256).max);

        tokens[1] = address(usdc);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Basketoor.AssetNotEnabled.selector, address(usdc)));
        b.createPlan("bad", tokens, amounts, 1 days, 3, false, type(uint256).max);
    }

    function test_underGassedCallRevertsInsteadOfNoop() public {
        _create(10e6, 10e6, 5, false);
        vm.prank(keeper);
        (bool ok,) = address(b).call{gas: 120_000}(abi.encodeCall(Basketoor.executeDue, (10)));
        assertFalse(ok);
        assertEq(b.dueCount(), 1);
    }

    function test_manyPlansInOneKeeperCall() public {
        for (uint256 i; i < 10; ++i) {
            _create(5e6, 5e6, 3, i % 2 == 0);
        }
        assertEq(b.dueCount(), 10);
        assertEq(_run(), 10);
        assertEq(b.dueCount(), 0);
    }
}
