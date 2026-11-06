ALTER TABLE "owners" ADD COLUMN "verify_method" text DEFAULT 'world' NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "register_tx" text;