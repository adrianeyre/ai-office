import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createFakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolRun } from "../models/agent-tool-client.ts";
import { dockerSessionTool } from "./chat-sessions.ts";

// G1 (issue #195), "AI Gateway and credentials": the Manager chat's way to
// models (FR-24, ADR 0004). Its session reaches the AI Gateway with the
// Manager's own Gateway Key, an Agent's key like any other: what the
// Gateway allows it, and the Token Caps it is held to, are those of the
// Manager (`apps/server/src/token-caps/enforcement.pen-test.test.ts`).
// These probes drive the real `dockerSessionTool` against a local bare
// repository and a recording tool runner, and keep holding that each turn
// is given only the Gateway's URL and the Manager's key, names its
// conversation as its session and no issue, and carries no GitHub token
// and no AI Account credential. That the key can be read inside the
// session and sent out is P2-1; what it can do at the Gateway is G1-1 to
// G1-5.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

const git = promisify(execFile);
const repository = "adrianeyre/web-shop";
const managerKey = "aio_gk_joansownkeyforhersession00000000000";
const conversation = "manager-chat:web-shop:0";

const answered = {
  "Claude Code": [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
  ],
  Codex: [
    JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "ok" },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ],
} as const;

const turn = (tool: "Claude Code" | "Codex") =>
  ({
    tool,
    floor: { id: "web-shop", repository, defaultBranch: "main" },
    manager: {
      id: "joan",
      aiProvider: tool === "Claude Code" ? "Claude" : "ChatGPT",
    },
    model: tool === "Claude Code" ? "claude-opus-5-5" : "gpt-5.5-codex",
    effort: "high",
    system: "You are Joan.",
    conversation,
    session:
      tool === "Claude Code"
        ? { resume: false as const, id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e" }
        : { resume: false as const, id: null },
    input: "Where is VAT?",
    images: [],
    signal: new AbortController().signal,
    onText: () => undefined,
    onTool: () => undefined,
    onSession: () => undefined,
  }) as never;

describe("G1: the Manager chat's Gateway path", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  const seeded = async () => {
    root = await mkdtemp(join(tmpdir(), "g1-manager-chat-"));
    const remote = join(root, "web-shop.git");
    const seed = join(root, "seed");
    await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await git("git", ["init", "--quiet", "-b", "main", seed]);
    await writeFile(join(seed, "total.ts"), "export const vat = 0.2;\n");
    const gitIn = (...args: string[]) =>
      git(
        "git",
        ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
        { cwd: seed },
      );
    await gitIn("add", "-A");
    await gitIn("commit", "--quiet", "-m", "chore: start");
    await gitIn("push", "--quiet", remote, "main");
    return remote;
  };

  for (const tool of ["Claude Code", "Codex"] as const) {
    it(`${tool}: each turn is given the Manager's own key and its conversation as the session, and nothing else to reach models with`, async () => {
      const remote = await seeded();
      const github = createFakeGitHub();
      github.installRepository(repository);
      const runs: ToolRun[] = [];
      const asked: string[] = [];
      const sessions = dockerSessionTool({
        github,
        gateway: (managerId) => {
          asked.push(managerId);
          return Promise.resolve({ url: "http://app:3047", key: managerKey });
        },
        async *run(run) {
          runs.push(run);
          await Promise.resolve();
          yield* answered[tool];
        },
        workDir: join(root ?? "", "work"),
        cloneUrl: () => remote,
      });
      await sessions.run(turn(tool));
      expect(asked).toEqual(["joan"]);
      const environment = runs[0]?.environment ?? {};
      if (tool === "Claude Code") {
        expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBe(managerKey);
        expect(environment["ANTHROPIC_CUSTOM_HEADERS"]).toBe(
          `x-ai-office-session: ${conversation}`,
        );
      } else {
        expect(environment["AI_OFFICE_GATEWAY_KEY"]).toBe(managerKey);
        expect(environment["AI_OFFICE_SESSION"]).toBe(conversation);
        expect(environment["AI_OFFICE_ISSUE"]).toBeUndefined();
      }
      const values = Object.values(environment).join("\n");
      // No GitHub token, no AI Account credential, no other key.
      expect(environment["GH_TOKEN"] ?? "").toBe("");
      expect(values).not.toMatch(/x-ai-office-issue|sk-ant-|sk-proj-|ghs_/);
      expect(values.match(/aio_gk_[A-Za-z0-9_-]+/g)).toEqual([managerKey]);
    });
  }
});
