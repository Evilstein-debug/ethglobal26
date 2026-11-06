ALTER TABLE "intents" ADD COLUMN "entry_style" text DEFAULT 'market' NOT NULL;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "twap_buckets" integer;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "twap_duration_sec" integer;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "twap_next_check_at" bigint;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "quote_first_out" text;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "quote_final_out" text;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "quote_revisions" integer;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "flash_note" text;