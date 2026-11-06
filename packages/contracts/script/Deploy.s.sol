// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SimpleEscrow} from "../src/SimpleEscrow.sol";

/// @notice Deploys the contracts and writes their addresses to
///         packages/shared/deployments/<chainId>.json (read by `pnpm codegen`).
/// @dev    The signer comes from the CLI (`--private-key` or `--account`), never from code.
contract Deploy is Script {
    function run() external {
        uint256 startBlock = block.number;

        vm.startBroadcast();
        SimpleEscrow escrow = new SimpleEscrow();
        vm.stopBroadcast();

        // A dry run (no --broadcast) must not overwrite real addresses.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console.log("Dry run: not writing deployments file");
            return;
        }

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "startBlock", startBlock);
        string memory json = vm.serializeAddress(key, "SimpleEscrow", address(escrow));

        string memory path =
            string.concat("../shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Wrote", path);
    }
}
