import { afterEach, describe, expect, it } from "vitest";

import { gitIn } from "../sandbox/git-backed-github.ts";
import {
  approve,
  branch,
  labelsOf,
  ofType,
  repository,
  requestChanges,
  scenario,
  workDone,
  type Scenario,
} from "../work/scenario.ts";

// QA end to end (PRD FR-28; §5 scenario 4): once every required reviewer
// approves, the Floor's QA Agent (a script in the fake sandbox) checks the
// pull request's branch. A pass moves the issue on; a failure goes back to
// the coder with the steps that reproduce it, until QA's own Round Cap or
// the overall cap on the pull request's rounds hands it to the Owner.

let setup: Scenario | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

const stageMoves = async (current: Scenario): Promise<string[]> =>
  ofType(await current.events(), "issue.label_changed")
    .filter(
      ({ to, from }) =>
        (to ?? "").startsWith("needs-") ||
        to === "ready-to-merge" ||
        (from === null && to !== "in-progress"),
    )
    .map(({ from, to }) => `${from ?? "-"}→${to ?? "-"}`);

const qaComments = async (current: Scenario) =>
  (await current.fake.repository(repository).listComments(2)).filter(
    ({ body }) => body.includes("**QA "),
  );

const actionNotices = async (current: Scenario) =>
  (await current.notices.open()).filter(({ kind }) => kind === "action");

describe("QA", () => {
  it("advances a pull request whose checks pass, with the tests QA added pushed and the result commented", async () => {
    setup = await scenario({ qa: [{ result: "pass", addsTest: true }] });
    const { model, grace, quinta, coder } = setup;
    const qa = setup.qa;
    model.answer(grace.id, approve(["Name it Basket."]));
    model.answer(quinta.id, approve());
    await setup.run();

    // QA ran once, on the pull request, from its own prompt.
    expect(setup.prompts).toHaveLength(1);
    expect(setup.qaPrompts).toHaveLength(1);
    const [prompt = ""] = setup.qaPrompts;
    expect(prompt).toContain(
      `You are ${qa?.name ?? ""}, a QA Agent in AI Office, checking pull request #2 for GitHub issue #1`,
    );
    expect(prompt).toContain("This is QA round 1 of at most 3.");
    expect(prompt).toContain("1. Run the tests: `pnpm test`");
    expect(prompt).toContain("add them, and commit them");
    expect(prompt).toContain("with Playwright");
    expect(prompt).toContain(
      `You are on the pull request's branch, \`${branch}\``,
    );
    expect(prompt).toContain(
      `What changed: Approved by ${grace.name} and Quinta in round 1 of the Review Loop. The basket, take 1.`,
    );
    expect(prompt).toContain("<qa-report>");

    // The test it added is on the branch, as the Owner's commit with QA's
    // trailer, after the coder's.
    expect(
      await gitIn(setup.remote, "log", "--format=%s", `main..${branch}`),
    ).toBe("test: the basket, QA round 1\nfeat: a basket, take 1");
    expect(
      await gitIn(setup.remote, "log", "-1", "--format=%b", branch),
    ).toContain(`Agent: ${qa?.name ?? ""} (QA, Claude claude-opus-5-5)`);

    // The result is commented on the pull request, and recorded.
    const [comment, ...more] = await qaComments(setup);
    expect(more).toEqual([]);
    expect(comment?.body).toBe(
      [
        `**QA passed** by ${qa?.name ?? ""} (QA, Claude claude-opus-5-5) in AI Office, QA round 1 of 3.`,
        "",
        "pnpm test passes, QA round 1.",
        "",
        "Tests added: 1 commit on this branch.",
      ].join("\n"),
    );
    const events = await setup.events();
    expect(ofType(events, "qa.reported")).toEqual([
      expect.objectContaining({
        agentId: qa?.id,
        issue: 1,
        pullRequest: 2,
        round: 1,
        result: "pass",
        url: comment?.htmlUrl,
      }),
    ]);

    // On to ready-to-merge (the Floor has no docs Agent), let go.
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→ready-to-merge",
    ]);
    // The reviewers' Handoff reached QA; QA's is kept for what comes next.
    expect(
      ofType(events, "handoff").map(({ fromAgentId, toAgentId, stage }) => [
        fromAgentId,
        toAgentId,
        stage,
      ]),
    ).toEqual([
      [coder.id, grace.id, "needs-review"],
      [coder.id, quinta.id, "needs-review"],
      [grace.id, qa?.id, "needs-qa"],
    ]);
    expect(setup.stores.reviews.handoffs.at(-1)).toMatchObject({
      stage: "ready-to-merge",
      fromAgentId: qa?.id,
      summary: {
        changed: `${qa?.name ?? ""} passed QA in round 1: pnpm test passes, QA round 1. QA added 1 commit of tests on the branch. Approved by ${grace.name} and Quinta in round 1 of the Review Loop. The basket, take 1.`,
      },
    });
    // The Floor's Merge Policy, send to me, hands it to the Owner.
    expect((await actionNotices(setup)).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval",
    ]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "ready-to-merge finished",
    ]);
  });

  it("returns a failing pull request to the coder with the steps that reproduce it, then advances when QA passes", async () => {
    setup = await scenario({ qa: [{ result: "fail" }, { result: "pass" }] });
    const { model, grace, quinta, coder } = setup;
    const qa = setup.qa;
    model.answer(grace.id, approve(), approve());
    model.answer(quinta.id, approve(), approve());
    await setup.run();

    // The coder ran again, with what QA found; review and QA ran again.
    expect(setup.prompts).toHaveLength(2);
    expect(setup.qaPrompts).toHaveLength(2);
    const fix = setup.prompts[1] ?? "";
    expect(fix).toContain("## QA feedback to fix (after QA round 1 of 3)");
    expect(fix).toContain(
      "What QA found: Adding the same sku twice fails, QA round 1.",
    );
    expect(fix).toContain(
      "Steps to reproduce:\n1. add('a')\n2. add('a')\n3. The basket has two",
    );
    expect(fix).toContain(
      `What changed: QA round 1 of 3: ${qa?.name ?? ""} found it failing. Adding the same sku twice fails, QA round 1.`,
    );
    expect(fix).toContain(
      "Known risks: 2 rounds of QA are left before the pull request goes to the Owner.",
    );
    expect(fix).not.toContain("Review feedback to fix");
    expect(setup.qaPrompts[1]).toContain("This is QA round 2 of at most 3.");

    // The failure was commented with its steps.
    const [failed, passed] = await qaComments(setup);
    expect(failed?.body).toContain(`**QA failed** by ${qa?.name ?? ""}`);
    expect(failed?.body).toContain(
      "### Steps to reproduce\n\n1. add('a')\n2. add('a')\n3. The basket has two",
    );
    expect(passed?.body).toContain("**QA passed**");
    expect(
      ofType(await setup.events(), "qa.reported").map(({ round, result }) => [
        round,
        result,
      ]),
    ).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);

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
    // QA's Handoff back reached the coder as it started its fix.
    expect(
      ofType(await setup.events(), "handoff")
        .filter(({ stage }) => stage === "needs-work")
        .map(({ fromAgentId, toAgentId }) => [fromAgentId, toAgentId]),
    ).toEqual([[qa?.id, coder.id]]);
    expect((await actionNotices(setup)).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval",
    ]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "ready-to-merge finished",
    ]);
  });

  it("hands the pull request to the Owner at QA's Round Cap", async () => {
    // QA finds something new each round, so it is not in conflict with the
    // reviewers (FR-30): each failure is the coder's to fix, up to the cap.
    setup = await scenario({
      qa: [
        { result: "fail" },
        {
          result: "fail",
          finding: {
            summary: "Removing a sku that is not there throws",
            steps: "1. remove('z')\n2. It throws a TypeError",
          },
        },
        {
          result: "fail",
          finding: {
            summary: "An empty sku is added to the basket",
            steps: "1. add('')\n2. size() is 1",
          },
        },
      ],
    });
    const { model, grace, quinta } = setup;
    model.answer(grace.id, approve(), approve(), approve());
    model.answer(quinta.id, approve(), approve(), approve());
    await setup.run();

    expect(setup.qaPrompts).toHaveLength(3);
    expect(setup.prompts).toHaveLength(3);
    expect(setup.prompts[2]).toContain(
      "Known risks: One round of QA is left: if it still fails, the pull request goes to the Owner.",
    );
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-human"]);
    expect(await labelsOf(setup, 2)).toContain("needs-human");
    const [notice, ...others] = await actionNotices(setup);
    expect(others).toEqual([]);
    expect(notice?.title).toBe(
      "QA Round Cap reached: PR #2 (#1) still fails QA after 3 rounds.",
    );
    expect(notice?.links.map(({ label }) => label)).toEqual([
      "Review round 1",
      "QA round 1",
      "Review round 2",
      "QA round 2",
      "Review round 3",
      "QA round 3",
    ]);
  });

  it("hands the pull request to the Owner at the overall cap on its rounds of review and QA", async () => {
    // Review round 1 asks for changes; round 2 approves, QA fails; round 3
    // approves, QA fails again: five rounds, the overall cap (3 + 3 - 1),
    // though neither the Round Cap nor QA's was reached.
    setup = await scenario({ qa: [{ result: "fail" }] });
    const { model, grace, quinta } = setup;
    model.answer(grace.id, approve(), approve(), approve());
    model.answer(
      quinta.id,
      requestChanges("Add an add(sku) function."),
      approve(),
      approve(),
    );
    await setup.run();

    expect(setup.prompts).toHaveLength(3);
    expect(setup.qaPrompts).toHaveLength(2);
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-human"]);
    expect(await labelsOf(setup, 2)).toContain("needs-human");

    const reviews = await setup.fake.repository(repository).listReviews(2);
    const comments = await qaComments(setup);
    const [notice, ...others] = await actionNotices(setup);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      title:
        "Overall cap reached: PR #2 (#1) still fails after 5 rounds of review and QA.",
      issue: { number: 1 },
      pullRequest: { number: 2 },
      links: [
        {
          label: "Review round 1",
          url: reviews.find(({ body }) => body.includes("Changes requested"))
            ?.htmlUrl,
        },
        { label: "Review round 2", url: expect.any(String) as string },
        { label: "QA round 1", url: comments[0]?.htmlUrl },
        { label: "Review round 3", url: expect.any(String) as string },
        { label: "QA round 2", url: comments[1]?.htmlUrl },
      ],
    });
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
    ]);
  });

  it("is skipped on a Floor without a QA Agent", async () => {
    setup = await scenario({ withQa: false });
    const { model, grace, quinta } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(setup.qaPrompts).toEqual([]);
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→ready-to-merge",
    ]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "ready-to-merge finished",
    ]);
  });
  it("blocks, leaving the issue at needs-qa, when QA gives no result", async () => {
    setup = await scenario({ qa: [{ result: "pass", silent: true }] });
    const { model, grace, quinta } = setup;
    const qa = setup.qa;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-qa"]);
    expect(await qaComments(setup)).toEqual([]);
    expect(ofType(await setup.events(), "qa.reported")).toEqual([]);
    const notices = await actionNotices(setup);
    expect(notices.map(({ title }) => title)).toEqual([
      `Agent blocked: ${qa?.name ?? ""} on QA of #1: ${qa?.name ?? ""} gave no QA result on PR #2.`,
    ]);
    expect(notices[0]).toMatchObject({
      agentId: qa?.id,
      pullRequest: { number: 2 },
    });
    expect(
      ofType(await setup.events(), "agent.status_changed")
        .filter(({ agentId }) => agentId === qa?.id)
        .map(({ status }) => status),
    ).toEqual(["working", "blocked"]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa failed",
    ]);
  });
});
