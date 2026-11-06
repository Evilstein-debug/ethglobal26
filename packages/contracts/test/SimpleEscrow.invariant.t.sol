// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SimpleEscrow} from "../src/SimpleEscrow.sol";

/// @dev The fuzzer calls these functions in random order with random inputs.
contract EscrowHandler is Test {
    SimpleEscrow public immutable escrow;
    address[] public actors;
    uint256[] public openIds;

    constructor(SimpleEscrow escrow_) {
        escrow = escrow_;
        for (uint256 i; i < 3; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    function create(uint256 actorSeed, uint128 amount, uint64 ttl) external {
        address payer = actors[actorSeed % actors.length];
        address payee = actors[(actorSeed + 1) % actors.length];
        amount = uint128(bound(amount, 1, 1_000 ether));
        ttl = uint64(bound(ttl, 1, 30 days));

        vm.deal(payer, payer.balance + amount);
        vm.prank(payer);
        openIds.push(escrow.create{value: amount}(payee, uint64(block.timestamp) + ttl));
    }

    function release(uint256 idSeed) external {
        if (openIds.length == 0) return;
        uint256 id = _popOpen(idSeed);
        (address payer,,,,) = escrow.deals(id);
        vm.prank(payer);
        escrow.release(id);
    }

    function refund(uint256 idSeed) external {
        if (openIds.length == 0) return;
        uint256 id = _popOpen(idSeed);
        (address payer,,, uint64 deadline,) = escrow.deals(id);
        if (block.timestamp < deadline) vm.warp(deadline);
        vm.prank(payer);
        escrow.refund(id);
    }

    function _popOpen(uint256 seed) private returns (uint256 id) {
        uint256 i = seed % openIds.length;
        id = openIds[i];
        openIds[i] = openIds[openIds.length - 1];
        openIds.pop();
    }
}

contract SimpleEscrowInvariantTest is Test {
    SimpleEscrow escrow;
    EscrowHandler handler;

    function setUp() public {
        escrow = new SimpleEscrow();
        handler = new EscrowHandler(escrow);
        targetContract(address(handler));
    }

    /// @notice The escrow always holds exactly the ETH it has accounted for.
    function invariant_balanceMatchesTotalLocked() public view {
        assertEq(address(escrow).balance, escrow.totalLocked());
    }
}
