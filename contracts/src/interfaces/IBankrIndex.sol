// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slices of Uniswap v4 and of Bankr's index contracts that DCAC's index support uses.
/// Bankr index tokens: https://docs.bankr.bot/token-launching/index-tokens-for-developers

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @dev Bankr's IndexFactory: every index it created is a vault (the index's own ERC-20).
interface IIndexFactory {
    function isVault(address vault) external view returns (bool);
}

/// @dev Bankr's IndexHook: each index has a pool against the stable (USDC on Base) and one against WETH.
interface IIndexHook {
    function poolsOf(address vault) external view returns (PoolKey memory stableKey, PoolKey memory wethKey);
    function buysPaused(address vault) external view returns (bool);
}

/// @dev Bankr's IndexLens: read-only views that never revert.
interface IIndexLens {
    function navUsdE18(address vault)
        external
        view
        returns (uint256 nav, uint256 circulating, uint256 navPerShareE18, bool complete);
}
