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

/// @title DCAC
/// @notice Recurring buys (DCA) of a basket of up to 5 tokenized stocks, paid in USDC, on Base.
///
/// A user opens a plan: which stocks, how much USDC per stock per buy, how often, and how many buys.
/// They deposit the whole budget up front: every buy plus its fee. While it waits, the budget can sit in
/// an ERC-4626 savings vault and earn yield. DCAC's keeper runs each buy when it is due. Every leg is
/// checked against the stock's Chainlink price, so a buy that would fill worse than the slippage limit, or
/// against a stale price (market closed), is skipped and its USDC stays in the plan. Shares go straight to
/// the user's wallet. The user can change or cancel the plan at any time and gets back what is unspent.
///
/// Fees: per buy, the larger of `feeBps` of what was actually spent and `minFee`, plus `smartFeeBps` while
/// smart buys are on. Nothing is charged for a buy where every leg was skipped. On close, DCAC keeps
/// `yieldFeeBps` of the yield the plan earned. All of them are fixed per plan when it is created.
///
/// Smart buys (opt-in per plan): the leg amounts set the basket's target weights, and each buy splits the same
/// USDC toward whichever stocks are furthest under their weight, valued at the oracle price. It only ever buys,
/// never sells, so the basket drifts back toward its targets over the following buys.
///
/// A run where nothing could be bought (stale prices, savings vault not paying out) is retried after
/// `RETRY_DELAY` instead of waiting a whole interval. Payouts that the recipient can't receive (e.g. a USDC
/// blocklisted address) are kept for them to `claim` instead of blocking the keeper or anyone's exit.
contract DCAC is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LEGS = 5;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 200; // 2%
    uint256 public constant MAX_YIELD_FEE_BPS = 3_000; // 30% of yield
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    /// @notice Gas budget per plan run: base + per active leg + savings vault. See `gasFor`. Measured on Base
    /// mainnet (eth_simulateV1) against Aerodrome Slipstream pools: ~3.1M for a first 5-leg run with savings and
    /// smart buys, TWAP-priced legs and cold storage included. Single swaps through the tokenized-stock pools have
    /// been seen at up to ~680k, so each leg is budgeted at 700k.
    uint256 public constant GAS_BASE = 250_000;
    uint256 public constant GAS_PER_LEG = 700_000;
    uint256 public constant GAS_VAULT = 400_000;
    /// @notice A run that bought nothing is retried this long after (or after one interval, if shorter).
    uint64 public constant RETRY_DELAY = 1 hours;

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
        uint64 lastRun; // time of the last buy; 0 before the first
        uint32 buysDone; // buys where at least one leg filled
        uint32 maxBuys;
        uint32 skippedRuns; // runs in a row where nothing was bought; reset by a buy
        bool active;
        bool savings; // budget sits in `vault`
        bool smart; // smart buys: split each buy toward the target weights
        uint16 feeBps; // snapshot at creation
        uint16 smartFeeBps; // snapshot at creation, charged on top of feeBps while `smart` is on
        uint16 yieldFeeBps; // snapshot at creation
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
    uint16 public smartFeeBps = 25; // +0.25% per buy while smart buys are on
    uint16 public yieldFeeBps = 1_000; // 10% of yield
    uint16 public maxSlippageBps = 150; // 1.5% from the oracle price
    uint64 public maxStaleness = 26 hours; // Chainlink stock feeds: 0.5% deviation / 24h heartbeat
    uint64 public minInterval = 1 hours;
    uint64 public maxInterval = 30 days;
    uint256 public minLegAmount = 1e6; // $1
    uint32 public maxSkippedRuns = 168; // a week of hourly retries
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

    /// @notice USDC owed to an address whose payout transfer failed. Withdrawn with `claim`.
    mapping(address => uint256) public owed;
    uint256 public totalOwed;

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
    event VaultUnavailable(uint256 indexed id); // the savings vault couldn't be read or pay out; run retried later
    event PaymentDeferred(address indexed to, uint256 amount);
    event Claimed(address indexed from, address indexed to, uint256 amount);
    event Executed(uint256 indexed id, uint32 buyIndex, uint256 spent, uint256 fee, uint64 nextRun);
    event SmartBuysSet(uint256 indexed id, bool on);

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
    error InsufficientGas(uint256 needed);
    error DepositTooHigh(uint256 required);
    error BadVaultDeposit();
    error NothingOwed();

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotKeeper();
        _;
    }

    constructor(IERC20 usdc_, ISwapAdapter swapAdapter_, address treasury_, address owner_) Ownable(owner_) {
        if (address(swapAdapter_).code.length == 0 || treasury_ == address(0)) revert BadConfig();
        usdc = usdc_;
        swapAdapter = swapAdapter_;
        treasury = treasury_;
    }

    // ================================================================ user

    /// @notice Open a plan. Pulls `quoteDeposit(sum(amounts), maxBuys)` USDC from the caller, and reverts if
    /// that is more than `maxDeposit` (a fee change landing first). The first buy is due immediately.
    function createPlan(
        string calldata name,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint64 interval,
        uint32 maxBuys,
        bool savings,
        bool smart,
        uint256 maxDeposit
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
        p.smartFeeBps = smartFeeBps;
        p.minFee = minFee;
        p.yieldFeeBps = yieldFeeBps;
        p.smart = smart;
        if (savings && address(savingsVault) != address(0)) {
            p.savings = true;
            p.vault = savingsVault;
        }

        _setLegs(id, tokens, amounts, true);

        uint256 deposit = _required(_perBuy(id), _bps(p), p.minFee, maxBuys);
        if (deposit > maxDeposit) revert DepositTooHigh(deposit);
        usdc.safeTransferFrom(msg.sender, address(this), deposit);
        _put(p, deposit, true);
        p.principal = deposit;

        _plansOf[msg.sender].push(id);
        _active.push(id);
        _activePos[id] = _active.length;

        emit PlanCreated(id, msg.sender, name, interval, maxBuys, p.savings, deposit);
        if (smart) emit SmartBuysSet(id, true);
    }

    /// @notice Turn smart buys on or off. Changes how future buys are split, not how much they spend, but the
    /// fee changes by the plan's `smartFeeBps`, so the budget is resized for the remaining buys: the extra
    /// fees are pulled (at most `maxPull`) or the unneeded ones refunded.
    function setSmartBuys(uint256 id, bool on, uint256 maxPull) external nonReentrant {
        Plan storage p = _ownedActive(id);
        p.smart = on;
        emit SmartBuysSet(id, on);
        (uint256 pulled, uint256 refunded) = _resize(p, _perBuy(id), maxPull);
        emit PlanUpdated(id, p.interval, p.maxBuys, pulled, refunded);
    }

    /// @notice Change amounts, add stocks, change the frequency or the number of buys.
    /// `tokens` must list the plan's current stocks first, in order (amount 0 pauses one), then any new ones.
    /// The budget is resized to fund exactly the remaining buys (at the plan's own fees): the difference is
    /// pulled (at most `maxPull`, and not while new plans are paused) or refunded. A new frequency applies from
    /// the last buy: next buy = last buy + new interval, or now if that has passed.
    function updatePlan(
        uint256 id,
        string calldata name,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint64 interval,
        uint32 maxBuys,
        bool smart,
        uint256 maxPull
    ) external nonReentrant {
        Plan storage p = _ownedActive(id);
        if (interval < minInterval || interval > maxInterval) revert BadInterval();
        if (maxBuys <= p.buysDone) revert BadMaxBuys();

        _setLegs(id, tokens, amounts, false);
        p.name = name;
        if (interval != p.interval && p.lastRun != 0) {
            p.nextRun = uint64(Math.max(p.lastRun + interval, block.timestamp));
        }
        p.interval = interval;
        p.maxBuys = maxBuys;
        if (smart != p.smart) {
            p.smart = smart;
            emit SmartBuysSet(id, smart);
        }

        (uint256 pulled, uint256 refunded) = _resize(p, _perBuy(id), maxPull);
        emit PlanUpdated(id, interval, maxBuys, pulled, refunded);
    }

    /// Fund exactly the remaining buys at the plan's own fees: pull the difference (at most `maxPull`, and not
    /// while new plans are paused) or refund it.
    function _resize(Plan storage p, uint256 per, uint256 maxPull) internal returns (uint256 pulled, uint256 refunded) {
        uint256 required = _required(per, _bps(p), p.minFee, p.maxBuys - p.buysDone);
        if (p.principal < required) {
            if (createPaused) revert CreatePaused();
            pulled = required - p.principal;
            if (pulled > maxPull) revert DepositTooHigh(pulled);
            usdc.safeTransferFrom(msg.sender, address(this), pulled);
            _put(p, pulled, true);
            p.principal += pulled;
        } else if (p.principal > required) {
            refunded = _take(p, p.principal - required);
            p.principal -= refunded;
            _pay(p.owner, refunded);
        }
    }

    /// @notice Stop the plan and get back everything unspent, plus yield (minus the yield fee).
    function cancelPlan(uint256 id) external nonReentrant {
        _ownedActive(id);
        _close(id, true);
    }

    /// @notice Withdraw USDC that couldn't be paid out to you (see `owed`), to any address.
    function claim(address to) external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        usdc.safeTransfer(to, amount);
        emit Claimed(msg.sender, to, amount);
    }

    // ================================================================ keeper

    /// @notice Run every due plan, up to `maxRuns`. This is what the scheduler calls.
    /// Reverts with `InsufficientGas` unless `gasFor(id)` is left before each plan, so a gas estimate covers
    /// every plan the call runs and an under-gassed call fails loudly instead of quietly doing part of it.
    /// Keep `maxRuns` small enough that the worst case (`maxRuns` 5-leg savings plans) fits one transaction.
    function executeDue(uint256 maxRuns) external onlyKeeper nonReentrant returns (uint256 ran) {
        uint256[] memory ids = duePlans(maxRuns);
        for (uint256 i; i < ids.length; ++i) {
            if (_execute(ids[i])) ++ran;
        }
    }

    /// @notice Run specific plans. Plans that are not due are ignored. Same gas rule as `executeDue`.
    function executeMany(uint256[] calldata ids) external onlyKeeper nonReentrant returns (uint256 ran) {
        for (uint256 i; i < ids.length; ++i) {
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

    /// @notice What each of the plan's stocks is worth now (USDC, 6 decimals, at the oracle price; 0 if there is
    /// no price) and its target weight in bps. `drift` is how far the basket is from its targets: the sum of the
    /// overweights, in bps of the basket's value.
    function weightsOf(uint256 id)
        external
        view
        returns (uint256[] memory values, uint256[] memory targetBps, uint256 drift)
    {
        Leg[] storage legs = _legs[id];
        uint256 n = legs.length;
        values = new uint256[](n);
        targetBps = new uint256[](n);
        uint256 per = _perBuy(id);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            (uint256 price,,) = priceOf(legs[i].token);
            if (price != 0) values[i] = _usdcValue(legs[i].token, legs[i].received, price);
            if (per != 0) targetBps[i] = legs[i].amount * BPS / per;
            total += values[i];
        }
        if (total == 0) return (values, targetBps, 0);
        for (uint256 i; i < n; ++i) {
            uint256 w = values[i] * BPS / total;
            if (w > targetBps[i]) drift += w - targetBps[i];
        }
    }

    /// @notice Gas a keeper must leave for one run of plan `id` (its close included).
    function gasFor(uint256 id) public view returns (uint256 gas) {
        Leg[] storage legs = _legs[id];
        gas = GAS_BASE;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].amount != 0) gas += GAS_PER_LEG;
        }
        if (_plans[id].savings) gas += GAS_VAULT;
    }

    /// @notice What a new plan without smart buys costs up front, at today's fees (with smart buys, add
    /// `smartFeeBps` to `feeBps`).
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
        if (address(adapter).code.length == 0) revert BadConfig();
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
        if (feeBps_ + smartFeeBps > MAX_FEE_BPS || yieldFeeBps_ > MAX_YIELD_FEE_BPS || minFee_ > 5e6) revert BadConfig();
        feeBps = feeBps_;
        minFee = minFee_;
        yieldFeeBps = yieldFeeBps_;
        emit ConfigChanged();
    }

    /// @notice The smart-buys premium for new plans, on top of `feeBps`. The two together stay within the 2% cap.
    function setSmartFee(uint16 smartFeeBps_) external onlyOwner {
        if (feeBps + smartFeeBps_ > MAX_FEE_BPS) revert BadConfig();
        smartFeeBps = smartFeeBps_;
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
        uint256 needed = gasFor(id);
        if (gasleft() < needed) revert InsufficientGas(needed);

        uint256 per = _perBuy(id);
        (uint256 value, bool vaultOk) = _valueOf(p);
        if (!vaultOk) return _skipRun(id, p, true);
        // The fee is charged from what is left after the buy (below), so ERC-4626 rounding dust in a savings
        // plan can't cancel the last funded buy.
        if (value < per) {
            _close(id, false); // ran out of budget
            return true;
        }

        uint256 got = _take(p, per);
        if (got < per) {
            p.idle += got; // the vault didn't pay out: keep what came back and try again later
            return _skipRun(id, p, true);
        }

        uint32 buyIndex = p.buysDone + 1;
        uint256 spent;
        Leg[] storage legs = _legs[id];
        (uint256[] memory prices, uint256[] memory allocs) = _allocate(legs, per, p.smart);
        for (uint256 i; i < legs.length; ++i) {
            if (allocs[i] == 0) continue;
            if (_buyLeg(id, buyIndex, p.owner, legs[i], allocs[i], prices[i])) spent += allocs[i];
        }

        if (per > spent) _put(p, per - spent, false);
        if (spent == 0) return _skipRun(id, p, false);

        // Normally exactly the fee; less only if the plan holds less (rounding dust, a vault loss).
        uint256 fee = _take(p, _feeFor(spent, _bps(p), p.minFee));
        _pay(treasury, fee);
        p.buysDone = buyIndex;
        p.skippedRuns = 0;
        p.lastRun = uint64(block.timestamp);
        p.totalSpent += spent;
        p.totalFees += fee;
        uint256 used = spent + fee;
        p.principal = p.principal > used ? p.principal - used : 0;

        uint64 next = p.nextRun + p.interval;
        if (next <= block.timestamp) next = uint64(block.timestamp) + p.interval;
        p.nextRun = next;
        emit Executed(id, buyIndex, spent, fee, next);

        if (p.buysDone >= p.maxBuys) _close(id, false);
        return true;
    }

    /// @dev Nothing was bought: retry soon, and retire the plan after `maxSkippedRuns` such runs in a row.
    function _skipRun(uint256 id, Plan storage p, bool vault) internal returns (bool) {
        if (vault) emit VaultUnavailable(id);
        ++p.skippedRuns;
        uint64 next = uint64(block.timestamp) + (p.interval < RETRY_DELAY ? p.interval : RETRY_DELAY);
        p.nextRun = next;
        emit Executed(id, p.buysDone, 0, 0, next);
        if (p.skippedRuns >= maxSkippedRuns) _close(id, false);
        return true;
    }

    /// @dev Buys one leg. The adapter only ever gets this leg's USDC, and the fill is measured at the
    /// recipient, so a bad adapter or route can't fill below the oracle bound.
    /// `price` is 0 when the oracle price is unavailable or stale: then the leg is skipped.
    function _buyLeg(uint256 id, uint32 buyIndex, address recipient, Leg storage leg, uint256 amount, uint256 price)
        internal
        returns (bool)
    {
        address token = leg.token;
        if (price == 0) {
            emit LegSkipped(id, token, 1);
            return false;
        }
        Asset memory a = assets[token];
        // expected = amount(6dp) * 10^tokenDec * 10^feedDec / (price * 10^6)
        uint256 expected = Math.mulDiv(amount, 10 ** (uint256(a.tokenDecimals) + a.feedDecimals), price * 1e6);
        uint256 minOut = expected * (BPS - maxSlippageBps) / BPS;

        ISwapAdapter adapter = swapAdapter;
        uint256 before = IERC20(token).balanceOf(recipient);
        usdc.forceApprove(address(adapter), amount);
        bool ok;
        try adapter.swap(address(usdc), token, amount, minOut, recipient) returns (uint256) {
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
        leg.spent += amount;
        leg.received += received;
        emit Bought(id, buyIndex, token, amount, received, price);
        return true;
    }

    /// @dev The usable oracle price of each leg (0 = skip it) and how much USDC each leg gets this run; the
    /// amounts add up to `per`. Plain plans use the leg amounts. Smart plans aim every leg at its target weight
    /// (its amount / `per`) of the basket after this buy, counting what the plan has bought so far at today's
    /// price, and split `per` in proportion to how far under target each leg is. A leg that would get less than
    /// `minLegAmount` hands its share to the leg furthest under target, so a buy never makes dust swaps. If any
    /// active leg has no usable price the basket can't be valued, so the run falls back to the leg amounts.
    function _allocate(Leg[] storage legs, uint256 per, bool smart)
        internal
        view
        returns (uint256[] memory prices, uint256[] memory allocs)
    {
        uint256 n = legs.length;
        prices = new uint256[](n);
        allocs = new uint256[](n);
        bool allPriced = true;
        for (uint256 i; i < n; ++i) {
            allocs[i] = legs[i].amount;
            if (allocs[i] == 0) continue;
            (uint256 price,, bool usable) = priceOf(legs[i].token);
            if (usable) prices[i] = price;
            else allPriced = false;
        }
        if (!smart || !allPriced) return (prices, allocs);

        // deficit = max(0, target - value), target = (holdings + per) * amount / per. Deficits add up to >= per.
        uint256[] memory deficits = new uint256[](n);
        uint256 total = per;
        for (uint256 i; i < n; ++i) {
            if (allocs[i] == 0) continue;
            deficits[i] = _usdcValue(legs[i].token, legs[i].received, prices[i]);
            total += deficits[i];
        }
        uint256 deficitSum;
        uint256 top = n; // the leg furthest under target
        for (uint256 i; i < n; ++i) {
            if (allocs[i] == 0) continue;
            uint256 target = Math.mulDiv(total, legs[i].amount, per);
            deficits[i] = target > deficits[i] ? target - deficits[i] : 0;
            deficitSum += deficits[i];
            if (top == n || deficits[i] > deficits[top]) top = i;
        }
        uint256 given;
        for (uint256 i; i < n; ++i) {
            if (allocs[i] == 0) continue;
            uint256 a = i == top ? 0 : Math.mulDiv(per, deficits[i], deficitSum);
            if (a < minLegAmount) a = 0;
            allocs[i] = a;
            given += a;
        }
        allocs[top] = per - given;
    }

    /// @dev USDC (6 decimals) value of `amount` of `token` at an oracle `price`.
    function _usdcValue(address token, uint256 amount, uint256 price) internal view returns (uint256) {
        Asset memory a = assets[token];
        return Math.mulDiv(amount, price * 1e6, 10 ** (uint256(a.tokenDecimals) + a.feedDecimals));
    }

    function _close(uint256 id, bool cancelled) internal {
        Plan storage p = _plans[id];
        uint256 assetsOut = p.idle;
        p.idle = 0;
        uint256 sharesOut;
        if (p.shares > 0) {
            uint256 shares = p.shares;
            p.shares = 0;
            try p.vault.redeem(shares, address(this), address(this)) returns (uint256 out) {
                assetsOut += out;
            } catch {
                sharesOut = shares; // the vault can't pay out: the owner gets the vault shares themselves
            }
        }
        // No yield fee when the owner is handed vault shares: what they are worth isn't known here.
        uint256 yieldEarned = sharesOut == 0 && assetsOut > p.principal ? assetsOut - p.principal : 0;
        uint256 yieldFee = yieldEarned * p.yieldFeeBps / BPS;
        p.principal = 0;
        p.active = false;

        uint256 pos = _activePos[id];
        uint256 last = _active[_active.length - 1];
        _active[pos - 1] = last;
        _activePos[last] = pos;
        _active.pop();
        delete _activePos[id];

        _pay(treasury, yieldFee);
        uint256 refund = assetsOut - yieldFee;
        _pay(p.owner, refund);
        if (sharesOut > 0) IERC20(address(p.vault)).safeTransfer(p.owner, sharesOut);
        emit PlanClosed(id, p.owner, refund, yieldEarned, yieldFee, cancelled);
    }

    /// @dev Pays out, or if the transfer fails (e.g. a blocklisted recipient) keeps it for them to `claim`,
    /// so one recipient can't block the keeper's batch or anyone else's exit.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!usdc.trySafeTransfer(to, amount)) {
            owed[to] += amount;
            totalOwed += amount;
            emit PaymentDeferred(to, amount);
        }
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

    /// The plan's fee rate per buy: its base fee, plus its smart-buys premium while smart buys are on.
    function _bps(Plan storage p) internal view returns (uint16) {
        return p.smart ? p.feeBps + p.smartFeeBps : p.feeBps;
    }

    function _feeFor(uint256 spent, uint16 bps, uint64 floor) internal pure returns (uint256) {
        return Math.max(spent * bps / BPS, floor);
    }

    function _required(uint256 per, uint16 bps, uint64 floor, uint256 buys) internal pure returns (uint256) {
        return (per + _feeFor(per, bps, floor)) * buys;
    }

    function _value(Plan storage p) internal view returns (uint256 v) {
        (v,) = _valueOf(p);
    }

    /// @dev USDC the plan holds; `ok` is false if the vault couldn't be read (then only idle USDC is counted).
    function _valueOf(Plan storage p) internal view returns (uint256 v, bool ok) {
        v = p.idle;
        ok = true;
        if (p.shares > 0) {
            try p.vault.previewRedeem(p.shares) returns (uint256 a) {
                v += a;
            } catch {
                ok = false;
            }
        }
    }

    /// @dev Moves up to `amount` USDC out of the plan's budget into this contract's loose balance and returns
    /// how much it moved: all of it unless the plan holds less or its vault doesn't pay out. Idle USDC goes
    /// first. Vault shares are redeemed rounding in the plan's favour; any excess stays in the plan as idle.
    function _take(Plan storage p, uint256 amount) internal returns (uint256 got) {
        if (amount == 0) return 0;
        got = Math.min(amount, p.idle);
        p.idle -= got;
        if (got == amount || p.shares == 0) return got;
        uint256 need = amount - got;
        uint256 shares;
        try p.vault.previewWithdraw(need) returns (uint256 s) {
            shares = Math.min(s, p.shares);
        } catch {
            return got;
        }
        try p.vault.redeem(shares, address(this), address(this)) returns (uint256 out) {
            p.shares -= shares;
            if (out > need) {
                p.idle += out - need;
                out = need;
            }
            got += out;
        } catch {}
    }

    /// @dev Moves `amount` loose USDC into the plan's budget. `strict` (new money from the user): the vault
    /// must take it and mint shares worth what went in (within 0.01%), or the call reverts. Otherwise (USDC
    /// coming back from a run) a vault that won't take it leaves it idle in the plan.
    function _put(Plan storage p, uint256 amount, bool strict) internal {
        if (amount == 0) return;
        if (!p.savings) {
            p.idle += amount;
            return;
        }
        IERC4626 vault = p.vault;
        usdc.forceApprove(address(vault), amount);
        try vault.deposit(amount, address(this)) returns (uint256 minted) {
            p.shares += minted;
            if (strict && (minted == 0 || vault.previewRedeem(minted) + amount / 10_000 < amount)) {
                revert BadVaultDeposit();
            }
        } catch {
            if (strict) revert BadVaultDeposit();
            usdc.forceApprove(address(vault), 0);
            p.idle += amount;
        }
    }
}
