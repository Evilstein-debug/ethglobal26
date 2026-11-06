// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Arena
/// @notice AgentArena's onchain rules:
///         1. Registry: every owner wallet and agent wallet maps to a World ID human
///            (humanId = keccak256(nullifier_hash)). One owner wallet per human.
///         2. Markets: every filled trade gets its own roundId and one entry. The operator locks
///            predictions no later than the trade's exit and resolves it YES / NO / VOID from
///            Flash fills.
///         3. Predictions (free, no money staked): registered agents or owners call whether an
///            entry ends in profit. Nobody may predict on an entry whose trader is the same human.
///         4. Rewards: a USDC pool. Per epoch the operator publishes awards (capped, at most one per
///            human); each human's owner wallet claims.
/// @dev    Trust assumption: the operator resolves entries and publishes awards from public data
///         (Flash fills, prediction scores); anyone can re-check with scripts/verify.ts.
contract Arena is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Outcome {
        Pending,
        Yes,
        No,
        Void
    }

    struct Entry {
        uint64 roundId;
        address trader;
        Outcome outcome;
        int32 pnlBps;
    }

    struct PredictionRecord {
        bool exists;
        bool yes;
        uint16 probYesBps;
    }

    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_AWARDS_PER_EPOCH = 20;

    IERC20 public immutable usdc;
    address public operator;
    /// @notice Max total USDC (base units) one epoch can award.
    uint256 public epochCap;

    // ── Registry ──────────────────────────────────────────────────────────────────────────
    mapping(address account => bytes32 humanId) public humanOf;
    mapping(bytes32 humanId => address owner) public ownerOfHuman;

    // ── Rounds and predictions ────────────────────────────────────────────────────────────
    uint256 public entryCount; // entry ids start at 1
    mapping(uint256 entryId => Entry) public entries;
    mapping(uint256 roundId => mapping(address trader => uint256 entryId)) public entryOf;
    mapping(uint256 roundId => bool) public roundLocked;
    mapping(uint256 entryId => mapping(address predictor => PredictionRecord)) public predictions;

    // ── Rewards ───────────────────────────────────────────────────────────────────────────
    /// @notice Awarded but not yet claimed. The pool always holds at least this much.
    uint256 public totalAllocated;
    mapping(uint256 epoch => bool) public epochPublished;
    mapping(uint256 epoch => mapping(bytes32 humanId => uint256 amount)) public awardOf;
    mapping(uint256 epoch => mapping(bytes32 humanId => bool)) public claimed;

    event OperatorChanged(address indexed operator);
    event EpochCapChanged(uint256 epochCap);
    event OwnerRegistered(address indexed owner, bytes32 indexed humanId);
    event AgentRegistered(address indexed agent, bytes32 indexed humanId);
    event EntryOpened(uint256 indexed entryId, uint256 indexed roundId, address indexed trader);
    event PredictionsLocked(uint256 indexed roundId);
    event EntryResolved(uint256 indexed entryId, Outcome outcome, int256 pnlBps);
    event Predicted(
        uint256 indexed entryId,
        address indexed predictor,
        bytes32 indexed humanId,
        bool yes,
        uint16 probYesBps,
        bytes32 zeroGRequestIdHash
    );
    event PoolFunded(address indexed from, uint256 amount);
    event EpochPublished(uint256 indexed epoch, uint256 total, uint256 awards);
    event Awarded(uint256 indexed epoch, bytes32 indexed humanId, uint256 amount);
    event Claimed(
        uint256 indexed epoch, bytes32 indexed humanId, address indexed to, uint256 amount
    );
    event Withdrawn(address indexed to, uint256 amount);

    error NotOperator();
    error ZeroAddress();
    error ZeroHumanId();
    error AlreadyRegistered(address account);
    error HumanHasOwner(bytes32 humanId);
    error UnknownHuman(bytes32 humanId);
    error NotRegistered(address account);
    error RoundIsLocked(uint256 roundId);
    error RoundNotLocked(uint256 roundId);
    error EntryExists(uint256 roundId, address trader);
    error UnknownEntry(uint256 entryId);
    error EntryNotPending(uint256 entryId);
    error InvalidOutcome();
    error PnlOutOfRange();
    error RoundIdTooLarge();
    error SameHuman();
    error AlreadyPredicted(uint256 entryId, address predictor);
    error InvalidProbability();
    error EpochAlreadyPublished(uint256 epoch);
    error LengthMismatch();
    error TooManyAwards();
    error ZeroAmount();
    error DuplicateAward(bytes32 humanId);
    error OverEpochCap(uint256 total, uint256 cap);
    error InsufficientPool(uint256 needed, uint256 available);
    error NothingToClaim();
    error NotHumanOwner(address caller);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 usdc_, address owner_, address operator_, uint256 epochCap_)
        Ownable(owner_)
    {
        if (address(usdc_) == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        operator = operator_;
        epochCap = epochCap_;
        emit OperatorChanged(operator_);
        emit EpochCapChanged(epochCap_);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────────────────

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setEpochCap(uint256 epochCap_) external onlyOwner {
        epochCap = epochCap_;
        emit EpochCapChanged(epochCap_);
    }

    /// @notice Withdraw pool funds that are not owed to anyone.
    function withdrawUnallocated(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = availablePool();
        if (amount > available) revert InsufficientPool(amount, available);
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ── Registry ──────────────────────────────────────────────────────────────────────────

    /// @notice Link a World-verified human to their owner wallet. One owner wallet per human.
    function registerOwner(address owner_, bytes32 humanId) external onlyOperator {
        if (owner_ == address(0)) revert ZeroAddress();
        if (humanId == bytes32(0)) revert ZeroHumanId();
        if (humanOf[owner_] != bytes32(0)) revert AlreadyRegistered(owner_);
        if (ownerOfHuman[humanId] != address(0)) revert HumanHasOwner(humanId);
        humanOf[owner_] = humanId;
        ownerOfHuman[humanId] = owner_;
        emit OwnerRegistered(owner_, humanId);
    }

    /// @notice Link an agent wallet to its owner's human. The human must have an owner first.
    function registerAgent(address agent, bytes32 humanId) external onlyOperator {
        if (agent == address(0)) revert ZeroAddress();
        if (humanId == bytes32(0)) revert ZeroHumanId();
        if (ownerOfHuman[humanId] == address(0)) revert UnknownHuman(humanId);
        if (humanOf[agent] != bytes32(0)) revert AlreadyRegistered(agent);
        humanOf[agent] = humanId;
        emit AgentRegistered(agent, humanId);
    }

    // ── Rounds ────────────────────────────────────────────────────────────────────────────

    function openEntry(uint256 roundId, address trader)
        external
        onlyOperator
        returns (uint256 entryId)
    {
        if (roundId > type(uint64).max) revert RoundIdTooLarge();
        if (humanOf[trader] == bytes32(0)) revert NotRegistered(trader);
        if (roundLocked[roundId]) revert RoundIsLocked(roundId);
        if (entryOf[roundId][trader] != 0) revert EntryExists(roundId, trader);
        entryId = ++entryCount;
        entries[entryId] =
            Entry({roundId: uint64(roundId), trader: trader, outcome: Outcome.Pending, pnlBps: 0});
        entryOf[roundId][trader] = entryId;
        emit EntryOpened(entryId, roundId, trader);
    }

    /// @notice Close predictions for a round. Called before any trading starts.
    function lockPredictions(uint256 roundId) external onlyOperator {
        if (roundLocked[roundId]) revert RoundIsLocked(roundId);
        roundLocked[roundId] = true;
        emit PredictionsLocked(roundId);
    }

    /// @param pnlBps realized PnL in basis points, emitted for transparency.
    function resolveEntry(uint256 entryId, Outcome outcome, int256 pnlBps) external onlyOperator {
        Entry storage entry = _entry(entryId);
        if (!roundLocked[entry.roundId]) revert RoundNotLocked(entry.roundId);
        if (entry.outcome != Outcome.Pending) revert EntryNotPending(entryId);
        if (outcome == Outcome.Pending) revert InvalidOutcome();
        if (pnlBps > type(int32).max || pnlBps < type(int32).min) revert PnlOutOfRange();
        entry.outcome = outcome;
        entry.pnlBps = int32(pnlBps);
        emit EntryResolved(entryId, outcome, pnlBps);
    }

    // ── Predictions ───────────────────────────────────────────────────────────────────────

    /// @notice A free prediction: will this entry's trader end the round in profit?
    /// @param probYesBps the predictor's probability of YES; must agree with `yes`.
    /// @param zeroGRequestIdHash keccak256 of the 0G request ID (zero for an owner's manual pick).
    function predict(uint256 entryId, bool yes, uint16 probYesBps, bytes32 zeroGRequestIdHash)
        external
    {
        Entry storage entry = _entry(entryId);
        bytes32 humanId = humanOf[msg.sender];
        if (humanId == bytes32(0)) revert NotRegistered(msg.sender);
        if (roundLocked[entry.roundId]) revert RoundIsLocked(entry.roundId);
        if (entry.outcome != Outcome.Pending) revert EntryNotPending(entryId);
        if (humanId == humanOf[entry.trader]) revert SameHuman();
        if (probYesBps > BPS || (yes ? probYesBps < BPS / 2 : probYesBps > BPS / 2)) {
            revert InvalidProbability();
        }
        PredictionRecord storage record = predictions[entryId][msg.sender];
        if (record.exists) revert AlreadyPredicted(entryId, msg.sender);
        record.exists = true;
        record.yes = yes;
        record.probYesBps = probYesBps;
        emit Predicted(entryId, msg.sender, humanId, yes, probYesBps, zeroGRequestIdHash);
    }

    // ── Rewards ───────────────────────────────────────────────────────────────────────────

    /// @notice Add USDC to the reward pool (requires prior approval).
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(msg.sender, amount);
    }

    /// @notice Publish an epoch's awards: at most one per human, total within the cap and the
    ///         unallocated pool. Each award goes to the human's registered owner wallet on claim.
    function publishEpoch(uint256 epoch, bytes32[] calldata humanIds, uint256[] calldata amounts)
        external
        onlyOperator
    {
        if (epochPublished[epoch]) revert EpochAlreadyPublished(epoch);
        if (humanIds.length != amounts.length) revert LengthMismatch();
        if (humanIds.length > MAX_AWARDS_PER_EPOCH) revert TooManyAwards();

        uint256 total;
        for (uint256 i; i < humanIds.length; ++i) {
            bytes32 humanId = humanIds[i];
            uint256 amount = amounts[i];
            if (amount == 0) revert ZeroAmount();
            if (ownerOfHuman[humanId] == address(0)) revert UnknownHuman(humanId);
            if (awardOf[epoch][humanId] != 0) revert DuplicateAward(humanId);
            awardOf[epoch][humanId] = amount;
            total += amount;
            emit Awarded(epoch, humanId, amount);
        }
        if (total > epochCap) revert OverEpochCap(total, epochCap);
        uint256 available = availablePool();
        if (total > available) revert InsufficientPool(total, available);

        epochPublished[epoch] = true;
        totalAllocated += total;
        emit EpochPublished(epoch, total, humanIds.length);
    }

    /// @notice Claim the caller's award for an epoch. Only the human's owner wallet can claim.
    function claim(uint256 epoch) external nonReentrant returns (uint256 amount) {
        bytes32 humanId = humanOf[msg.sender];
        if (humanId == bytes32(0) || ownerOfHuman[humanId] != msg.sender) {
            revert NotHumanOwner(msg.sender);
        }
        amount = awardOf[epoch][humanId];
        if (amount == 0 || claimed[epoch][humanId]) revert NothingToClaim();
        claimed[epoch][humanId] = true;
        totalAllocated -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Claimed(epoch, humanId, msg.sender, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────────────────

    function poolBalance() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Pool funds not yet awarded to anyone.
    function availablePool() public view returns (uint256) {
        uint256 balance = poolBalance();
        return balance > totalAllocated ? balance - totalAllocated : 0;
    }

    function sameHuman(address a, address b) external view returns (bool) {
        bytes32 h = humanOf[a];
        return h != bytes32(0) && h == humanOf[b];
    }

    function _entry(uint256 entryId) private view returns (Entry storage entry) {
        entry = entries[entryId];
        if (entry.trader == address(0)) revert UnknownEntry(entryId);
    }
}
