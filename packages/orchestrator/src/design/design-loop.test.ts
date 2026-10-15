import { afterEach, describe, expect, it } from "vitest";

import { gitIn } from "../sandbox/git-backed-github.ts";
import {
  approve,
  branch,
  labelsOf,
  ofType,
  repository,
  scenario,
  type Scenario,
} from "../work/scenario.ts";

// The designer end to end (PRD FR-10, FR-18): on a Floor with a designer,
// once QA passes a pull request, the designer (a script in the fake
// sandbox standing in for Claude Code taking screenshots with Playwright)
// reviews its UI against the repository's style guide, on the same stage
// label. Changes it asks for go back to the coder as a Handoff, through
// review and QA again; a pass moves the issue on, with any styling fixes
// it committed itself pushed; its own Round Cap hands the pull request to
// the Owner.

let setup: Scenario | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

const stageMoves = async (current: Scenario): Promise<string[]> =>
  ofType(await current.events(), "issue.label_changed")
    .filter(({ to }) => to !== null && to !== "in-progress")
    .map(({ from, to }) => `${from ?? "-"}→${to ?? "-"}`);

const designComments = async (current: Scenario) =>
  (await current.fake.repository(repository).listComments(2)).filter(
    ({ body }) => body.startsWith("**Design "),
  );

const actionNotices = async (current: Scenario) =>
  (await current.notices.open()).filter(({ kind }) => kind === "action");

/** Each piece of work's stage, its Role when it names one, and its end. */
const workDone = (current: Scenario): string[] =>
  current
    .work()
    .map(
      ({ stage, role, status }) =>
        `${stage}${role === undefined ? "" : ` (${role})`} ${status}`,
    );

describe("the designer", () => {
  it("returns its findings to the coder as a Handoff, then passes the fix after review and QA", async () => {
    setup = await scenario({
      design: [{ result: "changes" }, { result: "pass" }],
    });
    const { model, grace, quinta, coder, designer } = setup;
    const qa = setup.qa;
    model.answer(grace.id, approve(), approve());
    model.answer(quinta.id, approve(), approve());
    await setup.run();

    // The designer looked after QA, from its own prompt, with QA's Handoff.
    expect(setup.qaPrompts).toHaveLength(2);
    expect(setup.designPrompts).toHaveLength(2);
    const [first = "", second = ""] = setup.designPrompts;
    expect(first).toContain(
      "You are Dee, a designer Agent in AI Office, reviewing the UI of pull request #2 for GitHub issue #1 on the repository adrianeyre/web-shop",
    );
    expect(first).toContain(
      "It has passed review and QA. This is design round 1 of at most 3.",
    );
    expect(first).toContain("Find the repository's style guide");
    expect(first).toContain("take screenshots with Playwright");
    expect(first).toContain("Save them in `/tmp/design-review/`");
    expect(first).toContain("never commit them");
    expect(first).toContain("commit them as `style` or `fix` commits");
    expect(first).toContain("is a finding for the coder");
    expect(first).toContain(
      `You are on the pull request's branch, \`${branch}\``,
    );
    expect(first).toContain(
      `What changed: ${qa?.name ?? ""} passed QA in round 1: pnpm test passes, QA round 1.`,
    );
    expect(first).toContain("<design-review>");
    expect(second).toContain("This is design round 2 of at most 3.");

    // Its findings went back to the coder, quoted, with its Handoff.
    expect(setup.prompts).toHaveLength(2);
    const fix = setup.prompts[1] ?? "";
    expect(fix).toContain(
      "## Design feedback to fix (after design round 1 of 3)",
    );
    expect(fix).toContain(
      "What the designer found: The basket's button is off the style guide's palette, design round 1.",
    );
    expect(fix).toContain(
      "Changes to make:\n1. Basket, 1280 px: the Add button is #ff0000; the style guide's primary is #1d4ed8. Use the Button component's primary variant.",
    );
    expect(fix).toContain(
      "What changed: Design round 1 of 3: Dee reviewed the UI against the style guide. The basket's button is off the style guide's palette, design round 1.",
    );
    expect(fix).toContain(
      "Known risks: 2 rounds of design review are left before the pull request goes to the Owner.",
    );
    expect(fix).not.toContain("Review feedback to fix");
    expect(fix).not.toContain("QA feedback to fix");

    // Each result was commented on the pull request, and recorded.
    const [changes, passed, ...more] = await designComments(setup);
    expect(more).toEqual([]);
    expect(changes?.body).toBe(
      [
        "**Design changes requested** by Dee (designer, Claude claude-opus-5-5) in AI Office, design round 1 of 3.",
        "",
        "The basket's button is off the style guide's palette, design round 1.",
        "",
        "### Changes for the coder",
        "",
        "1. Basket, 1280 px: the Add button is #ff0000; the style guide's primary is #1d4ed8. Use the Button component's primary variant.",
      ].join("\n"),
    );
    expect(passed?.body).toContain(
      "**Design approved** by Dee (designer, Claude claude-opus-5-5) in AI Office, design round 2 of 3.",
    );
    const events = await setup.events();
    expect(
      ofType(events, "design.reported").map(
        ({ agentId, round, result, url }) => [agentId, round, result, url],
      ),
    ).toEqual([
      [designer?.id, 1, "changes", changes?.htmlUrl],
      [designer?.id, 2, "pass", passed?.htmlUrl],
    ]);

    // Back to needs-work, through review and QA again, then on.
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→ready-to-merge",
    ]);
    // QA handed to the designer, and the designer to the coder.
    const handoffs = ofType(events, "handoff").map(
      ({ fromAgentId, toAgentId, stage }) => [fromAgentId, toAgentId, stage],
    );
    expect(handoffs).toContainEqual([qa?.id, designer?.id, "needs-qa"]);
    expect(handoffs.filter(([, , stage]) => stage === "needs-work")).toEqual([
      [designer?.id, coder.id, "needs-work"],
    ]);
    expect(setup.stores.reviews.handoffs.at(-1)).toMatchObject({
      stage: "ready-to-merge",
      fromAgentId: designer?.id,
      summary: {
        changed: expect.stringContaining(
          "Dee passed the design review in round 2: The basket follows docs/style-guide.md at 1280 and 390 px, design round 2.",
        ) as string,
      },
    });
    expect((await actionNotices(setup)).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval",
    ]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-qa (designer) finished",
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-qa (designer) finished",
      "ready-to-merge finished",
    ]);
  });

  it("passes with a styling fix of its own pushed, before docs", async () => {
    setup = await scenario({
      design: [{ result: "pass", fixesStyle: true }],
      withDocs: true,
    });
    const { model, grace, quinta, designer } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(setup.prompts).toHaveLength(1);
    expect(setup.designPrompts).toHaveLength(1);
    // Its fix is on the branch, as the Owner's commit with its trailer,
    // after the coder's and before the docs Agent's.
    expect(
      await gitIn(setup.remote, "log", "--format=%s", `main..${branch}`),
    ).toBe(
      "docs: the basket\nstyle: the basket's spacing, design round 1\nfeat: a basket, take 1",
    );
    expect(
      await gitIn(setup.remote, "log", "-1", "--format=%b", `${branch}~1`),
    ).toContain("Agent: Dee (designer, Claude claude-opus-5-5)");
    const [comment] = await designComments(setup);
    expect(comment?.body).toBe(
      [
        "**Design approved** by Dee (designer, Claude claude-opus-5-5) in AI Office, design round 1 of 3.",
        "",
        "The basket follows docs/style-guide.md at 1280 and 390 px, design round 1.",
        "",
        "Design fixes made: 1 commit on this branch.",
      ].join("\n"),
    );
    expect(
      ofType(await setup.events(), "branch.pushed").map(
        ({ agentId }) => agentId,
      ),
    ).toEqual([setup.coder.id, designer?.id, setup.docs?.id]);
    // The docs Agent took the designer's Handoff.
    expect(setup.docsPrompts[0]).toContain(
      "What changed: Dee passed the design review in round 1: The basket follows docs/style-guide.md at 1280 and 390 px, design round 1. The designer committed 1 change of its own on the branch.",
    );
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→needs-docs",
      "needs-docs→ready-to-merge",
    ]);
  });

  it("hands the pull request to the Owner at its Round Cap", async () => {
    setup = await scenario({ design: [{ result: "changes" }] });
    const { model, grace, quinta } = setup;
    model.answer(grace.id, approve(), approve(), approve());
    model.answer(quinta.id, approve(), approve(), approve());
    await setup.run();

    expect(setup.designPrompts).toHaveLength(3);
    expect(setup.prompts).toHaveLength(3);
    expect(setup.prompts[2]).toContain(
      "Known risks: One round of design review is left: if it still asks for changes, the pull request goes to the Owner.",
    );
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-human"]);
    expect(await labelsOf(setup, 2)).toContain("needs-human");
    const [notice, ...others] = await actionNotices(setup);
    expect(others).toEqual([]);
    expect(notice?.title).toBe(
      "Design Round Cap reached: PR #2 (#1) still needs design changes after 3 rounds.",
    );
    const comments = await designComments(setup);
    expect(notice?.links.map(({ label }) => label)).toEqual([
      "Review round 1",
      "QA round 1",
      "Design round 1",
      "Review round 2",
      "QA round 2",
      "Design round 2",
      "Review round 3",
      "QA round 3",
      "Design round 3",
    ]);
    expect(notice?.links.at(-1)?.url).toBe(comments[2]?.htmlUrl);
  });

  it("reviews the UI after the reviewers on a Floor without a QA Agent", async () => {
    setup = await scenario({ withQa: false, design: [{ result: "pass" }] });
    const { model, grace, quinta, designer } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(setup.qaPrompts).toEqual([]);
    const [prompt = ""] = setup.designPrompts;
    expect(prompt).toContain(
      "It has passed review. This is design round 1 of at most 3.",
    );
    expect(prompt).toContain(
      `What changed: Approved by ${grace.name} and Quinta in round 1 of the Review Loop.`,
    );
    expect(
      ofType(await setup.events(), "handoff")
        .filter(({ stage }) => stage === "needs-qa")
        .map(({ fromAgentId, toAgentId }) => [fromAgentId, toAgentId]),
    ).toEqual([[grace.id, designer?.id]]);
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→ready-to-merge",
    ]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa (designer) finished",
      "ready-to-merge finished",
    ]);
  });

  it("blocks, leaving the issue at needs-qa, when it gives no review", async () => {
    setup = await scenario({ design: [{ result: "pass", silent: true }] });
    const { model, grace, quinta, designer } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-qa"]);
    expect(await designComments(setup)).toEqual([]);
    expect(ofType(await setup.events(), "design.reported")).toEqual([]);
    const notices = await actionNotices(setup);
    expect(notices.map(({ title }) => title)).toEqual([
      "Agent blocked: Dee on the design review of #1: Dee gave no design review on PR #2.",
    ]);
    expect(notices[0]).toMatchObject({
      agentId: designer?.id,
      pullRequest: { number: 2 },
    });
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-qa (designer) failed",
    ]);
  });
});
