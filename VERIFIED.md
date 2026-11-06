# Verified external values

Every external value this repo relies on, where it came from, and when it was checked.
Re-check anything older than your hackathon's start date before relying on it.

## Chains

Chain metadata is not hand-typed: it comes from viem's chain definitions (`viem/chains`) at the
pinned viem version, read from the installed package.

| Value                    | Used in                           | Value                                                                                                           | Source                                                                                           | Checked    |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| Anvil chain ID           | `packages/shared/src/chains.ts`   | `31337`                                                                                                         | viem 2.57.14 `anvil`; https://github.com/wevm/viem/blob/main/src/chains/definitions/anvil.ts     | 2026-11-02 |
| Anvil RPC                | scripts, apps (local)             | `http://127.0.0.1:8545` (anvil default port 8545)                                                               | viem 2.57.14 `anvil`; `anvil --help` (Foundry 1.8.7)                                             | 2026-11-02 |
| Anvil dev mnemonic       | `scripts/lib/local.ts`            | `test test test test test test test test test test test junk`                                                   | https://getfoundry.sh/anvil/overview                                                             | 2026-11-01 |
| Sepolia chain ID         | `packages/shared/src/chains.ts`   | `11155111`                                                                                                      | viem 2.57.14 `sepolia`; https://github.com/wevm/viem/blob/main/src/chains/definitions/sepolia.ts | 2026-11-02 |
| Sepolia default RPC      | fallback when no `RPC_URL` is set | `https://11155111.rpc.thirdweb.com` (answered `eth_chainId` = `0xaa36a7`)                                       | viem 2.57.14 `sepolia`                                                                           | 2026-11-02 |
| Sepolia public RPC (alt) | suggested in `.env.example` files | list at https://chainlist.org/chain/11155111; `https://ethereum-sepolia-rpc.publicnode.com` answered `0xaa36a7` | chainlist.org                                                                                    | 2026-11-01 |
| Sepolia explorer         | tx/address links in the web app   | `https://sepolia.etherscan.io`                                                                                  | viem 2.57.14 `sepolia`                                                                           | 2026-11-02 |
| Sepolia faucets          | `.env.example`                    | list at https://ethereum.org/developers/docs/networks/#sepolia                                                  | ethereum.org                                                                                     | 2026-11-02 |

## Explorers and verification

| Value                          | Value                                                                                                             | Source                                                                   | Checked    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| Foundry verifiers              | `etherscan`, `sourcify`, `blockscout`, `oklink`, `custom`                                                         | `forge verify-contract --help` (Foundry 1.8.7)                           | 2026-11-02 |
| Etherscan API key              | One key for all Etherscan-supported chains (`chainid` parameter); get it at https://etherscan.io/myapikey         | https://docs.etherscan.io/                                               | 2026-11-02 |
| Blockscout Sepolia             | `https://eth-sepolia.blockscout.com`, verifier URL `https://eth-sepolia.blockscout.com/api/` (no real key needed) | https://docs.blockscout.com/devs/verification/foundry-verification       | 2026-11-02 |
| Sourcify                       | `--verifier sourcify --chain 11155111`, no API key; lookup UI https://verify.sourcify.dev                         | https://docs.sourcify.dev/docs/verify-via-foundry/                       | 2026-11-02 |
| Foundry keystore (`--account`) | `cast wallet import <name> --interactive`, `cast wallet new`                                                      | `cast wallet import --help`; https://getfoundry.sh/cast/reference/wallet | 2026-11-02 |

## Toolchain

| Tool      | Version | Where pinned                                | Source                                                                                                                | Checked    |
| --------- | ------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| Node.js   | 20.20.2 | `.nvmrc`, `engines` (`>=20.19`)             | local install; `--env-file-if-exists` needs Node ≥ 20.19 (tested on 20.20.2)                                          | 2026-11-01 |
| pnpm      | 10.15.0 | `packageManager` in `package.json`          | local install                                                                                                         | 2026-11-01 |
| Foundry   | v1.8.7  | README, `.github/workflows/ci.yml`          | latest `vX.Y.Z` tag of https://github.com/foundry-rs/foundry; install https://getfoundry.sh/introduction/installation | 2026-11-01 |
| solc      | 0.8.30  | `packages/contracts/foundry.toml`           | https://binaries.soliditylang.org (latest was 0.8.38; 0.8.30 chosen as a widely used release)                         | 2026-11-01 |
| forge-std | v1.17.0 | `packages/contracts/package.json` (git tag) | latest tag of https://github.com/foundry-rs/forge-std                                                                 | 2026-11-01 |

## Key packages

Exact versions, from `npm view <pkg> version` unless noted.

| Package                               | Version       | Note                                                                                                                                                                                                                        | Checked    |
| ------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `@openzeppelin/contracts`             | 5.6.1         | Uses `ReentrancyGuard`                                                                                                                                                                                                      | 2026-11-01 |
| `viem`                                | 2.57.14       | Forced as the single copy via `pnpm-workspace.yaml` overrides                                                                                                                                                               | 2026-11-01 |
| `wagmi`                               | 2.19.5        | **Not** wagmi 3 (3.7.9 exists): RainbowKit 2.2.11 peer-requires `wagmi ^2.9.0`                                                                                                                                              | 2026-11-01 |
| `@rainbow-me/rainbowkit`              | 2.2.11        | https://rainbowkit.com/docs/installation, `ConnectButton.Custom`, `lightTheme({ borderRadius: 'none' })`                                                                                                                    | 2026-11-01 |
| `@tanstack/react-query`               | 5.105.1       |                                                                                                                                                                                                                             | 2026-11-01 |
| `@wagmi/cli`                          | 2.10.0        | Foundry plugin: https://wagmi.sh/cli/api/plugins/foundry                                                                                                                                                                    | 2026-11-01 |
| `next`                                | 16.4.3        | `next lint` removed in 16; ESLint flat config: https://nextjs.org/docs/app/api-reference/config/eslint                                                                                                                      | 2026-11-01 |
| `react`, `react-dom`                  | 19.3.1        |                                                                                                                                                                                                                             | 2026-11-01 |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.3         | https://tailwindcss.com/docs/installation/framework-guides/nextjs                                                                                                                                                           | 2026-11-01 |
| `express`                             | 5.3.0         | Express 5: async handler errors reach the error middleware; `app.listen` passes errors to its callback. https://expressjs.com/en/guide/migrating-5.html                                                                     | 2026-11-02 |
| `cors`                                | 2.8.6         | CORS middleware for Express                                                                                                                                                                                                 | 2026-11-02 |
| `@types/express`, `@types/cors`       | 5.0.6, 2.8.19 |                                                                                                                                                                                                                             | 2026-11-02 |
| `typescript`                          | 5.9.3         | **Not** 7.x: typescript-eslint 8.72.1 supports `>=4.8.4 <6.1.0`                                                                                                                                                             | 2026-11-01 |
| `typescript-eslint`                   | 8.72.1        |                                                                                                                                                                                                                             | 2026-11-01 |
| `eslint`                              | 9.39.5        | ESLint 10 works with eslint-config-next 16.4 but some plugins still warn on peers                                                                                                                                           | 2026-11-01 |
| `eslint-config-next`                  | 16.4.3        |                                                                                                                                                                                                                             | 2026-11-01 |
| `prettier`                            | 3.9.10        |                                                                                                                                                                                                                             | 2026-11-01 |
| `tsx`                                 | 4.23.15       |                                                                                                                                                                                                                             | 2026-11-01 |
| `@coinbase/cdp-sdk`                   | 1.52.0        | Transitive (wagmi → `@wagmi/connectors` → `@base-org/account`). Pinned via override: 1.53+ dynamically imports optional `@x402/*` peers that Next.js cannot resolve (dev server 500). Revisit when wagmi/RainbowKit update. | 2026-11-01 |

## CI actions

| Action                         | Version used             | Latest tag seen | Checked    |
| ------------------------------ | ------------------------ | --------------- | ---------- |
| `actions/checkout`             | `v7`                     | v7.0.1          | 2026-11-01 |
| `actions/setup-node`           | `v7`                     | v7.1.0          | 2026-11-01 |
| `pnpm/action-setup`            | `v6`                     | v6.1.0          | 2026-11-01 |
| `foundry-rs/foundry-toolchain` | `v1` (`version: v1.8.7`) | v1.9.2          | 2026-11-01 |

## Not verified

- **Etherscan support for Sepolia:** the supported-chains table at https://docs.etherscan.io/supported-chains did not render for me, so I could not confirm Sepolia is listed or which plans include it. Blockscout and Sourcify are documented alternatives.
- **Deploying and verifying on Sepolia end to end:** not run; no testnet key or explorer key was available. The commands follow the docs above.
- **Foundry's default verifier:** the docs disagree (Sourcify vs Etherscan depending on version and whether a key is set). Always pass `--verifier` explicitly.
- **WalletConnect:** the injected-wallet fallback is what was run. The `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` path (RainbowKit `getDefaultConfig`) typechecks but was not exercised with a real project ID. Project IDs come from https://dashboard.reown.com.
- **In-browser wallet flows:** checked with server-rendered HTML and `pnpm e2e:happy` (same simulate → send → wait sequence), not by clicking through a browser wallet.
