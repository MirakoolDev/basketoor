// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {TickMath} from "../lib/TickMath.sol";

/// @dev The oracle slice of an Aerodrome Slipstream (Uniswap v3 style) pool.
interface ICLPoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice A Chainlink-style USD price for a token with no Chainlink feed, read from the time-weighted average
/// price (TWAP) of its Aerodrome Slipstream pool against USDC, counting 1 USDC as $1.
///
/// Basketoor uses it exactly like a Chainlink feed: a buy must fill within `maxSlippageBps` of this price. A
/// TWAP can't be moved within one block, so a buy can't be sandwiched against it, but someone willing to hold
/// the pool price off for the whole window can shift it. Use it only for deep pools, with a window long enough
/// to make that expensive. The price is the token's onchain market price, not the underlying stock's.
contract PoolTwapFeed is IAggregatorV3 {
    uint8 public constant override decimals = 8;

    ICLPoolOracle public immutable pool;
    address public immutable token;
    uint32 public immutable window;
    bool internal immutable tokenIsToken0;
    uint256 internal immutable baseAmount; // one whole token, scaled so the USDC quote comes out with 8 decimals

    error BadPool();
    error BadWindow();

    /// @param tokenDecimals passed in rather than read: Coinbase stock tokens are precompiles that some tools
    /// (e.g. Foundry forks) can't call. Check it against the token when deploying.
    constructor(ICLPoolOracle pool_, address token_, address usdc_, uint8 tokenDecimals, uint8 usdcDecimals, uint32 window_) {
        if (window_ < 5 minutes) revert BadWindow();
        (address t0, address t1) = (pool_.token0(), pool_.token1());
        if (!((t0 == token_ && t1 == usdc_) || (t0 == usdc_ && t1 == token_)) || usdcDecimals > decimals) revert BadPool();
        pool = pool_;
        token = token_;
        window = window_;
        tokenIsToken0 = t0 == token_;
        baseAmount = 10 ** (uint256(tokenDecimals) + decimals - usdcDecimals);
    }

    function description() external pure returns (string memory) {
        return "Aerodrome TWAP / USD";
    }

    /// @notice The mean tick over the last `window` seconds, rounded down.
    function twapTick() public view returns (int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory cumulatives,) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 w = int56(uint56(window));
        tick = int24(delta / w);
        if (delta < 0 && delta % w != 0) tick--;
    }

    /// @notice USD price of one whole token, 8 decimals. Always "fresh": it is computed from the pool on read.
    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(quote(twapTick())), block.timestamp, block.timestamp, 1);
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
}
