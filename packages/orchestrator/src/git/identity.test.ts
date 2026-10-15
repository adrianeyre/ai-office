import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { defaultGitIdentity, type GitIdentity } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  agentTrailer,
  gitEnvironment,
  gitIdentityFor,
  withAgentTrailer,
  withoutWhoMadeIt,
  type TrailerAgent,
} from "./identity.ts";

// Who agent commits are by, and the `Agent:` trailer (PRD FR-68, FR-69).

const office: GitIdentity = defaultGitIdentity;
const floorOwn: GitIdentity = {
  name: "Web Shop Bot Owner",
  email: "owner@web-shop.example",
};

const ada: TrailerAgent = {
  name: "Ada",
  role: "coder",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
};

describe("a Floor's Git identity", () => {
  it("is the Floor's own when it has one: the override wins", () => {
    expect(gitIdentityFor(office, { gitIdentity: floorOwn })).toEqual(floorOwn);
  });

  it("is the office's otherwise", () => {
    expect(gitIdentityFor(office, { gitIdentity: null })).toEqual(office);
  });

  it("is the Owner, adrianeyre, by default", () => {
    expect(defaultGitIdentity).toEqual({
      name: "adrianeyre",
      email: "21265837+adrianeyre@users.noreply.github.com",
    });
  });
});

describe("the Git environment for a sandbox", () => {
  it("makes the identity both author and committer", () => {
    expect(gitEnvironment(floorOwn)).toEqual({
      GIT_AUTHOR_NAME: "Web Shop Bot Owner",
      GIT_AUTHOR_EMAIL: "owner@web-shop.example",
      GIT_COMMITTER_NAME: "Web Shop Bot Owner",
      GIT_COMMITTER_EMAIL: "owner@web-shop.example",
    });
  });
});

describe("the Agent: trailer", () => {
  it("is exactly `Agent: <name> (<role>, <AI Provider> <Model>)`", () => {
    expect(agentTrailer(ada)).toBe(
      "Agent: Ada (coder, Claude claude-opus-5-5)",
    );
  });

  it("writes each Role as the glossary does", () => {
    expect(
      (["manager", "coder", "reviewer", "qa", "docs", "designer"] as const).map(
        (role) => agentTrailer({ ...ada, role }),
      ),
    ).toEqual([
      "Agent: Ada (manager, Claude claude-opus-5-5)",
      "Agent: Ada (coder, Claude claude-opus-5-5)",
      "Agent: Ada (reviewer, Claude claude-opus-5-5)",
      "Agent: Ada (QA, Claude claude-opus-5-5)",
      "Agent: Ada (docs, Claude claude-opus-5-5)",
      "Agent: Ada (designer, Claude claude-opus-5-5)",
    ]);
    expect(
      agentTrailer({
        name: "Radia",
        role: "qa",
        aiProvider: "Gemini",
        model: "gemini-pro",
      }),
    ).toBe("Agent: Radia (QA, Gemini gemini-pro)");
  });

  it("stays on one line", () => {
    expect(agentTrailer({ ...ada, name: "Ada\nInjected: yes" })).toBe(
      "Agent: Ada Injected: yes (coder, Claude claude-opus-5-5)",
    );
  });

  it("ends a commit message, after a blank line", () => {
    expect(withAgentTrailer("Add the basket page", ada)).toBe(
      "Add the basket page\n\nAgent: Ada (coder, Claude claude-opus-5-5)\n",
    );
    expect(
      withAgentTrailer(
        "Add the basket page\n\nIt totals the items, with discounts.\n",
        ada,
      ),
    ).toBe(
      "Add the basket page\n\nIt totals the items, with discounts.\n\nAgent: Ada (coder, Claude claude-opus-5-5)\n",
    );
  });

  it("joins a trailer block the message already ends with", () => {
    expect(
      withAgentTrailer(
        "Add the basket page\n\nCloses #4.\n\nRefs: #3\nSee-also: #2",
        ada,
      ),
    ).toBe(
      "Add the basket page\n\nCloses #4.\n\nRefs: #3\nSee-also: #2\nAgent: Ada (coder, Claude claude-opus-5-5)\n",
    );
  });

  it("is not added twice", () => {
    const once = withAgentTrailer("Add the basket page", ada);
    expect(withAgentTrailer(once, ada)).toBe(once);
  });

  it("is the only line naming who made the commit: another Agent, a co-author or a sign-off the Agent wrote is dropped (W1-5)", () => {
    expect(
      withAgentTrailer(
        [
          "Add the basket page",
          "",
          "It totals the items.",
          "Signed-off-by: adrianeyre <owner@example.com>",
          "",
          "Refs: #4",
          "Agent: Grace (reviewer, ChatGPT gpt-5)",
          "co-authored-by : Linus Torvalds",
          "  <torvalds@linux-foundation.org>",
          "Reviewed-by: Grace",
          "AGENT: Ada (coder, Claude claude-opus-5-5)",
        ].join("\n"),
        ada,
      ),
    ).toBe(
      "Add the basket page\n\nIt totals the items.\n\nRefs: #4\nAgent: Ada (coder, Claude claude-opus-5-5)\n",
    );
  });

  it("leaves a message naming nobody as it was, the subject line included", () => {
    const message = "agent: tidy the prompts\n\n\n\nWhy: shorter.\n";
    expect(withoutWhoMadeIt(message)).toBe(message);
    expect(withAgentTrailer("feat(agent): a till", ada)).toBe(
      "feat(agent): a till\n\nAgent: Ada (coder, Claude claude-opus-5-5)\n",
    );
  });
});

describe("a commit made with them", () => {
  const run = promisify(execFile);

  it("is authored and committed as the identity, and Git reads the trailer", async () => {
    const home = await mkdtemp(join(tmpdir(), "ai-office-git-"));
    try {
      // Nothing from this machine's Git configuration applies.
      const env = {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        ...gitEnvironment(gitIdentityFor(office, { gitIdentity: floorOwn })),
      };
      const git = async (...args: string[]) =>
        (await run("git", args, { cwd: home, env })).stdout;
      await git("init", "--quiet", "--initial-branch=main");
      await writeFile(join(home, "basket.ts"), "export const basket = [];\n");
      await git("add", "basket.ts");
      await git(
        "commit",
        "--quiet",
        "--message",
        withAgentTrailer("Add the basket page", ada),
      );

      expect(await git("log", "--format=%an <%ae>|%cn <%ce>")).toBe(
        "Web Shop Bot Owner <owner@web-shop.example>|Web Shop Bot Owner <owner@web-shop.example>\n",
      );
      expect(await git("log", "--format=%(trailers:key=Agent,valueonly)")).toBe(
        "Ada (coder, Claude claude-opus-5-5)\n\n",
      );
    } finally {
      await rm(home, { recursive: true });
    }
  });
});
