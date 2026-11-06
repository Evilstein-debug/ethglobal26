// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Arena} from "../src/Arena.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract ArenaTest is Test {
    Arena arena;
    MockUSDC usdc;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address funder = makeAddr("funder");

    // Bob owns trader Alpha; Alice owns predictor Beta.
    address bob = makeAddr("bob");
    address alpha = makeAddr("alpha");
    address bobPredictor = makeAddr("bobPredictor");
    address alice = makeAddr("alice");
    address beta = makeAddr("beta");
    address stranger = makeAddr("stranger");

    bytes32 constant BOB = keccak256("nullifier-bob");
    bytes32 constant ALICE = keccak256("nullifier-alice");
    bytes32 constant REQ = keccak256("0g-request");
    uint256 constant CAP = 5e6; // 5 USDC
    uint256 constant ROUND = 7;

    function setUp() public {
        usdc = new MockUSDC();
        arena = new Arena(usdc, admin, operator, CAP);
        vm.startPrank(operator);
        arena.registerOwner(bob, BOB);
        arena.registerAgent(alpha, BOB);
        arena.registerAgent(bobPredictor, BOB);
        arena.registerOwner(alice, ALICE);
        arena.registerAgent(beta, ALICE);
        vm.stopPrank();
    }

    function _open() internal returns (uint256 entryId) {
        vm.prank(operator);
        entryId = arena.openEntry(ROUND, alpha);
    }

    function _fund(uint256 amount) internal {
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(arena), amount);
        arena.fund(amount);
        vm.stopPrank();
    }

    function _one(bytes32 h, uint256 a)
        internal
        pure
        returns (bytes32[] memory hs, uint256[] memory as_)
    {
        hs = new bytes32[](1);
        as_ = new uint256[](1);
        hs[0] = h;
        as_[0] = a;
    }

    // ── Constructor and admin ────────────────────────────────────────────────────────────

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(MockUSDC(address(0)), admin, operator, CAP);
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(usdc, admin, address(0), CAP);
    }

    function test_admin_onlyOwnerCanChangeOperatorAndCap() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        arena.setOperator(stranger);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator)
        );
        arena.setEpochCap(1);

        vm.startPrank(admin);
        arena.setOperator(stranger);
        arena.setEpochCap(1e6);
        vm.stopPrank();
        assertEq(arena.operator(), stranger);
        assertEq(arena.epochCap(), 1e6);
    }

    // ── Registry ─────────────────────────────────────────────────────────────────────────

    function test_registry_onlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.registerOwner(stranger, keccak256("x"));
    }

    function test_registry_oneOwnerWalletPerHuman() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.HumanHasOwner.selector, BOB));
        arena.registerOwner(stranger, BOB);
    }

    function test_registry_noDoubleRegistration() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.AlreadyRegistered.selector, bob));
        arena.registerOwner(bob, keccak256("new-human"));
        vm.expectRevert(abi.encodeWithSelector(Arena.AlreadyRegistered.selector, alpha));
        arena.registerAgent(alpha, ALICE);
        vm.stopPrank();
    }

    function test_registry_agentNeedsKnownHuman() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.UnknownHuman.selector, keccak256("ghost")));
        arena.registerAgent(stranger, keccak256("ghost"));
    }

    function test_registry_rejectsZeroValues() public {
        vm.startPrank(operator);
        vm.expectRevert(Arena.ZeroHumanId.selector);
        arena.registerOwner(stranger, bytes32(0));
        vm.expectRevert(Arena.ZeroAddress.selector);
        arena.registerOwner(address(0), keccak256("x"));
        vm.expectRevert(Arena.ZeroHumanId.selector);
        arena.registerAgent(stranger, bytes32(0));
        vm.stopPrank();
    }

    function test_sameHuman_view() public {
        assertTrue(arena.sameHuman(alpha, bobPredictor));
        assertTrue(arena.sameHuman(bob, alpha));
        assertFalse(arena.sameHuman(alpha, beta));
        assertFalse(arena.sameHuman(stranger, makeAddr("other-stranger")));
    }

    // ── Rounds ───────────────────────────────────────────────────────────────────────────

    function test_openEntry_assignsSequentialIds() public {
        uint256 first = _open();
        vm.prank(operator);
        uint256 second = arena.openEntry(ROUND, beta);
        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(arena.entryOf(ROUND, alpha), 1);
        (uint64 roundId, address trader, Arena.Outcome outcome,) = arena.entries(first);
        assertEq(roundId, ROUND);
        assertEq(trader, alpha);
        assertEq(uint8(outcome), uint8(Arena.Outcome.Pending));
    }

    function test_openEntry_rules() public {
        vm.prank(stranger);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.openEntry(ROUND, alpha);

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.NotRegistered.selector, stranger));
        arena.openEntry(ROUND, stranger);
        arena.openEntry(ROUND, alpha);
        vm.expectRevert(abi.encodeWithSelector(Arena.EntryExists.selector, ROUND, alpha));
        arena.openEntry(ROUND, alpha);
        arena.lockPredictions(ROUND);
        vm.expectRevert(abi.encodeWithSelector(Arena.RoundIsLocked.selector, ROUND));
        arena.openEntry(ROUND, beta);
        vm.expectRevert(abi.encodeWithSelector(Arena.RoundIsLocked.selector, ROUND));
        arena.lockPredictions(ROUND);
        vm.stopPrank();
    }

    function test_openEntry_rejectsHugeRoundId() public {
        vm.prank(operator);
        vm.expectRevert(Arena.RoundIdTooLarge.selector);
        arena.openEntry(uint256(type(uint64).max) + 1, alpha);
    }

    function test_resolveEntry_rules() public {
        uint256 id = _open();
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.RoundNotLocked.selector, ROUND));
        arena.resolveEntry(id, Arena.Outcome.Yes, 120);
        arena.lockPredictions(ROUND);
        vm.expectRevert(Arena.InvalidOutcome.selector);
        arena.resolveEntry(id, Arena.Outcome.Pending, 0);
        vm.expectRevert(Arena.PnlOutOfRange.selector);
        arena.resolveEntry(id, Arena.Outcome.Yes, int256(type(int32).max) + 1);
        vm.expectRevert(abi.encodeWithSelector(Arena.UnknownEntry.selector, 99));
        arena.resolveEntry(99, Arena.Outcome.No, 0);

        vm.expectEmit(address(arena));
        emit Arena.EntryResolved(id, Arena.Outcome.No, -45);
        arena.resolveEntry(id, Arena.Outcome.No, -45);
        vm.expectRevert(abi.encodeWithSelector(Arena.EntryNotPending.selector, id));
        arena.resolveEntry(id, Arena.Outcome.Yes, 10);
        vm.stopPrank();

        (,, Arena.Outcome outcome, int32 pnl) = arena.entries(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.No));
        assertEq(pnl, -45);

        vm.prank(stranger);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.resolveEntry(id, Arena.Outcome.Void, 0);
    }

    // ── Predictions ──────────────────────────────────────────────────────────────────────

    function test_predict_recordsAndEmits() public {
        uint256 id = _open();
        vm.prank(beta);
        vm.expectEmit(address(arena));
        emit Arena.Predicted(id, beta, ALICE, true, 6200, REQ);
        arena.predict(id, true, 6200, REQ);
        (bool exists, bool yes, uint16 prob) = arena.predictions(id, beta);
        assertTrue(exists);
        assertTrue(yes);
        assertEq(prob, 6200);
    }

    function test_predict_ownersCanPickManually() public {
        uint256 id = _open();
        vm.prank(alice);
        arena.predict(id, false, 3000, bytes32(0));
        (bool exists,,) = arena.predictions(id, alice);
        assertTrue(exists);
    }

    /// The World trust moment, onchain: no predictions on your own human's trader.
    function test_predict_revertsForSameHuman() public {
        uint256 id = _open();
        vm.prank(bobPredictor);
        vm.expectRevert(Arena.SameHuman.selector);
        arena.predict(id, true, 9000, REQ);
        vm.prank(bob);
        vm.expectRevert(Arena.SameHuman.selector);
        arena.predict(id, false, 1000, bytes32(0));
        vm.prank(alpha); // the trader itself
        vm.expectRevert(Arena.SameHuman.selector);
        arena.predict(id, true, 9000, REQ);
    }

    function test_predict_revertsAfterLock() public {
        uint256 id = _open();
        vm.prank(operator);
        arena.lockPredictions(ROUND);
        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(Arena.RoundIsLocked.selector, ROUND));
        arena.predict(id, true, 6000, REQ);
    }

    function test_predict_revertsOnDuplicateUnregisteredOrUnknown() public {
        uint256 id = _open();
        vm.startPrank(beta);
        arena.predict(id, true, 6000, REQ);
        vm.expectRevert(abi.encodeWithSelector(Arena.AlreadyPredicted.selector, id, beta));
        arena.predict(id, false, 4000, REQ);
        vm.expectRevert(abi.encodeWithSelector(Arena.UnknownEntry.selector, 42));
        arena.predict(42, true, 6000, REQ);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Arena.NotRegistered.selector, stranger));
        arena.predict(id, true, 6000, REQ);
    }

    function test_predict_probabilityMustAgreeWithSide() public {
        uint256 id = _open();
        vm.startPrank(beta);
        vm.expectRevert(Arena.InvalidProbability.selector);
        arena.predict(id, true, 4999, REQ);
        vm.expectRevert(Arena.InvalidProbability.selector);
        arena.predict(id, false, 5001, REQ);
        vm.expectRevert(Arena.InvalidProbability.selector);
        arena.predict(id, true, 10_001, REQ);
        arena.predict(id, true, 5000, REQ); // 50/50 is allowed on either side
        vm.stopPrank();
    }

    function testFuzz_predict_probabilityRule(bool yes, uint16 prob) public {
        uint256 id = _open();
        bool valid = prob <= 10_000 && (yes ? prob >= 5000 : prob <= 5000);
        vm.prank(beta);
        if (!valid) vm.expectRevert(Arena.InvalidProbability.selector);
        arena.predict(id, yes, prob, REQ);
    }

    // ── Rewards ──────────────────────────────────────────────────────────────────────────

    function test_rewards_publishAndClaim() public {
        _fund(10e6);
        bytes32[] memory hs = new bytes32[](2);
        uint256[] memory amounts = new uint256[](2);
        (hs[0], hs[1], amounts[0], amounts[1]) = (BOB, ALICE, 3e6, 2e6);

        vm.prank(operator);
        arena.publishEpoch(1, hs, amounts);
        assertEq(arena.totalAllocated(), 5e6);
        assertEq(arena.availablePool(), 5e6);

        vm.prank(bob);
        vm.expectEmit(address(arena));
        emit Arena.Claimed(1, BOB, bob, 3e6);
        arena.claim(1);
        assertEq(usdc.balanceOf(bob), 3e6);
        assertEq(arena.totalAllocated(), 2e6);

        vm.prank(alice);
        arena.claim(1);
        assertEq(usdc.balanceOf(alice), 2e6);
        assertEq(arena.totalAllocated(), 0);
        assertEq(arena.poolBalance(), 5e6);
    }

    function test_rewards_onlyOwnerWalletClaimsOnce() public {
        _fund(5e6);
        (bytes32[] memory hs, uint256[] memory as_) = _one(BOB, 1e6);
        vm.prank(operator);
        arena.publishEpoch(1, hs, as_);

        vm.prank(alpha); // Bob's agent, not Bob
        vm.expectRevert(abi.encodeWithSelector(Arena.NotHumanOwner.selector, alpha));
        arena.claim(1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Arena.NotHumanOwner.selector, stranger));
        arena.claim(1);
        vm.prank(alice); // no award this epoch
        vm.expectRevert(Arena.NothingToClaim.selector);
        arena.claim(1);

        vm.startPrank(bob);
        arena.claim(1);
        vm.expectRevert(Arena.NothingToClaim.selector);
        arena.claim(1);
        vm.stopPrank();
    }

    function test_rewards_oneAwardPerHumanPerEpoch() public {
        _fund(5e6);
        bytes32[] memory hs = new bytes32[](2);
        uint256[] memory amounts = new uint256[](2);
        (hs[0], hs[1], amounts[0], amounts[1]) = (BOB, BOB, 1e6, 1e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.DuplicateAward.selector, BOB));
        arena.publishEpoch(1, hs, amounts);
    }

    function test_rewards_epochCapAndPoolLimits() public {
        _fund(4e6);
        (bytes32[] memory hs, uint256[] memory as_) = _one(BOB, CAP + 1);
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Arena.OverEpochCap.selector, CAP + 1, CAP));
        arena.publishEpoch(1, hs, as_);
        as_[0] = 4e6 + 1;
        vm.expectRevert(abi.encodeWithSelector(Arena.InsufficientPool.selector, 4e6 + 1, 4e6));
        arena.publishEpoch(1, hs, as_);
        as_[0] = 4e6;
        arena.publishEpoch(1, hs, as_);
        // Pool is fully allocated now: the next epoch can't award anything.
        (hs, as_) = _one(ALICE, 1);
        vm.expectRevert(abi.encodeWithSelector(Arena.InsufficientPool.selector, 1, 0));
        arena.publishEpoch(2, hs, as_);
        vm.stopPrank();
    }

    function test_rewards_publishValidation() public {
        _fund(5e6);
        vm.startPrank(operator);
        (bytes32[] memory hs, uint256[] memory as_) = _one(BOB, 1e6);
        arena.publishEpoch(1, hs, as_);
        vm.expectRevert(abi.encodeWithSelector(Arena.EpochAlreadyPublished.selector, 1));
        arena.publishEpoch(1, hs, as_);

        vm.expectRevert(Arena.LengthMismatch.selector);
        arena.publishEpoch(2, hs, new uint256[](2));
        (hs, as_) = _one(BOB, 0);
        vm.expectRevert(Arena.ZeroAmount.selector);
        arena.publishEpoch(2, hs, as_);
        (hs, as_) = _one(keccak256("ghost"), 1);
        vm.expectRevert(abi.encodeWithSelector(Arena.UnknownHuman.selector, keccak256("ghost")));
        arena.publishEpoch(2, hs, as_);
        vm.expectRevert(Arena.TooManyAwards.selector);
        arena.publishEpoch(2, new bytes32[](21), new uint256[](21));
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(Arena.NotOperator.selector);
        arena.publishEpoch(3, hs, as_);
    }

    function test_rewards_withdrawOnlyUnallocated() public {
        _fund(5e6);
        (bytes32[] memory hs, uint256[] memory as_) = _one(BOB, 3e6);
        vm.prank(operator);
        arena.publishEpoch(1, hs, as_);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Arena.InsufficientPool.selector, 2e6 + 1, 2e6));
        arena.withdrawUnallocated(admin, 2e6 + 1);
        arena.withdrawUnallocated(admin, 2e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(admin), 2e6);
        // Bob's award is still fully covered.
        vm.prank(bob);
        arena.claim(1);
        assertEq(usdc.balanceOf(bob), 3e6);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator)
        );
        arena.withdrawUnallocated(operator, 0);
    }

    function test_fund_rejectsZero() public {
        vm.expectRevert(Arena.ZeroAmount.selector);
        arena.fund(0);
    }

    /// End-to-end: one round from entry to scored predictions and a claimed reward.
    function test_fullRound() public {
        _fund(5e6);
        uint256 id = _open();
        vm.prank(beta);
        arena.predict(id, true, 6200, REQ);
        vm.startPrank(operator);
        arena.lockPredictions(ROUND);
        arena.resolveEntry(id, Arena.Outcome.Yes, 85);
        (bytes32[] memory hs, uint256[] memory as_) = _one(ALICE, 1e6);
        arena.publishEpoch(1, hs, as_);
        vm.stopPrank();
        vm.prank(alice);
        assertEq(arena.claim(1), 1e6);
    }
}
