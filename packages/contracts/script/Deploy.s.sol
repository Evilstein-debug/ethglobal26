// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Deploys the contracts and writes their addresses to
///         packages/shared/deployments/<chainId>.json (read by `pnpm codegen`).
/// @dev    The signer comes from the CLI (`--private-key` or `--account`), never from code.
///         Phase 0: only the local MockUSDC. TradeLog and Arena are added in Phase 1.
contract Deploy is Script {
    uint256 constant ANVIL_CHAIN_ID = 31337;

    function run() external {
        uint256 startBlock = block.number;
        string memory key = "deployment";

        vm.startBroadcast();
        // LOCAL TEST ONLY: on Base the app uses Circle's USDC, never a mock.
        if (block.chainid == ANVIL_CHAIN_ID) {
            MockUSDC usdc = new MockUSDC();
            vm.serializeAddress(key, "MockUSDC", address(usdc));
        }
        vm.stopBroadcast();

        // A dry run (no --broadcast) must not overwrite real addresses.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console.log("Dry run: not writing deployments file");
            return;
        }

        vm.serializeUint(key, "chainId", block.chainid);
        string memory json = vm.serializeUint(key, "startBlock", startBlock);

        string memory path =
            string.concat("../shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Wrote", path);
    }
}
