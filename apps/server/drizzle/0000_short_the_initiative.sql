CREATE TABLE "agent_stats" (
	"agent_id" text NOT NULL,
	"role" text NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"voids" integer DEFAULT 0 NOT NULL,
	"pnl_bps_total" integer DEFAULT 0 NOT NULL,
	"brier_sum" double precision DEFAULT 0 NOT NULL,
	"brier_count" integer DEFAULT 0 NOT NULL,
	"replay" boolean DEFAULT false NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "agent_stats_agent_id_role_replay_pk" PRIMARY KEY("agent_id","role","replay")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_wallet" text NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"address" text NOT NULL,
	"enc_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"register_tx" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "agents_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"round_id" integer NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"request_id" text NOT NULL,
	"provider" text NOT NULL,
	"chat_id" text,
	"tee_verified" boolean,
	"raw_output" text NOT NULL,
	"accepted" boolean NOT NULL,
	"reject_reason" text,
	"latency_ms" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "decisions_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"agent_id" text NOT NULL,
	"entry_id" integer,
	"canonical_json" text NOT NULL,
	"intent_hash" text NOT NULL,
	"state" text NOT NULL,
	"asset" text NOT NULL,
	"size_quote" bigint NOT NULL,
	"entry_ref_price" text NOT NULL,
	"stop_price" text NOT NULL,
	"target_price" text NOT NULL,
	"decision_id" text,
	"commit_tx" text,
	"record_tx" text,
	"fail_reason" text,
	"flash_order_id" text,
	"flash_bracket_order_id" text,
	"flash_close_order_id" text,
	"entry_fill_tx" text,
	"exit_fill_tx" text,
	"usdc_spent" bigint,
	"usdc_received" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "intents_intent_hash_unique" UNIQUE("intent_hash")
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"wallet" text PRIMARY KEY NOT NULL,
	"world_nullifier_hash" text NOT NULL,
	"human_id" text NOT NULL,
	"verified_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "owners_world_nullifier_hash_unique" UNIQUE("world_nullifier_hash"),
	CONSTRAINT "owners_human_id_unique" UNIQUE("human_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"per_trade_cap" bigint NOT NULL,
	"round_trade_cap" bigint NOT NULL,
	"daily_cap" bigint NOT NULL,
	"token_allowlist" text DEFAULT '["WETH"]' NOT NULL,
	"predictions_per_round" integer DEFAULT 10 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"prediction_id" text PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"predictor_kind" text NOT NULL,
	"predictor_address" text NOT NULL,
	"agent_id" text,
	"side" text NOT NULL,
	"prob_yes_bps" integer NOT NULL,
	"canonical_json" text NOT NULL,
	"decision_id" text,
	"predict_tx" text,
	"brier" double precision,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_awards" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reward_awards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"epoch_id" integer NOT NULL,
	"human_id" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"agent_id" text NOT NULL,
	"category" text NOT NULL,
	"rank" integer NOT NULL,
	"amount" bigint NOT NULL,
	"claim_tx" text
);
--> statement-breakpoint
CREATE TABLE "reward_epochs" (
	"id" integer PRIMARY KEY NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"budget" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"publish_tx" text
);
--> statement-breakpoint
CREATE TABLE "round_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "round_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"round_id" integer NOT NULL,
	"trader_agent_id" text NOT NULL,
	"onchain_entry_id" integer,
	"policy_snapshot" text NOT NULL,
	"policy_snapshot_hash" text NOT NULL,
	"trade_budget" bigint NOT NULL,
	"outcome" text DEFAULT 'PENDING' NOT NULL,
	"pnl_bps" integer,
	"void_reason" text,
	"allocation_decision_id" text,
	"open_tx" text,
	"resolve_tx" text,
	CONSTRAINT "round_entries_onchain_entry_id_unique" UNIQUE("onchain_entry_id")
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" integer PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"epoch_id" integer NOT NULL,
	"starts_at" bigint NOT NULL,
	"phase_ends_at" bigint NOT NULL,
	"lock_tx" text
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"round_id" integer NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_stats" ADD CONSTRAINT "agent_stats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_wallet_owners_wallet_fk" FOREIGN KEY ("owner_wallet") REFERENCES "public"."owners"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_entry_id_round_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."round_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_entry_id_round_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."round_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_epoch_id_reward_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."reward_epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_owner_wallet_owners_wallet_fk" FOREIGN KEY ("owner_wallet") REFERENCES "public"."owners"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_trader_agent_id_agents_id_fk" FOREIGN KEY ("trader_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_allocation_decision_id_decisions_id_fk" FOREIGN KEY ("allocation_decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_wallet");--> statement-breakpoint
CREATE INDEX "decisions_agent_round_idx" ON "decisions" USING btree ("agent_id","round_id");--> statement-breakpoint
CREATE INDEX "intents_round_agent_idx" ON "intents" USING btree ("round_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "predictions_entry_predictor_uq" ON "predictions" USING btree ("entry_id","predictor_address");--> statement-breakpoint
CREATE UNIQUE INDEX "awards_epoch_human_uq" ON "reward_awards" USING btree ("epoch_id","human_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entries_round_trader_uq" ON "round_entries" USING btree ("round_id","trader_agent_id");--> statement-breakpoint
CREATE INDEX "spend_agent_idx" ON "spend_ledger" USING btree ("agent_id","status");