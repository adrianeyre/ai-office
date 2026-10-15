import { afterEach, describe, expect, it } from "vitest";

import {
  approve,
  labelsOf,
  ofType,
  repository,
  scenario,
  workDone,
  type Scenario,
} from "../work/scenario.ts";

// Conflicts between Roles end to end (PRD FR-30): the coder (a script in
// the fake sandbox), two required reviewers (a fake model) and the QA
// Agent (another script) work one issue from one work queue. When QA and
// the reviewers hold opposite positions, the loop stops at once: the issue
// and pull request are labelled `needs-human`, and an action Notice shows
// both positions side by side, instead of the coder being sent round again.

let setup: Scenario | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

const actionNotices = async (current: Scenario) =>
  (await current.notices.open()).filter(({ kind }) => kind === "action");

const qaComments = async (current: Scenario) =>
  (await current.fake.repository(repository).listComments(2)).filter(
    ({ body }) => body.includes("**QA "),
  );

/** A verdict with one blocking comment on `path`. */
const blockOn = (path: string, body: string, summary: string): string =>
  JSON.stringify({
    verdict: "changes_requested",
    summary,
    comments: [{ severity: "blocking", path, line: 1, body }],
  });

const reviewUrl = async (current: Scenario, round: number, agentId: string) =>
  (await current.stores.reviews.verdicts("web-shop", 1)).find(
    (verdict) => verdict.round === round && verdict.agentId === agentId,
  )?.reviewUrl;

describe("conflicts between Roles", () => {
  it("escalates, instead of looping, when QA fails again what every reviewer approved twice in a row", async () => {
    // QA fails the same way every time it is asked; the reviewers would
    // approve every round.
    setup = await scenario({ qa: [{ result: "fail" }] });
    const { model, grace, quinta } = setup;
    const qa = setup.qa;
    model.answer(grace.id, approve(), approve(), approve());
    model.answer(quinta.id, approve(), approve(), approve());
    await setup.run();

    // Two rounds of each, not a third: the coder is not sent back again.
    expect(setup.prompts).toHaveLength(2);
    expect(setup.qaPrompts).toHaveLength(2);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
    ]);
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-human"]);
    expect(await labelsOf(setup, 2)).toContain("needs-human");
    // QA's first failure went back to the coder; its second did not.
    expect(
      ofType(await setup.events(), "handoff").filter(
        ({ stage }) => stage === "needs-work",
      ),
    ).toHaveLength(1);

    const comments = await qaComments(setup);
    const [notice, ...others] = await actionNotices(setup);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      title:
        "Review Loop conflict between Roles: QA failed PR #2 (#1) in QA round 2 as in round 1, though every reviewer approved it twice in a row.",
      floorId: "web-shop",
      issue: { number: 1 },
      pullRequest: { number: 2 },
      links: [
        { label: "Review round 1" },
        { label: "QA round 1", url: comments[0]?.htmlUrl },
        { label: "Review round 2" },
        { label: "QA round 2", url: comments[1]?.htmlUrl },
      ],
    });
    // Both positions, side by side: the reviewers' approval, then QA's
    // failure, each in its own words and linked to where it was said.
    expect(notice?.positions).toEqual([
      {
        label: "Reviewers: approved in rounds 1 and 2",
        text: `${grace.name}: It does what the issue asks.\nQuinta: It does what the issue asks.`,
        url: await reviewUrl(setup, 2, grace.id),
      },
      {
        label: "QA: failed in QA rounds 1 and 2",
        text: "Adding the same sku twice fails, QA round 2.\n\nSteps to reproduce:\n1. add('a')\n2. add('a')\n3. The basket has two",
        url: comments[1]?.htmlUrl,
      },
    ]);
    expect(
      ofType(await setup.events(), "qa.reported").map(({ agentId }) => agentId),
    ).toEqual([qa?.id, qa?.id]);
  });

  it("escalates when the reviewers reject the coder's fix for what QA required", async () => {
    // Round 1 approves; QA fails it; the coder's fix changes the basket,
    // and Grace blocks that very change.
    setup = await scenario({ qa: [{ result: "fail" }, { result: "pass" }] });
    const { model, grace, quinta } = setup;
    model.answer(
      grace.id,
      approve(),
      blockOn(
        "src/basket.ts",
        "Do not change add(): shoppers buy two of a thing.",
        "Keep add() as it was.",
      ),
      approve(),
    );
    model.answer(quinta.id, approve(), approve(), approve());
    await setup.run();

    // The coder is not sent back a third time, and QA does not run again.
    expect(setup.prompts).toHaveLength(2);
    expect(setup.qaPrompts).toHaveLength(1);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-work finished",
      "needs-review finished",
    ]);
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "needs-human"]);
    expect(await labelsOf(setup, 2)).toContain("needs-human");

    const [comment] = await qaComments(setup);
    const [notice, ...others] = await actionNotices(setup);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      title:
        "Review Loop conflict between Roles: in round 2, the reviewers rejected the fix QA required of PR #2 (#1) in QA round 1.",
      pullRequest: { number: 2 },
      links: [
        { label: "Review round 1" },
        { label: "QA round 1", url: comment?.htmlUrl },
        {
          label: "Review round 2",
          url: await reviewUrl(setup, 2, grace.id),
        },
      ],
    });
    // QA's requirement first, then the reviewers' rejection of it.
    expect(notice?.positions).toEqual([
      {
        label: "QA: failed in QA round 1",
        text: "Adding the same sku twice fails, QA round 1.\n\nSteps to reproduce:\n1. add('a')\n2. add('a')\n3. The basket has two",
        url: comment?.htmlUrl,
      },
      {
        label: "Reviewers: changes requested in round 2",
        text: `${grace.name}: Keep add() as it was.\n\n- src/basket.ts line 1 (${grace.name}): Do not change add(): shoppers buy two of a thing.`,
        url: await reviewUrl(setup, 2, grace.id),
      },
    ]);
  });

  it("keeps looping when the reviewers' blocking comments after a QA failure are on something else", async () => {
    // Grace's blocking comment is on the README, which the coder's fix for
    // QA did not touch: the Review Loop's own business, not a conflict.
    setup = await scenario({ qa: [{ result: "fail" }, { result: "pass" }] });
    const { model, grace, quinta } = setup;
    model.answer(
      grace.id,
      approve(),
      blockOn("README.md", "Say how to add to the basket.", "Document it."),
      approve(),
    );
    model.answer(quinta.id, approve(), approve(), approve());
    await setup.run();

    expect(setup.prompts).toHaveLength(3);
    expect(setup.qaPrompts).toHaveLength(2);
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    // No conflict: only the Merge Policy's Notice, for the Owner to merge.
    expect((await actionNotices(setup)).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval",
    ]);
  });
});
