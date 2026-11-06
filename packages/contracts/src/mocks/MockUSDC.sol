// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL TEST ONLY. A 6-decimal stand-in for Base USDC on anvil, with open minting.
///         Never deployed to a real chain: Deploy.s.sol only deploys it on chain 31337, and on
///         Base the app uses Circle's USDC (see VERIFIED.md).
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC (local test only)", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
