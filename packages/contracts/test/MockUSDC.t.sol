// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";

contract MockUSDCTest is Test {
    function test_hasUsdcDecimalsAndMints() public {
        MockUSDC usdc = new MockUSDC();
        address alice = makeAddr("alice");
        usdc.mint(alice, 5e6);
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.balanceOf(alice), 5e6);
    }

    function test_mockWethHas18DecimalsAndMints() public {
        MockWETH weth = new MockWETH();
        weth.mint(address(this), 1 ether);
        assertEq(weth.decimals(), 18);
        assertEq(weth.balanceOf(address(this)), 1 ether);
    }
}
