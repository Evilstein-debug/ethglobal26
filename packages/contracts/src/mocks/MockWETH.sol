// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL TEST ONLY. An 18-decimal stand-in for Base WETH on anvil, with open minting, so
///         the bracket exit's WETH approval runs against a real token contract. Deploy.s.sol only
///         deploys it on chain 31337; on Base the app uses the WETH9 predeploy (see VERIFIED.md).
contract MockWETH is ERC20 {
    constructor() ERC20("Mock WETH (local test only)", "mWETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
