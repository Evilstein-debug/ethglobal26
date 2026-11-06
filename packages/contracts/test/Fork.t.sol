// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SimpleEscrow} from "../src/SimpleEscrow.sol";

/// @notice Fork-test example. Skipped unless FORK_RPC_URL is set, e.g.
///         FORK_RPC_URL=$SEPOLIA_RPC_URL forge test --match-contract ForkTest -vv
contract ForkTest is Test {
    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
    }

    function test_fork_deployAndUseEscrow() public {
        vm.skip(bytes(vm.envOr("FORK_RPC_URL", string(""))).length == 0);

        assertGt(block.number, 0, "fork should start at a live block");
        SimpleEscrow escrow = new SimpleEscrow();
        address payee = makeAddr("payee");
        uint256 before = payee.balance;

        vm.deal(address(this), 1 ether);
        uint256 id = escrow.create{value: 1 ether}(payee, uint64(block.timestamp + 1 hours));
        escrow.release(id);
        assertEq(payee.balance, before + 1 ether);
    }
}
