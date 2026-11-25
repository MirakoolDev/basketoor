// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import {Basketoor} from "src/Basketoor.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter, MockSavingsVault} from "src/mocks/Mocks.sol";

/// USDC stand-in with Circle-style blocklisting: transfers to or from a blocked address revert.
contract BlockableUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}

/// An ERC-4626 vault that can refuse withdrawals, as a paused or fully lent-out one does.
contract FreezableVault is ERC4626 {
    bool public frozen;

    constructor(IERC20 a) ERC20("v", "v") ERC4626(a) {}

    function setFrozen(bool f) external {
        frozen = f;
    }

    function _withdraw(address c, address r, address o, uint256 a, uint256 s) internal override {
        require(!frozen, "no liquidity");
        super._withdraw(c, r, o, a, s);
    }
}

/// Tests for the fixes to the imd.fun audit of commit b14b3cc (findings 1b and 5-14; 1-4 have their own files).
contract AuditFixesTest is Test {
    Basketoor b;
    BlockableUSDC usdc;
    MockSwapAdapter venue;
    MockSavingsVault vault;
    MockStock stock;
    MockFeed feed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant MAX = type(uint256).max;

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.startPrank(admin);
        usdc = new BlockableUSDC();
        venue = new MockSwapAdapter(admin);
        b = new Basketoor(usdc, ISwapAdapter(address(venue)), treasury, admin);
        vault = new MockSavingsVault(usdc);
        stock = new MockStock("Apple", "AAPLc", 8, admin);
        feed = new MockFeed(8, 200e8, admin);
        stock.setMinter(address(venue));
        venue.setFeed(address(stock), feed);
        b.setAsset(address(stock), feed, true);
        b.setKeeper(keeper, true);
        b.setSavingsVault(IERC4626(address(vault)));
        vm.stopPrank();
        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            usdc.mint(u, 100_000e6);
            vm.prank(u);
            usdc.approve(address(b), MAX);
        }
    }

    function _one(uint256 amount) internal view returns (address[] memory t, uint256[] memory a) {
        t = new address[](1);
        t[0] = address(stock);
        a = new uint256[](1);
        a[0] = amount;
    }

    function _create(address who, uint256 amount, uint64 interval, uint32 buys, bool savings) internal returns (uint256) {
        (address[] memory t, uint256[] memory a) = _one(amount);
        vm.prank(who);
        return b.createPlan("p", t, a, interval, buys, savings, false, MAX);
    }

    function _run() internal {
        vm.prank(admin);
        feed.setPrice(200e8);
        vm.prank(keeper);
        b.executeDue(10);
    }

    function _plan(uint256 id) internal view returns (Basketoor.Plan memory p) {
        (p,) = b.getPlan(id);
    }

    // 1b: value exactly equal to the budget at a share price of 1.5 used to revert the whole batch on the fee.
    function test_f1b_exactBudgetAtOddSharePriceDoesNotRevertBatch() public {
        usdc.mint(address(this), 1_999_999);
        usdc.approve(address(vault), MAX);
        vault.deposit(1_999_999, address(this));
        vault.accrueAmount(1_000_000);
        uint256 bobId = _create(bob, 10e6, 1 days, 3, false);
        uint256 aliceId = _create(alice, 10e6, 1 days, 1, true);
        assertLe(b.planValue(aliceId), b.quoteDeposit(10e6, 1), "funded to the wei or less");
        _run();
        assertEq(_plan(bobId).buysDone, 1);
        assertEq(_plan(aliceId).buysDone, 1);
        assertFalse(_plan(aliceId).active);
        assertEq(usdc.balanceOf(address(b)), b.totalOwed() + _plan(bobId).idle, "loose USDC");
    }

    // 2: a vault that can't pay out: the run is deferred and the owner can still cancel (gets the shares).
    function test_f2_frozenVaultDefersRunAndCancelHandsOverShares() public {
        FreezableVault fv = new FreezableVault(usdc);
        vm.prank(admin);
        b.setSavingsVault(IERC4626(address(fv)));
        uint256 id = _create(alice, 10e6, 1 days, 2, true);
        fv.setFrozen(true);
        _run();
        Basketoor.Plan memory p = _plan(id);
        assertEq(p.buysDone, 0);
        assertEq(p.skippedRuns, 1);
        assertEq(p.nextRun, block.timestamp + 1 hours, "retried in an hour");

        uint256 shares = p.shares;
        vm.prank(alice);
        b.cancelPlan(id);
        assertEq(fv.balanceOf(alice), shares, "owner holds the vault shares");
        assertFalse(_plan(id).active);
    }

    // 5: an under-gassed call reverts with InsufficientGas instead of running part of the due plans.
    function test_f5_gasRuleCoversEveryPlan() public {
        uint256 a = _create(alice, 10e6, 1 days, 3, false);
        _create(bob, 10e6, 1 days, 3, false);
        uint256 per = b.gasFor(a);
        assertEq(per, b.GAS_BASE() + b.GAS_PER_LEG());
        vm.prank(keeper);
        vm.expectRevert();
        b.executeDue{gas: per + 200_000}(10); // enough for one plan, not two
        vm.prank(keeper);
        assertEq(b.executeDue{gas: 2 * per + 300_000}(10), 2);
    }

    // 6: the yield fee is fixed when the plan is created.
    function test_f6_yieldFeeIsSnapshotted() public {
        uint256 id = _create(alice, 500e6, 1 days, 5, true);
        vault.accrueAmount(100e6);
        vm.prank(admin);
        b.setFees(50, 100_000, 3_000);
        uint256 before = usdc.balanceOf(treasury);
        vm.prank(alice);
        b.cancelPlan(id);
        assertApproxEqAbs(usdc.balanceOf(treasury) - before, 10e6, 2, "10% of yield, not 30%");
    }

    // 7: a blocklisted owner's refund is kept for them to claim; other plans keep running.
    function test_f7_blockedOwnerDoesNotBlockBatch() public {
        uint256 aliceId = _create(alice, 10e6, 1 days, 1, true);
        vault.accrueAmount(1e6); // yield: alice's plan has a refund at close
        uint256 bobId = _create(bob, 10e6, 1 days, 5, false);
        usdc.setBlocked(alice, true);
        _run();
        assertFalse(_plan(aliceId).active);
        assertEq(_plan(bobId).buysDone, 1);
        uint256 owedToAlice = b.owed(alice);
        assertGt(owedToAlice, 0);
        assertEq(usdc.balanceOf(address(b)), b.totalOwed() + _plan(bobId).idle);

        address fresh = makeAddr("alice2");
        vm.prank(alice);
        b.claim(fresh);
        assertEq(usdc.balanceOf(fresh), owedToAlice);
        assertEq(b.totalOwed(), 0);
    }

    // 8: a blocked treasury doesn't block exits or buys; the constructor rejects a zero treasury.
    function test_f8_blockedTreasuryAndZeroTreasury() public {
        uint256 id = _create(alice, 100e6, 1 days, 10, true);
        vault.accrueAmount(100e6);
        usdc.setBlocked(treasury, true);
        _run(); // first buy pays a fee to the treasury
        assertEq(_plan(id).buysDone, 1);
        vm.prank(alice);
        b.cancelPlan(id);
        assertFalse(_plan(id).active);
        assertGt(b.owed(treasury), 0);

        vm.expectRevert(Basketoor.BadConfig.selector);
        new Basketoor(usdc, ISwapAdapter(address(venue)), address(0), admin);
    }

    // 9: a new frequency applies from the last buy.
    function test_f9_newIntervalReanchorsSchedule() public {
        uint256 id = _create(alice, 10e6, 30 days, 10, false);
        _run();
        uint256 t = block.timestamp;
        vm.warp(t + 1 hours);
        (address[] memory tk, uint256[] memory a) = _one(10e6);
        vm.prank(alice);
        b.updatePlan(id, "p", tk, a, 1 hours, 10, MAX);
        assertEq(_plan(id).nextRun, t + 1 hours);
        vm.warp(t + 2 hours);
        _run();
        assertEq(_plan(id).buysDone, 2);
    }

    // 10: a deposit the vault prices at nothing (donation-inflated share price) is refused.
    function test_f10_inflatedVaultRejected() public {
        FreezableVault fresh = new FreezableVault(usdc);
        vm.prank(admin);
        b.setSavingsVault(IERC4626(address(fresh)));
        address mallory = makeAddr("mallory");
        usdc.mint(mallory, 100e6);
        vm.startPrank(mallory);
        usdc.approve(address(fresh), MAX);
        fresh.deposit(1, mallory);
        usdc.transfer(address(fresh), 50e6);
        vm.stopPrank();
        (address[] memory tk, uint256[] memory a) = _one(10e6);
        vm.prank(alice);
        vm.expectRevert(Basketoor.BadVaultDeposit.selector);
        b.createPlan("p", tk, a, 1 days, 2, true, false, MAX);
    }

    // 12: createPlan and updatePlan refuse to pull more than the caller allowed.
    function test_f12_maxDeposit() public {
        uint256 quote = b.quoteDeposit(10e6, 5);
        vm.prank(admin);
        b.setFees(200, 5e6, 1000);
        (address[] memory tk, uint256[] memory a) = _one(10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Basketoor.DepositTooHigh.selector, b.quoteDeposit(10e6, 5)));
        b.createPlan("p", tk, a, 1 days, 5, false, false, quote);

        uint256 id = _create(alice, 10e6, 1 days, 5, false);
        vm.prank(alice);
        vm.expectRevert();
        b.updatePlan(id, "p", tk, a, 1 days, 6, 1);
    }

    // 13: topping up a plan is blocked while new plans are paused; shrinking still works.
    function test_f13_pauseBlocksTopUpNotRefund() public {
        uint256 id = _create(alice, 10e6, 1 days, 5, false);
        vm.prank(admin);
        b.setCreatePaused(true);
        (address[] memory tk, uint256[] memory a) = _one(10e6);
        vm.prank(alice);
        vm.expectRevert(Basketoor.CreatePaused.selector);
        b.updatePlan(id, "p", tk, a, 1 days, 6, MAX);
        vm.prank(alice);
        b.updatePlan(id, "p", tk, a, 1 days, 2, MAX);
        assertEq(_plan(id).maxBuys, 2);
    }

    // 14: the adapter must be a contract.
    function test_f14_adapterMustHaveCode() public {
        vm.startPrank(admin);
        vm.expectRevert(Basketoor.BadConfig.selector);
        b.setSwapAdapter(ISwapAdapter(address(0)));
        vm.expectRevert(Basketoor.BadConfig.selector);
        b.setSwapAdapter(ISwapAdapter(address(0xdead)));
        vm.stopPrank();
    }
}
