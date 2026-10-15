import type { EventBus } from "@ai-office/events";
import type { GitHubApp, Repository } from "@ai-office/github";
import type { GitIdentity } from "@ai-office/shared";

import type { FloorRecord } from "../floors/store.ts";
import type { SandboxRun } from "../sandbox/runner.ts";
import type { TrailerAgent } from "./identity.ts";
import { publishBranch, type Published } from "./publish.ts";

// Pushing a sandbox run's branch (PRD FR-19; ADR 0002): AI Office, not the
// Agent, pushes, as the GitHub App, each new commit authored and committed
// as the Floor's Git identity with the Agent's trailer. Every flow whose
// Agent works in a sandbox (coder, QA, docs) pushes this way, and records
// it as `branch.pushed`. The coder's work is rebased onto the default
// branch first, before it goes to review (FR-25.5).

export interface PushRunOptions {
  readonly github: GitHubApp;
  readonly events: EventBus;
  /** Who a Floor's commits are by (FR-68). */
  readonly gitIdentity: (floorId: string) => Promise<GitIdentity>;
  /** Where branches are made ready to push, one directory each. */
  readonly scratchDir: string;
  /** Where to push a repository; its GitHub page plus `.git` by default. */
  readonly pushUrl?: (repository: Repository) => string;
}

/** Pushes `run`'s branch as the GitHub App, as the Owner's commits. */
export type PushRun = (input: {
  readonly floor: FloorRecord;
  readonly agentId: string;
  readonly trailer: TrailerAgent;
  readonly issue: number;
  readonly run: SandboxRun;
  /** Rebases it onto the Floor's default branch first, as GitHub has it. */
  readonly rebase?: boolean;
  readonly signal: AbortSignal;
}) => Promise<Published>;

export function createPushRun(options: PushRunOptions): PushRun {
  const { github, events } = options;
  return async ({ floor, agentId, trailer, issue, run, rebase, signal }) => {
    const client = github.repository(floor.repository);
    const [repository, writable] = await Promise.all([
      client.get(),
      client.installationToken(),
    ]);
    const published = await publishBranch({
      workspace: run.workspace,
      branch: run.branch,
      upstream: run.upstream,
      identity: await options.gitIdentity(floor.id),
      agent: trailer,
      url: options.pushUrl?.(repository) ?? `${repository.htmlUrl}.git`,
      token: writable.token,
      scratchDir: options.scratchDir,
      ...(rebase === true ? { rebaseOnto: floor.defaultBranch } : {}),
      signal,
    });
    await events.publish({
      type: "branch.pushed",
      version: 1,
      floorId: floor.id,
      agentId,
      issue,
      branch: run.branch,
      sha: published.sha,
      commits: published.commits.length,
      ...(published.rebase === undefined
        ? {}
        : {
            rebase: {
              outcome: published.rebase.outcome,
              onto: published.rebase.onto,
              base: published.rebase.base,
              ...(published.rebase.outcome === "conflict"
                ? { files: published.rebase.files.slice(0, 100) }
                : {}),
            },
          }),
    });
    return published;
  };
}
