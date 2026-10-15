-- What `src/schema.ts` cannot say, appended to the generated schema by
-- `pnpm db:generate` (src/generate-schema.ts): the events log's trigger and
-- the rows a new database starts with.
-- The events log is append-only (PRD §7): no update, truncation or delete,
-- but the retention clean-up's, which names its cutoff for its own
-- transaction in `ai_office.events_retention_cutoff` (set with
-- `set_config(…, true)`) and deletes only events older than it.
CREATE FUNCTION "events_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	cutoff text := current_setting('ai_office.events_retention_cutoff', true);
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF cutoff IS NOT NULL AND cutoff <> '' THEN
			IF OLD."occurred_at" < cutoff::timestamptz THEN
				RETURN OLD;
			END IF;
		END IF;
	END IF;
	RAISE EXCEPTION 'events is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "events_append_only"
	BEFORE UPDATE OR DELETE ON "events"
	FOR EACH ROW EXECUTE FUNCTION "events_refuse_change"();
CREATE TRIGGER "events_no_truncate"
	BEFORE TRUNCATE ON "events"
	FOR EACH STATEMENT EXECUTE FUNCTION "events_refuse_change"();
-- Which application this database belongs to.
INSERT INTO schema_meta (key, value, updated_at) VALUES ('application', 'ai-office', now());
-- The built-in Roles of the Role library, which the Owner may change.
INSERT INTO "roles" ("id", "name", "stage", "description", "instructions", "skills", "desk_dressing", "ai_provider", "model", "created_at", "updated_at") VALUES
	('coder', 'coder', 'work', 'Changes the code: features, fixes and refactors, with their tests.', '- Make the smallest change that does what the issue asks, and commit it. Work that is not committed is lost.', '[]'::jsonb, 'monitor', 'Claude', NULL, now(), now()),
	('reviewer', 'reviewer', 'review', 'Reviews a pull request''s diff against its issue and gives a verdict.', 'Review the change against the issue: does it do what the issue asks, correctly, safely, with tests where they are due, and in keeping with the code around it?', '[]'::jsonb, 'printouts', 'Claude', NULL, now(), now()),
	('qa', 'QA', 'qa', 'Runs the tests, adds the missing ones and tries the change as a user would.', E'2. Where the change has no tests that cover it, add them, and commit them. Do not change the code under test: report what fails instead.\n3. If the repository has a web UI, start it and exercise the change in a browser with Playwright (for example `pnpm dlx playwright`), as a user would. Otherwise skip this step.', '[]'::jsonb, 'test-devices', 'Claude', NULL, now(), now()),
	('docs', 'docs', 'docs', 'Documents the change: the README, the changelog and docstrings.', E'2. Update the README where the change affects what it says.\n3. Add an entry for the change to the changelog (such as `CHANGELOG.md`), if the repository keeps one.\n4. Add or update the docstrings of the code the change adds or changes.\n5. Change documentation only: never change behaviour, tests or configuration. If nothing needs documenting, change nothing.', '[]'::jsonb, 'books', 'Claude', 'claude-haiku-5-5', now(), now()),
	('designer', 'designer', 'work', 'Changes how it looks and feels: layouts, styles, components and images.', '- Make the smallest change that does what the issue asks, in keeping with the design the repository already has (its layout, type, colours and components), and commit it. Work that is not committed is lost.', '[]'::jsonb, 'dual-monitors', 'Claude', NULL, now(), now());
