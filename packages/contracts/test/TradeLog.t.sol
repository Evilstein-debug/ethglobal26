// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TradeLog} from "../src/TradeLog.sol";

contract TradeLogTest is Test {
    TradeLog tradeLog;
    address agent = makeAddr("agent");
    address other = makeAddr("other");
    bytes32 constant INTENT = keccak256("intent");
    bytes32 constant REQ = keccak256("0g-request");
    bytes32 constant FILL = keccak256("fill-tx");

    function setUp() public {
        tradeLog = new TradeLog();
    }

    function _commit() internal {
        vm.prank(agent);
        tradeLog.commit(7, INTENT, REQ);
    }

    function test_commit_storesAndEmits() public {
        vm.roll(100);
        vm.expectEmit(address(tradeLog));
        emit TradeLog.IntentCommitted(7, agent, INTENT, REQ);
        _commit();
        (address a, uint64 roundId, uint64 blockNo, TradeLog.Status status) =
            tradeLog.intents(INTENT);
        assertEq(a, agent);
        assertEq(roundId, 7);
        assertEq(blockNo, 100);
        assertEq(uint8(status), uint8(TradeLog.Status.Committed));
    }

    function test_commit_rejectsZeroHashesAndDuplicates() public {
        vm.startPrank(agent);
        vm.expectRevert(TradeLog.ZeroHash.selector);
        tradeLog.commit(1, bytes32(0), REQ);
        vm.expectRevert(TradeLog.ZeroHash.selector);
        tradeLog.commit(1, INTENT, bytes32(0));
        tradeLog.commit(1, INTENT, REQ);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.AlreadyCommitted.selector, INTENT));
        tradeLog.commit(1, INTENT, REQ);
        vm.stopPrank();
        // another agent cannot claim the same hash either
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.AlreadyCommitted.selector, INTENT));
        tradeLog.commit(1, INTENT, REQ);
    }

    function test_recordExecution_onlyAfterCommit_onlyByAgent_once() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.UnknownIntent.selector, INTENT));
        tradeLog.recordExecution(INTENT, FILL);

        _commit();
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.NotIntentAgent.selector, INTENT, other));
        tradeLog.recordExecution(INTENT, FILL);

        vm.prank(agent);
        vm.expectEmit(address(tradeLog));
        emit TradeLog.IntentExecuted(INTENT, agent, FILL);
        tradeLog.recordExecution(INTENT, FILL);

        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.AlreadyClosed.selector, INTENT));
        tradeLog.recordExecution(INTENT, FILL);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.AlreadyClosed.selector, INTENT));
        tradeLog.recordFailure(INTENT, 1);
        vm.stopPrank();
    }

    function test_recordFailure_closesIntent() public {
        _commit();
        vm.prank(agent);
        vm.expectEmit(address(tradeLog));
        emit TradeLog.IntentFailed(INTENT, agent, 3);
        tradeLog.recordFailure(INTENT, 3);
        (,,, TradeLog.Status status) = tradeLog.intents(INTENT);
        assertEq(uint8(status), uint8(TradeLog.Status.Failed));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TradeLog.AlreadyClosed.selector, INTENT));
        tradeLog.recordExecution(INTENT, FILL);
    }

    function test_recordExecution_rejectsZeroFill() public {
        _commit();
        vm.prank(agent);
        vm.expectRevert(TradeLog.ZeroHash.selector);
        tradeLog.recordExecution(INTENT, bytes32(0));
    }

    function test_commit_rejectsHugeRoundId() public {
        vm.prank(agent);
        vm.expectRevert(TradeLog.RoundIdTooLarge.selector);
        tradeLog.commit(uint256(type(uint64).max) + 1, INTENT, REQ);
    }
}
