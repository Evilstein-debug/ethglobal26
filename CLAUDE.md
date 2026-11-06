# AgentArena: Project Context for Coding Agents

> Working title, rename freely. Event: ETHGlobal Mumbai 2026. Submissions due **Sunday Nov 8, 09:00 IST** (aim for 07:00). Status: building in phases (section 8).
>
> **How to use this doc:** sections 1-6 are context, section 7 is what to build layer by layer, section 8 is the order of work, section 9 lists open questions and what has been answered.
>
> **Do not invent partner API details, contract addresses or chain IDs.** Every external value lives in `VERIFIED.md` with its source and check date. If a doc contradicts this file, the doc wins; flag the conflict to the team.
>
> **Design v3 (2026-11-06).** The original real-money prediction market was replaced by a **trader leaderboard with a capped reward pool** plus **free (no-stake) predictions**. Reasons: Flash has no testnet so every market would need real house money, real-money betting by agents raised legal questions (old Q5), and the smaller scope fits the deadline. Flash is spot-only, so **trades are long-only**.

---

## 1. Hackathon context and constraints

We submit one project to three partner prizes. ETHGlobal allows at most 3 partner picks, so **do not add other partners**.

| Partner                  | Prize                                                                                                                | What judges need to see                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Definitive** (primary) | **Best Use of Flash Advanced Orders in a Social App** ($2,500, open to new projects)                                 | A working trading flow through the Flash API or Flash MCP using advanced orders (bracket, stop loss, take profit, TWAP, DCA, limit). Onchain execution in the final demo. A short demo video posted on **both Discord and X**, tagging **@DefinitiveFi**. Our social layer: public agent track records, a trader leaderboard with rewards, and a prediction game where people's agents call whether trading agents will profit.                                                                                           |
| **0G**                   | **Build with 0G Private Computer** ($5,000: $2.5k / $1.5k / $1k)                                                     | Inference on 0G Private Computer in the main user flow, **with request IDs**. A working app a judge can try, **with a clear reason someone comes back tomorrow**. One sentence on what breaks if 0G is removed. Public repo (README + setup), demo video **under 3 min**, live demo link, contract addresses, team names and contacts (Telegram and X). Not wanted: chat wrappers, AI that could be removed unnoticed.                                                                                                    |
| **World**                | **Best Use of IDKit** ($2,500, up to 2 teams × $1,250). Stretch: **World ID Agent Pass** ($5,000), see section 9, Q7 | Integrate IDKit in a functioning app. Use at least one World ID credential and **verify the result on the server or onchain**. Explain the specific product event that needs trust and why the chosen credential is the **minimum sufficient assurance**. Demo a successful verification **and one alternative path** (cancellation, rejection, ineligible user). Include a short **integration debrief**: time to first success, friction, missing capability or docs, and the one improvement with the greatest impact. |

**Continuity status (TODO team: confirm on the ETHGlobal dashboard).** This doc assumes we are **not** in the Continuity batch; all three prizes above are open to new projects. If we are Continuity participants, only work done during the event is judged and the README needs a "Before / During the hackathon" section.

Rules that shape the design:

- 0G rejects apps where the AI could be removed unnoticed. **The model makes the real decisions** (whether to trade this round and with how much, the trade parameters, and each prediction with its probability), inside hard limits enforced by code.
- World wants the credential to solve a real trust problem. Ours: **one real human per owner account**, so nobody can farm the reward pool or the predictor leaderboard with extra accounts, or predict on their own agents from a second account.
- One demo video **under 3 minutes** must satisfy all three partners.
- Commit history must show steady progress (the team commits after each phase). Disclose AI usage per ETHGlobal rules.

---

## 2. Product description

**One sentence:** a Base-native arena where AI trading agents trade real markets through Definitive Flash bracket orders, other agents predict whether they will profit, every decision is made by a sealed 0G model, every trade is committed before it happens, and every owner is verified as a unique human by World ID.

**Currency:** USDC on Base, everywhere. Owners fund agents with Base USDC; trade budgets and rewards are Base USDC. The only traded asset is **WETH** (an allowlist, so nobody can fake PnL with a token they control). No other tokens (including $EDGE).

**Why it is interesting:** "my bot made money" claims are unverifiable. Here a trading agent's results are public, computed from real onchain fills of trades it committed to in advance, and other agents publicly call whether it will win. Strategy stays private (sealed inference); results are public and checkable.

**Why someone comes back tomorrow (0G requirement):** rounds run every hour. Owners return to see whether their trader profited, whether their predictor called it, their leaderboard ranks, and rewards to claim, and to adjust limits for the next round.

### Actors

- **Owner**: a human (e.g. Bob) who connects a wallet, **verifies once with World ID**, creates agents, funds them with Base USDC and sets limits. Owners can also make manual predictions.
- **Agent**: an AI agent with its own wallet and an owner-set **mode**: `trade`, `predict` or `both`.
  - **Trader role**: decides each round whether to enter and with what budget; enters become **round entries**; trades through Flash market buys with attached brackets.
  - **Predictor role**: studies trader agents' histories, asks its 0G model, and predicts YES/NO with a probability on each entry. **No money is staked.**
- **Operator**: a platform wallet that opens entries, locks predictions, resolves entries and publishes reward epochs. It also funds the reward pool.
- **Platform services**: World verification, policy engine, agent workers, TradeLog and Arena contracts, scheduler, resolver, reward epochs, leaderboards.

### The question every entry asks

> **"Will agent X end round N with positive realized PnL (net of fees)?"** YES or NO.

### Scores and rewards

- **Traders** are ranked by net return over the epoch, with a minimum number of trades.
- **Predictors** are ranked by Brier score over resolved predictions (with a minimum count). Brier rewards calibrated probabilities, not lucky guesses.
- Each **reward epoch** (demo: hourly; live: daily) the top 3 traders and the top predictor split a capped budget (e.g. 5 USDC). **At most one award per human per epoch**, enforced onchain. Rewards are claimed by the owner's verified wallet.

---

## 3. Solution overview

```
   Owner (wallet + World ID) ---> Web App (Next.js) <--- Arena / Leaderboards / Rewards
                                        | REST
                  +---------------------v---------------------+
                  |              apps/server (Express)          |
                  | world-verify | agents | policy | scheduler |
                  | trader worker | predictor worker | resolver |
                  | reward epochs                               |
                  +----+-------------+-------------+-----------+
                       |             |             |
              +--------+---+   +-----+------+  +---+---------------------------+
              | 0G Private |   | Definitive |  | Base mainnet                  |
              | Computer   |   | Flash API  |  | USDC, WETH, agent wallets,    |
              | (decisions)|   | (trades)   |  | TradeLog + Arena contracts    |
              +------------+   +------------+  +-------------------------------+
              World ID (IDKit) -- verified on our backend
```

**Chain:** everything onchain is on **Base mainnet** (anvil locally). Flash supports mainnets only, so trades use tiny real USDC. TradeLog and Arena are on Base too, so "committed before executed" and "predictions closed before trading" are block-order checks on one chain.

### 3.1 Round lifecycle (state machine)

Rounds are short for the demo (default about **20 minutes total**, configurable).

```
REGISTRATION -> PREDICTING -> TRADING -> RESOLVING -> SETTLED
                                              |
                                              +-> entry VOID (no trades, snapshot mismatch, error)
```

| Phase                 | What happens                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REGISTRATION (~3 min) | Agents in `trade`/`both` mode ask 0G whether to trade this round and with how much (clamped by policy). Each opting-in trader gets a **round entry** (`Arena.openEntry`). Its policy is **snapshotted**.                       |
| PREDICTING (~4 min)   | Predictor agents read histories, ask 0G, and submit predictions onchain (`Arena.predict`). Owners can pick manually. Then `lockPredictions`: the contract rejects later predictions. Predictions close **before any trading**. |
| TRADING (~10 min)     | Traders make 0G decisions, commit each trade intent to TradeLog, then place a Flash market buy with an attached bracket. At the end of the phase, any open bracket is cancelled and the position is market-sold.               |
| RESOLVING             | The resolver computes each trader's realized PnL from Flash fills of this round's committed intents, resolves each entry on Arena, and scores predictions.                                                                     |
| SETTLED               | Stats and leaderboards update. Reward epochs are computed and published separately.                                                                                                                                            |

### 3.2 Trade intent lifecycle

```
DRAFT -> COMMITTED -> EXECUTING -> EXECUTED -> CLOSED
             |            |
             +-> FAILED <-+      (failures are logged too)
```

**Design rule:** every trade intent is committed onchain (TradeLog event) **before** the Flash order is sent, and failures are logged too. The resolver only counts fills from committed intents of that round, and a trader cannot hide a losing trade, because every commit must end in EXECUTED or FAILED.

### 3.3 End-to-end example

1. Bob connects his wallet, verifies with World ID (Proof of Human), creates **Alpha** (`trade` mode) and funds it with 20 USDC. Alice, also verified, creates **Beta** (`predict` mode).
2. Round 7 opens. Alpha's 0G model decides to trade with 10 USDC. Alpha gets entry #12: "Will Alpha end Round 7 in profit?"
3. Beta reads Alpha's history (past rounds, win rate, PnL, voids, failures), asks its 0G model, and predicts YES at 62%. The 0G request ID's hash is stored with the prediction onchain.
4. Predictions lock. Alpha's 0G model returns a long-WETH bracket. Code validates it, Alpha commits the intent hash to TradeLog, then places a Flash market buy with take-profit and stop-loss attached.
5. The take-profit fills. The resolver computes Alpha's realized PnL from the fills: positive. Entry #12 resolves YES. Beta's Brier score for this pick is (1 − 0.62)² = 0.144.
6. At the end of the epoch, Alpha ranks #1 among traders and Beta #1 among predictors. Bob and Alice each claim their reward from the pool.
7. If Bob had made a second account to predict on Alpha, World ID would have blocked it (same human, same nullifier). If Bob's own predictor tried, `Arena.predict` reverts (same human).

---

## 4. Challenges and fixes

| #   | Challenge                                                                                           | Fix (design decision)                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Owners' wallets don't give agents authority**, and handing an agent the owner's key is dangerous. | Each agent gets its **own wallet**, funded only with what the owner sends. Worst-case loss = that pool.                                                                                                                                                                                                                                                                          |
| 2   | **Limits in app code can be bypassed by a bug.**                                                    | Hard ceiling = wallet balance. The policy engine is the single code path that can sign. Budget is **reserved atomically** before any trade. The signer only sends txs to {TradeLog, Arena, owner} or USDC/WETH approvals to the Flash settlement contract, and only signs EIP-712 data whose domain is Flash's settlement contract. Flash approvals use `forceMinimalAllowance`. |
| 3   | **Self-dealing**: an owner farms predictor points or rewards from their own traders.                | **No predictions on entries whose trader belongs to the same human**, enforced **onchain** in Arena (human-ID registry) and in the policy engine. Policy is snapshotted at REGISTRATION; changes void the entry.                                                                                                                                                                 |
| 4   | **Sybil accounts** farm the reward pool or dodge rule 3.                                            | **World ID Proof of Human** at onboarding. One verified human = one owner account (World ID nullifier). Every agent is linked to its owner's human ID. **One award per human per epoch**, enforced onchain. This is our World "trust moment".                                                                                                                                    |
| 5   | **Fake or cherry-picked trading results.**                                                          | Commit-before-trade on TradeLog; failures logged; the resolver computes PnL only from Flash fills of committed intents, never from agent self-reports. A public `scripts/verify.ts` re-checks any entry.                                                                                                                                                                         |
| 6   | **Faking PnL with an illiquid token the owner controls.**                                           | Asset allowlist: **WETH only**.                                                                                                                                                                                                                                                                                                                                                  |
| 7   | **Prompt injection** via headlines or agent histories.                                              | Inputs are untrusted data. The LLM outputs JSON in a fixed schema only, no tools. **Plain code validates** every field (asset allowlist, long-only, stop below and target above entry, R:R range, size caps, prediction limits, phase). The model never sets limits. Injection fixtures in tests.                                                                                |
| 8   | **No real track record at a hackathon.**                                                            | Any seeded history is labeled **"replay"** in data and UI. Never present fabricated results as real.                                                                                                                                                                                                                                                                             |
| 9   | **Fees make most short trades lose**, so every entry resolves NO.                                   | Measure Flash fees at small sizes (Phase 3). Validation requires the take-profit distance to beat round-trip cost. TRADING length is configurable.                                                                                                                                                                                                                               |
| 10  | **Open positions at round end** make PnL ambiguous.                                                 | Brackets have tight targets; anything still open at the end of TRADING is closed (cancel the bracket, then market-sell). PnL is realized only.                                                                                                                                                                                                                                   |
| 11  | **Clock and ordering disputes.**                                                                    | All onchain events are on Base, so ordering is by block number / log index. Predictions lock onchain before TRADING begins.                                                                                                                                                                                                                                                      |
| 12  | **Reward pool drained by a bug.**                                                                   | Per-epoch cap enforced onchain; pool funded with only what the next epochs need; daily budget in config.                                                                                                                                                                                                                                                                         |

---

## 5. Data model

### 5.1 Canonical trade intent (hashed and committed)

Serialize with sorted keys, no whitespace, UTF-8, then keccak256. Implemented in `packages/shared/src/canonical.ts`; schema in `packages/shared/src/schemas.ts` (`tradeIntentSchema`). Decimal values are strings.

```json
{
  "version": 1,
  "intentId": "uuid",
  "roundId": 7,
  "agentAddress": "0x...",
  "asset": "WETH",
  "side": "long",
  "entryRefPrice": "3000.00",
  "sizeQuote": "5.00",
  "orderType": "bracket",
  "stopPrice": "2950.00",
  "targetPrice": "3060.00",
  "rationale": "short text from the model",
  "zeroG": { "requestId": "x_0g_trace.request_id", "model": "glm-5.3" },
  "createdAt": "ISO-8601"
}
```

`side` is always `long` (Flash is spot). `stopPrice` and `targetPrice` become the attached bracket's `stopLoss` and `takeProfit` legs (`notionalPrice`, USD).

### 5.2 Prediction (hashed; request ID hash onchain)

Schema: `predictionSchema` in `packages/shared/src/schemas.ts`.

```json
{
  "version": 1,
  "predictionId": "uuid",
  "roundId": 7,
  "entryId": 12,
  "predictorKind": "agent",
  "predictor": "0x...",
  "side": "YES",
  "probYesBps": 6200,
  "rationale": "short text from the model",
  "zeroG": { "requestId": "...", "model": "glm-5.3" },
  "createdAt": "ISO-8601"
}
```

`side` must agree with `probYesBps`. Agent predictions require `zeroG`; owner picks have `zeroG: null`.

### 5.3 Contracts on Base (Solidity, Foundry)

**TradeLog**

- `commit(uint256 roundId, bytes32 intentHash, bytes32 zeroGRequestIdHash)`: called by the agent wallet; emits `IntentCommitted(roundId, agent, intentHash, zeroGRequestIdHash)`.
- `recordExecution(bytes32 intentHash, bytes32 fillTxHash)` / `recordFailure(bytes32 intentHash, uint8 reason)`: only by the committing agent, once; emit `IntentExecuted` / `IntentFailed`.

**Arena** (operator role, SafeERC20, ReentrancyGuard, USDC)

- Registry: `registerOwner(address owner, bytes32 humanId)`, `registerAgent(address agent, bytes32 humanId)`. Operator only. `humanId = keccak256(world nullifier_hash)`.
- Rounds: `openEntry(uint256 roundId, address trader) returns (uint256 entryId)`, `lockPredictions(uint256 roundId)`, `resolveEntry(uint256 entryId, uint8 outcome, int256 pnlBps)` (YES / NO / VOID).
- Predictions (no money): `predict(uint256 entryId, bool yes, uint16 probYesBps, bytes32 zeroGRequestIdHash)`. Caller must be a registered agent or owner. **Reverts if `humanId(caller) == humanId(trader)`**, after the lock, or on a duplicate. Emits `Predicted`.
- Rewards: `fund(uint256 amount)`, `publishEpoch(uint256 epoch, bytes32[] humanIds, uint256[] amounts)` (total ≤ `epochCap`, ≤ unallocated pool balance, **one award per humanId per epoch**), `claim(uint256 epoch)` pays only the registered owner wallet of the caller's humanId, once.
- Parameters: `operator`, `epochCap`, USDC address (from config, see `VERIFIED.md`).

Trust assumption (state in README): the operator resolves entries from public Flash fills and publishes rewards from public scores; anyone can re-check with `scripts/verify.ts`. A trustless resolver is out of scope.

### 5.4 Database tables (SQLite, Drizzle; `apps/server/src/db/schema.ts`)

USDC amounts are integers in base units (6 decimals); times are unix ms.

- `owners(wallet, world_nullifier_hash UNIQUE, human_id UNIQUE, verified_at)`
- `agents(id, owner_wallet, name, mode, address UNIQUE, enc_key, status, register_tx)`
- `policies(agent_id, per_trade_cap, round_trade_cap, daily_cap, token_allowlist, predictions_per_round, paused)`
- `spend_ledger(id, agent_id, round_id, kind[trade], amount, status[reserved|settled|released], ref)`
- `rounds(id, phase, epoch_id, starts_at, phase_ends_at, lock_tx)`
- `round_entries(id, round_id, trader_agent_id, onchain_entry_id, policy_snapshot(+hash), trade_budget, outcome, pnl_bps, void_reason, allocation_decision_id, open_tx, resolve_tx)`
- `intents(...canonical fields, canonical_json, intent_hash, state, commit_tx, record_tx, flash_order_id, flash_bracket_order_id, flash_close_order_id, entry/exit fill tx, usdc_spent, usdc_received)`
- `predictions(...canonical fields, canonical_json, predict_tx, brier)`
- `decisions(id, agent_id, round_id, kind, model, request_id UNIQUE, provider, chat_id, tee_verified, raw_output, accepted, reject_reason, latency_ms)`: every 0G call, accepted or not
- `agent_stats(agent_id, role, replay, rounds, wins, losses, voids, pnl_bps_total, brier_sum, brier_count)`
- `reward_epochs(id, starts_at, ends_at, budget, status, publish_tx)`, `reward_awards(epoch_id, human_id UNIQUE per epoch, owner_wallet, agent_id, category, rank, amount, claim_tx)`

---

## 6. Principles for anyone editing this repo

- Smallest diff that does the job. Do not refactor unrelated files.
- Never log or commit secrets. Keys come from env or an encrypted store.
- Never fake data silently. Replay or mock data must be labeled in code and UI.
- The LLM suggests, **code decides**. Any change that lets model output bypass the guardrails is a bug.
- Every external call (0G, Flash, World, Base) returns an ID or hash. Persist it; the demo and submission need links.
- Write a unit test with every guardrail or contract change.
- Every external value goes in `VERIFIED.md` with its source.
- Coding agents do not commit; the team commits after each phase.

---

## 7. Layer-by-layer implementation

Stack: TypeScript pnpm monorepo (from the `eth-starter` template), Next.js + wagmi/viem + RainbowKit, Express 5 server + workers, viem for Base, Foundry for contracts, zod, Drizzle + SQLite, `openai` SDK pointed at the 0G Router, World IDKit (current package per World's docs).

```
/apps/web             Next.js UI
/apps/server          API, scheduler, trader/predictor workers, resolver, reward epochs
/packages/contracts   TradeLog.sol, Arena.sol, mocks/MockUSDC.sol (anvil only), tests, Deploy.s.sol
/packages/shared      canonical.ts, schemas.ts, tokens.ts, chains.ts, generated ABIs + addresses
/packages/flash       Definitive Flash REST client
/packages/zerog       0G Compute Router client
/packages/world       World ID verification helpers
/scripts              dev.ts, e2e-happy.ts, verify.ts, seed-replay.ts
```

### Layer 1: Owner onboarding (wallet + World ID)

- **Wallet connect** (wagmi). The connected address is the owner wallet.
- **World ID (IDKit), Proof of Human credential:** after connecting, the owner verifies once. The frontend runs the IDKit flow; the **backend verifies the proof** per World's docs (never trust a client-side result) and stores the nullifier hash.
- **One human = one account:** `owners.world_nullifier_hash` is unique. A second wallet from the same human is rejected ("This person already has an account"). This is the demo's World **alternative path**, along with a cancelled verification.
- **Why Proof of Human is the minimum sufficient credential (README sentence):** "We don't need to know who you are or your nationality, only that you are one unique person, so one human can't run many accounts to farm the reward pool or predict on their own agents. Proof of Human gives exactly that."
- On success: `humanId = keccak256(nullifier_hash)`, `Arena.registerOwner(owner, humanId)`, and `Arena.registerAgent(agent, humanId)` for each new agent.
- Write `WORLD_FEEDBACK.md` (the debrief) as you go: time to first success, friction, missing docs or capability, top improvement.

### Layer 2: Agent wallets

- `POST /agents` (verified owners only) generates a secp256k1 key server-side, stores it encrypted (AES-GCM, `MASTER_KEY`), returns the address.
- **Funding:** the owner sends Base USDC (plus a little ETH for approval and commit gas) to the agent address. The UI reads balances from chain.
- **Withdraw / pause:** withdraw only to the owner address. Pause stops all signing immediately. Never withdraw WETH while a bracket is live (the exit would fail).
- **Signer allowlist:** transactions only to {TradeLog, Arena, owner}, or USDC/WETH `approve` to the Flash settlement contract; EIP-712 signatures only for Flash's settlement domain with the agent as funder. Agent wallets stay plain EOAs (no EIP-7702 delegation).

### Layer 3: Policy engine and spend ledger (the only path to signing)

```ts
// pseudo
async function authorizeTrade(agent, intent /* {amount, asset, roundId} */) {
  return db.tx(async (tx) => {
    const p = await getPolicy(tx, agent.id)
    if (p.paused) return deny('paused')
    if (!p.tokenAllowlist.includes(intent.asset)) return deny('asset_not_allowed')
    if (intent.amount > p.perTradeCap) return deny('over_trade_cap')
    if ((await roundSpent(tx, agent.id)) + intent.amount > p.roundTradeCap)
      return deny('over_round_trade_cap')
    if ((await daySpent(tx, agent.id)) + intent.amount > p.dailyCap) return deny('over_daily_cap')
    if (intent.amount > (await usdcBalance(agent.address))) return deny('insufficient_funds')
    const r = await reserve(tx, agent.id, intent) // atomic; settle on fill, release on failure
    return allow(r.id)
  })
}
// Predictions spend no money but are still checked: paused, phase, same-human, per-round limit.
```

Every deny returns a machine-readable reason, and the UI shows it (a demo moment).

### Layer 4: The 0G brain (three decision types)

0G Private Computer is the **0G Compute Router**: `https://router-api.0g.ai/v1`, OpenAI-compatible, `sk-` API key from pc.0g.ai (details and sources in `VERIFIED.md`).

- **Sealed inference only:** TeeML models (default `glm-5.3`), header `X-0G-Provider-Trust-Mode: private` and the API key set to Private, `verify_tee: true`, `response_format: {type: "json_object"}`. Reject any response with `tee_verified === false`. Never use `standard`-tier models (Claude, GPT and others are there): they carry no attestation.
- Persist per call: `x_0g_trace.request_id`, `provider`, the `ZG-Res-Key` chat ID, model, `tee_verified`, raw output, latency. Hash the request ID into the onchain commit or prediction.

Decisions:

1. **Allocation** (REGISTRATION, `trade`/`both` agents): given balance, own history and policy caps, return `{ trade: bool, tradeBudget }`. Clamped to caps.
2. **Trade** (TRADING): given live price (Flash `/search`) and labeled fixture headlines, return a long bracket intent (schema 5.1) or `{ action: "hold" }`. Validate: allowlisted asset, stop below and target above entry, R:R in range, take-profit distance beats measured round-trip cost, size within caps. **Clamp or reject, never trust.**
3. **Prediction** (PREDICTING, `predict`/`both` agents): given each entry's trader history (rounds, win rate, PnL, voids, failures), return `{ entryId, side, probYesBps }` per entry (schema 5.2). Validate against the same-human rule and per-round limit.

- **What breaks without 0G (README sentence):** "The models are the agents: they decide whether to trade, how to trade, and who will win, inside sealed enclaves so strategies stay private. Without 0G there are no decisions, and no proof which model made them."
- `scripts/verify.ts` re-verifies each decision independently with `@0gfoundation/0g-compute-ts-sdk` (`processResponse(provider, chatID)`).
- **Fallback:** keep the client behind an `LLMClient` interface; switching between TeeML models is a config change. 0G stays the only provider.
- MVP inputs: a **labeled fixture file** of headlines plus live prices. Live news scraping is a stretch goal.

### Layer 5: Execution (Definitive Flash)

Docs: `https://flash.definitive.fi/docs` (index: `/docs/llms.txt`, spec: `/v1/openapi.json`). Facts and sources in `VERIFIED.md`.

- `packages/flash`: REST client for `/search`, `/quote`, `/order`, `/orders/{id}`, cancel, typed from the OpenAPI spec. The **Flash MCP** (`@definitive-fi/flash-mcp`) is a dev tool and reference implementation only: it has no attached-bracket tool and holds a single funder key.
- **Trade = market buy USDC→WETH with `attachedBracket { takeProfit, stopLoss }`** (`notionalPrice` legs). One quote returns two EIP-712 payloads (entry and pair); sign both with the agent wallet; one submit.
- Quote with `evmUsePermit2: false` and `forceMinimalAllowance: true`. Send `evm.approveTx` (USDC) and `attachedBracket.evm.approveTx` (WETH) when returned.
- Attach our integrator fee (`flashIntegratorFeeBps`, same string on quote and submit) with our own Flash key (Definitive account → More → Flash → Create Flash Key).
- **Sequence enforced in code:** `authorize` → `TradeLog.commit` (wait for the receipt) → quote → approvals → sign → submit → poll → `recordExecution` / `recordFailure`. A test must fail if an order is placed without a prior commit.
- Persist order ID, `bracketOrderId`, fill tx hashes (`fills[].transactionId`) and notional amounts.
- **Close at the end of TRADING:** cancel the bracket order, then market-sell the WETH. Expiry alone does not sell.

### Layer 6: Round scheduler

- A worker drives phases on a timer: REGISTRATION → PREDICTING → TRADING → RESOLVING → SETTLED.
- REGISTRATION: allocation decisions, policy snapshots, `openEntry`. PREDICTING: predictor workers, then `lockPredictions`. TRADING: trader workers, then close all positions.
- Round length and phase durations come from config (demo default: 3 / 4 / 10 min + resolution). Live: one round per hour.

### Layer 7: Resolver and rewards

- For each entry: collect the trader's committed intents for the round, match them to Flash fills, compute realized PnL in bps net of fees.
- Outcome: PnL > 0 → YES; PnL ≤ 0 → NO; zero trades, a snapshot mismatch or a resolution error → VOID.
- Call `Arena.resolveEntry`, score predictions (Brier), update `agent_stats`.
- Reward epoch: rank traders (net return, min trades) and predictors (Brier, min count), keep one award per human, `publishEpoch` within the cap. Owners claim.
- `scripts/verify.ts <entryId>` re-derives the outcome from public Base data, Flash fills and 0G TEE verification, and prints PASS/FAIL per step. Judges can run it.

### Layer 8: Frontend

Pages:

- **Onboard:** connect, verify with World ID, show success, "already registered" and "cancelled" states.
- **Create Agent:** mode, limits, funding.
- **Agent profile:** public track record, balance, limits used, activity feed with 0G request IDs (TEE badge) and BaseScan links; pause and withdraw for the owner.
- **Arena:** current round and phase countdown, entries with the prediction split, manual owner picks.
- **Entry detail:** a verification checklist (commits before fills, fills match intents, PnL math, TEE verified) with real checks.
- **Leaderboards:** traders and predictors; losses and voids shown; replay rows labeled.
- **Rewards:** pool balance, current epoch, claim.

No mocked verification steps. Every page footer: "Demo, not financial advice."

### Layer 9: Ops, tests, submission

- **Required tests:**
  - Contract: same-human predict revert, late predict revert, duplicate predict, epoch cap, one award per human per epoch, claim only by the owner and only once, TradeLog ordering.
  - Backend: guardrails with prompt-injection fixtures, "no order without prior commit", budget reservation race, typed-data domain refusal, canonical hash determinism.
  - World: verification is rejected when the proof is invalid or the nullifier is reused.
- **Config:** every `.env.example` documents its keys (0G, Flash, World app ID/action, Base RPC, operator key, DB, master key). No secrets in git.
- **README:** setup, architecture diagram, partner checklist (section 10), contract addresses, the "what breaks without 0G" sentence, the World credential justification, trust assumptions, disclaimers, AI-usage disclosure, team contacts (Telegram and X). Plus `WORLD_FEEDBACK.md`.
- **Demo (under 3 min):**
  1. An owner verifies with World ID; a second-account attempt is rejected.
  2. Agents are created and funded with Base USDC.
  3. The round opens; the 0G allocation decision shows its request ID and TEE badge.
  4. A predictor's 0G prediction lands onchain; a same-human prediction reverts.
  5. The trader commits to TradeLog, then a Flash market buy with an attached bracket lands on Base (BaseScan link).
  6. The round resolves from fills; predictions are scored; the leaderboards update.
  7. An owner claims an epoch reward.
- Post a short clip on **Discord and X** tagging **@DefinitiveFi**.

---

## 8. Build order and acceptance criteria

Each phase ends at a checkable gate; the team reviews and commits after each. **M1-M4 are the must-have demo.** Full plan: `~/.claude/plans/refer-claude-md-and-build-rustling-wall.md` (local to the coding agent).

| Phase | Milestone               | Deliverable                                                                                                         | Done when                                                                                                       |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0     | **M0** Skeleton         | Starter repurposed: Base + anvil, token map, canonical hashing + schemas, DB, env files, partner package stubs      | `pnpm dev` boots; `pnpm test`, `pnpm typecheck`, `pnpm e2e:happy` green                                         |
| 1     | Contracts               | TradeLog, Arena, tests, deploy script                                                                               | `forge test` green; codegen emits both ABIs                                                                     |
| 2     | Wallets + policy        | Encrypted agent keys, signer allowlist, policy engine, ledger                                                       | On anvil an over-cap intent is denied with its reason; a valid one reserves budget                              |
| 3     | **M1** Trade core       | Flash client, commit → bracket trade → close                                                                        | One tiny bracket trade lands on Base after its commit; close works                                              |
| 4     | **M2** 0G brain         | Allocation, trade and prediction decisions on 0G, validation, request IDs                                           | Real decisions with `tee_verified: true` drive a trade and an onchain prediction; bad outputs rejected in tests |
| 5     | **M3** Rounds + rewards | Scheduler, resolver, prediction scoring, reward epochs                                                              | One full round + epoch completes on Base and an owner claims                                                    |
| 6     | **M4** World            | IDKit onboarding, backend verification, nullifier uniqueness, registry                                              | A second account is rejected; a same-human prediction reverts onchain                                           |
| 7     | **M5** UI               | Arena, entry detail, leaderboards, rewards                                                                          | A judge can watch a round and epoch end to end                                                                  |
| 8     | **M6** Polish           | `verify.ts`, README, WORLD_FEEDBACK.md, video, social clip                                                          | Section 10 checklist complete                                                                                   |
| —     | Stretch                 | World Agent Pass approval for large trades (with a denied path), news scraping, share cards for X, follow/watchlist | —                                                                                                               |

If time runs short: keep M0-M4, fixture headlines with **real** 0G calls, and a **labeled replay** history for the leaderboards.

---

## 9. Open questions (verify before relying on them)

Answered (2026-11-06, details and sources in `VERIFIED.md`):

- ~~Q2 Flash~~: no testnet (FAQ: use small amounts on Base); Base supported; server-held EOA keys can sign the typed data; brackets attach to a market entry and activate on fill; closing = cancel the bracket + market sell. **Still open:** minimum order size and fees at $2-10 (Phase 3 spike) and the Base settlement contract address.
- ~~Q4 0G~~: Private Computer = Compute Router; request ID = `x_0g_trace.request_id`; third parties verify via `processResponse(provider, chatID)`; credits = 0G tokens deposited on pc.0g.ai (ask the 0G team about hackathon credits). **Still open:** latency and JSON reliability of `glm-5.3` (Phase 4 spike).
- ~~Q5 market chain and legality~~: moot. No money is staked on predictions; rewards are prizes from our pool.
- ~~Q8 USDC on Base~~: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` from Circle's docs.

Open:

1. **Continuity status:** are we in the Continuity batch?
2. **Definitive "social":** confirm with a Definitive mentor that public track records + leaderboard + agent predictions count as a social app.
3. **World IDKit:** current package and verification endpoint; whether the simulator or staging works for the demo; how the nullifier is scoped (per app and action).
4. **World prizes:** can one project enter both "Best Use of IDKit" and "World ID Agent Pass"?
5. **Prediction rewards:** confirm with mentors that paying top predictors from our pool (free to enter) is acceptable; if not, predictors earn reputation only.
6. **Flash agent-reporting policy:** Flash's docs ask AI agents to send intent reports to Definitive. Decide as a team whether to; the app does not do it automatically.

---

## 10. Partner qualification checklist (copy into README)

- [ ] **Definitive:** Flash market orders with attached brackets in the main flow; onchain execution on Base shown in the demo; leaderboard + agent predictions as the social layer; clip posted on Discord and X tagging @DefinitiveFi.
- [ ] **0G:** sealed inference on 0G Private Computer (TeeML, trust mode `private`) in the main flow (allocation, trade and prediction decisions) with request IDs and TEE verification shown; a working app judges can try with a reason to come back tomorrow; "what breaks without 0G" sentence; public repo + README + setup; video under 3 min; live demo link; contract addresses; team names + Telegram and X.
- [ ] **World (IDKit):** IDKit in the onboarding flow; Proof of Human verified on our backend; README explains the trust moment (one human per account, so no farming the reward pool or predicting on your own agents) and why Proof of Human is the minimum sufficient credential; demo shows success plus a rejected second account or a cancelled verification; `WORLD_FEEDBACK.md` debrief included.
- [ ] **General:** steady commit history; AI usage disclosed; no secrets in the repo; replay data labeled; "demo, not financial advice" disclaimer.
