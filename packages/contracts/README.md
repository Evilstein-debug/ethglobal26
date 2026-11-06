# @starter/contracts

Foundry project. `SimpleEscrow` is the example contract: a payer locks ETH for a payee, then
either releases it or refunds it after a deadline. Replace it with your own.

```
src/SimpleEscrow.sol              example contract
test/SimpleEscrow.t.sol           unit + fuzz tests
test/SimpleEscrow.invariant.t.sol invariant test (escrow balance == totalLocked)
test/Fork.t.sol                   fork-test example, skipped unless FORK_RPC_URL is set
script/Deploy.s.sol               deploys, writes ../shared/deployments/<chainId>.json
```

Dependencies (OpenZeppelin, forge-std) come from npm/git via pnpm, so there are no git
submodules: `pnpm install` at the repo root is all you need.

## Test

```sh
forge test                      # from this folder, or `pnpm test` at the root
forge test -vvv --match-test testFuzz
FOUNDRY_PROFILE=ci forge test   # more fuzz runs, as in CI
FORK_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test --match-contract ForkTest -vv
```

## Deploy

Local: `pnpm dev` deploys automatically. To redeploy to a running anvil: `pnpm deploy:local`
(from the repo root, which also runs codegen).

Sepolia:

1. `cp .env.example .env` and set `SEPOLIA_RPC_URL`.
2. Put a **throwaway** deployer key into Foundry's encrypted keystore (never in `.env`):
   ```sh
   cast wallet new                          # if you need a fresh key
   cast wallet import deployer --interactive
   ```
   Fund that address with Sepolia ETH from a faucet.
3. From the repo root: `pnpm deploy:sepolia` (prompts for the keystore password, then runs
   `pnpm codegen` so the web app and server pick up the new address).
4. Commit `packages/shared/deployments/11155111.json` and `packages/shared/src/generated.ts`,
   so everyone gets the new address.

Use a different keystore name with `DEPLOYER_ACCOUNT=myname pnpm deploy:sepolia`.

## Verifying

Always pass `--verifier` explicitly (the default differs between Foundry versions).
`SimpleEscrow` has no constructor arguments; for contracts that do, add
`--constructor-args $(cast abi-encode "constructor(address)" 0x...)`.

Replace `<ADDRESS>` with the deployed address from `../shared/deployments/11155111.json`.

### Etherscan (sepolia.etherscan.io)

Needs `ETHERSCAN_API_KEY` in `.env` (free: https://etherscan.io/myapikey; one key covers every
chain Etherscan supports). `foundry.toml` already maps it for `--chain sepolia`.

```sh
forge verify-contract <ADDRESS> src/SimpleEscrow.sol:SimpleEscrow \
  --chain sepolia --verifier etherscan --watch
```

Or verify during deployment by adding `--verify --verifier etherscan` to the `forge script`
command in `package.json`.

### Blockscout (eth-sepolia.blockscout.com)

No API key needed when pointing at the instance directly.

```sh
forge verify-contract <ADDRESS> src/SimpleEscrow.sol:SimpleEscrow \
  --chain sepolia --verifier blockscout \
  --verifier-url https://eth-sepolia.blockscout.com/api/ --watch
```

### Sourcify

No API key needed. Check the result at https://verify.sourcify.dev.

```sh
forge verify-contract <ADDRESS> src/SimpleEscrow.sol:SimpleEscrow \
  --chain 11155111 --verifier sourcify --watch
```

Docs: [Foundry deploying](https://getfoundry.sh/forge/deploying) ·
[Blockscout + Foundry](https://docs.blockscout.com/devs/verification/foundry-verification) ·
[Sourcify + Foundry](https://docs.sourcify.dev/docs/verify-via-foundry/) ·
[Etherscan API](https://docs.etherscan.io/). Values and check dates are in `../../VERIFIED.md`.

## Adding a contract

1. Add `src/MyThing.sol` (+ tests).
2. Deploy it in `script/Deploy.s.sol` and add it to the JSON:
   `vm.serializeAddress(key, "MyThing", address(myThing));`
3. `pnpm codegen` (or restart `pnpm dev`): `myThingAbi` and `myThingAddress` appear in
   `@starter/shared/generated`. Codegen picks up every file in `src/` automatically.
