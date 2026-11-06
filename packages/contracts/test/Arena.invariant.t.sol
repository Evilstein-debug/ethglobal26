// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Arena} from "../src/Arena.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Drives random fund / publish / claim / withdraw sequences and tracks what is owed.
contract RewardsHandler is Test {
    Arena public arena;
    MockUSDC public usdc;
    address public admin;
    address public operator;
    address[2] public owners;
    bytes32[2] public humans;

    uint256 public nextEpoch = 1;
    uint256 public ghostUnclaimed;
    uint256 public ghostClaimed;
    uint256[] public epochs;

    constructor(
        Arena arena_,
        MockUSDC usdc_,
        address admin_,
        address operator_,
        address[2] memory owners_,
        bytes32[2] memory humans_
    ) {
        (arena, usdc, admin, operator, owners, humans) =
        (arena_, usdc_, admin_, operator_, owners_, humans_);
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 20e6);
        usdc.mint(address(this), amount);
        usdc.approve(address(arena), amount);
        arena.fund(amount);
    }

    function publish(uint256 a0, uint256 a1, bool both) external {
        uint256 available = arena.availablePool();
        uint256 limit = available < arena.epochCap() ? available : arena.epochCap();
        if (limit < 2) return;
        uint256 n = both ? 2 : 1;
        bytes32[] memory hs = new bytes32[](n);
        uint256[] memory as_ = new uint256[](n);
        hs[0] = humans[0];
        as_[0] = bound(a0, 1, both ? limit - 1 : limit);
        if (both) {
            hs[1] = humans[1];
            as_[1] = bound(a1, 1, limit - as_[0]);
        }
        uint256 epoch = nextEpoch++;
        vm.prank(operator);
        arena.publishEpoch(epoch, hs, as_);
        epochs.push(epoch);
        ghostUnclaimed += as_[0] + (both ? as_[1] : 0);
    }

    function claim(uint256 epochSeed, bool second) external {
        if (epochs.length == 0) return;
        uint256 epoch = epochs[bound(epochSeed, 0, epochs.length - 1)];
        uint256 i = second ? 1 : 0;
        uint256 amount = arena.awardOf(epoch, humans[i]);
        if (amount == 0 || arena.claimed(epoch, humans[i])) return;
        vm.prank(owners[i]);
        arena.claim(epoch);
        ghostUnclaimed -= amount;
        ghostClaimed += amount;
    }

    function withdraw(uint256 amount) external {
        uint256 available = arena.availablePool();
        if (available == 0) return;
        vm.prank(admin);
        arena.withdrawUnallocated(admin, bound(amount, 1, available));
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }
}

contract ArenaInvariantTest is Test {
    Arena arena;
    MockUSDC usdc;
    RewardsHandler handler;

    function setUp() public {
        address admin = makeAddr("admin");
        address operator = makeAddr("operator");
        address[2] memory owners = [makeAddr("bob"), makeAddr("alice")];
        bytes32[2] memory humans = [keccak256("bob"), keccak256("alice")];
        usdc = new MockUSDC();
        arena = new Arena(usdc, admin, operator, 5e6);
        vm.startPrank(operator);
        arena.registerOwner(owners[0], humans[0]);
        arena.registerOwner(owners[1], humans[1]);
        vm.stopPrank();
        handler = new RewardsHandler(arena, usdc, admin, operator, owners, humans);
        targetContract(address(handler));
    }

    /// The pool can always pay every published, unclaimed award.
    function invariant_poolCoversAllocated() public view {
        assertGe(usdc.balanceOf(address(arena)), arena.totalAllocated());
    }

    /// totalAllocated tracks exactly what is awarded and not yet claimed.
    function invariant_allocatedMatchesUnclaimed() public view {
        assertEq(arena.totalAllocated(), handler.ghostUnclaimed());
    }
}
