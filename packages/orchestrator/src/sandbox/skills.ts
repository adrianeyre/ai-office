import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentTool, SkillFile } from "@ai-office/shared";

// Skills in sandboxes (PRD FR-75): the Skills on for an Agent's Role are
// written to a folder of their own beside the clone (never in it, so they
// cannot be committed), then bind-mounted read-only where the Agent's
// tool looks for its user's Skills. Each tool also finds the repository's
// own Skills in the worktree, as it would anywhere.

/** Where each agent tool finds its user's Skills, one folder per Skill. */
export const skillDirectories: Readonly<Record<AgentTool, string>> = {
  "Claude Code": "/home/agent/.claude/skills",
  Codex: "/home/agent/.agents/skills",
  opencode: "/home/agent/.config/opencode/skills",
};

/** A bind mount into a sandbox: a Skills folder, always read-only. */
export interface SkillMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: true;
}

/** A Skill to mount: its name (its folder's) and files. */
export interface SkillToMount {
  readonly name: string;
  readonly files: readonly SkillFile[];
}

/** The mount that gives `tool` the Skills written to `hostPath`. */
export const skillMounts = (
  hostPath: string,
  tool: AgentTool,
): SkillMount[] => [
  { hostPath, sandboxPath: skillDirectories[tool], readonly: true },
];

/**
 * Writes each Skill to `<into>/<name>/`, its files read-only. Paths were
 * checked when the Skill was read (relative, without `.` or `..`).
 */
export async function writeSkills(
  into: string,
  skills: readonly SkillToMount[],
): Promise<void> {
  await mkdir(into, { recursive: true });
  for (const { name, files } of skills) {
    for (const { path, content } of files) {
      const target = join(into, name, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
      await chmod(target, 0o444);
    }
  }
}
