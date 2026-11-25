// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A venue Basketoor buys through. Basketoor approves `amountIn` of `tokenIn` to the adapter,
/// the adapter pulls it, swaps, and sends at least `minOut` of `tokenOut` to `recipient`.
interface ISwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);
}
