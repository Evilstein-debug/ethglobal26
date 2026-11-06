# AgentArena build progress

Live status of the phased build (plan: CLAUDE.md §8). Updated at every commit checkpoint so work
can resume from here. Design: **v3** (trader leaderboard + free predictions + capped USDC reward
pool; Base mainnet only; Base USDC; long-only Flash brackets; 0G private tier; Postgres).

## Rules of work

- Work on `main` only; commit after a green, coherent chunk; push; check CI when possible.
- Full gate before every commit: `pnpm exec prettier --check .`, `pnpm typecheck`, `pnpm lint`,
  `pnpm test`, plus `pnpm e2e:happy` when server/contracts change. Server tests also pass
  against real Postgres: `TEST_DATABASE_URL=postgres://…@127.0.0.1:…/db pnpm --filter @starter/server test`.
- **Never deploy or trade on a live chain from the agent.** All chain testing is on anvil.
  Flash and 0G run against labeled local stubs on anvil; live runs are for the team.

## Status

| Phase | Scope                                                                                                                         | State                                          | Commit               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------- |
| 0     | Starter repurposed: anvil + Base, tokens, canonical hashing, schemas, env, stubs                                              | ✅ done                                        | `81ad8a9`            |
| —     | DB switched SQLite → Postgres (Neon prod via `pg`, PGlite local/tests)                                                        | ✅ done                                        | `0e7aa0e`            |
| 1     | TradeLog + Arena contracts, 36 forge tests (unit, fuzz, invariants), deploy script                                            | ✅ done                                        | `5d5a198`            |
| 2     | Key box, egress allowlist, signer, policy engine; owner auth, verify route (dev verifier on anvil), agent API                 | ✅ done                                        | `44fe63c`, `9cff6ca` |
| 3     | Flash client + local stub; trade pipeline (commit → quote → approve → sign → submit → record), close; anvil integration tests | ✅ done on anvil (live Base run pending: team) | `a473c32`, `6d60f15` |
| 4     | 0G brain: client; allocation / trade / prediction decisions; validation, clamping, decisions log, injection fixtures          | ✅ done on anvil (live 0G run pending: team)   | `3dd1f65`, `aba1f56` |
| 5     | Scheduler, resolver, Brier scoring, reward epochs, read API, owner-prediction indexer; e2e runs a full round → claim          | ✅ done on anvil                               | `8d7393e`, next      |
| 6     | World ID (IDKit) verifier replacing the dev verifier; onboarding UI                                                           | ⬜                                             | —                    |
| 7     | Web UI: arena, agent profile, entry detail, leaderboards, rewards                                                             | ⬜                                             | —                    |
| 8     | verify.ts, seed-replay, README, WORLD_FEEDBACK.md, deploy config                                                              | ⬜                                             | —                    |

## Resume point

**Next step:** Phase 6, World ID (IDKit):

1. Read World's current IDKit docs (package name, verify endpoint, `action`, `signal`, nullifier
   scope, simulator/staging). Record in VERIFIED.md; start `WORLD_FEEDBACK.md`.
2. `packages/world`: backend verification of the IDKit result (never trust the client) →
   `HumanVerifier` with method `world`, `signal` = owner wallet.
3. Server: `HUMAN_VERIFIER=world` default on Base (already enforced), wire it in `index.ts`.
4. Web onboarding (Phase 7 UI): IDKit widget → `POST /api/owners/verify` with `{ proof }`;
   success / already-registered / cancelled states.
5. Tests: invalid proof, reused nullifier (already covered for the dev verifier), proof bound to
   another wallet.

Server API now available for the UI: `/api/rounds/current`, `/api/rounds/:id`, `/api/entries/:id`,
`/api/leaderboard`, `/api/epochs`, `/api/owners/:wallet` (+ `/awards`), `/api/agents/:id`
(+ `/intents`, `/activity`), owner routes (verify, create agent, policy, pause/resume, withdraw,
trade-preview, manual-trade, close). Dev-only on anvil: `/api/dev/flash-stub/price`,
`/api/dev/rounds/tick`.

## Things the team must do (agent can't)

1. Flash: create an integrator key; run `FLASH_API_KEY=… pnpm tsx scripts/flash-inspect.ts`
   (read-only quotes) and paste its output into `apps/server/.env` + VERIFIED.md; fund a Base
   wallet (~20 USDC + ~$2 ETH) for the first live trade.
2. 0G: create a Router `sk-` key at pc.0g.ai with trust mode **Private**, deposit 0G tokens.
3. World: Developer Portal app ID + action (Phase 6).
4. Neon: create a database and set `DATABASE_URL` for the deployed server.
5. CI: the repo is private, so the agent can't read Actions status without `gh` auth
   (`brew install gh && gh auth login`).
6. Mentor questions: CLAUDE.md §9.
