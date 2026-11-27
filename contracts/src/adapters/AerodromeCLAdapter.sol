// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @dev The slice of an Aerodrome Slipstream (Uniswap v3 style) concentrated-liquidity pool we use.
interface ICLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @dev The Slipstream pool factory: only pools it created are accepted.
interface ICLFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

/// @notice Mainnet venue: swaps directly against an owner-chosen Aerodrome concentrated-liquidity pool per
/// pair (where Coinbase's tokenized stocks are deepest), with no router in between.
/// The adapter checks `minOut` itself, so a thin pool makes this leg's swap revert (DCAC skips the
/// leg and keeps its USDC) rather than under-delivering. DCAC still re-checks what arrives.
/// Trust: the owner picks the pools, but only among pools the Slipstream factory created for the pair; use the
/// same key (and two-step handover) as DCAC's owner.
contract AerodromeCLAdapter is ISwapAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    ICLFactory public immutable factory;
    mapping(address tokenIn => mapping(address tokenOut => ICLPool)) public pools;

    /// @dev The pool we're mid-swap with; only it may call the callback.
    address transient activePool;

    event PoolSet(address indexed tokenIn, address indexed tokenOut, address pool);

    error NoPool();
    error WrongPool();
    error PartialFill();
    error Slippage(uint256 out, uint256 minOut);
    error UnexpectedCallback();

    constructor(ICLFactory factory_, address owner_) Ownable(owner_) {
        factory = factory_;
    }

    /// @notice Routes tokenIn -> tokenOut through `pool` (both directions are set). Pass address(0) to remove.
    function setPool(address tokenIn, address tokenOut, ICLPool pool) external onlyOwner {
        if (address(pool) != address(0)) {
            (address t0, address t1) = (pool.token0(), pool.token1());
            if (!((t0 == tokenIn && t1 == tokenOut) || (t0 == tokenOut && t1 == tokenIn))) revert WrongPool();
            if (factory.getPool(t0, t1, pool.tickSpacing()) != address(pool)) revert WrongPool();
        }
        pools[tokenIn][tokenOut] = pool;
        pools[tokenOut][tokenIn] = pool;
        emit PoolSet(tokenIn, tokenOut, address(pool));
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        ICLPool pool = pools[tokenIn][tokenOut];
        if (address(pool) == address(0)) revert NoPool();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        bool zeroForOne = tokenIn == pool.token0();
        activePool = address(pool);
        (int256 a0, int256 a1) = pool.swap(
            recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );
        activePool = address(0);

        (int256 paid, int256 got) = zeroForOne ? (a0, a1) : (a1, a0);
        // Running out of liquidity before spending everything would strand USDC here: refuse instead.
        if (uint256(paid) != amountIn) revert PartialFill();
        amountOut = uint256(-got);
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
    }

    /// @dev Aerodrome Slipstream pools call the Uniswap v3 callback name.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != activePool || activePool == address(0)) revert UnexpectedCallback();
        address tokenIn = abi.decode(data, (address));
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }
}
