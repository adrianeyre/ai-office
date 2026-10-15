import { existsSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createRoleMemoryReview } from "./role-review.ts";
import {
  memoryFiles,
  mountedMemorySection,
  proposingRoleMemory,
  quotedMemorySection,
} from "./shared.ts";
import { approve, ofType, scenario, type Scenario } from "../work/scenario.ts";

// Office-wide and Role memory end to end (PRD FR-54, FR-55, FR-56): the
// pipeline runs an issue from intake to `ready-to-merge` with the coder,
// two reviewers, QA and a docs Agent. Every sandbox has the office-wide
// memory and its Role's memory mounted read-only; every reviewer's prompt
// quotes them. The Agents propose Role memory in their Handoffs and
// report; what looks like a secret is refused, the Manager recommends or
// rejects the rest, and only the Owner accepts (ADR 0005).

const officeText = [
  "# Coding standards",
  "",
  "- Use pnpm, never npm.",
  "- Every exported function has a TSDoc comment.",
].join("\n");
const coderLesson = "Write the failing test first, then the fix.";
const reviewerLesson = "Check that every new route declares its access.";
const qaLesson = "Run the tests twice: the basket tests are order-dependent.";
const anthropicKey = "sk-ant-api03-thecodersleakedkey0123";
const smallCommits = "Keep each commit to one change, with its tests.";
const qaProposal = "Add a test for each step that reproduces a failure.";

let current: Scenario | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("office-wide and Role memory", () => {
  it("is mounted read-only into every sandbox and quoted in every reviewer's prompt; Agents propose Role memory, a secret is refused, the Manager recommends and the Owner accepts", async () => {
    const s = await scenario({
      withDocs: true,
      officeMemory: officeText,
      roleMemory: {
        coder: [coderLesson],
        reviewer: [reviewerLesson],
        qa: [qaLesson],
      },
      roleProposals: {
        coder: [smallCommits, `Push with ${anthropicKey} when CI is slow.`],
        qa: [qaProposal],
      },
    });
    current = s;
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();

    // The issue went all the way.
    expect(
      ofType(await s.events(), "issue.label_changed").map(({ to }) => to),
    ).toContain("ready-to-merge");

    // 1. Every sandbox had the memory mounted read-only, at the same place,
    //    and found it there while it worked: the office-wide memory, and
    //    its own Role's (the docs Role has none yet).
    expect(s.mountedMemory.map(({ agent }) => agent)).toEqual([
      "coder",
      "qa",
      "docs",
    ]);
    for (const { mount, files } of s.mountedMemory) {
      expect(mount?.sandboxPath).toBe("/home/agent/.ai-office/memory");
      expect(mount?.readonly).toBe(true);
      expect(files.every(({ writable }) => !writable)).toBe(true);
      // Beside the clone, never in it, and deleted with it.
      expect(existsSync(mount?.hostPath ?? "")).toBe(false);
    }
    const [coderMount, qaMount, docsMount] = s.mountedMemory;
    const filesOf = (role: "coder" | "qa" | "docs", entries: string[]) =>
      memoryFiles({ office: officeText, role: entries, roleOf: role }).map(
        ({ name, content }) => ({ name, content, writable: false }),
      );
    expect(coderMount?.files).toEqual(filesOf("coder", [coderLesson]));
    expect(qaMount?.files).toEqual(filesOf("qa", [qaLesson]));
    expect(docsMount?.files).toEqual(filesOf("docs", []));
    expect(docsMount?.files.map(({ name }) => name)).toEqual(["OFFICE.md"]);

    // 2. Each sandbox Agent's prompt says where the memory is, and how to
    //    propose to its Role's.
    const prompts: [string | undefined, "coder" | "qa" | "docs", string[]][] = [
      [s.prompts[0], "coder", [coderLesson]],
      [s.qaPrompts[0], "qa", [qaLesson]],
      [s.docsPrompts[0], "docs", []],
    ];
    for (const [prompt, role, entries] of prompts) {
      expect(prompt).toContain(
        mountedMemorySection({
          office: officeText,
          role: entries,
          roleOf: role,
        }).join("\n"),
      );
      expect(prompt).toContain(
        proposingRoleMemory(role === "qa" ? "report" : "Handoff", role).join(
          "\n",
        ),
      );
      // Mounted, not pasted in.
      expect(prompt).not.toContain("Every exported function has a TSDoc");
    }

    // 3. Each reviewer's prompt quotes the office-wide memory and the
    //    reviewers' Role memory.
    const quoted = quotedMemorySection({
      office: officeText,
      role: [reviewerLesson],
      roleOf: "reviewer",
    }).join("\n");
    for (const reviewer of [s.grace, s.quinta]) {
      const [request] = s.model.requestsOf(reviewer.id);
      expect(request?.messages[0]?.content).toContain(quoted);
      expect(request?.system).toContain(
        "The repository's memory, the office-wide and Role memory, the issue",
      );
    }

    // 4. The coder's and QA's proposals wait for a decision; the coder's
    //    secret was refused, and is nowhere.
    const proposals = ofType(await s.events(), "memory.role_proposed");
    expect(
      proposals.map(({ agentId, role, entries, refused }) => ({
        agentId,
        role,
        entries,
        refused,
      })),
    ).toEqual([
      // The Role memory the scenario started with, as the Owner gave it.
      {
        agentId: s.coder.id,
        role: "coder",
        entries: [coderLesson],
        refused: 0,
      },
      {
        agentId: s.grace.id,
        role: "reviewer",
        entries: [reviewerLesson],
        refused: 0,
      },
      { agentId: s.qa?.id, role: "qa", entries: [qaLesson], refused: 0 },
      // What the Agents proposed in their Handoff and report.
      {
        agentId: s.coder.id,
        role: "coder",
        entries: [smallCommits],
        refused: 1,
      },
      { agentId: s.qa?.id, role: "qa", entries: [qaProposal], refused: 0 },
    ]);
    const waiting = (await s.sharedMemory.roleEntries("web-shop")).filter(
      ({ status }) => status === "proposed",
    );
    expect(waiting.map(({ text, issue }) => ({ text, issue }))).toEqual([
      { text: smallCommits, issue: 1 },
      { text: qaProposal, issue: 1 },
    ]);
    const everything = JSON.stringify([
      await s.events(),
      s.stores.officeMemory.roleEntries,
      s.model.requests,
    ]);
    expect(everything).not.toContain(anthropicKey);
    // The proposals are no part of the Handoffs.
    for (const { summary } of ofType(await s.events(), "handoff")) {
      expect(JSON.stringify(summary)).not.toContain("role-memory");
      expect(JSON.stringify(summary)).not.toContain(smallCommits);
    }

    // 5. The Manager recommends one and rejects the other; the next coder
    //    is given the recommended one only once the Owner accepts it
    //    (ADR 0005).
    const [smallId, qaId] = waiting.map(({ id }) => id);
    s.model.answer(
      s.manager.id,
      JSON.stringify({
        decisions: [
          { id: smallId, decision: "accept", reason: "True of all work." },
          { id: qaId, decision: "reject", reason: "QA does this already." },
        ],
      }),
    );
    const review = createRoleMemoryReview({
      floors: s.stores.floors,
      agents: s.stores.agents,
      memory: s.sharedMemory,
      store: s.stores.officeMemory,
      models: s.model,
    });
    await review.check();
    expect(
      ofType(await s.events(), "memory.role_changed")
        .filter(({ by }) => by === "manager")
        .map(({ text, change, agentId }) => ({ text, change, agentId })),
    ).toEqual([
      { text: smallCommits, change: "recommended", agentId: s.manager.id },
      { text: qaProposal, change: "rejected", agentId: s.manager.id },
    ]);
    expect((await s.sharedMemory.forAgent("web-shop", "coder")).role).toEqual([
      coderLesson,
    ]);
    await s.sharedMemory.decide("web-shop", smallId ?? 0, "accept", {
      by: "owner",
    });
    expect((await s.sharedMemory.forAgent("web-shop", "coder")).role).toEqual([
      coderLesson,
      smallCommits,
    ]);
  });

  it("leaves every prompt and sandbox as it was when AI Office keeps no office-wide or Role memory", async () => {
    const s = await scenario();
    current = s;
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();
    expect(s.mountedMemory.map(({ mount }) => mount)).toEqual([
      undefined,
      undefined,
    ]);
    for (const prompt of [s.prompts[0], s.qaPrompts[0]]) {
      expect(prompt).not.toContain("Office-wide and Role memory");
      expect(prompt).not.toContain("<role-memory>");
    }
  });
});
