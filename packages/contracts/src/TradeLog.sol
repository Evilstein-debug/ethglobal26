// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TradeLog
/// @notice Commit-before-trade log. An agent commits the hash of a trade intent (canonical JSON,
///         see packages/shared/src/canonical.ts) BEFORE sending the order to Definitive Flash,
///         then records how it ended. Every commit must end in exactly one of Executed or Failed,
///         so an agent cannot hide a losing trade, and block order proves commit came first.
/// @dev    Permissionless: the resolver only counts commits from known agent wallets.
contract TradeLog {
    enum Status {
        None,
        Committed,
        Executed,
        Failed
    }

    struct Intent {
        address agent;
        uint64 roundId;
        uint64 committedBlock;
        Status status;
    }

    mapping(bytes32 intentHash => Intent) public intents;

    event IntentCommitted(
        uint256 indexed roundId,
        address indexed agent,
        bytes32 indexed intentHash,
        bytes32 zeroGRequestIdHash
    );
    event IntentExecuted(bytes32 indexed intentHash, address indexed agent, bytes32 fillTxHash);
    event IntentFailed(bytes32 indexed intentHash, address indexed agent, uint8 reason);

    error ZeroHash();
    error AlreadyCommitted(bytes32 intentHash);
    error UnknownIntent(bytes32 intentHash);
    error NotIntentAgent(bytes32 intentHash, address caller);
    error AlreadyClosed(bytes32 intentHash);
    error RoundIdTooLarge();

    /// @param zeroGRequestIdHash keccak256 of the 0G request ID behind this decision.
    function commit(uint256 roundId, bytes32 intentHash, bytes32 zeroGRequestIdHash) external {
        if (intentHash == bytes32(0) || zeroGRequestIdHash == bytes32(0)) revert ZeroHash();
        if (roundId > type(uint64).max) revert RoundIdTooLarge();
        if (intents[intentHash].status != Status.None) revert AlreadyCommitted(intentHash);
        intents[intentHash] = Intent({
            agent: msg.sender,
            roundId: uint64(roundId),
            committedBlock: uint64(block.number),
            status: Status.Committed
        });
        emit IntentCommitted(roundId, msg.sender, intentHash, zeroGRequestIdHash);
    }

    /// @param fillTxHash the Base transaction hash of the Flash entry fill.
    function recordExecution(bytes32 intentHash, bytes32 fillTxHash) external {
        if (fillTxHash == bytes32(0)) revert ZeroHash();
        _close(intentHash, Status.Executed);
        emit IntentExecuted(intentHash, msg.sender, fillTxHash);
    }

    /// @param reason app-defined failure code (quote/approve/sign/submit/rejected/expired...).
    function recordFailure(bytes32 intentHash, uint8 reason) external {
        _close(intentHash, Status.Failed);
        emit IntentFailed(intentHash, msg.sender, reason);
    }

    function _close(bytes32 intentHash, Status to) private {
        Intent storage intent = intents[intentHash];
        if (intent.status == Status.None) revert UnknownIntent(intentHash);
        if (intent.agent != msg.sender) revert NotIntentAgent(intentHash, msg.sender);
        if (intent.status != Status.Committed) revert AlreadyClosed(intentHash);
        intent.status = to;
    }
}
