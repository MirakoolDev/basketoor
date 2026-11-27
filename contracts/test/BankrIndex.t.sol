// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DCAC} from "src/DCAC.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";
import {BankrIndexRouter} from "src/adapters/BankrIndexRouter.sol";
import {BankrIndexNavFeed} from "src/feeds/BankrIndexNavFeed.sol";
import {IIndexFactory, IIndexHook, IIndexLens, IPoolManager} from "src/interfaces/IBankrIndex.sol";

/// Against live Base mainnet: the deployed DCAC, its Aerodrome venue and a live Bankr index. Set BASE_RPC_URL.
/// The index here holds crypto tokens only: a Foundry fork can't execute Coinbase stock tokens (B20
/// precompiles), so stock indexes are checked with script/simulate-bankr-index.sh against a real Base node.
contract BankrIndexForkTest is Test {
    DCAC constant DC = DCAC(0xC9A54a67cDC9f78B7D8207fAF46Ff92663a03313);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant VENUE = 0x27826d88468904cF97C2DcE28E344A16E3693645;
    address constant KEEPER = 0x3DAb104D8A1338Bb728310453DeBb6f2dc9D2Ef9;
    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IIndexFactory constant FACTORY = IIndexFactory(0x49a3A6D33110425099A9f070d22f576f592b46eB);
    IIndexHook constant HOOK = IIndexHook(0x2Fd0ba044Faa96A9d1B0f010C0Dac3F696aA2888);
    IIndexLens constant LENS = IIndexLens(0x0E19BDeB4EF2443413926b9Daa72E484f63BB72b);
    address constant BASE7 = 0x07CDF072CF8b91eA6d064B6f4A596F39F52F12b1; // 0.50% fee
    address constant HEAT = 0xa70E48a53F672324CcD064126d9332E6B18072f4; // 1.00% fee, the highest Bankr allows

    BankrIndexRouter router;
    BankrIndexNavFeed feed;
    address alice = makeAddr("alice");

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        router = new BankrIndexRouter(ISwapAdapter(VENUE), PM, FACTORY, HOOK, USDC);
        feed = new BankrIndexNavFeed(LENS, HOOK, BASE7);
        return true;
    }

    function test_fork_feedReadsNav() public {
        if (!_fork()) return;
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        console.log("BASE7 NAV per share (8dp)", uint256(answer));
        assertGt(answer, 0);
        assertEq(updatedAt, block.timestamp);
        assertTrue(router.isIndex(BASE7));
        assertFalse(router.isIndex(WETH));
    }

    function test_fork_routerBuysIndexNearNav() public {
        if (!_fork()) return;
        deal(USDC, address(this), 100e6);
        IERC20(USDC).approve(address(router), 100e6);
        uint256 out = router.swap(USDC, BASE7, 100e6, 0, alice);
        (, int256 nav,,,) = feed.latestRoundData();
        uint256 atNav = 100e6 * 1e18 * 1e8 / (uint256(nav) * 1e6);
        console.log("shares for $100", out);
        console.log("fill vs buy price (bps)", out * 10_000 / atNav);
        assertEq(IERC20(BASE7).balanceOf(alice), out);
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "no USDC left behind");
        assertGt(out * 10_000 / atNav, 9_850, "fills within DCAC's 1.5% bound");
    }

    /// The feed prices in the index fee, so even a 1% fee index fills inside DCAC's 1.5% bound.
    function test_fork_feedIncludesFeeSoHighFeeIndexFits() public {
        if (!_fork()) return;
        BankrIndexNavFeed heat = new BankrIndexNavFeed(LENS, HOOK, HEAT);
        (,, uint256 navE18,) = LENS.navUsdE18(HEAT);
        (, int256 price,,,) = heat.latestRoundData();
        assertEq(uint256(price), navE18 * 10_100 / 10_000 / 1e10, "NAV plus the 1% fee");
        deal(USDC, address(this), 100e6);
        IERC20(USDC).approve(address(router), 100e6);
        uint256 out = router.swap(USDC, HEAT, 100e6, 0, alice);
        uint256 expected = 100e6 * 1e18 * 1e8 / (uint256(price) * 1e6);
        console.log("HEAT fill vs buy price (bps)", out * 10_000 / expected);
        assertGt(out * 10_000 / expected, 9_850, "fills within DCAC's 1.5% bound");
    }

    function test_fork_routerRefusesBelowMinOut() public {
        if (!_fork()) return;
        deal(USDC, address(this), 100e6);
        IERC20(USDC).approve(address(router), 100e6);
        vm.expectRevert();
        router.swap(USDC, BASE7, 100e6, type(uint128).max, alice);
    }

    function test_fork_unlockCallbackOnlyFromOwnSwap() public {
        if (!_fork()) return;
        vm.expectRevert(BankrIndexRouter.NotPoolManager.selector);
        router.unlockCallback("");
        vm.prank(address(PM));
        vm.expectRevert(BankrIndexRouter.UnexpectedCallback.selector);
        router.unlockCallback("");
    }

    /// The live DCAC with the router as its venue and BASE7 listed: one plan buying the index and ETH. The ETH
    /// leg goes through the existing Aerodrome venue, so this also checks nothing else changes.
    function test_fork_dcacPlanBuysIndexAndEth() public {
        if (!_fork()) return;
        address owner = DC.owner();
        vm.startPrank(owner);
        DC.setSwapAdapter(router);
        DC.setAsset(BASE7, IAggregatorV3(address(feed)), true);
        vm.stopPrank();

        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (BASE7, WETH);
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (10e6, 10e6);
        deal(USDC, alice, 1_000e6);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(DC), type(uint256).max);
        uint256 id = DC.createPlan("index + eth", tokens, amounts, 1 days, 3, false, false, type(uint256).max);
        vm.stopPrank();

        vm.prank(KEEPER);
        DC.executeDue(10);
        (, DCAC.Leg[] memory legs) = DC.getPlan(id);
        console.log("BASE7 bought", legs[0].received);
        console.log("WETH bought ", legs[1].received);
        assertEq(legs[0].spent, 10e6, "index leg filled");
        assertEq(legs[1].spent, 10e6, "ETH leg filled");
        assertEq(IERC20(BASE7).balanceOf(alice), legs[0].received);
    }
}
