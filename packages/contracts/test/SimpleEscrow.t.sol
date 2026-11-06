// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SimpleEscrow} from "../src/SimpleEscrow.sol";

contract SimpleEscrowTest is Test {
    SimpleEscrow escrow;

    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    uint256 constant AMOUNT = 1 ether;

    function setUp() public {
        escrow = new SimpleEscrow();
        vm.deal(payer, 100 ether);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.create{value: AMOUNT}(payee, uint64(block.timestamp + 1 days));
    }

    function test_create_locksEthAndEmits() public {
        vm.expectEmit(address(escrow));
        emit SimpleEscrow.DealCreated(0, payer, payee, AMOUNT, uint64(block.timestamp + 1 days));
        uint256 id = _create();

        assertEq(id, 0);
        assertEq(escrow.nextId(), 1);
        assertEq(escrow.totalLocked(), AMOUNT);
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_create_revertsOnBadInput() public {
        vm.startPrank(payer);
        vm.expectRevert(SimpleEscrow.InvalidPayee.selector);
        escrow.create{value: AMOUNT}(address(0), uint64(block.timestamp + 1));
        vm.expectRevert(SimpleEscrow.InvalidPayee.selector);
        escrow.create{value: AMOUNT}(payer, uint64(block.timestamp + 1));
        vm.expectRevert(SimpleEscrow.InvalidAmount.selector);
        escrow.create(payee, uint64(block.timestamp + 1));
        vm.expectRevert(SimpleEscrow.InvalidDeadline.selector);
        escrow.create{value: AMOUNT}(payee, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_release_paysPayee() public {
        uint256 id = _create();
        vm.expectEmit(address(escrow));
        emit SimpleEscrow.DealReleased(id, payee, AMOUNT);
        vm.prank(payer);
        escrow.release(id);

        assertEq(payee.balance, AMOUNT);
        assertEq(escrow.totalLocked(), 0);
    }

    function test_release_onlyPayer() public {
        uint256 id = _create();
        vm.prank(payee);
        vm.expectRevert(SimpleEscrow.NotPayer.selector);
        escrow.release(id);
    }

    function test_release_cannotRunTwice() public {
        uint256 id = _create();
        vm.startPrank(payer);
        escrow.release(id);
        vm.expectRevert(SimpleEscrow.NotOpen.selector);
        escrow.release(id);
        vm.stopPrank();
    }

    function test_refund_onlyAfterDeadline() public {
        uint256 id = _create();
        vm.startPrank(payer);
        vm.expectRevert(SimpleEscrow.DeadlineNotReached.selector);
        escrow.refund(id);

        vm.warp(block.timestamp + 1 days);
        uint256 before = payer.balance;
        escrow.refund(id);
        vm.stopPrank();

        assertEq(payer.balance, before + AMOUNT);
        assertEq(escrow.totalLocked(), 0);
    }

    function testFuzz_create_release(uint128 amount, uint64 ttl) public {
        amount = uint128(bound(amount, 1, 100 ether));
        ttl = uint64(bound(ttl, 1, 365 days));

        vm.prank(payer);
        uint256 id = escrow.create{value: amount}(payee, uint64(block.timestamp) + ttl);
        assertEq(escrow.totalLocked(), amount);

        vm.prank(payer);
        escrow.release(id);
        assertEq(payee.balance, amount);
        assertEq(address(escrow).balance, 0);
    }
}
