// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IIndexLens} from "../interfaces/IBankrIndex.sol";

/// @notice The price of one Bankr index token in USD (8 decimals, like Chainlink), read from Bankr's IndexLens:
/// the basket's value per share. That value comes from Bankr's PriceModule (Chainlink where a feed exists,
/// otherwise prices Bankr and a co-signer sign), never from the index's own pools, so a trade can't move it.
/// When any basket token has no fresh price (`complete` is false) the feed answers 0, which DCAC treats as
/// unusable: that leg is skipped and retried, the same as a stale Chainlink stock feed.
contract BankrIndexNavFeed is IAggregatorV3 {
    IIndexLens public immutable lens;
    address public immutable index;

    constructor(IIndexLens lens_, address index_) {
        lens = lens_;
        index = index_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Bankr index NAV per share / USD";
    }

    function latestRoundData() external view returns (uint80, int256 answer, uint256, uint256, uint80) {
        (,, uint256 navPerShareE18, bool complete) = lens.navUsdE18(index);
        if (complete) answer = int256(navPerShareE18 / 1e10);
        // The lens prices the basket from fresh prices at this block, so the answer is current now.
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
