-- from: c831bd5be022b196bd2d5dc71aaba0ea54780cde150ec03512a689e53a34ca6e
-- to: e1c5989bf773b8895ce7dd0a1dcceb77fffe96886b3ff99abe2e9b8b19b78619
-- Release 1.15.0: Guidelines, Specs and Hooks (and schema.sql's header now
-- says how migrations are made). New tables only, two new columns on
-- grilling_sessions, and two more skills its CHECK allows.

ALTER TABLE "grilling_sessions" ADD COLUMN "guidelines" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "grilling_sessions" ADD COLUMN "spec" jsonb;
ALTER TABLE "grilling_sessions" DROP CONSTRAINT "grilling_sessions_skill";
ALTER TABLE "grilling_sessions" ADD CONSTRAINT "grilling_sessions_skill" CHECK ("grilling_sessions"."skill" IN ('grilling', 'grill-with-docs', 'wayfinder', 'to-tickets', 'to-spec', 'guidelines', 'spec'));

CREATE TABLE "approved_guidelines" (
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"approval" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approved_guidelines_floor_id_name_content_hash_pk" PRIMARY KEY("floor_id","name","content_hash"),
	CONSTRAINT "approved_guidelines_name" CHECK ("approved_guidelines"."name" ~ '^[a-z0-9-]+$' AND length("approved_guidelines"."name") <= 255),
	CONSTRAINT "approved_guidelines_content_hash" CHECK ("approved_guidelines"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "approved_guidelines_content" CHECK (length("approved_guidelines"."content") <= 12000),
	CONSTRAINT "approved_guidelines_approval" CHECK ("approved_guidelines"."approval" IN ('owner_merge', 'owner_push', 'owner_admin'))
);

CREATE TABLE "guideline_changes" (
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"commit_sha" text,
	"status" text DEFAULT 'awaiting' NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "guideline_changes_floor_id_name_content_hash_pk" PRIMARY KEY("floor_id","name","content_hash"),
	CONSTRAINT "guideline_changes_name" CHECK ("guideline_changes"."name" ~ '^[a-z0-9-]+$' AND length("guideline_changes"."name") <= 255),
	CONSTRAINT "guideline_changes_content_hash" CHECK ("guideline_changes"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "guideline_changes_content" CHECK (length("guideline_changes"."content") <= 12000),
	CONSTRAINT "guideline_changes_commit_sha" CHECK ("guideline_changes"."commit_sha" IS NULL OR "guideline_changes"."commit_sha" ~ '^[0-9a-f]{40,64}$'),
	CONSTRAINT "guideline_changes_status" CHECK ("guideline_changes"."status" IN ('awaiting', 'dismissed') AND ("guideline_changes"."status" = 'dismissed') = ("guideline_changes"."dismissed_at" IS NOT NULL))
);

CREATE TABLE "guideline_proposals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "guideline_proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"agent_id" text NOT NULL,
	"issue" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"pull_request" integer,
	"url" text,
	CONSTRAINT "guideline_proposals_name" CHECK ("guideline_proposals"."name" ~ '^[a-z0-9-]+$' AND length("guideline_proposals"."name") <= 255),
	CONSTRAINT "guideline_proposals_content_hash" CHECK ("guideline_proposals"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "guideline_proposals_content" CHECK (length("guideline_proposals"."content") BETWEEN 1 AND 12000),
	CONSTRAINT "guideline_proposals_issue" CHECK ("guideline_proposals"."issue" > 0),
	CONSTRAINT "guideline_proposals_status" CHECK ("guideline_proposals"."status" IN ('proposed', 'opened', 'rejected') AND ("guideline_proposals"."status" = 'proposed') = ("guideline_proposals"."decided_at" IS NULL) AND ("guideline_proposals"."status" = 'opened') = ("guideline_proposals"."pull_request" IS NOT NULL AND "guideline_proposals"."url" IS NOT NULL))
);

CREATE TABLE "guideline_suggestions" (
	"floor_id" text PRIMARY KEY NOT NULL,
	"suggested_at" timestamp with time zone NOT NULL
);

CREATE TABLE "hook_push_heads" (
	"floor_id" text PRIMARY KEY NOT NULL,
	"sha" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hook_push_heads_sha" CHECK ("hook_push_heads"."sha" ~ '^[0-9a-f]{40,64}$')
);

CREATE TABLE "hook_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hook_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"hook_id" bigint NOT NULL,
	"floor_id" text NOT NULL,
	"agent_id" text,
	"trigger" text NOT NULL,
	"issue" integer,
	"pull_request" integer,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" text,
	"comment_url" text,
	CONSTRAINT "hook_runs_status" CHECK ("hook_runs"."status" IN ('running', 'succeeded', 'failed') AND ("hook_runs"."status" = 'running') = ("hook_runs"."finished_at" IS NULL)),
	CONSTRAINT "hook_runs_subject" CHECK (("hook_runs"."issue" IS NULL OR "hook_runs"."issue" > 0) AND ("hook_runs"."pull_request" IS NULL OR "hook_runs"."pull_request" > 0)),
	CONSTRAINT "hook_runs_result" CHECK ("hook_runs"."result" IS NULL OR length("hook_runs"."result") <= 8000)
);

CREATE TABLE "hooks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hooks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"stage" text,
	"labels" text[] NOT NULL,
	"file_patterns" text[] NOT NULL,
	"agent_id" text,
	"role" text,
	"skill_name" text NOT NULL,
	"runs_per_hour" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hooks_name" CHECK (length("hooks"."name") BETWEEN 1 AND 60 AND "hooks"."name" = btrim("hooks"."name")),
	CONSTRAINT "hooks_trigger" CHECK ("hooks"."trigger" IN ('stage', 'pull_request_opened', 'push', 'wrap_up', 'spec_filed', 'run_now') AND ("hooks"."trigger" = 'stage') = ("hooks"."stage" IS NOT NULL)),
	CONSTRAINT "hooks_stage" CHECK ("hooks"."stage" IS NULL OR "hooks"."stage" IN ('needs-work', 'needs-review', 'needs-qa', 'needs-docs')),
	CONSTRAINT "hooks_filters" CHECK (cardinality("hooks"."labels") <= 20 AND cardinality("hooks"."file_patterns") <= 20),
	CONSTRAINT "hooks_action" CHECK (("hooks"."agent_id" IS NULL) <> ("hooks"."role" IS NULL) AND "hooks"."role" IS DISTINCT FROM 'manager'),
	CONSTRAINT "hooks_skill_name" CHECK ("hooks"."skill_name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("hooks"."skill_name") <= 64),
	CONSTRAINT "hooks_runs_per_hour" CHECK ("hooks"."runs_per_hour" BETWEEN 1 AND 60),
	CONSTRAINT "hooks_failures" CHECK ("hooks"."failures" >= 0)
);

ALTER TABLE "approved_guidelines" ADD CONSTRAINT "approved_guidelines_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "guideline_changes" ADD CONSTRAINT "guideline_changes_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "guideline_proposals" ADD CONSTRAINT "guideline_proposals_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "guideline_suggestions" ADD CONSTRAINT "guideline_suggestions_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "hook_push_heads" ADD CONSTRAINT "hook_push_heads_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "hook_runs" ADD CONSTRAINT "hook_runs_hook_id_hooks_id_fk" FOREIGN KEY ("hook_id") REFERENCES "public"."hooks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "hook_runs" ADD CONSTRAINT "hook_runs_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "guideline_proposals_floor" ON "guideline_proposals" USING btree ("floor_id","status");
CREATE UNIQUE INDEX "guideline_proposals_waiting" ON "guideline_proposals" USING btree ("floor_id","name","content_hash") WHERE "guideline_proposals"."status" = 'proposed';
CREATE INDEX "hook_runs_hook" ON "hook_runs" USING btree ("hook_id","started_at");
CREATE UNIQUE INDEX "hooks_name_unique" ON "hooks" USING btree ("floor_id",lower("name"));
