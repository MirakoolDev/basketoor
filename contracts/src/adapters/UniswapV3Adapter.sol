// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Mainnet venue: Uniswap v3 style router (SwapRouter02) with an owner-set path per stock,
/// e.g. USDC -(500)-> NVDA. Basketoor still enforces the oracle bound on what arrives.
contract UniswapV3Adapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    mapping(address tokenIn => mapping(address tokenOut => bytes path)) public paths;

    constructor(ISwapRouter02 router_, address owner_) Ownable(owner_) {
        router = router_;
    }

    /// @param path Uniswap-encoded path: tokenIn, fee, [token, fee, ...], tokenOut.
    function setPath(address tokenIn, address tokenOut, bytes calldata path) external onlyOwner {
        paths[tokenIn][tokenOut] = path;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        bytes memory path = paths[tokenIn][tokenOut];
        require(path.length >= 43, "no path");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        amountOut = router.exactInput(
            ISwapRouter02.ExactInputParams({path: path, recipient: recipient, amountIn: amountIn, amountOutMinimum: minOut})
        );
    }
}
