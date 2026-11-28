// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {TickMath} from "../lib/TickMath.sol";

/// @dev The oracle slice of an Aerodrome Slipstream (Uniswap v3 style) pool.
interface ICLPoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice A Chainlink-style USD price for a token with no Chainlink feed, read from its Aerodrome Slipstream pool
/// against USDC (1 USDC counted as $1). The price is the token's onchain market price, not the underlying stock's.
///
/// DCAC uses it like a Chainlink feed: a buy must fill within `maxSlippageBps` of this price. A plain 30-minute
/// mean can be dragged by a few seconds at an extreme tick in a thin pool (imd.fun re-audit, finding 1), so this
/// feed only answers when the pool's recent history is consistent and the pool is deep:
///
/// - The window is cut into `slices` equal parts. The price is the median of their mean ticks, and every slice must
///   sit within `maxDeviationTicks` of that median. A spike, even one block long, puts its slice far off and the
///   feed refuses for as long as that slice is in the window.
/// - The pool's current tick must also be within `maxDeviationTicks` of the median.
/// - The USDC it takes to move the pool's price by 1%, from its in-range liquidity now, must be at least
///   `minDepthUsdc`.
/// - The pool must keep enough observations to cover the window (finding 6); the constructor checks it.
///
/// When any check fails the answer is 0, which DCAC treats as "no usable price": that leg is skipped and retried,
/// its USDC stays in the plan. `status()` says which check failed. Moving the median takes holding the pool off
/// the market for at least half the window against arbitrage, and even then by at most about `maxDeviationTicks`.
contract PoolTwapFeed is IAggregatorV3 {
    uint8 public constant override decimals = 8;
    /// @dev Base makes a block every 2 seconds and a pool writes at most one observation per block. A window of W
    /// seconds needs W / 2 observations; this asks for a third more.
    uint32 internal constant BLOCK_TIME = 2;

    enum Status {
        Ok,
        NoHistory, // the pool couldn't report the whole window
        Unsteady, // a slice of the window is too far from the median: a spike or a fast market
        SpotAway, // the pool price now is too far from the median
        TooThin // too little liquidity around the current price
    }

    ICLPoolOracle public immutable pool;
    address public immutable token;
    uint32 public immutable window;
    uint8 public immutable slices;
    int24 public immutable maxDeviationTicks;
    uint256 public immutable minDepthUsdc; // USDC (raw units) to move the price 1%
    bool internal immutable tokenIsToken0;
    uint256 internal immutable baseAmount; // one whole token, scaled so the USDC quote comes out with 8 decimals

    error BadPool();
    error BadWindow();
    error BadParams();
    error NotEnoughHistory(uint16 has, uint16 needs);

    /// @param tokenDecimals passed in rather than read: Coinbase stock tokens are precompiles that some tools
    /// (e.g. Foundry forks) can't call. Check it against the token when deploying.
    /// @param window_ seconds of history, e.g. 1800. Must split evenly into `slices_`.
    /// @param maxDeviationTicks_ about one basis point per tick, e.g. 150 for 1.5%.
    constructor(
        ICLPoolOracle pool_,
        address token_,
        address usdc_,
        uint8 tokenDecimals,
        uint8 usdcDecimals,
        uint32 window_,
        uint8 slices_,
        int24 maxDeviationTicks_,
        uint256 minDepthUsdc_
    ) {
        if (window_ < 10 minutes || window_ > 2 hours) revert BadWindow();
        if (slices_ < 3 || slices_ > 12 || window_ % slices_ != 0) revert BadParams();
        if (maxDeviationTicks_ <= 0 || maxDeviationTicks_ > 1000 || minDepthUsdc_ == 0) revert BadParams();
        (address t0, address t1) = (pool_.token0(), pool_.token1());
        if (!((t0 == token_ && t1 == usdc_) || (t0 == usdc_ && t1 == token_)) || usdcDecimals > decimals) revert BadPool();
        (,,,, uint16 cardinalityNext,) = pool_.slot0();
        uint16 needs = minObservations(window_);
        if (cardinalityNext < needs) revert NotEnoughHistory(cardinalityNext, needs);

        pool = pool_;
        token = token_;
        window = window_;
        slices = slices_;
        maxDeviationTicks = maxDeviationTicks_;
        minDepthUsdc = minDepthUsdc_;
        tokenIsToken0 = t0 == token_;
        baseAmount = 10 ** (uint256(tokenDecimals) + decimals - usdcDecimals);
    }

    /// @notice Observations a pool must keep for a window: grow it first with the pool's own (permissionless)
    /// `increaseObservationCardinalityNext`.
    function minObservations(uint32 window_) public pure returns (uint16) {
        return uint16(window_ / BLOCK_TIME + window_ / BLOCK_TIME / 3);
    }

    function description() external pure returns (string memory) {
        return "Aerodrome TWAP (checked) / USD";
    }

    /// @notice USD price of one whole token, 8 decimals, or 0 when the pool can't be trusted right now.
    /// `updatedAt` is now: the price is computed from the pool on read.
    function latestRoundData() external view override returns (uint80, int256 answer, uint256, uint256, uint80) {
        (uint256 price, Status s,,) = read();
        if (s == Status.Ok) answer = int256(price);
        return (1, answer, block.timestamp, block.timestamp, 1);
    }

    /// @notice Which check passes or fails now, for apps and keepers.
    function status() external view returns (Status s) {
        (, s,,) = read();
    }

    /// @notice The price (median of the slices, 8 decimals), the check result, the median tick and the pool's
    /// USDC depth for a 1% move.
    function read() public view returns (uint256 price, Status s, int24 median, uint256 depth) {
        uint32[] memory ago = new uint32[](uint256(slices) + 1);
        uint32 step = window / slices;
        for (uint256 i; i <= slices; ++i) {
            ago[i] = window - uint32(i) * step;
        }
        int56[] memory cum;
        try pool.observe(ago) returns (int56[] memory c, uint160[] memory) {
            cum = c;
        } catch {
            return (0, Status.NoHistory, 0, 0);
        }

        int24[] memory means = new int24[](slices);
        for (uint256 i; i < slices; ++i) {
            means[i] = _mean(cum[i + 1] - cum[i], step);
        }
        median = _median(means);
        price = quote(median);

        for (uint256 i; i < slices; ++i) {
            if (_far(means[i], median)) return (price, Status.Unsteady, median, 0);
        }
        (uint160 sqrtPriceX96, int24 spot,,,,) = pool.slot0();
        if (_far(spot, median)) return (price, Status.SpotAway, median, 0);
        depth = depthUsdc(sqrtPriceX96, pool.liquidity());
        if (depth < minDepthUsdc) return (price, Status.TooThin, median, depth);
        s = Status.Ok;
    }

    /// @notice USDC (raw units) it takes to move the price 1% with liquidity `L` in range at `sqrtPriceX96`,
    /// ignoring tick crossings. For a v3 pool, 1% in price is a factor of sqrt(1.01) = 1.004988 in sqrt price.
    function depthUsdc(uint160 sqrtPriceX96, uint128 L) public view returns (uint256) {
        // USDC is token1: dy = L * dSqrtP; USDC is token0: dx = L * d(1/sqrtP). Both ~ 0.4988% of L at the price.
        uint256 perUnit = tokenIsToken0 ? Math.mulDiv(L, sqrtPriceX96, 1 << 96) : Math.mulDiv(L, 1 << 96, sqrtPriceX96);
        return perUnit * 4988 / 1_000_000;
    }

    /// @notice USDC (8 decimals) for one whole token at `tick`. Same maths as Uniswap's OracleLibrary.getQuoteAtTick.
    function quote(int24 tick) public view returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        // price = token1 per token0 = sqrtPrice^2 / 2^192
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return tokenIsToken0 ? Math.mulDiv(ratioX192, baseAmount, 1 << 192) : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return tokenIsToken0 ? Math.mulDiv(ratioX128, baseAmount, 1 << 128) : Math.mulDiv(1 << 128, baseAmount, ratioX128);
    }

    /// @dev Mean tick over `secs` seconds, rounded down.
    function _mean(int56 delta, uint32 secs) internal pure returns (int24 tick) {
        int56 w = int56(uint56(secs));
        tick = int24(delta / w);
        if (delta < 0 && delta % w != 0) tick--;
    }

    function _far(int24 a, int24 b) internal view returns (bool) {
        int256 d = int256(a) - int256(b);
        return d > maxDeviationTicks || d < -maxDeviationTicks;
    }

    /// @dev Median of a short list (sorted in place); the lower middle one for an even count.
    function _median(int24[] memory v) internal pure returns (int24) {
        int24[] memory s = new int24[](v.length);
        for (uint256 i; i < v.length; ++i) {
            int24 x = v[i];
            uint256 j = i;
            while (j > 0 && s[j - 1] > x) {
                s[j] = s[j - 1];
                --j;
            }
            s[j] = x;
        }
        return s[(s.length - 1) / 2];
    }
}
