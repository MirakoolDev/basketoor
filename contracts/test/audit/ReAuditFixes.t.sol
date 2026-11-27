// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {DCAC} from "src/DCAC.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter, MockSavingsVault} from "src/mocks/Mocks.sol";

/// Fixes for the imd.fun re-audit of 404e0ce (job 2b372e3c). The auditors' proofs for the starvation and
/// stranded-creator findings are included as they wrote them (only the shared base is merged).
abstract contract ReAuditBase is Test {
    DCAC b;
    MockUSDC usdc;
    MockSwapAdapter venue;
    MockSavingsVault vault;
    MockStock nvda;
    MockStock aapl;
    MockFeed nvdaFeed;
    MockFeed aaplFeed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");

    function setUp() public virtual {
        vm.warp(1_795_000_000);
        vm.startPrank(admin);
        usdc = new MockUSDC();
        venue = new MockSwapAdapter(admin);
        b = new DCAC(usdc, ISwapAdapter(address(venue)), treasury, admin);
        vault = new MockSavingsVault(usdc);
        b.setSavingsVault(IERC4626(address(vault)));
        nvda = new MockStock("NVIDIA", "NVDA", 8, admin);
        aapl = new MockStock("Apple", "AAPL", 8, admin);
        nvdaFeed = new MockFeed(8, 100e8, admin);
        aaplFeed = new MockFeed(8, 100e8, admin);
        nvda.setMinter(address(venue));
        aapl.setMinter(address(venue));
        venue.setFeed(address(nvda), nvdaFeed);
        venue.setFeed(address(aapl), aaplFeed);
        b.setAsset(address(nvda), nvdaFeed, true);
        b.setAsset(address(aapl), aaplFeed, true);
        b.setKeeper(keeper, true);
        vm.stopPrank();
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
    }

    function _one(address token, uint256 amount) internal pure returns (address[] memory t, uint256[] memory a) {
        t = new address[](1);
        t[0] = token;
        a = new uint256[](1);
        a[0] = amount;
    }

    function _two(uint256 n, uint256 x) internal view returns (address[] memory t, uint256[] memory a) {
        t = new address[](2);
        t[0] = address(nvda);
        t[1] = address(aapl);
        a = new uint256[](2);
        a[0] = n;
        a[1] = x;
    }
}

/// Auditor proof (medium): plans that never buy re-queue hourly and used to hold the front of the queue.
contract RetryQueueStarvationTest is ReAuditBase {
    function test_plansBehind180AlwaysSkippingPlansStillGetTheirBuy() public {
        vm.prank(admin);
        aaplFeed.setUpdatedAt(1_795_000_000 - 27 hours);

        address mallory = makeAddr("mallory");
        usdc.mint(mallory, 198e6);
        vm.startPrank(mallory);
        usdc.approve(address(b), type(uint256).max);
        (address[] memory t, uint256[] memory a) = _one(address(aapl), 1e6);
        for (uint256 i; i < 180; ++i) {
            b.createPlan("x", t, a, 30 days, 1, false, false, type(uint256).max);
        }
        vm.stopPrank();

        (t, a) = _one(address(nvda), 100e6);
        vm.prank(alice);
        uint256 id = b.createPlan("nvda", t, a, 1 days, 10, false, false, type(uint256).max);

        uint256 t0 = 1_795_000_000;
        for (uint256 i; i < 360; ++i) {
            vm.prank(keeper);
            b.executeDue(3);
            vm.warp(t0 + (i + 1) * 60);
            vm.prank(admin);
            nvdaFeed.setPrice(100e8);
        }
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertGe(p.buysDone, 1, "plan starved behind plans that never buy");
    }

    /// The same, measured: with three plans ahead of it that never buy, a new plan runs on the keeper's second call.
    function test_scanResumesWhereItStopped() public {
        vm.prank(admin);
        aaplFeed.setUpdatedAt(1_795_000_000 - 27 hours);
        (address[] memory t, uint256[] memory a) = _one(address(aapl), 1e6);
        vm.startPrank(alice);
        for (uint256 i; i < 3; ++i) b.createPlan("x", t, a, 30 days, 1, false, false, type(uint256).max);
        (t, a) = _one(address(nvda), 10e6);
        uint256 id = b.createPlan("nvda", t, a, 1 days, 10, false, false, type(uint256).max);
        vm.stopPrank();

        vm.prank(keeper);
        b.executeDue(3); // the three AAPL plans: skipped, due again in an hour
        vm.warp(block.timestamp + 2 hours);
        vm.prank(admin);
        nvdaFeed.setPrice(100e8);
        uint256[] memory next = b.duePlans(3);
        assertEq(next[0], id, "the scan starts after the plans it ran last time");
        vm.prank(keeper);
        b.executeDue(3);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.buysDone, 1);
    }

    /// Changing the interval of a plan that is waiting out a retry no longer makes it due at once.
    function test_intervalChangeKeepsRetryWait() public {
        (address[] memory t, uint256[] memory a) = _one(address(aapl), 10e6);
        vm.prank(alice);
        uint256 id = b.createPlan("x", t, a, 1 hours, 10, false, false, type(uint256).max);
        vm.prank(keeper);
        b.executeDue(3); // first buy fills
        vm.warp(block.timestamp + 1 hours);
        vm.prank(admin);
        aaplFeed.setUpdatedAt(block.timestamp - 27 hours);
        vm.prank(keeper);
        b.executeDue(3); // stale: skipped, retry in an hour
        (DCAC.Plan memory p,) = b.getPlan(id);
        uint64 retryAt = p.nextRun;
        assertGt(retryAt, block.timestamp);

        vm.prank(alice);
        b.updatePlan(id, "x", t, a, 2 hours, 10, false, 0);
        (p,) = b.getPlan(id);
        assertEq(p.nextRun, retryAt, "interval change pulled a retrying plan forward");
    }
}

/// Auditor proof (low): a creator that can never move its cut used to strand it in DCAC.
contract CreatorIsContractTest is ReAuditBase {
    function test_creatorCutPaidToDcacItselfIsStuck() public {
        (address[] memory t, uint256[] memory a) = _one(address(nvda), 100e6);
        vm.prank(alice);
        try b.createSharedPlan(address(b), "copy", t, a, 1 days, 2, false, false, type(uint256).max) returns (uint256 id) {
            vm.prank(keeper);
            b.executeDue(3);
            vm.prank(alice);
            b.cancelPlan(id);
        } catch {
            return;
        }
        assertEq(b.activePlans().length, 0);
        assertEq(usdc.balanceOf(address(b)), b.totalOwed(), "USDC stuck in DCAC");
    }

    function test_usdcAsCreatorIsNoCreator() public {
        (address[] memory t, uint256[] memory a) = _one(address(nvda), 100e6);
        vm.prank(alice);
        uint256 id = b.createSharedPlan(address(usdc), "copy", t, a, 1 days, 2, false, false, type(uint256).max);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.creator, address(0));
        vm.prank(keeper);
        b.executeDue(3);
        assertEq(usdc.balanceOf(treasury), 0.5e6);
        assertEq(b.totalOwed(), 0);
    }
}

/// The smart-buys premium is only charged on runs that were rebalanced.
contract PremiumOnFallbackTest is ReAuditBase {
    function test_noPremiumWhenSmartFellBack() public {
        (address[] memory t, uint256[] memory a) = _two(600e6, 400e6);
        vm.prank(alice);
        uint256 id = b.createPlan("s", t, a, 1 days, 2, false, true, type(uint256).max);
        vm.prank(admin);
        aaplFeed.setUpdatedAt(block.timestamp - 2 days); // stale: the smart split falls back to plain amounts
        vm.prank(keeper);
        b.executeDue(3);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.totalSpent, 600e6);
        assertEq(p.totalFees, 3e6, "0.5% of 600, no premium on a fallback run");
    }

    function test_premiumWhenRebalanced() public {
        (address[] memory t, uint256[] memory a) = _two(600e6, 400e6);
        vm.prank(alice);
        uint256 id = b.createPlan("s", t, a, 1 days, 2, false, true, type(uint256).max);
        vm.prank(keeper);
        b.executeDue(3);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.totalFees, 7.5e6, "0.75% of 1,000");
    }
}

/// A budget top-up under a cent into a savings plan stays idle instead of failing the strict vault check.
contract TinyTopUpTest is ReAuditBase {
    function test_subCentTopUpIntoSavingsPlan() public {
        // $13.40 a buy: 0.5% is under the $0.10 minimum, 0.75% is $0.1005, so smart buys add $0.0005 a buy.
        (address[] memory t, uint256[] memory a) = _two(6.7e6, 6.7e6);
        vm.prank(alice);
        uint256 id = b.createPlan("s", t, a, 1 days, 1, true, false, type(uint256).max);
        vault.accrue(3); // shares now worth a little more than 1 USDC, so tiny deposits round down
        vm.prank(alice);
        b.setSmartBuys(id, true, 1e6);
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.idle, 500);
        assertTrue(p.smart);
    }
}

/// The savings vault budget in gasFor.
contract GasBudgetTest is ReAuditBase {
    function test_gasForWithSavings() public {
        (address[] memory t, uint256[] memory a) = _two(5e6, 5e6);
        vm.prank(alice);
        uint256 id = b.createPlan("s", t, a, 1 days, 1, true, false, type(uint256).max);
        assertEq(b.gasFor(id), 250_000 + 2 * 700_000 + 800_000);
    }
}
