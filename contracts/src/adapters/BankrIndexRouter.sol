// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {
    IIndexFactory, IIndexHook, IPoolManager, IUnlockCallback, PoolKey, SwapParams
} from "../interfaces/IBankrIndex.sol";

/// @notice DCAC's venue once index tokens are listed. A buy of a Bankr index token (USDC in) goes through the
/// index's own Uniswap v4 pool, whose hook buys the basket and mints index shares. Every other swap is passed
/// unchanged to the existing venue (AerodromeCLAdapter), so stock and crypto buys work exactly as before.
/// Nothing here is owned or configurable: the index is recognised by Bankr's factory and its pool is read from
/// Bankr's hook, so the only trust added is in Bankr's index contracts themselves.
/// Like the Aerodrome adapter it checks `minOut` itself and refuses a partial fill; DCAC re-checks what arrives.
contract BankrIndexRouter is ISwapAdapter, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    ISwapAdapter public immutable fallbackVenue;
    IPoolManager public immutable poolManager;
    IIndexFactory public immutable factory;
    IIndexHook public immutable hook;
    address public immutable stable;

    /// @dev Set only while this contract is inside its own unlock.
    bool transient unlocking;

    error NotPoolManager();
    error UnexpectedCallback();
    error PartialFill();
    error Slippage(uint256 out, uint256 minOut);

    constructor(ISwapAdapter fallbackVenue_, IPoolManager poolManager_, IIndexFactory factory_, IIndexHook hook_, address stable_) {
        fallbackVenue = fallbackVenue_;
        poolManager = poolManager_;
        factory = factory_;
        hook = hook_;
        stable = stable_;
    }

    /// @notice True when `token` is a Bankr index this router buys through its own pool.
    function isIndex(address token) public view returns (bool) {
        return factory.isVault(token);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == stable && isIndex(tokenOut)) {
            (PoolKey memory key,) = hook.poolsOf(tokenOut);
            unlocking = true;
            amountOut = abi.decode(poolManager.unlock(abi.encode(key, tokenOut, amountIn, recipient)), (uint256));
            unlocking = false;
        } else {
            IERC20(tokenIn).forceApprove(address(fallbackVenue), amountIn);
            amountOut = fallbackVenue.swap(tokenIn, tokenOut, amountIn, minOut, recipient);
            IERC20(tokenIn).forceApprove(address(fallbackVenue), 0);
        }
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
    }

    /// @dev Pays the USDC in first (Bankr's hook buys the basket with it during the swap), swaps exact input,
    /// then sends the minted index shares to the recipient.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!unlocking) revert UnexpectedCallback();
        (PoolKey memory key, address index, uint256 amountIn, address recipient) =
            abi.decode(data, (PoolKey, address, uint256, address));

        poolManager.sync(stable);
        IERC20(stable).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();

        bool zeroForOne = key.currency0 == stable;
        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 d0, int128 d1) = (int128(delta >> 128), int128(delta));
        (int128 paid, int128 got) = zeroForOne ? (d0, d1) : (d1, d0);
        if (uint256(uint128(-paid)) != amountIn) revert PartialFill();
        uint256 out = uint256(uint128(got));
        poolManager.take(index, recipient, out);
        return abi.encode(out);
    }
}
