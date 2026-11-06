// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract MockUSDCTest is Test {
    function test_hasUsdcDecimalsAndMints() public {
        MockUSDC usdc = new MockUSDC();
        address alice = makeAddr("alice");
        usdc.mint(alice, 5e6);
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.balanceOf(alice), 5e6);
    }
}
