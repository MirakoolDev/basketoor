// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import {Basketoor} from "src/Basketoor.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter} from "src/mocks/Mocks.sol";

/// An ERC-4626 vault that can refuse withdrawals (paused, or all liquidity lent out), as real ones do.
contract IlliquidVault is ERC4626 {
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

/// One savings plan whose vault cannot pay out must not stop plans that never opted into savings.
contract ProofVaultBlocksBatch is Test {
    Basketoor b;
    MockUSDC usdc;
    IlliquidVault vault;
    MockStock stock;
    MockFeed feed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.startPrank(admin);
        usdc = new MockUSDC();
        MockSwapAdapter venue = new MockSwapAdapter(admin);
        b = new Basketoor(usdc, ISwapAdapter(address(venue)), treasury, admin);
        vault = new IlliquidVault(usdc);
        stock = new MockStock("Apple", "AAPLc", 8, admin);
        feed = new MockFeed(8, 180e8, admin);
        stock.setMinter(address(venue));
        venue.setFeed(address(stock), feed);
        b.setAsset(address(stock), feed, true);
        b.setKeeper(keeper, true);
        b.setSavingsVault(IERC4626(address(vault)));
        vm.stopPrank();
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(b), type(uint256).max);
    }

    function _create(address who, bool savings) internal returns (uint256) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10e6;
        vm.prank(who);
        return b.createPlan("p", tokens, amounts, 1 days, 2, savings, false, type(uint256).max);
    }

    function test_nonSavingsPlanStillRunsWhenVaultCannotPay() public {
        _create(bob, true); // savings plan, first in the active list
        uint256 aliceId = _create(alice, false); // plain escrow, no vault involved
        vault.setFrozen(true);

        vm.prank(keeper);
        b.executeDue(10); // reverts today: bob's vault.withdraw bubbles up

        (Basketoor.Plan memory p,) = b.getPlan(aliceId);
        assertEq(p.buysDone, 1, "alice's non-savings plan was blocked by the vault");
    }
}
