import type { AgentTool } from "@ai-office/shared";

// The sandbox images, one per agent tool (PRD FR-16), as `pnpm
// sandbox:build` tags them. Each tag's version changes whenever its
// Dockerfile does, so a server never runs sandboxes from a stale build.

/** Claude Code's image, built from docker/sandbox-claude/Dockerfile. */
export const claudeSandboxImage = "ai-office/sandbox-claude:6";

/** Codex's image, built from docker/sandbox-codex/Dockerfile. */
export const codexSandboxImage = "ai-office/sandbox-codex:6";

/** opencode's image, built from docker/sandbox-opencode/Dockerfile. */
export const opencodeSandboxImage = "ai-office/sandbox-opencode:6";

/** Each agent tool's image. */
export const sandboxImages: Readonly<Record<AgentTool, string>> = {
  "Claude Code": claudeSandboxImage,
  Codex: codexSandboxImage,
  opencode: opencodeSandboxImage,
};
