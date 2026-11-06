# @starter/contracts

Foundry project for AgentArena.

```
src/TradeLog.sol       commit-before-trade log; every commit ends Executed or Failed
src/Arena.sol          human registry, entries, predictions, reward epochs (USDC)
src/mocks/             MockUSDC, MockWETH (local anvil only)
test/                  unit, fuzz and invariant tests
script/Deploy.s.sol    deploys, writes ../shared/deployments/<chainId>.json
```

```sh
forge test              # from this directory
pnpm deploy:local       # from the repo root, with anvil running
pnpm deploy:base        # real gas; see the root README "Deploy"
```

`Deploy.s.sol` reads `USDC_ADDRESS` (required off anvil), `ARENA_OWNER`, `OPERATOR_ADDRESS` and
`EPOCH_CAP`. The signer comes from the CLI, never from a file: import the deployer into Foundry's
encrypted keystore with `cast wallet import deployer --interactive`.
