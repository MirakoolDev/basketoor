// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Testnet stand-ins. Coinbase's tokenized stocks, their Chainlink feeds and their DEX pools exist only on
// Base mainnet, so Base Sepolia gets mocks with the same interfaces.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice Test USDC: 6 decimals, anyone can mint up to 10,000 at a time (a faucet).
contract MockUSDC is ERC20 {
    constructor() ERC20("Test USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to, uint256 amount) external {
        require(amount <= 10_000e6, "max 10k");
        _mint(to, amount);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A tokenized stock or crypto token stand-in. Only the minter (the mock swap venue) can mint.
contract MockStock is ERC20, Ownable {
    address public minter;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter || msg.sender == owner(), "not minter");
        _mint(to, amount);
    }
}

/// @notice A Chainlink-style feed whose price the owner (or a price-relay bot) sets.
contract MockFeed is IAggregatorV3, Ownable {
    uint8 public immutable override decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    mapping(address => bool) public updaters;

    constructor(uint8 decimals_, int256 answer_, address owner_) Ownable(owner_) {
        decimals = decimals_;
        _set(answer_);
    }

    function setUpdater(address who, bool allowed) external onlyOwner {
        updaters[who] = allowed;
    }

    function setPrice(int256 answer_) external {
        require(msg.sender == owner() || updaters[msg.sender], "not updater");
        _set(answer_);
    }

    /// @dev For tests: pretend the last update happened at `when`.
    function setUpdatedAt(uint256 when) external onlyOwner {
        updatedAt = when;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function _set(int256 answer_) internal {
        answer = answer_;
        updatedAt = block.timestamp;
        ++roundId;
    }
}

/// @notice A swap venue that sells mock stocks at their feed price minus a spread, minting them on demand.
/// The USDC it takes stays here.
contract MockSwapAdapter is ISwapAdapter, Ownable {
    mapping(address => IAggregatorV3) public feedOf;
    uint256 public spreadBps = 20; // 0.2%

    constructor(address owner_) Ownable(owner_) {}

    function setFeed(address token, IAggregatorV3 feed) external onlyOwner {
        feedOf[token] = feed;
    }

    function setSpread(uint256 bps) external onlyOwner {
        require(bps <= 1_000, "spread");
        spreadBps = bps;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        IAggregatorV3 feed = feedOf[tokenOut];
        require(address(feed) != address(0), "no market");
        (, int256 price,,,) = feed.latestRoundData();
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 inDec = ERC20(tokenIn).decimals();
        uint256 outDec = ERC20(tokenOut).decimals();
        amountOut = Math.mulDiv(amountIn, 10 ** (outDec + feed.decimals()), uint256(price) * 10 ** inDec);
        amountOut = amountOut * (10_000 - spreadBps) / 10_000;
        require(amountOut >= minOut, "slippage");
        MockStock(tokenOut).mint(recipient, amountOut);
    }
}

/// @notice A USDC savings vault. Yield appears when someone calls `accrue` (minting test USDC into it).
contract MockSavingsVault is ERC4626 {
    constructor(IERC20 usdc_) ERC20("Basketoor Test Savings", "bsUSDC") ERC4626(usdc_) {}

    /// @dev Add `bps` of current assets as yield.
    function accrue(uint256 bps) external {
        uint256 amount = totalAssets() * bps / 10_000;
        MockUSDC(asset()).mint(address(this), amount);
    }

    /// @dev Add an exact amount of yield (the testnet keeper drips it at a realistic APY).
    function accrueAmount(uint256 amount) external {
        MockUSDC(asset()).mint(address(this), amount);
    }
}
