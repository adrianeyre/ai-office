import { mergeActions } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  approve,
  labelsOf,
  ofType,
  repository,
  requestChanges,
  scenario,
  workDone,
  type Scenario,
} from "../work/scenario.ts";

// The Merge Policy end to end (PRD FR-29, FR-49; §5 scenario 3; ADR 0002):
// the Owner labels an issue; the coder (Claude Code, as a script in a fake
// sandbox) works it, the Floor's two required reviewers approve it, QA
// passes it, and at ready-to-merge the Floor's Merge Policy either has the
// GitHub App merge it, once CI on its head has finished, or hands it to the
// Owner with an action Notice whose "Approve and merge" merges it.

let setup: Scenario | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

const notices = async (current: Scenario, kind: "action" | "info") =>
  (await current.notices.open()).filter((notice) => notice.kind === kind);

const pullRequest = (current: Scenario) =>
  current.fake.repository(repository).getPullRequest(2);

const approvedByBoth = (current: Scenario): void => {
  current.model.answer(current.grace.id, approve());
  current.model.answer(current.quinta.id, approve());
};

describe("the Merge Policy", () => {
  it("sends the pull request to the Owner by default, and merges it when the Owner approves it from the Notice", async () => {
    setup = await scenario({ ci: [{ conclusion: "success" }] });
    approvedByBoth(setup);
    await setup.run();

    // §5 scenario 3: "PR #2 awaiting your approval", with its links.
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    const opened = await pullRequest(setup);
    expect(opened.merged).toBe(false);
    const [notice, ...others] = await notices(setup, "action");
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      title: "PR #2 awaiting your approval",
      floorId: "web-shop",
      issue: { number: 1, url: `https://github.com/${repository}/issues/1` },
      pullRequest: { number: 2, url: opened.htmlUrl },
      links: [
        { label: "Review round 1", url: expect.any(String) as string },
        { label: "QA round 1", url: expect.any(String) as string },
      ],
      actions: [
        { id: mergeActions.approveAndMerge, label: "Approve and merge" },
      ],
    });
    // It did not wait for CI: the Owner decides.
    expect(setup.ciWaits()).toBe(0);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "ready-to-merge finished",
    ]);

    // The Owner approves and merges: the App merges it.
    await setup.notices.act(notice?.id ?? "", mergeActions.approveAndMerge);
    expect(await pullRequest(setup)).toMatchObject({
      merged: true,
      state: "closed",
    });
    expect((await setup.fake.repository(repository).getIssue(1)).state).toBe(
      "closed",
    );
    expect(
      ofType(await setup.events(), "pull_request.merged").map(
        ({ pullRequest: number, by }) => [number, by],
      ),
    ).toEqual([[2, "owner"]]);
    expect(await notices(setup, "action")).toEqual([]);
    expect((await notices(setup, "info")).map(({ title }) => title)).toEqual([
      "PR #2 merged, as you approved it.",
      "PR #2 opened: Add a basket!",
    ]);
  });

  it("merges automatically once CI on the head passes, on an auto-merge Floor", async () => {
    setup = await scenario({
      mergePolicy: "auto_merge",
      ci: [{ name: "test", conclusion: "success" }],
      requiredChecks: ["test"],
    });
    // Round 1 asks for a change; round 2 approves.
    setup.model.answer(
      setup.grace.id,
      requestChanges("Shoppers cannot add to it yet."),
      approve(),
    );
    setup.model.answer(setup.quinta.id, approve(), approve());
    await setup.run();

    // It waited for CI, then the App merged it.
    expect(setup.ciWaits()).toBe(1);
    expect(await pullRequest(setup)).toMatchObject({ merged: true });
    const merged = ofType(await setup.events(), "pull_request.merged");
    expect(merged).toEqual([
      expect.objectContaining({
        floorId: "web-shop",
        issue: 1,
        pullRequest: 2,
        by: "app",
      }),
    ]);
    expect(await notices(setup, "action")).toEqual([]);
    expect((await notices(setup, "info")).map(({ title }) => title)).toContain(
      "PR #2 merged automatically: every required reviewer approved and CI passed.",
    );
    expect(workDone(setup).at(-1)).toBe("ready-to-merge finished");
  });

  it("sends the pull request to the Owner, saying why, when CI fails on an auto-merge Floor", async () => {
    setup = await scenario({
      mergePolicy: "auto_merge",
      ci: [{ name: "test", conclusion: "failure" }],
    });
    approvedByBoth(setup);
    await setup.run();

    expect(await pullRequest(setup)).toMatchObject({ merged: false });
    expect(ofType(await setup.events(), "pull_request.merged")).toEqual([]);
    const [notice, ...others] = await notices(setup, "action");
    expect(others).toEqual([]);
    expect(notice?.title).toBe(
      'PR #2 awaiting your approval: not merged automatically, as CI check "test" failed.',
    );
    expect(notice?.ciRunUrl).toMatch(
      new RegExp(`^https://github.com/${repository}/runs/\\d+$`),
    );
    expect(notice?.actions).toEqual([
      {
        id: mergeActions.approveAndMerge,
        label: "Approve and merge",
        sha: (await pullRequest(setup)).head.sha,
      },
    ]);
  });

  it("sends the pull request to the Owner when a required check never runs", async () => {
    setup = await scenario({
      mergePolicy: "auto_merge",
      ci: [{ name: "test", conclusion: "success" }],
      requiredChecks: ["test", "e2e"],
    });
    approvedByBoth(setup);
    await setup.run();

    expect(await pullRequest(setup)).toMatchObject({ merged: false });
    expect((await notices(setup, "action")).map(({ title }) => title)).toEqual([
      'PR #2 awaiting your approval: not merged automatically, as the required check "e2e" never ran.',
    ]);
    // It waited half an hour, a look every 30 seconds.
    expect(setup.ciWaits()).toBe(60);
  });

  it("merges automatically on a send-to-me Floor when the Owner labelled the issue ai-office:auto-merge", async () => {
    setup = await scenario({
      issueLabels: [{ name: "ai-office:auto-merge" }],
      ci: [{ conclusion: "success" }],
    });
    approvedByBoth(setup);
    await setup.run();

    expect(await pullRequest(setup)).toMatchObject({ merged: true });
    expect(await notices(setup, "action")).toEqual([]);
  });

  it("sends the pull request to the Owner on an auto-merge Floor when the issue is labelled ai-office:manual", async () => {
    setup = await scenario({
      mergePolicy: "auto_merge",
      issueLabels: [{ name: "ai-office:manual" }],
      ci: [{ conclusion: "success" }],
    });
    approvedByBoth(setup);
    await setup.run();

    expect(await pullRequest(setup)).toMatchObject({ merged: false });
    expect((await notices(setup, "action")).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval (ai-office:manual)",
    ]);
    expect(setup.ciWaits()).toBe(0);
  });
});
