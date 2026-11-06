// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SimpleEscrow
/// @notice Example contract: a payer locks ETH for a payee. The payer can release it to the
///         payee at any time, or refund it to themselves after the deadline.
/// @dev    Replace or delete this; it exists to exercise the stack end to end.
contract SimpleEscrow is ReentrancyGuard {
    enum Status {
        None,
        Open,
        Released,
        Refunded
    }

    struct Deal {
        address payer;
        address payee;
        uint128 amount;
        uint64 deadline;
        Status status;
    }

    uint256 public nextId;
    uint256 public totalLocked;
    mapping(uint256 id => Deal) public deals;

    event DealCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        uint64 deadline
    );
    event DealReleased(uint256 indexed id, address indexed payee, uint256 amount);
    event DealRefunded(uint256 indexed id, address indexed payer, uint256 amount);

    error InvalidPayee();
    error InvalidAmount();
    error InvalidDeadline();
    error NotPayer();
    error NotOpen();
    error DeadlineNotReached();
    error TransferFailed();

    /// @notice Lock the sent ETH for `payee` until `deadline`.
    function create(address payee, uint64 deadline) external payable returns (uint256 id) {
        if (payee == address(0) || payee == msg.sender) revert InvalidPayee();
        if (msg.value == 0 || msg.value > type(uint128).max) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        id = nextId++;
        deals[id] = Deal(msg.sender, payee, uint128(msg.value), deadline, Status.Open);
        totalLocked += msg.value;
        emit DealCreated(id, msg.sender, payee, msg.value, deadline);
    }

    /// @notice Payer releases the locked ETH to the payee.
    function release(uint256 id) external nonReentrant {
        Deal storage deal = _openDealOf(id);
        deal.status = Status.Released;
        totalLocked -= deal.amount;

        _send(deal.payee, deal.amount);
        emit DealReleased(id, deal.payee, deal.amount);
    }

    /// @notice Payer reclaims the ETH once the deadline has passed.
    function refund(uint256 id) external nonReentrant {
        Deal storage deal = _openDealOf(id);
        if (block.timestamp < deal.deadline) revert DeadlineNotReached();
        deal.status = Status.Refunded;
        totalLocked -= deal.amount;

        _send(deal.payer, deal.amount);
        emit DealRefunded(id, deal.payer, deal.amount);
    }

    function _openDealOf(uint256 id) private view returns (Deal storage deal) {
        deal = deals[id];
        if (deal.status != Status.Open) revert NotOpen();
        if (deal.payer != msg.sender) revert NotPayer();
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
