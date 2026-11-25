// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

import {PoolTwapFeed, ICLPoolOracle} from "src/feeds/PoolTwapFeed.sol";
import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";
import {TickMath} from "src/lib/TickMath.sol";

/// A pool whose tick history is set by the test.
contract FakePool is ICLPoolOracle {
    address public token0;
    address public token1;
    int56 public cumNow;
    int56 public cumThen;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function setTicks(int56 then_, int56 now_) external {
        cumThen = then_;
        cumNow = now_;
    }

    function observe(uint32[] calldata) external view returns (int56[] memory c, uint160[] memory s) {
        c = new int56[](2);
        c[0] = cumThen;
        c[1] = cumNow;
        s = new uint160[](2);
    }
}

contract PoolTwapFeedTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // ---- unit tests (no network)

    function test_quoteMatchesKnownTicks() public {
        address stock = address(0xb2); // sorts below USDC: stock is token0
        FakePool pool = new FakePool(stock, USDC);
        PoolTwapFeed feed = new PoolTwapFeed(pool, stock, USDC, 8, 6, 30 minutes);
        // tick 0 means 1 raw USDC unit per raw stock unit: 1e-6 USDC per 1e-8 stock = $100 per stock
        assertEq(feed.quote(0), 100e8);
        // a constant tick T over the window gives the price at T
        int24 t = -23_027; // ~ 1.0001^-23027 = 0.1: $10
        pool.setTicks(0, int56(t) * 1800);
        assertEq(feed.twapTick(), t);
        (, int256 p,, uint256 updated,) = feed.latestRoundData();
        assertApproxEqRel(uint256(p), 10e8, 1e14); // 0.01%
        assertEq(updated, block.timestamp);
    }

    function test_negativeTicksRoundDown() public {
        address stock = address(0xb2);
        FakePool pool = new FakePool(stock, USDC);
        PoolTwapFeed feed = new PoolTwapFeed(pool, stock, USDC, 8, 6, 30 minutes);
        pool.setTicks(0, -1801); // mean -1.0006
        assertEq(feed.twapTick(), -2);
        pool.setTicks(0, 1801);
        assertEq(feed.twapTick(), 1);
    }

    function test_rejectsWrongPairAndShortWindow() public {
        FakePool pool = new FakePool(address(1), address(2));
        vm.expectRevert(PoolTwapFeed.BadPool.selector);
        new PoolTwapFeed(pool, address(1), USDC, 8, 6, 30 minutes);
        FakePool ok = new FakePool(address(0xb2), USDC);
        vm.expectRevert(PoolTwapFeed.BadWindow.selector);
        new PoolTwapFeed(ok, address(0xb2), USDC, 8, 6, 60);
    }

    // ---- against live Base mainnet (set BASE_RPC_URL to run)

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    function _compare(string memory name, address pool, address token, uint8 dec, address chainlink, uint256 maxDiffBps) internal {
        PoolTwapFeed feed = new PoolTwapFeed(ICLPoolOracle(pool), token, USDC, dec, 6, 30 minutes);
        (, int256 twap,,,) = feed.latestRoundData();
        (, int256 cl,,,) = IAggregatorV3(chainlink).latestRoundData();
        uint256 diff = uint256(twap > cl ? twap - cl : cl - twap) * 10_000 / uint256(cl);
        console.log(name);
        console.log("  twap (8dp)", uint256(twap));
        console.log("  chainlink ", uint256(cl));
        console.log("  diff bps  ", diff);
        assertLe(diff, maxDiffBps, name);
    }

    function test_fork_twapTracksChainlink() public {
        if (!_fork()) return;
        _compare("NVDAc", 0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC, 0xb20000000000000000000078ee7ce2fE4908108C, 8, 0x04689a41629776563E6822F76f2e57D148d28513, 300);
        _compare("AAPLc", 0xF5FCB9CDAFcE67d50AfEf298F88E709d2B946BA6, 0xb200000000000000000000C2e324d24d7eEcd1fb, 8, 0x787f13dEa48Db0897CbCDD985de77809D837F988, 300);
        _compare("WETH", 0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59, 0x4200000000000000000000000000000000000006, 18, 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, 100);
    }
}
