-- from: e1c5989bf773b8895ce7dd0a1dcceb77fffe96886b3ff99abe2e9b8b19b78619
-- to: 88f0c75ac3a102844f606ef4d981140abfa27155211635934e561eb03df61b96
-- Release 1.17.0: Scorecards, Sizes, Owner-only Paths and Recurring Goals
-- (docs/product-requirements-document/scorecards.md; ADR 0018). New
-- columns on floors (Owner-only Paths and the changed-lines limit),
-- agents (the Sizes each takes: all three for every Agent already here),
-- issue_triage (an issue's Size: none for a triage from before) and
-- office_settings (the Scorecard's retention); three new tables.

ALTER TABLE "floors" ADD COLUMN "owner_only_paths" text[] DEFAULT '{}' NOT NULL;
ALTER TABLE "floors" ADD COLUMN "changed_lines_limit" integer;
ALTER TABLE "floors" ADD CONSTRAINT "floors_changed_lines_limit" CHECK ("floors"."changed_lines_limit" IS NULL OR "floors"."changed_lines_limit" >= 1);

ALTER TABLE "agents" ADD COLUMN "sizes" text[] DEFAULT '{small,medium,large}' NOT NULL;
ALTER TABLE "agents" ADD CONSTRAINT "agents_sizes" CHECK (cardinality("agents"."sizes") >= 1 AND "agents"."sizes" <@ ARRAY['small', 'medium', 'large']::text[]);

ALTER TABLE "issue_triage" ADD COLUMN "size" text;
ALTER TABLE "issue_triage" ADD CONSTRAINT "issue_triage_size" CHECK ("issue_triage"."size" IS NULL OR "issue_triage"."size" IN ('small', 'medium', 'large'));

ALTER TABLE "office_settings" ADD COLUMN "retention_scorecard_days" integer;
ALTER TABLE "office_settings" DROP CONSTRAINT "office_settings_retention";
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_retention" CHECK (("office_settings"."retention_request_bodies_days" IS NULL OR "office_settings"."retention_request_bodies_days" BETWEEN 0 AND 3650) AND ("office_settings"."retention_request_metadata_days" IS NULL OR "office_settings"."retention_request_metadata_days" BETWEEN 32 AND 3650) AND ("office_settings"."retention_activity_days" IS NULL OR "office_settings"."retention_activity_days" BETWEEN 30 AND 3650) AND ("office_settings"."retention_connection_deliveries_days" IS NULL OR "office_settings"."retention_connection_deliveries_days" BETWEEN 1 AND 3650) AND ("office_settings"."retention_scorecard_days" IS NULL OR "office_settings"."retention_scorecard_days" BETWEEN 90 AND 3650));

CREATE TABLE "scorecard_records" (
	"floor_id" text NOT NULL,
	"issue" integer NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"role" text NOT NULL,
	"stage" text NOT NULL,
	"contractor" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"size" text,
	"outcome" text NOT NULL,
	"rounds_to_approval" integer,
	"qa_rounds_failed" integer DEFAULT 0 NOT NULL,
	"stalls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"rounds_reviewed" integer DEFAULT 0 NOT NULL,
	"blocking_comments" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scorecard_records_floor_id_issue_agent_id_model_pk" PRIMARY KEY("floor_id","issue","agent_id","model"),
	CONSTRAINT "scorecard_records_outcome" CHECK ("scorecard_records"."outcome" IN ('merged', 'closed', 'handed_to_owner')),
	CONSTRAINT "scorecard_records_stage" CHECK ("scorecard_records"."stage" IN ('work', 'review', 'qa', 'docs')),
	CONSTRAINT "scorecard_records_size" CHECK ("scorecard_records"."size" IS NULL OR "scorecard_records"."size" IN ('small', 'medium', 'large')),
	CONSTRAINT "scorecard_records_counts" CHECK ("scorecard_records"."issue" > 0 AND ("scorecard_records"."rounds_to_approval" IS NULL OR "scorecard_records"."rounds_to_approval" > 0) AND "scorecard_records"."qa_rounds_failed" >= 0 AND "scorecard_records"."stalls" >= 0 AND "scorecard_records"."failures" >= 0 AND "scorecard_records"."rounds_reviewed" >= 0 AND "scorecard_records"."blocking_comments" >= 0 AND "scorecard_records"."input_tokens" >= 0 AND "scorecard_records"."output_tokens" >= 0 AND "scorecard_records"."estimated_cost_usd" >= 0)
);
CREATE INDEX "scorecard_records_ended_at" ON "scorecard_records" USING btree ("ended_at");

CREATE TABLE "recurring_goals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recurring_goals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"words" text NOT NULL,
	"frequency" text NOT NULL,
	"days" integer[] NOT NULL,
	"time" text NOT NULL,
	"token_cap" bigint,
	"enabled" boolean NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recurring_goals_name" CHECK (length("recurring_goals"."name") BETWEEN 1 AND 100 AND "recurring_goals"."name" = btrim("recurring_goals"."name")),
	CONSTRAINT "recurring_goals_words" CHECK (length("recurring_goals"."words") BETWEEN 1 AND 2000),
	CONSTRAINT "recurring_goals_schedule" CHECK ((("recurring_goals"."frequency" = 'daily' AND cardinality("recurring_goals"."days") = 0) OR ("recurring_goals"."frequency" = 'weekly' AND cardinality("recurring_goals"."days") BETWEEN 1 AND 7 AND "recurring_goals"."days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6])) AND "recurring_goals"."time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "recurring_goals_token_cap" CHECK ("recurring_goals"."token_cap" IS NULL OR "recurring_goals"."token_cap" > 0),
	CONSTRAINT "recurring_goals_failures" CHECK ("recurring_goals"."failures" >= 0)
);
ALTER TABLE "recurring_goals" ADD CONSTRAINT "recurring_goals_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "recurring_goals_name_unique" ON "recurring_goals" USING btree ("floor_id",lower("name"));

CREATE TABLE "recurring_goal_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recurring_goal_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"goal_id" bigint NOT NULL,
	"floor_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"batch_id" bigint,
	"issues" integer[] DEFAULT '{}' NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "recurring_goal_runs_outcome" CHECK ("recurring_goal_runs"."outcome" IN ('running', 'planned', 'skipped', 'failed') AND ("recurring_goal_runs"."outcome" = 'running') = ("recurring_goal_runs"."finished_at" IS NULL)),
	CONSTRAINT "recurring_goal_runs_tokens" CHECK ("recurring_goal_runs"."tokens" >= 0)
);
ALTER TABLE "recurring_goal_runs" ADD CONSTRAINT "recurring_goal_runs_goal_id_recurring_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."recurring_goals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "recurring_goal_runs" ADD CONSTRAINT "recurring_goal_runs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "recurring_goal_runs_goal_idx" ON "recurring_goal_runs" USING btree ("goal_id","id");
