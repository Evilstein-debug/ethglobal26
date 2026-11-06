# Verified external values

Every external value this repo relies on, where it came from, and when it was checked.
Re-check anything older than your hackathon's start date before relying on it.

## Chains

Product decision (2026-11-06): **Base mainnet only**, plus anvil for local dev. Flash has no testnet,
so Sepolia and Base Sepolia were removed. Chain metadata comes from viem's chain definitions
(`viem/chains`) at the pinned viem version.

| Value              | Used in                         | Value                                                         | Source                                                                    | Checked    |
| ------------------ | ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| Anvil chain ID     | `packages/shared/src/chains.ts` | `31337`                                                       | viem 2.57.14 `anvil`                                                      | 2026-11-02 |
| Anvil RPC          | scripts, apps (local)           | `http://127.0.0.1:8545`                                       | viem 2.57.14 `anvil`; `anvil --help` (Foundry 1.8.7)                      | 2026-11-02 |
| Anvil dev mnemonic | `scripts/lib/local.ts`          | `test test test test test test test test test test test junk` | https://getfoundry.sh/anvil/overview                                      | 2026-11-01 |
| Base chain ID      | `packages/shared/src/chains.ts` | `8453`                                                        | viem 2.57.14 `base`; Flash supported-chains page                          | 2026-11-06 |
| Base default RPC   | fallback when no RPC URL is set | `https://mainnet.base.org` (rate-limited; use a provider)     | viem 2.57.14 `base`; https://flash.definitive.fi/docs/supported-chains.md | 2026-11-06 |
| Base explorer      | tx/address links                | `https://basescan.org`                                        | viem 2.57.14 `base`                                                       | 2026-11-06 |

## Tokens (Base mainnet)

| Token | Used in                         | Address                                      | Source                                                                                                    | Checked    |
| ----- | ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------- |
| USDC  | `packages/shared/src/tokens.ts` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses (also used in Flash's examples) | 2026-11-06 |
| WETH  | `packages/shared/src/tokens.ts` | `0x4200000000000000000000000000000000000006` | Base: https://docs.base.org/base-chain/network-information/base-contracts (WETH9)                         | 2026-11-06 |

On anvil the app uses `MockUSDC` (`packages/contracts/src/mocks/MockUSDC.sol`, local test only).

## Definitive Flash

| Value                               | Value                                                                                                          | Source                                                          | Checked    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| API base URL                        | `https://flash.definitive.fi/v1`, header `x-definitive-api-key`                                                | https://flash.definitive.fi/docs/for-agents.md                  | 2026-11-06 |
| Testnet                             | None. FAQ: test on a production chain like Base with small amounts                                             | https://flash.definitive.fi/docs/faq.md                         | 2026-11-06 |
| Order model                         | Spot swaps (target/contra). No shorting: our trades are long-only                                              | https://flash.definitive.fi/docs/placing-orders.md              | 2026-11-06 |
| Bracket                             | `attachedBracket {takeProfit, stopLoss, expireTime?}` on a `market` entry; two EIP-712 signatures              | https://flash.definitive.fi/docs/brackets.md                    | 2026-11-06 |
| EVM signing                         | `signTypedData(JSON.parse(quote.evm.orderTypedData))`; EOAs or EIP-1271; 7702-delegated EOAs need care         | https://flash.definitive.fi/docs/evm-overview.md                | 2026-11-06 |
| Allowance controls                  | `evmUsePermit2: false`, `forceMinimalAllowance: true`; Permit2 is `0x000000000022D473030F116dDEE9F6B43aC78BA3` | https://flash.definitive.fi/docs/evm-overview.md                | 2026-11-06 |
| Fills                               | `GET /orders/{id}` → `filled.*`, `fills[].{notional, fillPrice, transactionId, integratorFeeNotional}`         | https://flash.definitive.fi/docs/post-trade-reporting.md        | 2026-11-06 |
| Integrator fee                      | `flashIntegratorFeeBps`, same string on `/quote` and `/order`                                                  | https://flash.definitive.fi/docs/monetizing-your-integration.md | 2026-11-06 |
| MCP server                          | `@definitive-fi/flash-mcp` 0.1.11; no attached-bracket tool; one funder key → dev tool only                    | https://flash.definitive.fi/docs/flash-mcp.md, `npm view`       | 2026-11-06 |
| Settlement contract (Base)          | **TODO Phase 3 spike**: read from a real quote's `evm.orderTypedData` domain                                   | n/a                                                             | n/a        |
| Minimum order size, small-size fees | **TODO Phase 3 spike**: undocumented                                                                           | n/a                                                             | n/a        |

## 0G Private Computer (0G Compute Router)

| Value             | Value                                                                                                             | Source                                                                                                  | Checked    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| API base URL      | `https://router-api.0g.ai/v1` (OpenAI-compatible), `Authorization: Bearer sk-…`; web UI https://pc.0g.ai          | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview.md                      | 2026-11-06 |
| Request ID        | `x_0g_trace.request_id` (+ `provider`) on every response; chat ID in the `ZG-Res-Key` header                      | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution.md | 2026-11-06 |
| Sealed inference  | Header `X-0G-Provider-Trust-Mode: private` (TeeML only; 503 instead of downgrading); `verify_tee: true`           | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy.md                       | 2026-11-06 |
| TeeML text models | `glm-5.3` (default), `0gm-1.0-35b-a3b`, `laya`, `vela-2.0-9b`. Claude/GPT are `standard` (non-verifiable)         | `GET https://router-api.0g.ai/v1/models` (`verifiability`)                                              | 2026-11-06 |
| Independent check | `@0gfoundation/0g-compute-ts-sdk` `broker.inference.processResponse(provider, chatID)` via `https://evmrpc.0g.ai` | verifiable-execution page above                                                                         | 2026-11-06 |
| JSON mode         | `response_format: {"type": "json_object"}`                                                                        | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions.md     | 2026-11-06 |

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

| Package                               | Version         | Note                                                                                                                                                                                                                        | Checked    |
| ------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `@openzeppelin/contracts`             | 5.6.1           | Uses `ReentrancyGuard`                                                                                                                                                                                                      | 2026-11-01 |
| `viem`                                | 2.57.14         | Forced as the single copy via `pnpm-workspace.yaml` overrides                                                                                                                                                               | 2026-11-01 |
| `wagmi`                               | 2.19.5          | **Not** wagmi 3 (3.7.9 exists): RainbowKit 2.2.11 peer-requires `wagmi ^2.9.0`                                                                                                                                              | 2026-11-01 |
| `@rainbow-me/rainbowkit`              | 2.2.11          | https://rainbowkit.com/docs/installation, `ConnectButton.Custom`, `lightTheme({ borderRadius: 'none' })`                                                                                                                    | 2026-11-01 |
| `@tanstack/react-query`               | 5.105.1         |                                                                                                                                                                                                                             | 2026-11-01 |
| `@wagmi/cli`                          | 2.10.0          | Foundry plugin: https://wagmi.sh/cli/api/plugins/foundry                                                                                                                                                                    | 2026-11-01 |
| `next`                                | 16.4.3          | `next lint` removed in 16; ESLint flat config: https://nextjs.org/docs/app/api-reference/config/eslint                                                                                                                      | 2026-11-01 |
| `react`, `react-dom`                  | 19.3.1          |                                                                                                                                                                                                                             | 2026-11-01 |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.3           | https://tailwindcss.com/docs/installation/framework-guides/nextjs                                                                                                                                                           | 2026-11-01 |
| `express`                             | 5.3.0           | Express 5: async handler errors reach the error middleware; `app.listen` passes errors to its callback. https://expressjs.com/en/guide/migrating-5.html                                                                     | 2026-11-02 |
| `cors`                                | 2.8.6           | CORS middleware for Express                                                                                                                                                                                                 | 2026-11-02 |
| `@types/express`, `@types/cors`       | 5.0.6, 2.8.19   |                                                                                                                                                                                                                             | 2026-11-02 |
| `typescript`                          | 5.9.3           | **Not** 7.x: typescript-eslint 8.72.1 supports `>=4.8.4 <6.1.0`                                                                                                                                                             | 2026-11-01 |
| `typescript-eslint`                   | 8.72.1          |                                                                                                                                                                                                                             | 2026-11-01 |
| `eslint`                              | 9.39.5          | ESLint 10 works with eslint-config-next 16.4 but some plugins still warn on peers                                                                                                                                           | 2026-11-01 |
| `eslint-config-next`                  | 16.4.3          |                                                                                                                                                                                                                             | 2026-11-01 |
| `prettier`                            | 3.9.10          |                                                                                                                                                                                                                             | 2026-11-01 |
| `tsx`                                 | 4.23.15         |                                                                                                                                                                                                                             | 2026-11-01 |
| `zod`                                 | 4.6.7           | Canonical record schemas (`packages/shared/src/schemas.ts`). zod 4 runs refinements after a failed check, so refinements guard their own inputs                                                                             | 2026-11-06 |
| `drizzle-orm`, `drizzle-kit`          | 0.45.4, 0.31.11 | Postgres schema + migrations in `apps/server` (https://orm.drizzle.team/docs/drizzle-config-file)                                                                                                                           | 2026-11-06 |
| `pg`, `@types/pg`                     | 8.23.1          | node-postgres: production driver (Neon). Tested against a local Postgres 17 via `TEST_DATABASE_URL`                                                                                                                         | 2026-11-06 |
| `@electric-sql/pglite`                | 0.5.15          | In-process Postgres (WASM) for local dev and tests; same SQL and migrations as production                                                                                                                                   | 2026-11-06 |
| `@coinbase/cdp-sdk`                   | 1.52.0          | Transitive (wagmi → `@wagmi/connectors` → `@base-org/account`). Pinned via override: 1.53+ dynamically imports optional `@x402/*` peers that Next.js cannot resolve (dev server 500). Revisit when wagmi/RainbowKit update. | 2026-11-01 |

## CI actions

| Action                         | Version used             | Latest tag seen | Checked    |
| ------------------------------ | ------------------------ | --------------- | ---------- |
| `actions/checkout`             | `v7`                     | v7.0.1          | 2026-11-01 |
| `actions/setup-node`           | `v7`                     | v7.1.0          | 2026-11-01 |
| `pnpm/action-setup`            | `v6`                     | v6.1.0          | 2026-11-01 |
| `foundry-rs/foundry-toolchain` | `v1` (`version: v1.8.7`) | v1.9.2          | 2026-11-01 |

## Not verified

- **Deploying and verifying on Base end to end:** not run yet (Phase 1 deploys). `foundry.toml` uses Etherscan API V2 with `chain = 8453`.
- **Flash and 0G calls:** documented above from the official docs, not yet exercised with keys (Phases 3 and 4).
- **Foundry's default verifier:** the docs disagree (Sourcify vs Etherscan depending on version and whether a key is set). Always pass `--verifier` explicitly.
- **WalletConnect:** the injected-wallet fallback is what was run. The `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` path (RainbowKit `getDefaultConfig`) typechecks but was not exercised with a real project ID. Project IDs come from https://dashboard.reown.com.
- **In-browser wallet flows:** checked with server-rendered HTML and `pnpm e2e:happy` (same simulate → send → wait sequence), not by clicking through a browser wallet.
