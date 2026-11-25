// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title Basketoor
/// @notice Recurring buys (DCA) of a basket of up to 5 tokenized stocks, paid in USDC, on Base.
///
/// A user opens a plan: which stocks, how much USDC per stock per buy, how often, and how many buys.
/// They deposit the whole budget up front: every buy plus its fee. While it waits, the budget can sit in
/// an ERC-4626 savings vault and earn yield. Basketoor's keeper runs each buy when it is due. Every leg is
/// checked against the stock's Chainlink price, so a buy that would fill worse than the slippage limit, or
/// against a stale price (market closed), is skipped and its USDC stays in the plan. Shares go straight to
/// the user's wallet. The user can change or cancel the plan at any time and gets back what is unspent.
///
/// Fees: per buy, the larger of `feeBps` of what was actually spent and `minFee`. Nothing is charged for a
/// buy where every leg was skipped. On close, Basketoor keeps `yieldFeeBps` of the yield the plan earned.
contract Basketoor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LEGS = 5;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 200; // 2%
    uint256 public constant MAX_YIELD_FEE_BPS = 3_000; // 30% of yield
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    /// @notice Gas a keeper should budget per plan (5 legs, savings on). executeDue stops early below this.
    uint256 public constant GAS_PER_RUN = 900_000;

    // ---------------------------------------------------------------- types

    struct Asset {
        IAggregatorV3 feed; // USD price of one whole token
        uint8 tokenDecimals;
        uint8 feedDecimals;
        bool enabled;
    }

    struct Leg {
        address token;
        uint256 amount; // USDC (6 decimals) per buy; 0 = leg paused
        uint256 spent; // USDC spent on this leg, all time
        uint256 received; // tokens received on this leg, all time
    }

    struct Plan {
        address owner;
        uint64 interval;
        uint64 nextRun;
        uint64 createdAt;
        uint32 buysDone; // buys where at least one leg filled
        uint32 maxBuys;
        uint32 skippedRuns; // runs where every leg was skipped
        bool active;
        bool savings; // budget sits in `vault`
        uint16 feeBps; // snapshot at creation
        uint64 minFee; // snapshot at creation
        IERC4626 vault;
        uint256 shares; // vault shares held for this plan
        uint256 idle; // USDC held for this plan outside the vault
        uint256 principal; // USDC deposited minus USDC spent and paid in fees
        uint256 totalSpent;
        uint256 totalFees;
        string name;
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable usdc;

    ISwapAdapter public swapAdapter;
    IERC4626 public savingsVault; // used by new plans that opt in; address(0) = savings off
    address public treasury;

    uint16 public feeBps = 50; // 0.5%
    uint64 public minFee = 100_000; // $0.10
    uint16 public yieldFeeBps = 1_000; // 10% of yield
    uint16 public maxSlippageBps = 150; // 1.5% from the oracle price
    uint64 public maxStaleness = 26 hours; // Chainlink stock feeds: 0.5% deviation / 24h heartbeat
    uint64 public minInterval = 1 hours;
    uint64 public maxInterval = 30 days;
    uint256 public minLegAmount = 1e6; // $1
    uint32 public maxSkippedRuns = 60;
    bool public createPaused;

    mapping(address => Asset) public assets;
    address[] public assetList;
    mapping(address => bool) public keepers;

    uint256 public nextPlanId = 1;
    mapping(uint256 => Plan) internal _plans;
    mapping(uint256 => Leg[]) internal _legs;
    mapping(address => uint256[]) internal _plansOf;

    uint256[] internal _active;
    mapping(uint256 => uint256) internal _activePos; // index + 1

    // ---------------------------------------------------------------- events

    event PlanCreated(
        uint256 indexed id, address indexed owner, string name, uint64 interval, uint32 maxBuys, bool savings, uint256 deposit
    );
    event PlanUpdated(uint256 indexed id, uint64 interval, uint32 maxBuys, uint256 pulled, uint256 refunded);
    event PlanClosed(uint256 indexed id, address indexed owner, uint256 refund, uint256 yieldEarned, uint256 yieldFee, bool cancelled);
    event Bought(
        uint256 indexed id, uint32 indexed buyIndex, address indexed token, uint256 usdcIn, uint256 amountOut, uint256 price
    );
    event LegSkipped(uint256 indexed id, address indexed token, uint8 reason); // 1 price unavailable/stale, 2 swap failed
    event Executed(uint256 indexed id, uint32 buyIndex, uint256 spent, uint256 fee, uint64 nextRun);

    event AssetSet(address indexed token, address feed, bool enabled);
    event KeeperSet(address indexed keeper, bool allowed);
    event ConfigChanged();

    // ---------------------------------------------------------------- errors

    error NotKeeper();
    error NotPlanOwner();
    error PlanNotActive();
    error BadLegs();
    error AssetNotEnabled(address token);
    error LegTooSmall();
    error BadInterval();
    error BadMaxBuys();
    error CreatePaused();
    error BadConfig();
    error UnderDelivered(address token);

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotKeeper();
        _;
    }

    constructor(IERC20 usdc_, ISwapAdapter swapAdapter_, address treasury_, address owner_) Ownable(owner_) {
        usdc = usdc_;
        swapAdapter = swapAdapter_;
        treasury = treasury_;
    }

    // ================================================================ user

    /// @notice Open a plan. Pulls `quoteDeposit(sum(amounts), maxBuys)` USDC from the caller.
    /// The first buy is due immediately.
    function createPlan(
        string calldata name,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint64 interval,
        uint32 maxBuys,
        bool savings
    ) external nonReentrant returns (uint256 id) {
        if (createPaused) revert CreatePaused();
        if (interval < minInterval || interval > maxInterval) revert BadInterval();
        if (maxBuys == 0) revert BadMaxBuys();

        id = nextPlanId++;
        Plan storage p = _plans[id];
        p.owner = msg.sender;
        p.name = name;
        p.interval = interval;
        p.maxBuys = maxBuys;
        p.nextRun = uint64(block.timestamp);
        p.createdAt = uint64(block.timestamp);
        p.active = true;
        p.feeBps = feeBps;
        p.minFee = minFee;
        if (savings && address(savingsVault) != address(0)) {
            p.savings = true;
            p.vault = savingsVault;
        }

        _setLegs(id, tokens, amounts, true);

        uint256 deposit = _required(_perBuy(id), p.feeBps, p.minFee, maxBuys);
        usdc.safeTransferFrom(msg.sender, address(this), deposit);
        _put(p, deposit);
        p.principal = deposit;

        _plansOf[msg.sender].push(id);
        _active.push(id);
        _activePos[id] = _active.length;

        emit PlanCreated(id, msg.sender, name, interval, maxBuys, p.savings, deposit);
    }

    /// @notice Change amounts, add stocks, change the frequency or the number of buys.
    /// `tokens` must list the plan's current stocks first, in order (amount 0 pauses one), then any new ones.
    /// The budget is resized to fund exactly the remaining buys: the difference is pulled or refunded.
    function updatePlan(
        uint256 id,
        string calldata name,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint64 interval,
        uint32 maxBuys
    ) external nonReentrant {
        Plan storage p = _ownedActive(id);
        if (interval < minInterval || interval > maxInterval) revert BadInterval();
        if (maxBuys <= p.buysDone) revert BadMaxBuys();

        _setLegs(id, tokens, amounts, false);
        p.name = name;
        p.interval = interval;
        p.maxBuys = maxBuys;

        uint256 required = _required(_perBuy(id), p.feeBps, p.minFee, maxBuys - p.buysDone);
        uint256 pulled;
        uint256 refunded;
        if (p.principal < required) {
            pulled = required - p.principal;
            usdc.safeTransferFrom(msg.sender, address(this), pulled);
            _put(p, pulled);
            p.principal += pulled;
        } else if (p.principal > required) {
            refunded = Math.min(p.principal - required, _value(p));
            _take(p, refunded);
            p.principal -= refunded;
            usdc.safeTransfer(p.owner, refunded);
        }
        emit PlanUpdated(id, interval, maxBuys, pulled, refunded);
    }

    /// @notice Stop the plan and get back everything unspent, plus yield (minus the yield fee).
    function cancelPlan(uint256 id) external nonReentrant {
        _ownedActive(id);
        _close(id, true);
    }

    // ================================================================ keeper

    /// @notice Run every due plan, up to `maxRuns`. This is what the scheduler calls.
    function executeDue(uint256 maxRuns) external onlyKeeper nonReentrant returns (uint256 ran) {
        uint256[] memory ids = duePlans(maxRuns);
        for (uint256 i; i < ids.length; ++i) {
            // Always attempt the first plan, so an under-gassed call reverts instead of quietly doing nothing.
            if (i > 0 && gasleft() < GAS_PER_RUN) break;
            if (_execute(ids[i])) ++ran;
        }
    }

    /// @notice Run specific plans. Plans that are not due are ignored.
    function executeMany(uint256[] calldata ids) external onlyKeeper nonReentrant returns (uint256 ran) {
        for (uint256 i; i < ids.length; ++i) {
            if (i > 0 && gasleft() < GAS_PER_RUN) break;
            if (_execute(ids[i])) ++ran;
        }
    }

    // ================================================================ views

    function getPlan(uint256 id) external view returns (Plan memory plan, Leg[] memory legs) {
        return (_plans[id], _legs[id]);
    }

    function plansOf(address user) external view returns (uint256[] memory) {
        return _plansOf[user];
    }

    function activePlans() external view returns (uint256[] memory) {
        return _active;
    }

    function getAssets() external view returns (address[] memory) {
        return assetList;
    }

    /// @notice USDC the plan holds right now, yield included.
    function planValue(uint256 id) external view returns (uint256) {
        return _value(_plans[id]);
    }

    function perBuy(uint256 id) external view returns (uint256) {
        return _perBuy(id);
    }

    /// @notice What a new plan costs up front, at today's fees.
    function quoteDeposit(uint256 perBuyAmount, uint32 buys) external view returns (uint256) {
        return _required(perBuyAmount, feeBps, minFee, buys);
    }

    function feeFor(uint256 spent) external view returns (uint256) {
        return _feeFor(spent, feeBps, minFee);
    }

    /// @notice The oracle price of a stock (USD, `feedDecimals`), and whether a buy would use it.
    function priceOf(address token) public view returns (uint256 price, uint256 updatedAt, bool usable) {
        Asset memory a = assets[token];
        if (address(a.feed) == address(0)) return (0, 0, false);
        try a.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updated, uint80) {
            if (answer <= 0) return (0, updated, false);
            price = uint256(answer);
            updatedAt = updated;
            usable = a.enabled && updated + maxStaleness >= block.timestamp;
        } catch {
            return (0, 0, false);
        }
    }

    function dueCount() external view returns (uint256 n) {
        for (uint256 i; i < _active.length; ++i) {
            if (_plans[_active[i]].nextRun <= block.timestamp) ++n;
        }
    }

    function duePlans(uint256 maxRuns) public view returns (uint256[] memory ids) {
        uint256 len = _active.length;
        ids = new uint256[](Math.min(len, maxRuns));
        uint256 n;
        for (uint256 i; i < len && n < ids.length; ++i) {
            uint256 id = _active[i];
            if (_plans[id].nextRun <= block.timestamp) ids[n++] = id;
        }
        assembly {
            mstore(ids, n)
        }
    }

    // ================================================================ admin

    function setAsset(address token, IAggregatorV3 feed, bool enabled) external onlyOwner {
        if (address(assets[token].feed) == address(0)) assetList.push(token);
        assets[token] = Asset({
            feed: feed,
            tokenDecimals: IERC20Metadata(token).decimals(),
            feedDecimals: feed.decimals(),
            enabled: enabled
        });
        emit AssetSet(token, address(feed), enabled);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setSwapAdapter(ISwapAdapter adapter) external onlyOwner {
        swapAdapter = adapter;
        emit ConfigChanged();
    }

    /// @dev Only affects plans created afterwards. Must be an ERC-4626 vault whose asset is USDC.
    function setSavingsVault(IERC4626 vault) external onlyOwner {
        if (address(vault) != address(0) && vault.asset() != address(usdc)) revert BadConfig();
        savingsVault = vault;
        emit ConfigChanged();
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert BadConfig();
        treasury = treasury_;
        emit ConfigChanged();
    }

    /// @dev Fees are snapshotted per plan, so changes only affect new plans.
    function setFees(uint16 feeBps_, uint64 minFee_, uint16 yieldFeeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || yieldFeeBps_ > MAX_YIELD_FEE_BPS || minFee_ > 5e6) revert BadConfig();
        feeBps = feeBps_;
        minFee = minFee_;
        yieldFeeBps = yieldFeeBps_;
        emit ConfigChanged();
    }

    function setExecutionParams(uint16 maxSlippageBps_, uint64 maxStaleness_, uint32 maxSkippedRuns_)
        external
        onlyOwner
    {
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS || maxStaleness_ == 0 || maxSkippedRuns_ == 0) revert BadConfig();
        maxSlippageBps = maxSlippageBps_;
        maxStaleness = maxStaleness_;
        maxSkippedRuns = maxSkippedRuns_;
        emit ConfigChanged();
    }

    function setLimits(uint64 minInterval_, uint64 maxInterval_, uint256 minLegAmount_) external onlyOwner {
        if (minInterval_ == 0 || minInterval_ > maxInterval_) revert BadConfig();
        minInterval = minInterval_;
        maxInterval = maxInterval_;
        minLegAmount = minLegAmount_;
        emit ConfigChanged();
    }

    function setCreatePaused(bool paused) external onlyOwner {
        createPaused = paused;
        emit ConfigChanged();
    }

    // ================================================================ internals

    function _execute(uint256 id) internal returns (bool) {
        Plan storage p = _plans[id];
        if (!p.active || block.timestamp < p.nextRun) return false;

        uint256 per = _perBuy(id);
        if (_value(p) < per + _feeFor(per, p.feeBps, p.minFee)) {
            _close(id, false); // ran out of budget
            return true;
        }

        _take(p, per);
        uint32 buyIndex = p.buysDone + 1;
        uint256 spent;
        Leg[] storage legs = _legs[id];
        for (uint256 i; i < legs.length; ++i) {
            Leg storage leg = legs[i];
            if (leg.amount == 0) continue;
            if (_buyLeg(id, buyIndex, p.owner, leg)) spent += leg.amount;
        }

        if (per > spent) _put(p, per - spent);
        uint256 fee;
        if (spent > 0) {
            fee = _feeFor(spent, p.feeBps, p.minFee);
            _take(p, fee);
            usdc.safeTransfer(treasury, fee);
            p.buysDone = buyIndex;
            p.totalSpent += spent;
            p.totalFees += fee;
            uint256 used = spent + fee;
            p.principal = p.principal > used ? p.principal - used : 0;
        } else {
            ++p.skippedRuns;
        }

        uint64 next = p.nextRun + p.interval;
        if (next <= block.timestamp) next = uint64(block.timestamp) + p.interval;
        p.nextRun = next;
        emit Executed(id, p.buysDone, spent, fee, next);

        if (p.buysDone >= p.maxBuys || p.skippedRuns >= maxSkippedRuns) _close(id, false);
        return true;
    }

    /// @dev Buys one leg. The adapter only ever gets this leg's USDC, and the fill is measured at the
    /// recipient, so a bad adapter or route can't fill below the oracle bound.
    function _buyLeg(uint256 id, uint32 buyIndex, address recipient, Leg storage leg) internal returns (bool) {
        address token = leg.token;
        (uint256 price,, bool usable) = priceOf(token);
        if (!usable) {
            emit LegSkipped(id, token, 1);
            return false;
        }
        Asset memory a = assets[token];
        // expected = amount(6dp) * 10^tokenDec * 10^feedDec / (price * 10^6)
        uint256 expected = Math.mulDiv(leg.amount, 10 ** (uint256(a.tokenDecimals) + a.feedDecimals), price * 1e6);
        uint256 minOut = expected * (BPS - maxSlippageBps) / BPS;

        ISwapAdapter adapter = swapAdapter;
        uint256 before = IERC20(token).balanceOf(recipient);
        usdc.forceApprove(address(adapter), leg.amount);
        bool ok;
        try adapter.swap(address(usdc), token, leg.amount, minOut, recipient) returns (uint256) {
            ok = true;
        } catch {}
        usdc.forceApprove(address(adapter), 0);

        uint256 received = IERC20(token).balanceOf(recipient) - before;
        if (!ok || received < minOut) {
            // A swap that reported success but under-delivered would mean a broken adapter: refuse it.
            if (ok) revert UnderDelivered(token);
            emit LegSkipped(id, token, 2);
            return false;
        }
        leg.spent += leg.amount;
        leg.received += received;
        emit Bought(id, buyIndex, token, leg.amount, received, price);
        return true;
    }

    function _close(uint256 id, bool cancelled) internal {
        Plan storage p = _plans[id];
        uint256 assetsOut = p.idle;
        p.idle = 0;
        if (p.shares > 0) {
            assetsOut += p.vault.redeem(p.shares, address(this), address(this));
            p.shares = 0;
        }
        uint256 yieldEarned = assetsOut > p.principal ? assetsOut - p.principal : 0;
        uint256 yieldFee = yieldEarned * yieldFeeBps / BPS;
        p.principal = 0;
        p.active = false;

        uint256 pos = _activePos[id];
        uint256 last = _active[_active.length - 1];
        _active[pos - 1] = last;
        _activePos[last] = pos;
        _active.pop();
        delete _activePos[id];

        if (yieldFee > 0) usdc.safeTransfer(treasury, yieldFee);
        uint256 refund = assetsOut - yieldFee;
        if (refund > 0) usdc.safeTransfer(p.owner, refund);
        emit PlanClosed(id, p.owner, refund, yieldEarned, yieldFee, cancelled);
    }

    function _setLegs(uint256 id, address[] calldata tokens, uint256[] calldata amounts, bool fresh) internal {
        uint256 n = tokens.length;
        if (n == 0 || n > MAX_LEGS || n != amounts.length) revert BadLegs();
        Leg[] storage legs = _legs[id];
        uint256 existing = legs.length;
        if (n < existing) revert BadLegs();
        bool any;
        for (uint256 i; i < n; ++i) {
            address token = tokens[i];
            uint256 amount = amounts[i];
            if (amount != 0) {
                if (amount < minLegAmount) revert LegTooSmall();
                if (!assets[token].enabled) revert AssetNotEnabled(token);
                any = true;
            }
            for (uint256 j; j < i; ++j) {
                if (tokens[j] == token) revert BadLegs();
            }
            if (i < existing) {
                if (legs[i].token != token) revert BadLegs();
                legs[i].amount = amount;
            } else {
                if (amount == 0 && fresh) revert BadLegs();
                legs.push(Leg({token: token, amount: amount, spent: 0, received: 0}));
            }
        }
        if (!any) revert BadLegs();
    }

    function _ownedActive(uint256 id) internal view returns (Plan storage p) {
        p = _plans[id];
        if (p.owner != msg.sender) revert NotPlanOwner();
        if (!p.active) revert PlanNotActive();
    }

    function _perBuy(uint256 id) internal view returns (uint256 total) {
        Leg[] storage legs = _legs[id];
        for (uint256 i; i < legs.length; ++i) total += legs[i].amount;
    }

    function _feeFor(uint256 spent, uint16 bps, uint64 floor) internal pure returns (uint256) {
        return Math.max(spent * bps / BPS, floor);
    }

    function _required(uint256 per, uint16 bps, uint64 floor, uint256 buys) internal pure returns (uint256) {
        return (per + _feeFor(per, bps, floor)) * buys;
    }

    function _value(Plan storage p) internal view returns (uint256) {
        uint256 v = p.idle;
        if (p.shares > 0) v += p.vault.previewRedeem(p.shares);
        return v;
    }

    /// @dev Move `amount` USDC out of the plan's budget into this contract's loose balance.
    function _take(Plan storage p, uint256 amount) internal {
        if (amount == 0) return;
        if (p.savings) {
            uint256 burned = p.vault.withdraw(amount, address(this), address(this));
            p.shares -= burned;
        } else {
            p.idle -= amount;
        }
    }

    /// @dev Move `amount` loose USDC into the plan's budget.
    function _put(Plan storage p, uint256 amount) internal {
        if (amount == 0) return;
        if (p.savings) {
            usdc.forceApprove(address(p.vault), amount);
            p.shares += p.vault.deposit(amount, address(this));
        } else {
            p.idle += amount;
        }
    }
}
