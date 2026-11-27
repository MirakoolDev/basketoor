// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IIndexHook, IIndexLens} from "../interfaces/IBankrIndex.sol";

/// @notice What one Bankr index token costs to buy, in USD (8 decimals, like Chainlink): the basket's value per
/// share from Bankr's IndexLens, plus the index's own fee (fixed when the index was created, 0.25% to 1%).
/// Pricing in the fee means DCAC's slippage bound only has to cover the basket's pool costs, whatever the fee.
/// The basket value comes from Bankr's PriceModule (Chainlink where a feed exists, otherwise prices Bankr and a
/// co-signer sign), never from the index's own pools, so a trade can't move it.
/// When any basket token has no fresh price (`complete` is false) the feed answers 0, which DCAC treats as
/// unusable: that leg is skipped and retried, the same as a stale Chainlink stock feed.
contract BankrIndexNavFeed is IAggregatorV3 {
    uint256 internal constant BPS = 10_000;

    IIndexLens public immutable lens;
    IIndexHook public immutable hook;
    address public immutable index;

    constructor(IIndexLens lens_, IIndexHook hook_, address index_) {
        lens = lens_;
        hook = hook_;
        index = index_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Bankr index buy price (NAV per share + fee) / USD";
    }

    function latestRoundData() external view returns (uint80, int256 answer, uint256, uint256, uint80) {
        (,, uint256 navPerShareE18, bool complete) = lens.navUsdE18(index);
        if (complete) answer = int256(navPerShareE18 * (BPS + hook.feeBpsOf(index)) / BPS / 1e10);
        // The lens prices the basket from fresh prices at this block, so the answer is current now.
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
