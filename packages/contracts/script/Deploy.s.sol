// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Arena} from "../src/Arena.sol";
import {TradeLog} from "../src/TradeLog.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Deploys TradeLog + Arena and writes their addresses to
///         packages/shared/deployments/<chainId>.json (read by `pnpm codegen`).
/// @dev    The signer comes from the CLI (`--private-key` or `--account`), never from code.
///         Env (all optional on anvil):
///           USDC_ADDRESS     required off anvil; Circle's USDC (see VERIFIED.md)
///           ARENA_OWNER      admin (Ownable2Step); default: the deployer
///           OPERATOR_ADDRESS server wallet that opens/locks/resolves/publishes; default: deployer
///           EPOCH_CAP        max USDC base units per reward epoch; default 5e6 (5 USDC)
contract Deploy is Script {
    uint256 constant ANVIL_CHAIN_ID = 31337;

    function run() external {
        uint256 startBlock = block.number;
        string memory key = "deployment";
        address deployer = msg.sender;
        address owner = vm.envOr("ARENA_OWNER", deployer);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);
        uint256 epochCap = vm.envOr("EPOCH_CAP", uint256(5e6));

        vm.startBroadcast();
        address usdc;
        if (block.chainid == ANVIL_CHAIN_ID) {
            // LOCAL TEST ONLY: on Base the app uses Circle's USDC, never a mock.
            usdc = address(new MockUSDC());
            vm.serializeAddress(key, "MockUSDC", usdc);
        } else {
            usdc = vm.envAddress("USDC_ADDRESS");
            require(usdc.code.length > 0, "USDC_ADDRESS has no code on this chain");
        }
        TradeLog tradeLog = new TradeLog();
        Arena arena = new Arena(IERC20(usdc), owner, operator, epochCap);
        vm.stopBroadcast();

        console.log("deployer", deployer);
        console.log("TradeLog", address(tradeLog));
        console.log("Arena   ", address(arena));
        console.log("operator", operator);

        // A dry run (no --broadcast) must not overwrite real addresses.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console.log("Dry run: not writing deployments file");
            return;
        }

        vm.serializeAddress(key, "TradeLog", address(tradeLog));
        vm.serializeAddress(key, "Arena", address(arena));
        vm.serializeAddress(key, "USDC", usdc);
        vm.serializeUint(key, "chainId", block.chainid);
        string memory json = vm.serializeUint(key, "startBlock", startBlock);

        string memory path =
            string.concat("../shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Wrote", path);
    }
}
