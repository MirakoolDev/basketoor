// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Basketoor} from "src/Basketoor.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter, MockSavingsVault} from "src/mocks/Mocks.sol";

/// Savings plans: ERC-4626 share rounding leaves planValue 1 wei under the budget, so the budget check in
/// _execute closes the plan ("ran out of budget") instead of doing the buy the user paid for.
contract ProofSavingsRounding is Test {
    Basketoor b;
    MockUSDC usdc;
    MockSwapAdapter venue;
    MockSavingsVault vault;
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
        venue = new MockSwapAdapter(admin);
        b = new Basketoor(usdc, ISwapAdapter(address(venue)), treasury, admin);
        vault = new MockSavingsVault(usdc);
        stock = new MockStock("Apple", "AAPLc", 8, admin);
        feed = new MockFeed(8, 180e8, admin);
        stock.setMinter(address(venue));
        venue.setFeed(address(stock), feed);
        b.setAsset(address(stock), feed, true);
        b.setKeeper(keeper, true);
        b.setSavingsVault(IERC4626(address(vault)));
        vm.stopPrank();

        // The vault already has another depositor and has earned yield: share price 1.111111, not 1.
        usdc.mint(address(this), 1000e6);
        usdc.approve(address(vault), 1000e6);
        vault.deposit(1000e6, address(this));
        vault.accrueAmount(111_111_111);

        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
    }

    function _create(uint32 buys) internal returns (uint256) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10e6;
        vm.prank(alice);
        return b.createPlan("p", tokens, amounts, 1 days, buys, true, type(uint256).max);
    }

    function test_singleBuySavingsPlanActuallyBuys() public {
        uint256 id = _create(1); // pulls 10.10 USDC: one $10 buy + $0.10 fee
        vm.prank(keeper);
        b.executeDue(10);
        (Basketoor.Plan memory p,) = b.getPlan(id);
        assertEq(p.buysDone, 1, "the one funded buy never ran");
        assertGt(stock.balanceOf(alice), 0, "no stock delivered");
    }

    function test_threeBuySavingsPlanDoesAllThreeBuys() public {
        uint256 id = _create(3); // pulls 30.30 USDC
        for (uint256 k; k < 3; ++k) {
            vm.warp(t0 + k * 1 days);
            vm.prank(admin);
            feed.setPrice(180e8);
            vm.prank(keeper);
            b.executeDue(10);
        }
        (Basketoor.Plan memory p,) = b.getPlan(id);
        assertEq(p.buysDone, 3, "last funded buy was dropped");
    }
}
