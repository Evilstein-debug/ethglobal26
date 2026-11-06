CREATE TABLE "agent_activity" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"agent_id" text NOT NULL,
	"state" text NOT NULL,
	"message" text NOT NULL,
	"rationale" text,
	"decision_id" text,
	"entry_id" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_status" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"detail" text NOT NULL,
	"next_think_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "round_entries" DROP CONSTRAINT "round_entries_allocation_decision_id_decisions_id_fk";
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "closes_at" bigint;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_entry_id_round_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."round_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_status" ADD CONSTRAINT "agent_status_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "agent_activity" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "round_entries" DROP COLUMN "allocation_decision_id";