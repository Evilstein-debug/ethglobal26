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

| Phase | Scope                                                                                                                                                                        | State                                          | Commit               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------- |
| 0     | Starter repurposed: anvil + Base, tokens, canonical hashing, schemas, env, stubs                                                                                             | ✅ done                                        | `81ad8a9`            |
| —     | DB switched SQLite → Postgres (Neon prod via `pg`, PGlite local/tests)                                                                                                       | ✅ done                                        | `0e7aa0e`            |
| 1     | TradeLog + Arena contracts, 36 forge tests (unit, fuzz, invariants), deploy script                                                                                           | ✅ done                                        | `5d5a198`            |
| 2     | Key box, egress allowlist, signer, policy engine; owner auth, verify route (dev verifier on anvil), agent API                                                                | ✅ done                                        | `44fe63c`, `9cff6ca` |
| 3     | Flash client + local stub; trade pipeline (commit → quote → approve → sign → submit → record), close; anvil integration tests                                                | ✅ done on anvil (live Base run pending: team) | `a473c32`, `6d60f15` |
| 4     | 0G brain: `packages/zerog` client; allocation / trade / prediction decisions with code validation, clamping, decisions log, injection fixtures; local labeled model on anvil | ✅ done on anvil (live 0G run pending: team)   | `3dd1f65`, next      |
| 5     | Scheduler, resolver, prediction scoring, reward epochs, read API                                                                                                             | ⬜                                             | —                    |
| 6     | World ID (IDKit) verifier replacing the dev verifier; onboarding UI                                                                                                          | ⬜                                             | —                    |
| 7     | Web UI: arena, agent profile, entry detail, leaderboards, rewards                                                                                                            | ⬜                                             | —                    |
| 8     | verify.ts, seed-replay, README, WORLD_FEEDBACK.md, deploy config                                                                                                             | ⬜                                             | —                    |

## Resume point

**Next step:** Phase 5, rounds + resolver + rewards (`apps/server/src/rounds/`, `rewards/`):

1. Scheduler (timer-driven, configurable 3/4/10 min, live hourly): REGISTRATION →
   `decideAllocation` per trade/both agent → policy snapshot + `Arena.openEntry` + `round_entries`;
   PREDICTING → `decidePredictions` per predict/both agent → `Arena.lockPredictions`;
   TRADING → `decideTrade` per entry (loop until budget/time) → at end `closePosition` for every
   EXECUTED intent; RESOLVING → resolver; SETTLED.
2. Resolver: committed intents of the round ↔ fills → net PnL bps → YES/NO/VOID (VOID: no trades,
   snapshot mismatch, unresolved/failed close) → `Arena.resolveEntry` → Brier for predictions →
   `agent_stats`.
3. Reward epochs: rank traders (net return, min trades) and predictors (mean Brier, min count),
   one award per human, budget split, `Arena.publishEpoch`; owners claim from the web app.
4. Read API: current round, entries, entry detail, leaderboards, agent activity, epochs.
5. Tests: anvil integration for a full round + epoch + claim; e2e:happy extended to one round.

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
