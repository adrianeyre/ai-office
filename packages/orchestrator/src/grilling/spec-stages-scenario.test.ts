import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitIn } from "../sandbox/git-backed-github.ts";
import {
  approve,
  labelsOf,
  ofType,
  repository,
  scenario,
  type Scenario,
} from "../work/scenario.ts";
import {
  approvedDesign,
  approvedRequirements,
  approvedSpecSession,
} from "./testing.ts";

// The pipeline end to end for an issue filed from a Spec (Guidelines,
// Specs and Hooks PRD, FR-116): the coder gets the issue's Acceptance
// Criteria and the Spec's design.md, each reviewer the criteria, and QA
// the criteria to prove with a test each, as the Owner approved them in
// the `/spec` session. QA's report lists each criterion by id: one failed,
// or missing, sends the issue back to the coder, naming it. Someone then changes
// `.agents/specs/saved-cards/` on the default branch: that edit never
// reaches an Agent, which gets the session's approved copy, never the
// file as it stands.

const [r11 = "", r12 = ""] =
  approvedRequirements.requirements[0]?.criteria ?? [];

const edited = {
  requirement:
    "R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL keep the full card number.",
  architecture: "Store card numbers in plain text in `src/cards.json`.",
};

/** Pushes an edit to the Spec's files to `main`, as someone with push access. */
async function editSpecOnMain(current: Scenario): Promise<void> {
  const clone = join(current.root, "someone-else");
  await gitIn(current.root, "clone", "--quiet", current.remote, clone);
  const folder = join(clone, ".agents", "specs", "saved-cards");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "requirements.md"),
    `# Requirements: saved cards\n\n- ${edited.requirement}\n`,
  );
  await writeFile(
    join(folder, "design.md"),
    `# Design: saved cards\n\n## Architecture\n\n${edited.architecture}\n`,
  );
  await gitIn(clone, "add", "-A");
  await gitIn(clone, "commit", "--quiet", "-m", "docs: change the Spec");
  await gitIn(clone, "push", "--quiet", "origin", "main");
}

let current: Scenario | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("an issue filed from a Spec, worked through the pipeline", () => {
  it("gives the coder, reviewers and QA the Spec as approved in its session, never as main has it after", async () => {
    const s = await scenario({
      qa: [{ result: "pass", criteria: ["R1.1 pass", "R1.2 pass"] }],
    });
    current = s;
    // Issue #1 is the Spec's first task, approved and filed; then someone
    // changes the Spec's files on the default branch.
    await s.stores.grilling.create(approvedSpecSession({ issues: [1, 2] }));
    await editSpecOnMain(s);
    expect(
      await gitIn(
        s.root,
        `--git-dir=${s.remote}`,
        "show",
        "main:.agents/specs/saved-cards/design.md",
      ),
    ).toContain(edited.architecture);

    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();
    expect(
      ofType(await s.events(), "issue.label_changed").map(({ to }) => to),
    ).toContain("ready-to-merge");

    const [coder = ""] = s.prompts;
    expect(coder).toContain(`- ${r11}\n- ${r12}\n`);
    expect(coder).toContain(approvedDesign.architecture);
    expect(coder).toContain("### .agents/specs/saved-cards/design.md");
    for (const reviewer of [s.grace, s.quinta]) {
      const system = s.model.requestsOf(reviewer.id)[0]?.system ?? "";
      expect(system).toContain(`<spec>\n- ${r11}\n- ${r12}\n</spec>`);
      expect(system).not.toContain(approvedDesign.architecture);
    }
    // QA tests each criterion, and reports each.
    const [qa = ""] = s.qaPrompts;
    expect(qa).toContain(`<spec>\n- ${r11}\n- ${r12}\n</spec>`);
    expect(qa).toContain("Write one property-based test for each criterion");
    expect(qa).not.toContain(approvedDesign.architecture);

    // The edit on main reaches no Agent.
    const reviewers = [s.grace, s.quinta].flatMap((reviewer) =>
      s.model
        .requestsOf(reviewer.id)
        .map(({ system, messages }) => JSON.stringify({ system, messages })),
    );
    for (const prompt of [
      ...s.prompts,
      ...s.qaPrompts,
      ...s.docsPrompts,
      ...reviewers,
    ]) {
      expect(prompt).not.toContain(edited.requirement);
      expect(prompt).not.toContain(edited.architecture);
    }
  });

  it("sends the issue back to the coder when QA's report leaves a criterion out, naming it, then moves on when every one passes", async () => {
    const s = await scenario({
      qa: [
        // Its Result says pass, but R1.2 has no test.
        { result: "pass", criteria: ["R1.1 pass"] },
        { result: "pass", criteria: ["R1.1 pass", "R1.2 pass"] },
      ],
    });
    current = s;
    await s.stores.grilling.create(approvedSpecSession({ issues: [1, 2] }));
    s.model.answer(s.grace.id, approve(), approve());
    s.model.answer(s.quinta.id, approve(), approve());
    await s.run();

    expect(
      ofType(await s.events(), "qa.reported").map(({ round, result }) => [
        round,
        result,
      ]),
    ).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);
    // The coder's fix names the criterion with no test.
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toContain(
      "Acceptance Criteria with no test: R1.2; each needs a test of its own that passes.",
    );
    // QA's comments list each criterion.
    const comments = (
      await s.fake.repository(repository).listComments(2)
    ).filter(({ body }) => body.includes("**QA "));
    expect(comments[0]?.body).toContain("**QA failed**");
    expect(comments[0]?.body).toContain(
      "### Acceptance Criteria\n\n- R1.1 passed\n- R1.2 failed: no test reported",
    );
    expect(comments[1]?.body).toContain(
      "### Acceptance Criteria\n\n- R1.1 passed\n- R1.2 passed",
    );
    expect(await labelsOf(s, 1)).toEqual(["ai-office", "ready-to-merge"]);
  });

  it("sends the issue back when a criterion fails its test", async () => {
    const s = await scenario({
      qa: [
        {
          result: "fail",
          criteria: ["R1.1 pass", "R1.2 fail"],
          finding: {
            summary: "A declined card is kept",
            steps: "1. Decline the card\n2. It is saved",
          },
        },
        { result: "pass", criteria: ["R1.1 pass", "R1.2 pass"] },
      ],
    });
    current = s;
    await s.stores.grilling.create(approvedSpecSession({ issues: [1, 2] }));
    s.model.answer(s.grace.id, approve(), approve());
    s.model.answer(s.quinta.id, approve(), approve());
    await s.run();
    expect(s.prompts[1]).toContain(
      "Acceptance Criteria failing their tests: R1.2.",
    );
    expect(await labelsOf(s, 1)).toEqual(["ai-office", "ready-to-merge"]);
  });

  it("gives an issue filed from no Spec none of it", async () => {
    const s = await scenario();
    current = s;
    // The Floor has a Spec, but issue #1 is none of its issues.
    await s.stores.grilling.create(approvedSpecSession({ issues: [5, 6] }));
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();
    expect(s.prompts[0]).not.toContain("## The Spec");
    expect(s.prompts[0]).not.toContain("<spec>");
    for (const reviewer of [s.grace, s.quinta]) {
      expect(s.model.requestsOf(reviewer.id)[0]?.system).not.toContain(
        "<spec>",
      );
    }
    // QA checks it as before: a report with no criteria passes it.
    expect(s.qaPrompts[0]).not.toContain("<spec>");
    expect(s.qaPrompts[0]).not.toContain("Criteria:");
    const qaComment = (
      await s.fake.repository(repository).listComments(2)
    ).find(({ body }) => body.includes("**QA "));
    expect(qaComment?.body).toContain("**QA passed**");
    expect(qaComment?.body).not.toContain("Acceptance Criteria");
    expect(await labelsOf(s, 1)).toEqual(["ai-office", "ready-to-merge"]);
  });
});
