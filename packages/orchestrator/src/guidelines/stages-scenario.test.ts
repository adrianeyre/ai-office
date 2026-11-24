import { afterEach, describe, expect, it } from "vitest";

import { repositoryAgentFilesNote } from "../sandbox/agent-tools.ts";
import { approve, ofType, scenario, type Scenario } from "../work/scenario.ts";
import {
  approvedGuideline,
  releaseGuideline,
  techGuideline,
  webGuideline,
} from "./testing.ts";

// The pipeline end to end on a Floor with Guidelines (Guidelines, Specs and
// Hooks PRD, FR-105, FR-106): each Stage chooses its task's Guidelines and
// gets them as its kind of Agent does. The coder writes `src/basket.ts`;
// the issue has no Batch, so no Plan names its files.

const basketGuideline = approvedGuideline(
  "basket",
  [
    "inclusion: fileMatch",
    'fileMatchPattern: "src/**/*.ts"',
    "description: The basket's code.",
  ],
  "Keep the basket pure: no I/O in src/.",
);

let current: Scenario | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("each Stage's Guidelines on a Floor with them", () => {
  it("mounts the sandbox Stages' and quotes the reviewers', by the Plan's files or the pull request's, and the issue's labels", async () => {
    const s = await scenario({
      withDocs: true,
      design: [{ result: "pass" }],
      issueLabels: [{ name: "guideline:release" }],
      guidelines: [
        techGuideline,
        basketGuideline,
        webGuideline,
        releaseGuideline,
      ],
    });
    current = s;
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();
    expect(
      ofType(await s.events(), "issue.label_changed").map(({ to }) => to),
    ).toContain("ready-to-merge");

    // Sandboxes: the work Stage and the designer, with no Plan naming the
    // issue's files, follow the always and labelled ones and have the
    // fileMatch ones mounted to read before changing a matching file; QA
    // and docs follow those the pull request's files match.
    expect(s.mountedGuidelines).toEqual([
      {
        agent: "coder",
        files: ["basket.md", "release.md", "tech.md", "web.md"],
      },
      { agent: "qa", files: ["basket.md", "release.md", "tech.md"] },
      {
        agent: "designer",
        files: ["basket.md", "release.md", "tech.md", "web.md"],
      },
      { agent: "docs", files: ["basket.md", "release.md", "tech.md"] },
    ]);
    const [coder = ""] = s.prompts;
    expect(coder).toContain("- `release.md`: for this issue, whose");
    expect(coder).toContain(
      "- `basket.md`: for files matching `src/**/*.ts`. The basket's code.",
    );
    const [qa = ""] = s.qaPrompts;
    expect(qa).toContain(
      "- `basket.md`: for the files this pull request changes that match `src/**/*.ts`.",
    );
    for (const prompt of [coder, qa, ...s.docsPrompts, ...s.designPrompts]) {
      expect(prompt).toContain("/home/agent/.ai-office/guidelines/");
      // The repository's own `.agents/` is still its content (P1-9).
      expect(prompt).toContain(repositoryAgentFilesNote);
    }

    // Reviewers: quoted, by the pull request's files.
    for (const reviewer of [s.grace, s.quinta]) {
      const [request] = s.model.requestsOf(reviewer.id);
      const system = request?.system ?? "";
      expect(system).toContain('<guideline name="basket">');
      expect(system).toContain('<guideline name="release">');
      expect(system).toContain('<guideline name="tech">');
      expect(system).not.toContain('<guideline name="web">');
    }
    expect(ofType(await s.events(), "guideline.over_budget")).toEqual([]);
  });

  it("changes no prompt and mounts nothing on a Floor whose Guidelines are none of a task's", async () => {
    const s = await scenario({
      guidelines: [
        approvedGuideline(
          "api",
          ["inclusion: fileMatch", 'fileMatchPattern: "api/**"'],
          "Rules.",
        ),
      ],
    });
    current = s;
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();
    // The coder is told of it, to read before changing a matching file;
    // reviewers and QA, whose pull request changes none, get nothing.
    expect(s.mountedGuidelines).toEqual([
      { agent: "coder", files: ["api.md"] },
      { agent: "qa", files: [] },
    ]);
    expect(s.qaPrompts[0]).not.toContain("Guidelines");
    for (const reviewer of [s.grace, s.quinta]) {
      expect(s.model.requestsOf(reviewer.id)[0]?.system).not.toContain(
        "Guidelines",
      );
    }
  });
});
