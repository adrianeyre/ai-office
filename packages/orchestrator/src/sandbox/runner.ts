import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  run as sandcastleRun,
  type AgentStreamEvent,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { maxStreamText, type EventBus } from "@ai-office/events";
import type {
  GitHubApp,
  InstallationToken,
  Repository,
} from "@ai-office/github";
import type { AgentTool, GitIdentity, Role } from "@ai-office/shared";

import {
  freshStartPrompt,
  maxTranscript,
  type FreshStartReason,
  type FreshStarts,
  type FreshStartWatch,
} from "../context/fresh-start.ts";
import type { MemoryFile } from "../memory/shared.ts";

import { runGit } from "../git/command.ts";
import { agentToolSetup } from "./agent-tools.ts";
import { issueBranch } from "./branch.ts";
import { cloneRepository } from "./clone.ts";
import { fileDiffs, type FileDiff } from "./diffs.ts";
import { dockerProvider } from "./docker.ts";
import { sandboxImages } from "./images.ts";
import { memoryMount, writeMemory } from "./memory.ts";
import {
  skillMounts,
  writeSkills,
  type SkillMount,
  type SkillToMount,
} from "./skills.ts";
import {
  allowListed,
  refuseAiAccountCredentials,
  sandboxEnvironment,
  type AiAccountCredentialCheck,
  type GatewayAccess,
  type SandboxEnvironment,
} from "./environment.ts";
import { guardSandcastleGit } from "./sandcastle-git.ts";
import type { ToolCallScreens } from "./tool-call-screens.ts";
import { makeWorkDir } from "./work-dir.ts";

// The sandbox runner (PRD FR-19, §8): runs one Agent's task with Sandcastle
// in a Docker sandbox. It clones the Floor's repository at its default
// branch, works on the issue's branch (`ai-office/<issue>-<slug>`, or its
// Batch's when the task names one, ADR 0010; the `branch` strategy), gives
// the sandbox only the allowed environment (the AI Gateway's URL and the
// Agent's Gateway Key, with its model calls attributed to the issue and
// pull request; never an AI Account's credential), runs the Floor's setup command when the sandbox is ready,
// then the agent tool of the Agent's AI Provider (FR-16), with the Floor's
// Skills on for the Agent's Role mounted read-only where that tool finds
// them (FR-75), and the office-wide and Role memory mounted read-only
// (FR-54, FR-55), and streams what the Agent says and the tools it calls
// to the event bus. Each tool call is screened (FR-17: AI Office's rules,
// and the Decision Model while it is on), and one judged unsafe stops the
// run: its work is thrown away and the run fails, saying why. With the
// screens open to the sandboxes (P1-8), Claude Code asks about each call
// before it runs, and a call judged unsafe never runs; Codex's and
// opencode's are screened as they stream. The Floor's setup command is
// screened before it runs too.
// It returns the commits and the tokens used, and kills the sandbox on
// timeout or cancellation. Pushing is not its business: AI Office pushes
// later.
//
// Each sandbox is one Agent session. With Fresh Starts (FR-86, FR-87), a
// session whose Context Usage crosses its threshold, or whose Fresh Start
// the Owner asks for, is ended: work not yet committed is saved in a
// commit, the sandbox stops, the Agent's Model writes its summary, and a
// new sandbox starts on the same branch in the same clone, its prompt
// carrying the summary. One Fresh Start past the cap pauses the Agent
// instead, and the run ends with its commits kept.

/** The task: one Agent working one issue on one Floor. */
export interface SandboxTask {
  readonly floor: {
    readonly id: string;
    /** `owner/name` on GitHub. */
    readonly repository: string;
    readonly defaultBranch: string;
    /** Run in the sandbox before the Agent starts; empty for none. */
    readonly setupCommand: string;
  };
  readonly agent: {
    readonly id: string;
    readonly role: Role;
    /** Such as `Claude`. */
    readonly aiProvider: string;
    readonly model: string;
    readonly effort: string | null;
  };
  readonly issue: { readonly number: number; readonly title: string };
  /**
   * The branch to work on: its Batch's, for an issue of a Batch handed
   * over "in one PR" (ADR 0010); the issue's own when absent.
   */
  readonly branch?: string;
  /** What the Agent is asked to do. Never holds a credential. */
  readonly prompt: string;
  /**
   * The office-wide and Role memory, mounted read-only where the prompt
   * says (FR-54, FR-55); none when absent or empty.
   */
  readonly memory?: readonly MemoryFile[];
  /** Who its commits are by: the Floor's identity (FR-68). */
  readonly gitIdentity: GitIdentity;
  /** Cancels the run, killing the sandbox. */
  readonly signal?: AbortSignal;
}

/** Tokens the Agent used, as its agent tool reported them. */
export interface SandboxUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** A finished run. */
export interface SandboxRun {
  readonly sandboxId: string;
  readonly branch: string;
  /** The commits the Agent made on `branch`, oldest first. */
  readonly commits: readonly string[];
  /**
   * What was on GitHub when the Agent started, read from the clone before
   * it ran: the default branch's head, and the branch's if it was pushed
   * before. The Agent's work is what `branch` has beyond these.
   */
  readonly upstream: readonly string[];
  /** Null when the agent tool reported none. */
  readonly usage: SandboxUsage | null;
  /**
   * The last text the agent said, such as its closing summary; null if it
   * said none. Written by the Agent, so untrusted.
   */
  readonly lastText: string | null;
  /** How many Fresh Starts it made (FR-86). */
  readonly freshStarts: number;
  /**
   * True when one more Fresh Start than the cap was due: the Agent is
   * paused and its work unfinished, its commits kept (FR-86).
   */
  readonly escalated: boolean;
  /** The host clone holding `branch`, for AI Office to push from. */
  readonly workspace: string;
  /** Deletes the clone. */
  discard(): Promise<void>;
}

export type SandboxOutcome = "failed" | "cancelled" | "timed_out";

/** A run that did not finish. Its sandbox is gone and its clone deleted. */
export class SandboxRunError extends Error {
  readonly outcome: SandboxOutcome;
  readonly sandboxId: string;

  constructor(
    outcome: SandboxOutcome,
    sandboxId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxRunError";
    this.outcome = outcome;
    this.sandboxId = sandboxId;
  }
}

export interface SandboxRunner {
  run(task: SandboxTask): Promise<SandboxRun>;
}

/** Sandcastle's `run`, or a stand-in with the same contract. */
export type RunSandcastle = typeof sandcastleRun;

export interface SandboxRunnerOptions {
  readonly github: GitHubApp;
  readonly events: EventBus;
  /**
   * The Sandcastle sandbox provider to start with `environment`, for
   * `tool`, with `mounts` (the Agent's Skills and memory, read-only): Docker with the
   * agent tool's image in production. Whatever else it or Sandcastle adds
   * to the environment is dropped.
   */
  readonly sandbox: (
    environment: SandboxEnvironment,
    tool: AgentTool,
    mounts: readonly SkillMount[],
  ) => SandboxProvider;
  /**
   * The Skills the task's Agent is given (FR-75), its Floor's repository
   * read from the clone at `clone`; none without it.
   */
  readonly skills?: (
    task: SandboxTask,
    clone: string,
  ) => Promise<readonly SkillToMount[]>;
  /**
   * How the Agent's sandbox reaches models: the AI Gateway's URL and the
   * Agent's own Gateway Key, never an AI Account's credential (ADR 0001).
   */
  readonly gateway: (agent: SandboxTask["agent"]) => Promise<GatewayAccess>;
  /**
   * Holds the run's work for its Agent at the AI Gateway until the
   * function it returns is called (pen-testing G1-1): meanwhile every call
   * the Agent's key makes counts against the issue and its pull request,
   * whatever it names. Without it, they count against no issue.
   */
  readonly holdWork?: (work: {
    readonly agentId: string;
    readonly issue: number;
    readonly pullRequest: number | undefined;
  }) => () => void;
  /**
   * Whether a value holds one of the Owner's AI Account credentials: a
   * sandbox whose environment does, under any key, is never started.
   * Values shaped like AI Providers' credentials are refused regardless.
   */
  readonly isAiAccountCredential?: AiAccountCredentialCheck;
  /**
   * Screens each of the Agent's tool calls, and the Floor's setup command
   * (named `Setup`), FR-17: why it is unsafe, which stops the run;
   * undefined to let it be. None by default.
   */
  readonly toolCallCheck?: (
    task: SandboxTask,
    call: { readonly name: string; readonly args: string },
  ) => Promise<string | undefined>;
  /**
   * Where each session's screen is opened for its sandbox to ask, through
   * the AI Gateway's screen route (P1-8): with them, and `toolCallCheck`,
   * Claude Code asks about each call before it runs. Without them, calls
   * are screened only as they stream.
   */
  readonly screens?: ToolCallScreens;
  /** Where clones are made, one directory per run. */
  readonly workDir: string;
  /** How long a run may take in all; an hour by default. */
  readonly timeoutMs?: number;
  /** How long the Agent may be silent; 10 minutes by default. */
  readonly idleTimeoutSeconds?: number;
  /** How long the setup command may take; 15 minutes by default. */
  readonly setupTimeoutMs?: number;
  /** Where to clone a repository from; its GitHub page plus `.git`. */
  readonly cloneUrl?: (repository: Repository) => string;
  readonly runSandcastle?: RunSandcastle;
  /**
   * Fresh Starts (FR-86, FR-87): each session is watched, and ended when
   * one is due. Without them, a run is one session.
   */
  readonly freshStarts?: FreshStarts;
}

/**
 * Docker sandboxes from the agent tool's image (`sandboxImages`, or
 * `images` in its place), with `environment` only and `mounts` read-only,
 * attached to `network` (the Docker network the AI Gateway is reachable
 * on) when one is given, and hardened as every container AI Office starts
 * for an Agent is (`sandboxHardening`, pen-testing S2-4).
 */
export const dockerSandbox =
  (
    options: {
      images?: Partial<Record<AgentTool, string>>;
      network?: string | undefined;
    } = {},
  ) =>
  (
    environment: SandboxEnvironment,
    tool: AgentTool,
    mounts: readonly SkillMount[] = [],
  ): SandboxProvider =>
    dockerProvider({
      imageName: options.images?.[tool] ?? sandboxImages[tool],
      env: { ...environment },
      ...(mounts.length === 0
        ? {}
        : {
            mounts: mounts.map(({ hostPath, sandboxPath }) => ({
              hostPath,
              sandboxPath,
              readonly: true,
            })),
          }),
      ...(options.network === undefined ? {} : { network: options.network }),
    });

const cut = (text: string): string =>
  text.length <= maxStreamText ? text : `${text.slice(0, maxStreamText - 1)}…`;

/** The most of the agent's last text a run keeps. */
const maxLastText = 20_000;

const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

/**
 * The usage on a Claude Code `result` line of its stream, if it is one.
 * Codex's usage comes through Sandcastle; opencode reports none.
 */
function resultUsage(line: string): SandboxUsage | undefined {
  if (!line.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      usage?: Record<string, unknown>;
    };
    if (parsed.type !== "result" || typeof parsed.usage !== "object") {
      return undefined;
    }
    const usage = parsed.usage;
    return {
      inputTokens: tokens(usage["input_tokens"]),
      outputTokens: tokens(usage["output_tokens"]),
      cacheReadTokens: tokens(usage["cache_read_input_tokens"]),
      cacheWriteTokens: tokens(usage["cache_creation_input_tokens"]),
    };
  } catch {
    return undefined;
  }
}

/** The usage Sandcastle read from the agent's session, if it did. */
const iterationUsage = (
  usage:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadInputTokens: number;
        readonly cacheCreationInputTokens: number;
      }
    | undefined,
): SandboxUsage | null =>
  usage === undefined
    ? null
    : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheWriteTokens: usage.cacheCreationInputTokens,
      };

/**
 * What a Claude Code stream line says and does, for a session's
 * transcript: its text, and its tool calls with their input. Sandcastle
 * holds text until a tool call it shows, so a session ended between them
 * would otherwise lose its last words. Other tools' lines say nothing.
 */
export function transcriptLines(line: string): string[] {
  if (!line.startsWith("{")) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const { type, message } = parsed as { type?: unknown; message?: unknown };
  const content = (message as { content?: unknown } | undefined)?.content;
  if (type !== "assistant" || !Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block: unknown): string[] => {
    const { type: kind, text, name, input } = block as Record<string, unknown>;
    if (kind === "text" && typeof text === "string") {
      return [text];
    }
    if (kind === "tool_use" && typeof name === "string") {
      return [`▸ ${name} ${JSON.stringify(input ?? {}).slice(0, 2000)}`];
    }
    return [];
  });
}

/** Two runs' usage added together; null when neither reported any. */
const addUsage = (
  a: SandboxUsage | null,
  b: SandboxUsage | null,
): SandboxUsage | null =>
  a === null || b === null
    ? (a ?? b)
    : {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      };

/** Where Sandcastle keeps `branch`'s worktree in the clone. */
export const worktreeOf = (workspace: string, branch: string): string =>
  join(workspace, ".sandcastle", "worktrees", branch.replaceAll("/", "-"));

/** The message of the commit that saves work in progress at a Fresh Start. */
export const freshStartCommitMessage =
  "chore: save work in progress for a Fresh Start";

/**
 * Commits whatever the Agent had not committed in `worktree`, so its next
 * session finds it. Only once its sandbox has stopped: Git here reads the
 * worktree's config first (`runGit`), which the Agent must not change
 * meanwhile. Best effort: if nothing can be saved the summary still says
 * what was in progress.
 */
async function saveUncommitted(
  worktree: string,
  identity: GitIdentity,
): Promise<void> {
  try {
    const changed = await runGit(
      "read the worktree's changes",
      ["status", "--porcelain"],
      { cwd: worktree },
    );
    if (changed === "") {
      return;
    }
    await runGit("stage the work in progress", ["add", "--all"], {
      cwd: worktree,
    });
    await runGit(
      "commit the work in progress",
      ["commit", "--quiet", "--no-verify", "-m", freshStartCommitMessage],
      {
        cwd: worktree,
        env: {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        },
      },
    );
  } catch {
    // Nothing saved: the next session starts from the commits it made.
  }
}

/** The lines of a Git command's output; none when it fails. */
const gitLines = async (
  step: string,
  args: readonly string[],
  cwd: string,
): Promise<string[]> => {
  const output = await runGit(step, args, { cwd }).catch(() => "");
  return output === "" ? [] : output.split("\n");
};

export function createSandboxRunner(
  options: SandboxRunnerOptions,
): SandboxRunner {
  const { github, events, freshStarts } = options;
  const runSandcastle = options.runSandcastle ?? sandcastleRun;
  // Sandcastle's own Git on the host runs nothing the Agent's repository
  // names (S1-2).
  guardSandcastleGit();
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;

  return {
    async run(task) {
      const firstSandboxId = `sbx-${randomUUID()}`;
      // Each session's sandbox: a Fresh Start starts another.
      let sandboxId = firstSandboxId;
      const branch =
        task.branch ?? issueBranch(task.issue.number, task.issue.title);
      const workspace = join(options.workDir, firstSandboxId);
      // The Agent's Skills, beside the clone rather than in it.
      const skillsDir = join(options.workDir, `${firstSandboxId}-skills`);
      // Its office-wide and Role memory, beside it too.
      const memoryDir = join(options.workDir, `${firstSandboxId}-memory`);
      const subject = () => ({
        floorId: task.floor.id,
        agentId: task.agent.id,
        issue: task.issue.number,
        sandboxId,
      });
      // A run stopped mid-command may still be writing to its clone for a
      // moment: deleting it is tried again.
      const removed = { recursive: true, force: true, maxRetries: 5 };
      const discard = async () => {
        await rm(workspace, removed);
        await rm(skillsDir, removed);
        await rm(memoryDir, removed);
      };

      // Published one after another, in the order Sandcastle streamed them.
      let streamed: Promise<unknown> = Promise.resolve();
      const stream = (
        event:
          | { type: "sandbox.text"; text: string }
          | { type: "sandbox.tool_call"; name: string; args: string }
          | ({ type: "sandbox.diff" } & FileDiff),
      ): void => {
        const about = subject();
        streamed = streamed
          .then(() => events.publish({ ...event, version: 1, ...about }))
          .catch(() => undefined);
      };
      // Tool calls being screened, and why the first unsafe one was, which
      // stops the run.
      const screening: Promise<void>[] = [];
      let unsafe: string | undefined;
      const stop = new AbortController();
      // Each call's verdict, asked once whether the agent tool asks before
      // it runs or the call is seen as it streams, or both; the latest few.
      const verdicts = new Map<string, Promise<string | undefined>>();
      const judge = (call: {
        readonly name: string;
        readonly args: string;
      }): Promise<string | undefined> => {
        const check = options.toolCallCheck;
        if (check === undefined) {
          return Promise.resolve(undefined);
        }
        const key = `${call.name}\u0000${call.args}`;
        const asked = verdicts.get(key);
        if (asked !== undefined) {
          return asked;
        }
        const verdict = check(task, call).then((reason) => {
          if (reason !== undefined && unsafe === undefined) {
            unsafe = reason;
            stop.abort();
          }
          return reason;
        });
        verdicts.set(key, verdict);
        for (const old of verdicts.keys()) {
          if (verdicts.size <= 200) {
            break;
          }
          verdicts.delete(old);
        }
        return verdict;
      };
      const screen = (name: string, args: string): void => {
        screening.push(
          judge({ name, args }).then(
            () => undefined,
            () => undefined,
          ),
        );
      };
      let usage: SandboxUsage | null = null;
      let lastText: string | null = null;
      // The session as AI Office saw it, for a Fresh Start's summary: from
      // Claude Code's own lines when it streams them, else from what
      // Sandcastle shows of other agent tools.
      let transcript = "";
      let fromLines = false;
      const record = (line: string): void => {
        transcript = `${transcript}${line}\n`.slice(-maxTranscript);
      };
      const onAgentStreamEvent = (event: AgentStreamEvent): void => {
        if (event.type === "text") {
          lastText = event.message.slice(0, maxLastText);
          if (!fromLines) {
            record(event.message);
          }
          stream({ type: "sandbox.text", text: cut(event.message) });
        } else if (event.type === "toolCall") {
          if (!fromLines) {
            record(`▸ ${event.name} ${event.formattedArgs}`);
          }
          stream({
            type: "sandbox.tool_call",
            name: event.name,
            args: cut(event.formattedArgs),
          });
          screen(event.name, event.formattedArgs);
        } else {
          usage = resultUsage(event.line) ?? usage;
          const said = transcriptLines(event.line);
          if (said.length > 0) {
            fromLines = true;
            said.forEach(record);
          }
          for (const diff of fileDiffs(event.line)) {
            stream({
              type: "sandbox.diff",
              ...diff,
              path: diff.path.slice(0, 1000),
              diff: cut(diff.diff),
            });
          }
        }
      };

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([
        ...(task.signal === undefined ? [] : [task.signal]),
        timeout,
        stop.signal,
      ]);

      // Whether the current session's sandbox has started and not stopped.
      const current = { open: false };
      const started = async () => {
        await events.publish({
          type: "sandbox.started",
          version: 1,
          ...subject(),
          branch,
        });
        current.open = true;
      };
      const stopped = async (
        outcome: "finished" | "fresh_start" | SandboxOutcome,
        exitCode: number | null,
      ) => {
        current.open = false;
        await events.publish({
          type: "sandbox.stopped",
          version: 1,
          ...subject(),
          outcome,
          exitCode,
        });
      };

      const repositoryClient = github.repository(task.floor.repository);
      // Each sandbox's read-only token is its own, minted for it and
      // revoked as it stops (W1-3): one a sandbox sends out reads nothing
      // once that sandbox has gone.
      let readOnly: InstallationToken | undefined;
      const revokeReadOnly = async (): Promise<void> => {
        const token = readOnly?.token;
        readOnly = undefined;
        if (token !== undefined) {
          // It expires within the hour if GitHub cannot be told now.
          await repositoryClient.revokeToken(token).catch(() => undefined);
        }
      };

      // Ends the run's work at the Gateway, once it is held.
      let release: (() => void) | undefined;
      await started();
      try {
        signal.throwIfAborted();
        const [repository, minted, gateway, existing, [pullRequest]] =
          await Promise.all([
            repositoryClient.get(),
            repositoryClient.readOnlyToken(),
            options.gateway(task.agent),
            repositoryClient.getBranch(branch),
            repositoryClient.listPullRequests({ head: branch }),
          ]);
        readOnly = minted;
        release = options.holdWork?.({
          agentId: task.agent.id,
          issue: task.issue.number,
          pullRequest: pullRequest?.number,
        });
        // Each session is one Agent session (FR-37): its model calls name
        // its sandbox, which Context Usage is measured by (FR-84). With the
        // screens open to it, it asks about each call before it runs.
        const screens =
          options.toolCallCheck === undefined ? undefined : options.screens;
        const toolFor = (session: string) =>
          agentToolSetup(
            task.agent,
            gateway,
            {
              issue: task.issue.number,
              pullRequest: pullRequest?.number,
              session,
            },
            { beforeCalls: screens !== undefined },
          );
        // Refused before anything is cloned, if it is not a Gateway Key
        // or no agent tool runs the AI Provider.
        toolFor(sandboxId);
        await makeWorkDir(options.workDir);
        await cloneRepository({
          url: options.cloneUrl?.(repository) ?? `${repository.htmlUrl}.git`,
          token: minted.token,
          branch: task.floor.defaultBranch,
          // Work already pushed for the issue carries on.
          ...(existing === undefined ? {} : { alsoFetch: branch }),
          into: workspace,
          signal,
        });
        const upstream = [
          await runGit("read the default branch", ["rev-parse", "HEAD"], {
            cwd: workspace,
          }),
          ...(existing === undefined
            ? []
            : [
                await runGit(
                  `read ${branch}`,
                  ["rev-parse", `refs/heads/${branch}`],
                  { cwd: workspace },
                ),
              ]),
        ];
        // Sandcastle reads `.sandcastle/.env` from the clone; a repository
        // must not choose what the sandbox gets.
        await rm(join(workspace, ".sandcastle", ".env"), { force: true });
        /** The Agent's commits on the branch so far, oldest first. */
        const branchCommits = () =>
          gitLines(
            `list ${branch}'s commits`,
            [
              "rev-list",
              "--reverse",
              `refs/heads/${branch}`,
              "--not",
              ...upstream,
            ],
            workspace,
          );

        const skills = (await options.skills?.(task, workspace)) ?? [];
        let mounts: SkillMount[] = [];
        if (skills.length > 0) {
          await writeSkills(skillsDir, skills);
          mounts = skillMounts(skillsDir, toolFor(sandboxId).tool);
        }
        if (task.memory !== undefined && task.memory.length > 0) {
          await writeMemory(memoryDir, task.memory);
          mounts = [...mounts, memoryMount(memoryDir)];
        }
        const setup = task.floor.setupCommand.trim();
        // The setup command runs in every session's sandbox, before the
        // Agent: it is screened once, before any of them (P1-8).
        if (setup !== "") {
          const reason = await judge({ name: "Setup", args: setup });
          if (reason !== undefined) {
            throw new Error(reason);
          }
        }
        let prompt = task.prompt;
        // How many Fresh Starts it has made, and the sessions' usage before.
        let made = 0;
        let earlierUsage: SandboxUsage | null = null;
        for (;;) {
          const agentTool = toolFor(sandboxId);
          // After a Fresh Start, a new sandbox: a new token.
          readOnly ??= await repositoryClient.readOnlyToken();
          const environment = sandboxEnvironment({
            identity: task.gitIdentity,
            githubToken: readOnly.token,
            model: agentTool.environment,
          });
          if (options.isAiAccountCredential !== undefined) {
            await refuseAiAccountCredentials(
              environment,
              options.isAiAccountCredential,
            );
          }
          const session = {
            floorId: task.floor.id,
            agentId: task.agent.id,
            issue: task.issue.number,
            session: sandboxId,
          };
          const watch: FreshStartWatch | undefined =
            await freshStarts?.watch(session);
          // A Fresh Start ends the session: its sandbox is stopped, then
          // what it had not committed is saved (below), so the Agent can
          // write nothing in the worktree while the app runs Git there.
          const ending = new AbortController();
          void watch?.due.then(() => {
            ending.abort();
          });
          let result: Awaited<ReturnType<RunSandcastle>> | undefined;
          const close = screens?.open(sandboxId, task.agent.id, judge);
          try {
            result = await runSandcastle({
              agent: agentTool.provider,
              sandbox: allowListed(
                options.sandbox(environment, agentTool.tool, mounts),
              ),
              cwd: workspace,
              // Inline, so Sandcastle never runs shell blocks in it.
              prompt,
              name: `${task.floor.id}#${String(task.issue.number)}`,
              branchStrategy: {
                type: "branch",
                branch,
                baseBranch: task.floor.defaultBranch,
              },
              ...(setup === ""
                ? {}
                : {
                    hooks: {
                      sandbox: {
                        onSandboxReady: [
                          {
                            command: setup,
                            timeoutMs: options.setupTimeoutMs ?? 15 * 60 * 1000,
                          },
                        ],
                      },
                    },
                  }),
              logging: {
                type: "file",
                path: join(
                  workspace,
                  ".sandcastle",
                  "logs",
                  `${sandboxId}.log`,
                ),
                onAgentStreamEvent,
              },
              idleTimeoutSeconds: options.idleTimeoutSeconds ?? 600,
              signal: AbortSignal.any([signal, ending.signal]),
            });
          } catch (error) {
            // Stopped for a Fresh Start, not by a failure: carry on below.
            if (!ending.signal.aborted || signal.aborted) {
              throw error;
            }
          } finally {
            close?.();
            watch?.close();
            // Its sandbox has stopped: so does its token.
            await revokeReadOnly();
          }
          await streamed;
          // A call still being screened may yet be judged unsafe.
          await Promise.all(screening);
          if (unsafe !== undefined) {
            throw new Error(unsafe);
          }
          const reason: FreshStartReason | undefined = watch?.reason;

          if (result !== undefined) {
            usage ??= iterationUsage(result.iterations.at(-1)?.usage);
            await stopped("finished", 0);
            release?.();
            return {
              sandboxId,
              branch: result.branch,
              // With a Fresh Start, the branch holds every session's.
              commits:
                made === 0 && reason === undefined
                  ? result.commits.map(({ sha }) => sha)
                  : await branchCommits(),
              upstream,
              usage: addUsage(earlierUsage, usage),
              lastText,
              freshStarts: made,
              escalated: false,
              workspace,
              discard,
            };
          }

          // Ended for a Fresh Start (FR-86, FR-87).
          await saveUncommitted(
            worktreeOf(workspace, branch),
            task.gitIdentity,
          );
          const why = reason ?? { trigger: "manual", contextUsage: 0 };
          await stopped("fresh_start", null);
          if (freshStarts === undefined) {
            throw new Error("A session ended without Fresh Starts.");
          }
          if (made >= freshStarts.cap) {
            // One past the cap: the Owner decides.
            await freshStarts.escalate({ ...session, ...why });
            return {
              sandboxId,
              branch,
              commits: await branchCommits(),
              upstream,
              usage: addUsage(earlierUsage, usage),
              lastText,
              freshStarts: made,
              escalated: true,
              workspace,
              discard,
            };
          }
          const summary = await freshStarts.summarise({
            ...session,
            agent: { id: task.agent.id, model: task.agent.model },
            issueTitle: task.issue.title,
            transcript,
            files: await gitLines(
              `list the files ${branch} changed`,
              [
                "diff",
                "--name-only",
                upstream[0] ?? "HEAD",
                `refs/heads/${branch}`,
              ],
              workspace,
            ),
            commits: await gitLines(
              `list ${branch}'s commit subjects`,
              [
                "log",
                "--reverse",
                "--format=%s",
                `refs/heads/${branch}`,
                "--not",
                ...upstream,
              ],
              workspace,
            ),
            signal,
          });
          made += 1;
          await events.publish({
            type: "agent.fresh_start",
            version: 1,
            floorId: task.floor.id,
            agentId: task.agent.id,
            issue: task.issue.number,
            trigger: why.trigger,
            contextUsage: why.contextUsage,
          });
          prompt = freshStartPrompt(task.prompt, summary, {
            number: made,
            cap: freshStarts.cap,
          });
          // A new session, in a new sandbox, on the same branch.
          sandboxId = `sbx-${randomUUID()}`;
          earlierUsage = addUsage(earlierUsage, usage);
          usage = null;
          transcript = "";
          fromLines = false;
          lastText = null;
          await started();
        }
      } catch (error) {
        await revokeReadOnly();
        release?.();
        await streamed;
        await Promise.all(screening);
        const outcome: SandboxOutcome =
          task.signal?.aborted === true
            ? "cancelled"
            : timeout.aborted
              ? "timed_out"
              : "failed";
        if (current.open) {
          await stopped(outcome, null);
        }
        await discard();
        throw new SandboxRunError(
          outcome,
          sandboxId,
          outcome === "cancelled"
            ? `The sandbox for issue #${String(task.issue.number)} was cancelled.`
            : outcome === "timed_out"
              ? `The sandbox for issue #${String(task.issue.number)} ran out of time.`
              : unsafe !== undefined
                ? `The sandbox for issue #${String(task.issue.number)} was stopped: ${unsafe}`
                : `The sandbox for issue #${String(task.issue.number)} failed: ${(error as Error).message}`,
          { cause: error },
        );
      }
    },
  };
}
