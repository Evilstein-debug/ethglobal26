CREATE TABLE `agent_stats` (
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`rounds` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`voids` integer DEFAULT 0 NOT NULL,
	`pnl_bps_total` integer DEFAULT 0 NOT NULL,
	`brier_sum` real DEFAULT 0 NOT NULL,
	`brier_count` integer DEFAULT 0 NOT NULL,
	`replay` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`agent_id`, `role`, `replay`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_wallet` text NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`address` text NOT NULL,
	`enc_key` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`register_tx` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_wallet`) REFERENCES `owners`(`wallet`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_address_unique` ON `agents` (`address`);--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`owner_wallet`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`round_id` integer NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`request_id` text NOT NULL,
	`provider` text NOT NULL,
	`chat_id` text,
	`tee_verified` integer,
	`raw_output` text NOT NULL,
	`accepted` integer NOT NULL,
	`reject_reason` text,
	`latency_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_request_id_unique` ON `decisions` (`request_id`);--> statement-breakpoint
CREATE INDEX `decisions_agent_round_idx` ON `decisions` (`agent_id`,`round_id`);--> statement-breakpoint
CREATE TABLE `intents` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`round_id` integer NOT NULL,
	`agent_id` text NOT NULL,
	`entry_id` integer,
	`canonical_json` text NOT NULL,
	`intent_hash` text NOT NULL,
	`state` text NOT NULL,
	`asset` text NOT NULL,
	`size_quote` integer NOT NULL,
	`entry_ref_price` text NOT NULL,
	`stop_price` text NOT NULL,
	`target_price` text NOT NULL,
	`decision_id` text,
	`commit_tx` text,
	`record_tx` text,
	`fail_reason` text,
	`flash_order_id` text,
	`flash_bracket_order_id` text,
	`flash_close_order_id` text,
	`entry_fill_tx` text,
	`exit_fill_tx` text,
	`usdc_spent` integer,
	`usdc_received` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `round_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intents_intent_hash_unique` ON `intents` (`intent_hash`);--> statement-breakpoint
CREATE INDEX `intents_round_agent_idx` ON `intents` (`round_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `owners` (
	`wallet` text PRIMARY KEY NOT NULL,
	`world_nullifier_hash` text NOT NULL,
	`human_id` text NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owners_world_nullifier_hash_unique` ON `owners` (`world_nullifier_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `owners_human_id_unique` ON `owners` (`human_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`per_trade_cap` integer NOT NULL,
	`round_trade_cap` integer NOT NULL,
	`daily_cap` integer NOT NULL,
	`token_allowlist` text DEFAULT '["WETH"]' NOT NULL,
	`predictions_per_round` integer DEFAULT 10 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `predictions` (
	`prediction_id` text PRIMARY KEY NOT NULL,
	`round_id` integer NOT NULL,
	`entry_id` integer NOT NULL,
	`predictor_kind` text NOT NULL,
	`predictor_address` text NOT NULL,
	`agent_id` text,
	`side` text NOT NULL,
	`prob_yes_bps` integer NOT NULL,
	`canonical_json` text NOT NULL,
	`decision_id` text,
	`predict_tx` text,
	`brier` real,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `round_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_entry_predictor_uq` ON `predictions` (`entry_id`,`predictor_address`);--> statement-breakpoint
CREATE TABLE `reward_awards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`epoch_id` integer NOT NULL,
	`human_id` text NOT NULL,
	`owner_wallet` text NOT NULL,
	`agent_id` text NOT NULL,
	`category` text NOT NULL,
	`rank` integer NOT NULL,
	`amount` integer NOT NULL,
	`claim_tx` text,
	FOREIGN KEY (`epoch_id`) REFERENCES `reward_epochs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_wallet`) REFERENCES `owners`(`wallet`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `awards_epoch_human_uq` ON `reward_awards` (`epoch_id`,`human_id`);--> statement-breakpoint
CREATE TABLE `reward_epochs` (
	`id` integer PRIMARY KEY NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`budget` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`publish_tx` text
);
--> statement-breakpoint
CREATE TABLE `round_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`trader_agent_id` text NOT NULL,
	`onchain_entry_id` integer,
	`policy_snapshot` text NOT NULL,
	`policy_snapshot_hash` text NOT NULL,
	`trade_budget` integer NOT NULL,
	`outcome` text DEFAULT 'PENDING' NOT NULL,
	`pnl_bps` integer,
	`void_reason` text,
	`allocation_decision_id` text,
	`open_tx` text,
	`resolve_tx` text,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trader_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`allocation_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `round_entries_onchain_entry_id_unique` ON `round_entries` (`onchain_entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_round_trader_uq` ON `round_entries` (`round_id`,`trader_agent_id`);--> statement-breakpoint
CREATE TABLE `rounds` (
	`id` integer PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`epoch_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`phase_ends_at` integer NOT NULL,
	`lock_tx` text
);
--> statement-breakpoint
CREATE TABLE `spend_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`round_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`ref` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `spend_agent_idx` ON `spend_ledger` (`agent_id`,`status`);