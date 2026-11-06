# AgentArena build progress

Live status of the phased build (plan: CLAUDE.md §8). Updated at every commit checkpoint so work
can resume from here. Design: **v4** (per-trade markets, autonomous agents, Live tab; trader leaderboard + free predictions + capped USDC reward
pool; Base mainnet only; Base USDC; long-only Flash brackets; 0G private tier; Postgres).

## Rules of work

- Work on `main` only; commit after a green, coherent chunk; push; check CI when possible.
- Full gate before every commit: `pnpm exec prettier --check .`, `pnpm typecheck`, `pnpm lint`,
  `pnpm test`, plus `pnpm e2e:happy` when server/contracts change. Server tests also pass
  against real Postgres: `TEST_DATABASE_URL=postgres://…@127.0.0.1:…/db pnpm --filter @starter/server test`.
- **Never deploy or trade on a live chain from the agent.** All chain testing is on anvil.
  Flash and 0G run against labeled local stubs on anvil; live runs are for the team.

## Status

| Phase | Scope                                                                                                                                                                     | State                                          | Commit                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| 0     | Starter repurposed: anvil + Base, tokens, canonical hashing, schemas, env, stubs                                                                                          | ✅ done                                        | `81ad8a9`                       |
| —     | DB switched SQLite → Postgres (Neon prod via `pg`, PGlite local/tests)                                                                                                    | ✅ done                                        | `0e7aa0e`                       |
| 1     | TradeLog + Arena contracts, 36 forge tests (unit, fuzz, invariants), deploy script                                                                                        | ✅ done                                        | `5d5a198`                       |
| 2     | Key box, egress allowlist, signer, policy engine; owner auth, verify route (dev verifier on anvil), agent API                                                             | ✅ done                                        | `44fe63c`, `9cff6ca`            |
| 3     | Flash client + local stub; trade pipeline (commit → quote → approve → sign → submit → record), close; anvil integration tests                                             | ✅ done on anvil (live Base run pending: team) | `a473c32`, `6d60f15`            |
| 4     | 0G brain: client; allocation / trade / prediction decisions; validation, clamping, decisions log, injection fixtures                                                      | ✅ done on anvil (live 0G run pending: team)   | `3dd1f65`, `aba1f56`            |
| 5     | Scheduler, resolver, Brier scoring, reward epochs, read API, owner-prediction indexer; e2e runs a full round → claim                                                      | ✅ done on anvil                               | `8d7393e`, `08f052d`            |
| 6     | World ID 4.0 backend: RP signatures, proof verification (signal = wallet, Proof of Human, v4 verify), nullifier normalization, routes; WORLD_FEEDBACK.md started          | ✅ server done (live World run pending: team)  | `2ee03b7`                       |
| 7     | Web UI: shell, onboarding, arena, agents, entry verification (real checks in the browser), leaderboards, rewards + claim; driven end to end in headless Chromium on anvil | ✅ done                                        | `dc908f7`, `90dd19c`            |
| 8     | verify.ts (shared verifier used by the entry page and CLI), labeled replay data, README, ARCHITECTURE, Dockerfile, render.yaml, env docs; CI runs e2e and the web build   | ✅ done (live run, video, submission: team)    | `7c13100`, `ae4825a`, `0b54e4a` |
| —     | Flash read-only inspection with the team's key: Base contract `0x5d00…8f78` (approvals + FlashOrder), $2–$10 bracket quotes OK; written to server env + VERIFIED.md       | ✅ done                                        | `35ac212`                       |
| —     | Local runs (`pnpm dev`, `pnpm e2e:happy`) blank real keys from `apps/server/.env`, so they always use stubs and a local DB                                                | ✅ done                                        | next                            |

## Per-trade markets (design v4)

Done on anvil: the round timer is gone. Agents choose to buy, predict or wait; every fill opens its
own market; the Live tab shows state and reasoning; optional RSS news; epochs unchanged. No testnet
or mainnet deployment yet.

## Resume point

**All build phases (0–8) are done and verified on local anvil.** Re-checked on 2026-11-06 after the
last commit:

| Check                                  | Result                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| `forge test`                           | 36 passed                                                |
| Server tests (incl. anvil integration) | 64 passed                                                |
| shared / flash / zerog / world tests   | 20 / 10 / 6 / 6 passed                                   |
| `pnpm e2e:happy`                       | Passed: full round → onchain claim → `scripts/verify.ts` |
| Typecheck, ESLint, Prettier            | Clean                                                    |
| `next build` (apps/web)                | Passes                                                   |

CI status was not readable from here (`gh` isn't installed and the repo is private).
Nothing has been deployed or traded on a live chain, and no live 0G or World call has been made.
Details and known limitations: `completed.md`.

## Things the team must do (agent can't)

1. Flash: ✅ key added and inspected (addresses in `apps/server/.env` + VERIFIED.md). Still to do:
   fund a Base wallet (~20 USDC + ~$2 ETH), deploy contracts to Base, run one $2 manual trade
   (`ALLOW_MANUAL_TRADES=true`), then set `TRADE_MIN_TP_PCT` from the real fill's fees and check
   `pnpm verify <entryId>` on a live entry.
2. 0G: create a Router `sk-` key at pc.0g.ai with trust mode **Private**, deposit 0G tokens.
3. World: Developer Portal app (World ID 4.0): `app_id`, `rp_id`, RP signing key → server env
   `WORLD_*`; test with the simulator (`WORLD_ENVIRONMENT=staging`); fill in `WORLD_FEEDBACK.md`.
4. Neon: create a database and set `DATABASE_URL` for the deployed server.
5. Deploy: contracts to Base, server (render.yaml), web (Vercel), fund the pool: README "Deploy".
6. Fill in the README TODOs (team, links, addresses) and `WORLD_FEEDBACK.md`; record the video;
   post the clip on Discord and X tagging @DefinitiveFi.
7. Mentor questions: CLAUDE.md §9.
