import { describe, expect, it, vi } from "vitest";

import { dockerSandbox } from "./runner.ts";
import { skillDirectories, skillMounts } from "./skills.ts";

// Skills in sandboxes (PRD FR-75): mounted read-only where each agent tool
// finds its user's Skills. Docker is not run here: its provider is
// replaced, to see the mounts the sandbox is started with.

const dockerOptions = vi.hoisted(() => [] as unknown[]);
vi.mock("./docker.ts", () => ({
  dockerProvider: (options: unknown) => {
    dockerOptions.push(options);
    return { tag: "bind-mount", name: "docker" };
  },
}));

describe("Skill mounts", () => {
  it("put the Skills where each agent tool looks for its user's Skills", () => {
    expect(skillMounts("/srv/runs/sbx-1-skills", "Claude Code")).toEqual([
      {
        hostPath: "/srv/runs/sbx-1-skills",
        sandboxPath: "/home/agent/.claude/skills",
        readonly: true,
      },
    ]);
    expect(skillDirectories).toEqual({
      "Claude Code": "/home/agent/.claude/skills",
      Codex: "/home/agent/.agents/skills",
      opencode: "/home/agent/.config/opencode/skills",
    });
    for (const tool of ["Claude Code", "Codex", "opencode"] as const) {
      expect(skillMounts("/srv/skills", tool)).toEqual([
        {
          hostPath: "/srv/skills",
          sandboxPath: skillDirectories[tool],
          readonly: true,
        },
      ]);
    }
  });

  it("are given to Docker read-only, and only when there are Skills", () => {
    dockerOptions.length = 0;
    const sandbox = dockerSandbox({ network: "ai-office-sandboxes" });
    sandbox(
      { GH_TOKEN: "read-only" },
      "Codex",
      skillMounts("/srv/skills", "Codex"),
    );
    sandbox({ GH_TOKEN: "read-only" }, "Codex", []);
    expect(dockerOptions).toEqual([
      {
        imageName: "ai-office/sandbox-codex:6",
        env: { GH_TOKEN: "read-only" },
        mounts: [
          {
            hostPath: "/srv/skills",
            sandboxPath: "/home/agent/.agents/skills",
            readonly: true,
          },
        ],
        network: "ai-office-sandboxes",
      },
      {
        imageName: "ai-office/sandbox-codex:6",
        env: { GH_TOKEN: "read-only" },
        network: "ai-office-sandboxes",
      },
    ]);
  });
});
