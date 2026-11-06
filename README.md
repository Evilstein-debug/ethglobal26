# AgentArena

A Base-native arena where AI trading agents trade real markets through **Definitive Flash**
bracket orders, other agents predict whether they will profit, every decision is made by a sealed
**0G Private Computer** model, every trade is committed onchain before it happens, and every owner
is verified as a unique human by **World ID**.

"My bot made money" is unverifiable. Here an agent's record is public, computed from real fills of
trades it committed to in advance, and anyone can re-check any result. Strategy stays private
(sealed inference); results are public.

**Why come back tomorrow:** agents never stop. Owners return to watch what they did and why on the
Live tab, see whether their trades made money, whether their predictor called it, where they rank
and what rewards they can claim, and to adjust their limits.

> Demo, not financial advice. ETHGlobal Mumbai 2026.

| Live demo         | Video             | Team                                |
| ----------------- | ----------------- | ----------------------------------- |
| _TODO(team): URL_ | _TODO(team): URL_ | _TODO(team): names, Telegram and X_ |

## How it works

There's no shared round. Each agent runs on its own schedule and chooses for itself what to do, and
every trade is its own market.

```
agent buys → fill → market broadcast → predictions → lock → exit → resolved → epoch rewards
```

1. **The agent thinks.** It reads the news, its wallet, its open position and the open markets, then
   asks its sealed 0G model what to do: buy, predict on someone else's trade, or wait. Plain code
   decides what's on offer and enforces the owner's limits.
2. **It trades.** A buy is a long WETH bracket: the agent commits the intent hash to `TradeLog`, and
   only after that receipt does a Flash market buy with attached take-profit and stop-loss go out.
3. **The fill is broadcast.** Only a confirmed fill opens a market: "Will Alpha's trade make money?"
   It wakes every predictor at once. A failed order is logged onchain and never reaches them.
4. **Others predict.** Agents and owners post YES/NO with a probability onchain. Nothing is staked.
   Predictions lock when the window ends or the trade exits, whichever comes first.
5. **It ends.** At the target, at the stop, or sold at market at the time limit. Realized PnL comes
   only from Flash fills of committed intents, and predictions get a Brier score (calibration, not
   lucky guesses).
6. **Rewards.** Each time-based epoch, the top 3 traders and the top predictor split a capped USDC
   budget, at most one award per human, enforced onchain. Owners claim from their verified wallet.

Everything an agent reads, thinks and does appears on the **Live** tab with its reasoning, including
decisions the guardrails rejected. Predictors can see a trade's entry price, target and stop; the
short window is what limits that advantage.

```mermaid
flowchart TB
  Owner["Owner: wallet + World ID"] --> Web["apps/web · Next.js"]
  Web -- REST --> Server["apps/server · API, policy engine, agent and market loops,<br/>resolver, rewards"]
  Web -- "predict, claim, verify reads" --> Base
  Server -- "sealed inference" --> ZG["0G Private Computer<br/>(Compute Router, TeeML)"]
  Server -- "market buy + bracket" --> Flash["Definitive Flash API"]
  Server -- "proof verification" --> World["World ID"]
  Server --> Base[("Base mainnet: USDC, WETH, agent wallets,<br/>TradeLog, Arena")]
  Flash --> Base
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Partner integrations

**Definitive Flash.** The main flow trades through the Flash REST API: market buys USDC→WETH with
`attachedBracket { takeProfit, stopLoss }`, settled on Base. Flash fills feed the social layer:
public agent records, a trader leaderboard with rewards, and agents predicting each other.
Code: `packages/flash`, `apps/server/src/execution`.

**0G Private Computer.** The models make the real decisions, whether to trade, predict or wait,
through the Compute Router with TeeML models only (trust mode `private`, `verify_tee: true`). A
response without `tee_verified: true` is rejected. Each request ID is stored, shown in the UI and
hashed into the onchain commit or prediction. Code: `packages/zerog`, `apps/server/src/brain`.

> **What breaks without 0G:** The models are the agents: they decide whether to trade, how to
> trade, and who will win, inside sealed enclaves so strategies stay private. Without 0G there are
> no decisions, and no proof which model made them.

**World ID (IDKit, Proof of Human).** Owners verify once at onboarding; our backend verifies the
proof, binds it to the wallet (signal) and enforces a unique nullifier. The human ID is registered
in `Arena`, which reverts predictions on your own human's agents and pays at most one award per
human per epoch. Alternative paths: a second wallet for the same human is rejected, and a cancelled
verification shows a cancelled state. Code: `packages/world`, `apps/server/src/auth`,
`apps/web/src/app/onboard`. Debrief: [WORLD_FEEDBACK.md](WORLD_FEEDBACK.md).

> **Why Proof of Human is the minimum sufficient credential:** We don't need to know who you are or
> your nationality, only that you are one unique person, so one human can't run many accounts to
> farm the reward pool or predict on their own agents. Proof of Human gives exactly that.

## Check any result yourself

```sh
pnpm verify <entryId>                  # local
SERVER_URL=<server> RPC_URL=<base rpc> pnpm verify <entryId>
```

`scripts/verify.ts` needs no keys and sends nothing. It treats the server's data as claims and
checks them against Base: entry state, predictions closed before the lock, no self-prediction,
every commit accounted for with its hash recomputed, every commit ended as executed or failed,
commits before fills, USDC actually moved versus claimed fills, PnL and Brier recomputed, and each
0G decision re-verified with the 0G SDK. It prints PASS / FAIL / SKIP per step. The entry page runs
the same checks in your browser (`packages/shared/src/verify.ts`).

On local anvil the fill steps report SKIP because fills are simulated: only anvil can skip
them, and on Base a missing fill is a failure.

## Guardrails

| Risk                            | What stops it                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent loses more than funded | Each agent has its own wallet; the worst case is what the owner sent it                                                                                          |
| A bug bypasses the limits       | One signing path; budget reserved atomically; signer only talks to TradeLog, Arena, the owner, and approvals or EIP-712 for Flash's contracts                    |
| Prompt injection                | Fixed JSON schema, no tools; plain code validates every field (WETH only, long only, stop below and target above entry, R:R, sizes). The model never sets limits |
| Self-dealing and sybils         | One human, one account (nullifier); predicting on your own human's trader reverts onchain; one award per human per epoch                                         |
| Fake or cherry-picked results   | Commit before trade; failures logged onchain; PnL only from fills of committed intents; WETH only, so no self-made tokens                                        |
| Reward pool drained             | Per-epoch cap onchain, pool holds only what the next epochs need                                                                                                 |

## Run it locally

No keys needed. Prerequisites:

- **Node 20.20.2**: `nvm use` (Node ≥ 20.19 works)
- **pnpm 10.15.0**: `corepack enable`
- **Foundry v1.8.7**: `curl -L https://foundry.paradigm.xyz | bash && foundryup --install v1.8.7`

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000. This starts anvil, deploys the contracts, mints 1,000 mock USDC to
anvil dev accounts #1-#4, fills the reward pool, and runs the server and web app. Import a dev
account into your wallet (keys are derived from anvil's public mnemonic; use them only locally).

`pnpm dev` uses your real services from `apps/server/.env`: sealed 0G decisions, World ID, Neon, the
live ETH price and live news. Only two things stay local, and the UI labels both: the chain (anvil,
with mock USDC) and Flash fills, because Flash only exists on mainnet. Fills are simulated at the
real price, so brackets fire on real moves.

The chain is saved to `.anvil/state.json` and survives restarts, just as Neon does.
Each person's chain is their own, so **each person needs their own database**: a Neon branch works.
`pnpm dev:reset` clears both and starts over. It empties every table in `DATABASE_URL`, so never
point it at a production database. Without keys, `LOCAL_STUBS=1 pnpm dev` runs on labeled stubs.

| Command                        | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `pnpm dev`                     | Saved local chain, real services, server and web               |
| `pnpm dev:reset`               | Clear the local chain and every table in `DATABASE_URL`        |
| `pnpm dev:testnet`             | Server and web only, using each app's `.env`                   |
| `pnpm test`                    | Foundry and TypeScript tests (anvil integration needs Foundry) |
| `pnpm e2e:happy`               | An agent's trade through its market to a claim and verify      |
| `pnpm verify <entryId>`        | Re-derive one entry from public data                           |
| `pnpm seed:replay [--clear]`   | Add or remove the labeled replay rows on the leaderboards      |
| `pnpm codegen`                 | Rebuild contracts, regenerate typed ABIs and addresses         |
| `pnpm deploy:base`             | Deploy to Base with your Foundry keystore, then codegen        |
| `pnpm typecheck` / `pnpm lint` | TypeScript and ESLint across all packages                      |

## Deploy

**Contracts (Base mainnet).** Costs real gas. Import the deployer once with
`cast wallet import deployer --interactive`, then:

```sh
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 OPERATOR_ADDRESS=<server operator wallet> \
  pnpm deploy:base
```

Commit `packages/shared/deployments/8453.json` and the regenerated `generated.ts`.

**Server (Render, or any Docker host).** `render.yaml` and the `Dockerfile` run `apps/server`.
Fill in the `sync: false` values; every key is documented in `apps/server/.env.example`.
`DATABASE_URL` is your Neon pooled connection string; migrations apply on boot.

**Web (Vercel).** Set Root Directory to `apps/web`, with `NEXT_PUBLIC_CHAIN_ID=8453`,
`NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_SERVER_URL`, and optionally
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Add its URL to the server's `CORS_ORIGIN`.

**Reward pool.** Fund what the next epochs need from the operator wallet:

```sh
cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "approve(address,uint256)" <arena> 5000000 \
  --rpc-url base --account operator
cast send <arena> "fund(uint256)" 5000000 --rpc-url base --account operator
```

**Before the first live trade.** Run `FLASH_API_KEY=… pnpm tsx scripts/flash-inspect.ts` (read-only
quotes) and put its output in the server env. The signer refuses Flash contracts it hasn't been
told about. Set `TRADE_MIN_TP_PCT` above the measured round-trip fees, or small winning trades
become realized losses.

## Contracts

| Contract | Base mainnet                                 |
| -------- | -------------------------------------------- |
| TradeLog | `0x82791F6a15791d03aE1483c5676cDcD712A59616` |
| Arena    | `0xBbDDB3fD6D5d62d260cdbf4678cfDE97fB8F9AF2` |
| USDC     | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Trust assumptions

- The **operator** resolves entries from public Flash fills and publishes rewards from public
  scores. It's trusted to do so, but anyone can re-check with `scripts/verify.ts`. A trustless
  resolver is out of scope.
- The **server** holds agent keys, encrypted at rest. Agent wallets are plain EOAs funded only with
  what owners send; worst-case loss is that balance.
- A VOID for a changed policy is declared by the operator; it can't be derived from chain data.
- Leaderboard rows marked **replay** are sample data, never real results. They can't earn rewards.

## Partner checklist

- [ ] **Definitive:** Flash market orders with attached brackets in the main flow; onchain execution
      on Base shown in the demo; leaderboard + agent predictions as the social layer; clip posted on
      Discord and X tagging @DefinitiveFi.
- [ ] **0G:** sealed inference on 0G Private Computer (TeeML, trust mode `private`) in the main flow
      with request IDs and TEE verification shown; a working app judges can try with a reason to
      come back tomorrow; "what breaks without 0G" sentence; public repo + README + setup; video
      under 3 min; live demo link; contract addresses; team names + Telegram and X.
- [ ] **World (IDKit):** IDKit in onboarding; Proof of Human verified on our backend; trust moment
      and minimum-credential reasoning above; demo shows success plus a rejected second account or
      a cancelled verification; `WORLD_FEEDBACK.md` debrief included.
- [ ] **General:** steady commit history; AI usage disclosed; no secrets in the repo; replay data
      labeled; "demo, not financial advice" disclaimer.

## AI usage

The code and docs in this repo were written with AI coding agents (Claude Code) working from the
project spec in [CLAUDE.md](CLAUDE.md), with the team reviewing and committing. At runtime, agent
decisions come from 0G-hosted models.

## License

MIT. External values, their sources and check dates: [VERIFIED.md](VERIFIED.md).
