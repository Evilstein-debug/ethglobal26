# AgentArena: what's implemented

Status as of 2026-11-06. All build phases (0-8 in CLAUDE.md §8) are done and tested **on local
anvil**. **Nothing has been deployed or traded on a live chain, and no real Flash, 0G or World
call has been made**: those need your keys. See "What only you can do".

## Verification results

Run locally on the final code, and on CI (`gh run list`):

| Check                                 | Result                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| `forge test`                          | 36 passed                                                      |
| Server tests (with anvil integration) | 64 passed                                                      |
| shared / flash / zerog / world tests  | 20 / 10 / 6 / 6 passed                                         |
| `pnpm e2e:happy`                      | Passed: full round to onchain claim, then `verify.ts`          |
| Typecheck, ESLint, Prettier           | Clean                                                          |
| `next build`                          | Passes                                                         |
| Real browser (headless Chromium)      | Onboard, create agent, round, entry checks, leaderboard, Claim |

The browser run used a real local stack and a test wallet backed by anvil. It clicked through
onboarding and agent creation, watched a round resolve YES, saw the entry checks run against the
chain, and claimed 2 USDC through the Claim button.

## Implemented

### Real services on local runs

- `pnpm dev`: real 0G (TEE signatures checked independently), World ID, Neon, live ETH price, RSS.
- The chain persists to match Neon; `pnpm dev:reset` clears both.
- Agents think in parallel; open stub positions survive a server restart.

### Per-trade markets (design v4, anvil only)

- Autonomous agents: one `think` step chooses buy, predict or wait; code decides what's on offer.
- One market per trade, broadcast only after a confirmed fill; predictors woken at once.
- Predictions lock at the window end or the exit; time-limit sale; reward epochs unchanged.
- Edge cases tested: exit inside the window, late predictions, own-agent predictions, no predictors,
  failed orders, restart recovery, retrying `openEntry`, pause mid-trade, limit edits, spam limits,
  no gas or funds, and verifying an entry.
- Live tab with each agent's state, reasoning, 0G request IDs and rejected decisions.
- Optional RSS news with the labeled fixture as fallback.

**Contracts.** `TradeLog` (commit before trade; every commit ends Executed or Failed) and `Arena`
(human registry, entries, predictions, reward epochs). Same-human predictions and late predictions
revert; one award per human per epoch; capped epochs; claims paid only to the owner wallet.

**Agents and safety.** A separate wallet per agent with AES-GCM encrypted keys; a signer allowlist;
the policy engine with atomic budget reservation and machine-readable deny reasons; pause and
withdraw (WETH is blocked while a bracket is live).

**Flash.** REST client plus a labeled local stub; market buy with attached bracket; commit enforced
before any order; failures recorded onchain; closing cancels the bracket and market-sells.

**0G.** Compute Router client (sealed tier, rejects unverified responses); allocation, trade and
prediction decisions; validation and clamping in plain code; prompt-injection fixtures; every call
logged with its request ID.

**Rounds and rewards.** Timer-driven state machine that resumes after a restart; resolver computing
PnL from fills; Brier scoring; trader and predictor rankings; reward epochs; an indexer for owners'
manual predictions and reward claims.

**World ID.** IDKit 4 onboarding; proofs verified on the server and bound to the wallet; nullifier
uniqueness; the human ID registered onchain.

**Web.** Arena with countdown and manual picks; onboarding; agent creation and profile (fund,
withdraw, pause, trades, decisions); entry detail; leaderboards; rewards with claim. Red banners
label every stub.

**Added in this session:**

- `packages/shared/src/verify.ts`: one verifier, used by the entry page and the CLI, so the
  checklist can't drift from the script. It treats the server's data as claims and checks them
  against the chain. Tests tamper with PnL, outcome, intent JSON, a hidden trade, a rewritten
  prediction and a fake lock tx, and each one fails.
- Entry verification page, leaderboards page, rewards and claim page.
- `scripts/verify.ts` (`pnpm verify <entryId>`), needing no keys. On Base it re-verifies each 0G
  decision with the 0G SDK.
- `scripts/seed-replay.ts` (`pnpm seed:replay [--clear]`): labeled replay rows from
  `apps/server/fixtures/replay.json`. The agents have no keys, are paused and can't earn.
- Reward claim txs are now recorded (`claim_tx` was never written before).
- `pnpm dev` now mints mock USDC to dev wallets and fills the reward pool; before, a fresh local
  run couldn't fund an agent or pay rewards.
- `Dockerfile`, `.dockerignore`, `render.yaml`.
- README, `docs/ARCHITECTURE.md` and the contracts README rewritten; they still described the
  starter template.
- CI now runs `e2e:happy` and the web build.

**Bugs fixed:**

- `pnpm codegen`, `pnpm dev` and `pnpm e2e:happy` all failed on your machine because the repo path
  has a space ("Web development") and wagmi's plugin runs forge through an unquoted shell command.
  CI couldn't see this.
- Leaderboard columns ran together on phones.

## Not verified

These could only be checked up to the point real services are needed:

- **`verify.ts` against live Flash.** The fill and USDC steps are unit-tested with a simulated
  chain only, because the local stub moves no USDC. They assume real USDC transfers from the agent
  match Flash's reported amounts within 5 bps (`FILL_TOLERANCE_BPS`). If Flash reports amounts
  before fees, that step will show FAIL on real trades: treat it as a sign that stored PnL is not
  net of fees, not as noise. Check it on the first live trade.
- **`verify.ts` against live 0G.** The SDK loads and reaches chain 16661 with a throwaway wallet,
  but `processResponse` has never seen a real chat ID. A false result fails the step.
- **Docker image.** The daemon wasn't running, so the image was never built. I ran its steps by hand
  on a clean copy of the repo (filtered install, then boot), and those worked. `render.yaml` is
  untested on Render.
- **Base configuration.** The server has never booted with `CHAIN_ID=8453`, because no contracts
  are deployed there yet.

## Known limitations

- A VOID for a changed policy is declared by the operator and can't be derived from chain data. In
  principle an owner could edit limits mid-round to void a losing entry. It's listed under trust
  assumptions in the README.
- Local `pnpm dev` runs real rounds, but the stub's price doesn't move, so entries resolve NO
  unless you move it (README has the curl).

## What only you can do

1. **Flash:** create an integrator key, run `scripts/flash-inspect.ts`, put its output in the server
   env and `VERIFIED.md`, set `TRADE_MIN_TP_PCT` above the measured fees, and fund a Base wallet.
2. **0G:** a Router key with trust mode Private, plus deposited 0G tokens.
3. **World:** a World ID 4.0 app (`app_id`, `rp_id`, signing key). Test with the simulator, and fill
   in the TODOs in `WORLD_FEEDBACK.md`.
4. **Neon:** a database and its `DATABASE_URL`.
5. **Deploy** server and web, and fund the pool: README "Deploy". Contracts are on Base (2026-11-07).
6. **README TODOs:** team names and contacts, live link, video link.
7. **Demo:** a video under 3 minutes, and a clip on Discord and X tagging @DefinitiveFi.
8. **Decisions:** Continuity status, whether to send Flash's agent intent reports, and the mentor
   questions in CLAUDE.md §9.
