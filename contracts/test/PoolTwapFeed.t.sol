// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

import {DCAC} from "src/DCAC.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";
import {PoolTwapFeed, ICLPoolOracle} from "src/feeds/PoolTwapFeed.sol";
import {TickMath} from "src/lib/TickMath.sol";
import {MockUSDC, MockStock, MockFeed, MockSwapAdapter} from "src/mocks/Mocks.sol";

/// Slipstream / Uniswap-v3 style oracle (from the imd.fun re-audit's proof): tickCumulative grows by
/// tick * seconds, an observation is written when the tick changes, and observe() interpolates between
/// observations like the real Oracle library. Plus the slot0 / liquidity reads the feed checks.
contract OraclePool {
    address public immutable token0;
    address public immutable token1;
    int24 public tick;
    uint128 public liquidity = 2e12;
    uint16 public cardinalityNext = 1200;
    bool public brokenHistory;
    uint32[] internal times;
    int56[] internal cums;

    constructor(address t0, address t1, int24 tick_) {
        token0 = t0;
        token1 = t1;
        tick = tick_;
        times.push(uint32(block.timestamp));
        cums.push(0);
    }

    /// A swap that leaves the pool at `newTick`.
    function setTick(int24 newTick) external {
        uint32 last = times[times.length - 1];
        if (block.timestamp > last) {
            cums.push(cums[cums.length - 1] + int56(tick) * int56(uint56(block.timestamp - last)));
            times.push(uint32(block.timestamp));
        }
        tick = newTick;
    }

    function setLiquidity(uint128 l) external {
        liquidity = l;
    }

    function setCardinalityNext(uint16 n) external {
        cardinalityNext = n;
    }

    function breakHistory(bool b) external {
        brokenHistory = b;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool) {
        return (TickMath.getSqrtPriceAtTick(tick), tick, 0, cardinalityNext, cardinalityNext, true);
    }

    function _cumAt(uint32 when) internal view returns (int56) {
        uint256 n = times.length;
        uint32 last = times[n - 1];
        if (when >= last) return cums[n - 1] + int56(tick) * int56(uint56(when - last));
        for (uint256 i = n - 1; i > 0; --i) {
            if (times[i - 1] <= when) {
                int56 slope = (cums[i] - cums[i - 1]) / int56(uint56(times[i] - times[i - 1]));
                return cums[i - 1] + slope * int56(uint56(when - times[i - 1]));
            }
        }
        revert("OLD");
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory c, uint160[] memory s) {
        require(!brokenHistory, "OLD");
        c = new int56[](ago.length);
        s = new uint160[](ago.length);
        for (uint256 i; i < ago.length; ++i) {
            c[i] = _cumAt(uint32(block.timestamp) - ago[i]);
        }
    }
}

contract PoolTwapFeedTest is Test {
    int24 constant MARKET_TICK = -8587; // USDC is token0, an 8-decimal stock at about $236 (ADBEc pool on Base)
    int24 constant FAR_TICK = -887272; // TickMath.MIN_TICK: where a swap ends once it runs out of liquidity
    uint256 constant MIN_DEPTH = 5_000e6; // $5,000 to move the price 1%

    DCAC b;
    MockUSDC usdc;
    MockStock stock;
    MockSwapAdapter venue;
    MockFeed spot; // the price the venue fills at: the pool's spot price
    OraclePool pool;
    PoolTwapFeed feed;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.startPrank(admin);
        usdc = new MockUSDC();
        stock = new MockStock("Adobe", "ADBE", 8, admin);
        pool = new OraclePool(address(usdc), address(stock), MARKET_TICK);
        feed = _feed(pool);
        venue = new MockSwapAdapter(admin);
        spot = new MockFeed(8, 1, admin);
        venue.setFeed(address(stock), spot);
        stock.setMinter(address(venue));
        b = new DCAC(usdc, ISwapAdapter(address(venue)), treasury, admin);
        b.setAsset(address(stock), feed, true);
        b.setKeeper(keeper, true);
        vm.stopPrank();
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(b), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(b), type(uint256).max);
        vm.warp(block.timestamp + 1800); // a quiet half hour at the market price
        (, int256 fair,,,) = feed.latestRoundData();
        vm.prank(admin);
        spot.setPrice(fair);
    }

    function _feed(OraclePool p) internal returns (PoolTwapFeed) {
        return new PoolTwapFeed(ICLPoolOracle(address(p)), address(stock), address(usdc), 8, 6, 1800, 6, 150, MIN_DEPTH);
    }

    function _price() internal view returns (uint256) {
        (, int256 answer,,,) = feed.latestRoundData();
        return uint256(answer);
    }

    function _spike() internal {
        pool.setTick(FAR_TICK); // last transaction of block N
        vm.warp(block.timestamp + 2); // one Base block
        pool.setTick(MARKET_TICK); // first transaction of block N+1: the pool is back at the market price
    }

    function _open(address who) internal returns (uint256) {
        address[] memory t = new address[](1);
        t[0] = address(stock);
        uint256[] memory a = new uint256[](1);
        a[0] = 1_000e6;
        vm.prank(who);
        return b.createPlan("adbe", t, a, 1 days, 1, false, false, type(uint256).max);
    }

    // ---------------------------------------------------------------- price

    function test_steadyPoolGivesItsPrice() public view {
        assertApproxEqRel(_price(), 236e8, 0.01e18);
        assertEq(uint8(feed.status()), uint8(PoolTwapFeed.Status.Ok));
        assertEq(_price(), feed.quote(MARKET_TICK));
    }

    function test_quoteMatchesKnownTicks() public {
        address s = address(0xb2); // sorts below USDC: the stock is token0
        OraclePool p = new OraclePool(s, address(usdc) > s ? address(usdc) : address(0xffff), 0);
        PoolTwapFeed f = new PoolTwapFeed(ICLPoolOracle(address(p)), s, p.token1(), 8, 6, 1800, 6, 150, 1);
        // tick 0 = 1 raw USDC unit per raw stock unit: 1e-6 USDC per 1e-8 stock = $100 per stock
        assertEq(f.quote(0), 100e8);
        assertApproxEqRel(f.quote(-23_027), 10e8, 1e14); // 1.0001^-23027 ~ 0.1: $10
    }

    function test_followsARealMove() public {
        // The market moves 1% and stays there: once the whole window has seen it, the feed reports it.
        pool.setTick(MARKET_TICK + 100);
        vm.warp(block.timestamp + 1800);
        assertEq(uint8(feed.status()), uint8(PoolTwapFeed.Status.Ok));
        assertApproxEqRel(_price(), feed.quote(MARKET_TICK + 100), 1e14);
    }

    // ---------------------------------------------------------------- the audit's attacks

    /// Re-audit finding 1: one 2-second block at the far end of the tick range moved the old feed's 30-minute price
    /// by about 10%. Now that slice sits thousands of ticks from the median and the feed refuses.
    function test_oneBlockSpikeIsRefused() public {
        uint256 fair = _price();
        _spike();
        assertEq(_price(), 0, "refuses instead of moving");
        assertEq(uint8(feed.status()), uint8(PoolTwapFeed.Status.Unsteady));
        (uint256 median,,,) = feed.read();
        assertEq(median, fair, "the median itself didn't move");
        vm.warp(block.timestamp + 1800); // once the spike leaves the window, prices are back
        assertEq(_price(), fair);
    }

    /// The re-audit's DCAC repro: before the fix, the spike let an 8%-overpriced fill through.
    function test_spikeDoesNotLoosenDcacBound() public {
        uint256 fair = _price();
        vm.prank(admin);
        spot.setPrice(int256(fair * 108 / 100)); // what the pool sells at while the attacker holds it up

        _open(bob);
        vm.prank(keeper);
        b.executeDue(3);
        assertEq(stock.balanceOf(bob), 0, "control: an 8% overpriced fill is refused");

        _spike();
        uint256 id = _open(alice);
        vm.prank(keeper);
        b.executeDue(3);
        assertEq(stock.balanceOf(alice), 0, "no fill while the feed refuses");
        (DCAC.Plan memory p,) = b.getPlan(id);
        assertEq(p.skippedRuns, 1, "the leg was skipped and will be retried");
    }

    /// Holding the pool 20% off for one slice (the re-audit's "HOOD parked +20%") is refused too.
    function test_heldDisplacementForOneSliceIsRefused() public {
        pool.setTick(MARKET_TICK + 1823); // +20%
        vm.warp(block.timestamp + 300);
        pool.setTick(MARKET_TICK);
        assertEq(_price(), 0);
    }

    /// To move the price at all, an attacker has to hold the pool off for at least half the window, and stay close
    /// enough to the median that no slice is flagged: the most they shift it is about `maxDeviationTicks`.
    function test_slowDragMovesAtMostTheTolerance() public {
        pool.setTick(MARKET_TICK + 140);
        vm.warp(block.timestamp + 900); // half the window at +1.4%
        uint256 p = _price();
        assertGt(p, 0);
        uint256 fair = feed.quote(MARKET_TICK);
        assertApproxEqRel(p, fair, 0.0151e18); // within about 1.5% of the market, whichever way the tick runs
    }

    function test_spotFarFromMedianIsRefused() public {
        pool.setTick(MARKET_TICK + 400); // the pool is 4% off right now
        assertEq(_price(), 0);
        assertEq(uint8(feed.status()), uint8(PoolTwapFeed.Status.SpotAway));
    }

    // ---------------------------------------------------------------- depth and history

    function test_thinPoolIsRefused() public {
        pool.setLiquidity(1e8); // what the live ADBE pool had on 2026-11-28: dust, cents of depth
        assertEq(_price(), 0);
        (,, , uint256 depth) = feed.read();
        assertLt(depth, 1e6);
        assertEq(uint8(feed.status()), uint8(PoolTwapFeed.Status.TooThin));
        pool.setLiquidity(2e12);
        (,,, depth) = feed.read();
        console.log("depth for 1% at L=2e12 (USDC)", depth / 1e6);
        assertGe(depth, MIN_DEPTH);
    }

    /// Re-audit finding 6: a pool that keeps too few observations can't be used.
    function test_rejectsPoolWithShortHistory() public {
        OraclePool p = new OraclePool(address(usdc), address(stock), MARKET_TICK);
        p.setCardinalityNext(900);
        vm.expectRevert(abi.encodeWithSelector(PoolTwapFeed.NotEnoughHistory.selector, uint16(900), uint16(1200)));
        _feed(p);
    }

    function test_unreadableHistoryAnswersZero() public {
        pool.breakHistory(true);
        assertEq(_price(), 0);
        assertEq(uint8(feed.status()), uint8(PoolTwapFeed.Status.NoHistory));
        (,, bool usable) = b.priceOf(address(stock));
        assertFalse(usable);
    }

    function test_rejectsBadSetup() public {
        OraclePool wrong = new OraclePool(address(1), address(2), 0);
        vm.expectRevert(PoolTwapFeed.BadPool.selector);
        _feed(wrong);
        vm.expectRevert(PoolTwapFeed.BadWindow.selector);
        new PoolTwapFeed(ICLPoolOracle(address(pool)), address(stock), address(usdc), 8, 6, 60, 6, 150, MIN_DEPTH);
        vm.expectRevert(PoolTwapFeed.BadParams.selector);
        new PoolTwapFeed(ICLPoolOracle(address(pool)), address(stock), address(usdc), 8, 6, 1800, 7, 150, MIN_DEPTH);
        vm.expectRevert(PoolTwapFeed.BadParams.selector);
        new PoolTwapFeed(ICLPoolOracle(address(pool)), address(stock), address(usdc), 8, 6, 1800, 6, 0, MIN_DEPTH);
    }

    // ---------------------------------------------------------------- against live Base (set BASE_RPC_URL)

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    /// Chainlink-priced stocks whose pools are deep: the checked TWAP should agree with Chainlink.
    function test_fork_tracksChainlink() public {
        if (!_fork()) return;
        _compare("NVDAc", 0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC, 0xb20000000000000000000078ee7ce2fE4908108C, 8, 0x04689a41629776563E6822F76f2e57D148d28513);
        _compare("WETH", 0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59, 0x4200000000000000000000000000000000000006, 18, 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70);
    }

    function _compare(string memory name, address p, address token, uint8 dec, address chainlink) internal {
        address usdc_ = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        (,,,, uint16 next,) = ICLPoolOracle(p).slot0();
        if (next < 1200) vm.mockCall(p, abi.encodeWithSelector(ICLPoolOracle.slot0.selector), _slot0With(p, 1200));
        PoolTwapFeed f = new PoolTwapFeed(ICLPoolOracle(p), token, usdc_, dec, 6, 1800, 6, 150, 1);
        vm.clearMockedCalls();
        (uint256 price, PoolTwapFeed.Status s,, uint256 depth) = f.read();
        (, int256 cl,,,) = IAggregatorV3(chainlink).latestRoundData();
        uint256 diff = (price > uint256(cl) ? price - uint256(cl) : uint256(cl) - price) * 10_000 / uint256(cl);
        console.log(name, price, uint256(cl));
        console.log("  status, diff bps, depth $", uint8(s), diff, depth / 1e6);
        assertLe(diff, 300, name);
    }

    function _slot0With(address p, uint16 next) internal view returns (bytes memory) {
        (uint160 a, int24 t, uint16 i, uint16 c,, bool u) = ICLPoolOracle(p).slot0();
        return abi.encode(a, t, i, c, next, u);
    }
}
