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

| Phase | Scope                                                                                                                                                                     | State                                          | Commit               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------- |
| 0     | Starter repurposed: anvil + Base, tokens, canonical hashing, schemas, env, stubs                                                                                          | ✅ done                                        | `81ad8a9`            |
| —     | DB switched SQLite → Postgres (Neon prod via `pg`, PGlite local/tests)                                                                                                    | ✅ done                                        | `0e7aa0e`            |
| 1     | TradeLog + Arena contracts, 36 forge tests (unit, fuzz, invariants), deploy script                                                                                        | ✅ done                                        | `5d5a198`            |
| 2     | Key box, egress allowlist, signer, policy engine; owner auth, verify route (dev verifier on anvil), agent API                                                             | ✅ done                                        | `44fe63c`, `9cff6ca` |
| 3     | Flash client + local stub; trade pipeline (commit → quote → approve → sign → submit → record), close; anvil integration tests                                             | ✅ done on anvil (live Base run pending: team) | `a473c32`, `6d60f15` |
| 4     | 0G brain: client; allocation / trade / prediction decisions; validation, clamping, decisions log, injection fixtures                                                      | ✅ done on anvil (live 0G run pending: team)   | `3dd1f65`, `aba1f56` |
| 5     | Scheduler, resolver, Brier scoring, reward epochs, read API, owner-prediction indexer; e2e runs a full round → claim                                                      | ✅ done on anvil                               | `8d7393e`, `08f052d` |
| 6     | World ID 4.0 backend: RP signatures, proof verification (signal = wallet, Proof of Human, v4 verify), nullifier normalization, routes; WORLD_FEEDBACK.md started          | ✅ server done (live World run pending: team)  | `2ee03b7`            |
| 7     | Web UI: shell, onboarding, arena, agents, entry verification (real checks in the browser), leaderboards, rewards + claim; driven end to end in headless Chromium on anvil | ✅ done                                        | `dc908f7`, `90dd19c` |
| 8     | verify.ts, labeled replay data, README, ARCHITECTURE, Dockerfile, render.yaml; CI runs e2e and the web build                                                              | ✅ done (live run, video, submission: team)    | `7c13100`, next      |

## Resume point

All build phases are done on anvil. What's left needs the team's keys and accounts: see below and
`completed.md`. Nothing has been deployed or traded on a live chain.

## Things the team must do (agent can't)

1. Flash: create an integrator key; run `FLASH_API_KEY=… pnpm tsx scripts/flash-inspect.ts`
   (read-only quotes) and paste its output into `apps/server/.env` + VERIFIED.md; fund a Base
   wallet (~20 USDC + ~$2 ETH) for the first live trade.
2. 0G: create a Router `sk-` key at pc.0g.ai with trust mode **Private**, deposit 0G tokens.
3. World: Developer Portal app (World ID 4.0): `app_id`, `rp_id`, RP signing key → server env
   `WORLD_*`; test with the simulator (`WORLD_ENVIRONMENT=staging`); fill in `WORLD_FEEDBACK.md`.
4. Neon: create a database and set `DATABASE_URL` for the deployed server.
5. Deploy: contracts to Base, server (render.yaml), web (Vercel), fund the pool: README "Deploy".
6. Fill in the README TODOs (team, links, addresses) and `WORLD_FEEDBACK.md`; record the video;
   post the clip on Discord and X tagging @DefinitiveFi.
7. Mentor questions: CLAUDE.md §9.
