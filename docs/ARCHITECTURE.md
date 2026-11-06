# Architecture

Where code lives and how data flows. Product rules and the data model: [CLAUDE.md](../CLAUDE.md).

```
apps/web             Next.js UI: arena, entry detail, leaderboards, rewards, onboarding, agents
apps/server          Express API, scheduler, trader and predictor workers, resolver, reward epochs
packages/contracts   TradeLog.sol, Arena.sol, mocks (anvil only), tests, Deploy.s.sol
packages/shared      canonical hashing, schemas, tokens, chains, verify.ts, generated ABIs
packages/flash       Definitive Flash REST client + labeled local stub
packages/zerog       0G Compute Router client + labeled local stub
packages/world       World ID verification helpers
scripts              dev.ts, e2e-happy.ts, verify.ts, seed-replay.ts, flash-inspect.ts
```

## Server map

| Path                      | Job                                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| `src/rounds/scheduler.ts` | Round state machine, driven by the `rounds` table so restarts resume |
| `src/brain/`              | 0G prompts, the three decisions, validation and clamping             |
| `src/policy/authorize.ts` | Limits and atomic budget reservation; the only way to get a budget   |
| `src/wallets/`            | Encrypted keys, egress allowlist, the signer                         |
| `src/execution/`          | Commit → quote → approve → sign → submit → record; close             |
| `src/rounds/resolver.ts`  | PnL from fills, outcome, Brier, stats                                |
| `src/rewards/epoch.ts`    | Rankings, one award per human, `publishEpoch`                        |
| `src/rounds/indexer.ts`   | Owner actions sent from browsers: manual predictions, reward claims  |
| `src/routes/`             | HTTP API                                                             |
| `src/services/replay.ts`  | Labeled replay rows                                                  |

## One trade

```mermaid
sequenceDiagram
  participant S as Scheduler
  participant G as 0G (TeeML)
  participant P as Policy engine
  participant T as TradeLog
  participant F as Flash
  S->>G: trade decision (price, labeled headlines)
  G-->>S: JSON + request ID + tee_verified
  S->>S: validate; reject or clamp
  S->>P: authorize and reserve budget
  S->>T: commit(round, intentHash, requestIdHash)
  T-->>S: receipt (nothing goes to Flash before this)
  S->>F: quote, approvals, sign entry + bracket, submit
  F-->>S: fill
  S->>T: recordExecution or recordFailure
```

## Where each guarantee lives

- **One human, one account:** unique `owners.world_nullifier_hash`.
- **No self-prediction:** `Arena.predict` reverts on the same human, and the policy engine checks too.
- **Predictions close before trading:** `Arena.lockPredictions`, checked against commit order in
  `verify.ts`.
- **Commit before trade:** order in `execution/trade.ts`, covered by tests.
- **No hidden trades:** `TradeLog` requires each commit to end Executed or Failed; `verify.ts`
  compares onchain commits with the intents the server claims.
- **One award per human, capped epochs:** `Arena.publishEpoch`.

## Conventions

- **Codegen, not copy-paste.** The deploy script writes `packages/shared/deployments/<chainId>.json`;
  `pnpm codegen` turns it and the contracts into typed exports. CI fails if they're stale.
- **Safe writes in the browser.** `useTx()` simulates first, so revert reasons show before the
  wallet opens, then signs, waits for the receipt and refreshes reads.
- **One chain per deployment.** `NEXT_PUBLIC_CHAIN_ID` (web) and `CHAIN_ID` (server, scripts).
- **Stubs are labeled.** On anvil, Flash, 0G and World are stand-ins; the API reports them and the UI
  shows a banner. None of them can run on Base.
- **Database.** Postgres through Drizzle: Neon in production, in-process PGlite locally and in
  tests. Migrations apply on open.
