/**
 * Server database (Postgres via Drizzle: Neon in production, in-process PGlite locally and in
 * tests). Conventions:
 * - USDC amounts are integers in base units (6 decimals): `usdc_*` / `*_cap` / `amount`.
 * - Times are unix milliseconds.
 * - Addresses are stored lowercase.
 * - Every external call result (0G request ID, Flash order ID, tx hash) gets persisted; the demo
 *   and verify.ts need them.
 * After editing: `pnpm --filter @starter/server db:generate` and commit the new migration.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const now = sql`(extract(epoch from now()) * 1000)::bigint`
/** Unix ms or USDC base units: bigint columns read back as JS numbers (safe below 2^53). */
const num = (name: string) => bigint(name, { mode: 'number' })
const createdAt = () => num('created_at').notNull().default(now)
const updatedAt = () => num('updated_at').notNull().default(now)

/** One row per World-verified human. Unique nullifier = one human, one account. */
export const owners = pgTable('owners', {
  wallet: text('wallet').primaryKey(),
  worldNullifierHash: text('world_nullifier_hash').notNull().unique(),
  /** keccak256(nullifier_hash); the id registered in Arena. */
  humanId: text('human_id').notNull().unique(),
  verifiedAt: num('verified_at').notNull(),
  /** 'world' (IDKit proof) or 'dev' (local anvil only, labeled in the API). */
  verifyMethod: text('verify_method', { enum: ['world', 'dev'] })
    .notNull()
    .default('world'),
  /** Arena.registerOwner tx. */
  registerTx: text('register_tx'),
  createdAt: createdAt(),
})

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    ownerWallet: text('owner_wallet')
      .notNull()
      .references(() => owners.wallet),
    name: text('name').notNull(),
    mode: text('mode', { enum: ['trade', 'predict', 'both'] }).notNull(),
    address: text('address').notNull().unique(),
    /** AES-GCM encrypted private key (MASTER_KEY); never logged, never returned by the API. */
    encKey: text('enc_key').notNull(),
    status: text('status', { enum: ['active', 'paused'] })
      .notNull()
      .default('active'),
    registerTx: text('register_tx'),
    createdAt: createdAt(),
  },
  (t) => [index('agents_owner_idx').on(t.ownerWallet)],
)

/** Owner-set limits. The model never sets these. */
export const policies = pgTable('policies', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id),
  perTradeCap: num('per_trade_cap').notNull(),
  roundTradeCap: num('round_trade_cap').notNull(),
  dailyCap: num('daily_cap').notNull(),
  /** JSON array of TradeAsset symbols, e.g. ["WETH"]. */
  tokenAllowlist: text('token_allowlist').notNull().default('["WETH"]'),
  predictionsPerRound: integer('predictions_per_round').notNull().default(10),
  paused: boolean('paused').notNull().default(false),
  updatedAt: updatedAt(),
})

/** Budget reservations: reserve before signing, settle on fill, release on failure. */
export const spendLedger = pgTable(
  'spend_ledger',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    roundId: integer('round_id').notNull(),
    kind: text('kind', { enum: ['trade'] }).notNull(),
    amount: num('amount').notNull(),
    status: text('status', { enum: ['reserved', 'settled', 'released'] }).notNull(),
    /** intents.intent_id this reservation backs. */
    ref: text('ref').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('spend_agent_idx').on(t.agentId, t.status)],
)

export const rounds = pgTable('rounds', {
  id: integer('id').primaryKey(),
  phase: text('phase', {
    enum: ['REGISTRATION', 'PREDICTING', 'TRADING', 'RESOLVING', 'SETTLED'],
  }).notNull(),
  epochId: integer('epoch_id').notNull(),
  startsAt: num('starts_at').notNull(),
  phaseEndsAt: num('phase_ends_at').notNull(),
  lockTx: text('lock_tx'),
})

/** A trader agent opted into a round. Predictions target entries. */
export const roundEntries = pgTable(
  'round_entries',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    roundId: integer('round_id')
      .notNull()
      .references(() => rounds.id),
    traderAgentId: text('trader_agent_id')
      .notNull()
      .references(() => agents.id),
    onchainEntryId: integer('onchain_entry_id').unique(),
    /** Policy snapshot taken at REGISTRATION; a mismatch at resolution voids the entry. */
    policySnapshot: text('policy_snapshot').notNull(),
    policySnapshotHash: text('policy_snapshot_hash').notNull(),
    tradeBudget: num('trade_budget').notNull(),
    outcome: text('outcome', { enum: ['PENDING', 'YES', 'NO', 'VOID'] })
      .notNull()
      .default('PENDING'),
    pnlBps: integer('pnl_bps'),
    voidReason: text('void_reason'),
    allocationDecisionId: text('allocation_decision_id').references(() => decisions.id),
    openTx: text('open_tx'),
    resolveTx: text('resolve_tx'),
  },
  (t) => [uniqueIndex('entries_round_trader_uq').on(t.roundId, t.traderAgentId)],
)

export const intents = pgTable(
  'intents',
  {
    intentId: text('intent_id').primaryKey(),
    roundId: integer('round_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    entryId: integer('entry_id').references(() => roundEntries.id),
    /** The exact canonical JSON that was hashed and committed. */
    canonicalJson: text('canonical_json').notNull(),
    intentHash: text('intent_hash').notNull().unique(),
    state: text('state', {
      enum: ['DRAFT', 'COMMITTED', 'EXECUTING', 'EXECUTED', 'CLOSED', 'FAILED'],
    }).notNull(),
    asset: text('asset').notNull(),
    sizeQuote: num('size_quote').notNull(),
    entryRefPrice: text('entry_ref_price').notNull(),
    stopPrice: text('stop_price').notNull(),
    targetPrice: text('target_price').notNull(),
    decisionId: text('decision_id').references(() => decisions.id),
    commitTx: text('commit_tx'),
    recordTx: text('record_tx'),
    failReason: text('fail_reason'),
    flashOrderId: text('flash_order_id'),
    flashBracketOrderId: text('flash_bracket_order_id'),
    flashCloseOrderId: text('flash_close_order_id'),
    entryFillTx: text('entry_fill_tx'),
    exitFillTx: text('exit_fill_tx'),
    /** Realized amounts from Flash fills, USDC base units. */
    usdcSpent: num('usdc_spent'),
    usdcReceived: num('usdc_received'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('intents_round_agent_idx').on(t.roundId, t.agentId)],
)

export const predictions = pgTable(
  'predictions',
  {
    predictionId: text('prediction_id').primaryKey(),
    roundId: integer('round_id').notNull(),
    entryId: integer('entry_id')
      .notNull()
      .references(() => roundEntries.id),
    predictorKind: text('predictor_kind', { enum: ['agent', 'owner'] }).notNull(),
    predictorAddress: text('predictor_address').notNull(),
    agentId: text('agent_id').references(() => agents.id),
    side: text('side', { enum: ['YES', 'NO'] }).notNull(),
    probYesBps: integer('prob_yes_bps').notNull(),
    canonicalJson: text('canonical_json').notNull(),
    decisionId: text('decision_id').references(() => decisions.id),
    predictTx: text('predict_tx'),
    /** Brier score once the entry resolves (lower is better); null while pending or VOID. */
    brier: doublePrecision('brier'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('predictions_entry_predictor_uq').on(t.entryId, t.predictorAddress)],
)

/** Every 0G Router call, accepted or rejected: the audit trail behind each decision. */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    roundId: integer('round_id').notNull(),
    kind: text('kind', { enum: ['allocation', 'trade', 'prediction'] }).notNull(),
    model: text('model').notNull(),
    /** x_0g_trace.request_id */
    requestId: text('request_id').notNull().unique(),
    /** x_0g_trace.provider (onchain provider address) */
    provider: text('provider').notNull(),
    /** ZG-Res-Key header; input to independent TEE verification. */
    chatId: text('chat_id'),
    teeVerified: boolean('tee_verified'),
    rawOutput: text('raw_output').notNull(),
    accepted: boolean('accepted').notNull(),
    rejectReason: text('reject_reason'),
    latencyMs: num('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('decisions_agent_round_idx').on(t.agentId, t.roundId)],
)

export const agentStats = pgTable(
  'agent_stats',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    role: text('role', { enum: ['trader', 'predictor'] }).notNull(),
    rounds: integer('rounds').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    voids: integer('voids').notNull().default(0),
    pnlBpsTotal: integer('pnl_bps_total').notNull().default(0),
    brierSum: doublePrecision('brier_sum').notNull().default(0),
    brierCount: integer('brier_count').notNull().default(0),
    /** Rows derived from labeled replay data, never mixed silently with live results. */
    replay: boolean('replay').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.role, t.replay] })],
)

export const rewardEpochs = pgTable('reward_epochs', {
  id: integer('id').primaryKey(),
  startsAt: num('starts_at').notNull(),
  endsAt: num('ends_at').notNull(),
  budget: num('budget').notNull(),
  status: text('status', { enum: ['open', 'computed', 'published'] })
    .notNull()
    .default('open'),
  publishTx: text('publish_tx'),
})

/** At most one award per human per epoch (mirrors the onchain rule). */
export const rewardAwards = pgTable(
  'reward_awards',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    epochId: integer('epoch_id')
      .notNull()
      .references(() => rewardEpochs.id),
    humanId: text('human_id').notNull(),
    ownerWallet: text('owner_wallet')
      .notNull()
      .references(() => owners.wallet),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    category: text('category', { enum: ['trader', 'predictor'] }).notNull(),
    rank: integer('rank').notNull(),
    amount: num('amount').notNull(),
    claimTx: text('claim_tx'),
  },
  (t) => [uniqueIndex('awards_epoch_human_uq').on(t.epochId, t.humanId)],
)
