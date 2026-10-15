import { afterEach, describe, expect, it } from "vitest";

import { gitIn } from "../sandbox/git-backed-github.ts";
import {
  approve,
  branch,
  labelsOf,
  ofType,
  scenario,
  workDone,
  type Scenario,
} from "../work/scenario.ts";

// The docs stage end to end (PRD FR-18): once a pull request passes review
// and QA, the Floor's docs Agent (a script in the fake sandbox standing in
// for Claude Code on a small Model) documents it on the same branch, and
// the issue moves to ready-to-merge. A Floor without a docs Agent skips
// the stage.

let setup: Scenario | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

const stageMoves = async (current: Scenario): Promise<string[]> =>
  ofType(await current.events(), "issue.label_changed")
    .filter(({ to }) => to !== null && to !== "in-progress")
    .map(({ from, to }) => `${from ?? "-"}→${to ?? "-"}`);

describe("the docs stage", () => {
  it("documents the change on the pull request's branch with a small Model, then moves the issue to ready-to-merge", async () => {
    setup = await scenario({ withDocs: true });
    const { model, grace, quinta } = setup;
    const { qa, docs } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    // The docs Agent uses its AI Provider's small Model by default.
    expect(docs?.modelOverride).toBe("claude-haiku-5-5");

    // It ran once, after QA, from its own prompt.
    expect(setup.qaPrompts).toHaveLength(1);
    expect(setup.docsPrompts).toHaveLength(1);
    const [prompt = ""] = setup.docsPrompts;
    expect(prompt).toContain(
      "You are Dora, a docs Agent in AI Office, documenting the change in pull request #2 for GitHub issue #1",
    );
    expect(prompt).toContain("`git diff main...HEAD`");
    expect(prompt).toContain("2. Update the README where the change affects");
    expect(prompt).toContain("3. Add an entry for the change to the changelog");
    expect(prompt).toContain("4. Add or update the docstrings");
    expect(prompt).toContain("Change documentation only");
    expect(prompt).toContain(
      `What changed: ${qa?.name ?? ""} passed QA in round 1: pnpm test passes, QA round 1.`,
    );
    expect(prompt).toContain(
      `You are on the pull request's branch, \`${branch}\``,
    );

    // What it wrote is on the branch, as the Owner's commit with its
    // trailer naming its small Model.
    expect(
      await gitIn(setup.remote, "log", "--format=%s", `main..${branch}`),
    ).toBe("docs: the basket\nfeat: a basket, take 1");
    expect(
      await gitIn(setup.remote, "log", "-1", "--format=%b", branch),
    ).toContain("Agent: Dora (docs, Claude claude-haiku-5-5)");
    expect(await gitIn(setup.remote, "show", `${branch}:README.md`)).toContain(
      "Shoppers add skus to the basket with `add(sku)`.",
    );
    const events = await setup.events();
    expect(
      ofType(events, "branch.pushed").map(({ agentId }) => agentId),
    ).toEqual([setup.coder.id, docs?.id]);

    // Then ready-to-merge, let go, with its Handoff.
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→needs-docs",
      "needs-docs→ready-to-merge",
    ]);
    expect(
      ofType(events, "handoff")
        .filter(({ stage }) => stage === "needs-docs")
        .map(({ fromAgentId, toAgentId }) => [fromAgentId, toAgentId]),
    ).toEqual([[qa?.id, docs?.id]]);
    expect(setup.stores.reviews.handoffs.at(-1)).toMatchObject({
      stage: "ready-to-merge",
      fromAgentId: docs?.id,
      summary: {
        changed: "The README says how to add to the basket.",
        check: "The README's example.",
        risks: "None.",
      },
    });
    // Then the Floor's Merge Policy, send to me, hands it to the Owner.
    expect(
      (await setup.notices.open())
        .filter(({ kind }) => kind === "action")
        .map(({ title }) => title),
    ).toEqual(["PR #2 awaiting your approval"]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "needs-docs finished",
      "ready-to-merge finished",
    ]);
  });

  it("follows review directly on a Floor with a docs Agent but no QA Agent", async () => {
    setup = await scenario({ withDocs: true, withQa: false });
    const { model, grace, quinta, docs } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(setup.qaPrompts).toEqual([]);
    expect(setup.docsPrompts).toHaveLength(1);
    expect(setup.docsPrompts[0]).toContain(
      `What changed: Approved by ${grace.name} and Quinta in round 1 of the Review Loop.`,
    );
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-docs",
      "needs-docs→ready-to-merge",
    ]);
    expect(
      ofType(await setup.events(), "handoff")
        .filter(({ stage }) => stage === "needs-docs")
        .map(({ fromAgentId, toAgentId }) => [fromAgentId, toAgentId]),
    ).toEqual([[grace.id, docs?.id]]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-docs finished",
      "ready-to-merge finished",
    ]);
  });

  it("is skipped on a Floor without a docs Agent", async () => {
    setup = await scenario();
    const { model, grace, quinta } = setup;
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    expect(setup.docs).toBeUndefined();
    expect(setup.docsPrompts).toEqual([]);
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    expect(await stageMoves(setup)).toEqual([
      "-→needs-work",
      "needs-work→needs-review",
      "needs-review→needs-qa",
      "needs-qa→ready-to-merge",
    ]);
    expect(
      await gitIn(setup.remote, "log", "--format=%s", `main..${branch}`),
    ).toBe("feat: a basket, take 1");
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "ready-to-merge finished",
    ]);
  });
});
