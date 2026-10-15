import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  run as sandcastleRun,
  type AgentStreamEvent,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import type { EventBus } from "@ai-office/events";
import type {
  GitHubApp,
  InstallationToken,
  Repository,
} from "@ai-office/github";
import {
  maxGrillingFactLength,
  type AgentTool,
  type GrillingFactStatus,
} from "@ai-office/shared";

import { runGit } from "../git/command.ts";
import { agentToolSetup, type ToolAgent } from "../sandbox/agent-tools.ts";
import { cloneRepository } from "../sandbox/clone.ts";
import {
  allowListed,
  refuseAiAccountCredentials,
  sandboxEnvironment,
  type AiAccountCredentialCheck,
  type GatewayAccess,
  type SandboxEnvironment,
} from "../sandbox/environment.ts";
import { worktreeOf, type RunSandcastle } from "../sandbox/runner.ts";
import { guardSandcastleGit } from "../sandbox/sandcastle-git.ts";
import type { ToolCallScreens } from "../sandbox/tool-call-screens.ts";
import { makeWorkDir } from "../sandbox/work-dir.ts";

// Fact-finding in a Grilling Session (PRD FR-79): the Manager finds facts
// itself rather than asking the Owner. One fact is one read-only sandbox:
// the Floor's repository is cloned at its default branch with the GitHub
// App's read-only token, and the agent tool of the Agent sent (the Manager,
// or one of the Floor's Agents it delegates to) reads its code and docs,
// and its issues with `gh`, through the AI Gateway with that Agent's own
// Gateway Key (ADR 0001). The sandbox is read-only in every way that
// matters to the Floor:
// - its GitHub token can read but not write, so it can change nothing on
//   GitHub;
// - it is given no Git identity, and nothing from it is ever pushed;
// - an answer from a sandbox that changed the repository anyway is not
//   kept, as it may describe its own changes; and
// - its clone is deleted when it stops, whatever it did.
// Its answer is what it writes between `<fact>` and `</fact>`. Its tool
// calls are screened as an Agent's are in its task's sandbox (FR-17,
// P1-8): before each runs when its agent tool asks (Claude Code), and as
// each streams; one judged unsafe stops the sandbox, and no answer is kept.
//
// It works on a branch of its own in the clone, never kept, rather than
// in the clone itself: there Sandcastle would merge what it committed back
// with Git on the host while its sandbox still runs, and so could still
// write the repository's config (S1-2). On a branch, Sandcastle's Git runs
// in it only to read it until the sandbox has stopped.

/** One fact to find, by one Agent. */
export interface FactRequest {
  readonly floor: {
    readonly id: string;
    /** `owner/name` on GitHub. */
    readonly repository: string;
    readonly defaultBranch: string;
  };
  /** The Agent sent to find it: its agent tool, Model and Gateway Key are used. */
  readonly agent: ToolAgent & { readonly id: string; readonly name: string };
  /**
   * The Grilling Session it is found for; null for research a chat request
   * sent (ADR 0004), whose Contractor reports it to the Manager.
   */
  readonly sessionId: number | null;
  /** What the session (or the chat request) is about; empty for nothing. */
  readonly topic: string;
  readonly question: string;
  readonly signal?: AbortSignal;
}

/** What was found: the answer, or why there is none. */
export interface FactResult {
  readonly status: GrillingFactStatus;
  /** The answer, word for word; or, when `failed`, why there is none. */
  readonly answer: string;
}

/** Finds the facts a Grilling Session's Manager asks for (FR-79). */
export interface FactFinder {
  /** Never rejects: a fact that cannot be found is `failed`, saying why. */
  find(request: FactRequest): Promise<FactResult>;
}

export interface SandboxFactFinderOptions {
  readonly github: GitHubApp;
  readonly events: EventBus;
  /**
   * The Sandcastle sandbox provider to start with `environment`, for
   * `tool`: Docker with the agent tool's image in production. Whatever
   * else it or Sandcastle adds to the environment is dropped.
   */
  readonly sandbox: (
    environment: SandboxEnvironment,
    tool: AgentTool,
  ) => SandboxProvider;
  /** The AI Gateway's URL and the Agent's own Gateway Key (ADR 0001). */
  readonly gateway: (agent: FactRequest["agent"]) => Promise<GatewayAccess>;
  /** Whether a value holds one of the Owner's AI Account credentials. */
  readonly isAiAccountCredential?: AiAccountCredentialCheck;
  /** Where clones are made, one directory per fact. */
  readonly workDir: string;
  /** How long finding one fact may take; 10 minutes by default. */
  readonly timeoutMs?: number;
  /** How long the Agent may be silent; 5 minutes by default. */
  readonly idleTimeoutSeconds?: number;
  /** Where to clone a repository from; its GitHub page plus `.git`. */
  readonly cloneUrl?: (repository: Repository) => string;
  readonly runSandcastle?: RunSandcastle;
  /**
   * Screens each of the Agent's tool calls (FR-17): why it is unsafe,
   * which stops the sandbox; undefined to let it be. None by default.
   */
  readonly toolCallCheck?: (call: {
    readonly name: string;
    readonly args: string;
  }) => Promise<string | undefined>;
  /**
   * Where each sandbox's screen is opened for it to ask, through the AI
   * Gateway's screen route (P1-8): with them, and `toolCallCheck`, Claude
   * Code asks about each call before it runs.
   */
  readonly screens?: ToolCallScreens;
}

/** The tag the Agent writes its answer in. */
export const factTag = "fact";

/** What the Agent sent to find a fact is asked to do. */
export function factFindingPrompt(request: FactRequest): string {
  return [
    request.sessionId === null
      ? `You are ${request.agent.name}, researching for your Floor's Manager, which is answering a request the Owner made in its chat${request.topic === "" ? "" : `: ${request.topic}`}. You change nothing and file nothing: you find the answer, and the Manager uses it.`
      : `You are ${request.agent.name}, finding a fact for your Floor's Manager. The Manager is running a Grilling Session with the Owner${request.topic === "" ? "" : ` on: ${request.topic}`}. It asks the Owner only for decisions, so it finds facts itself, and this one is yours to find.`,
    "",
    "## The question",
    "",
    request.question,
    "",
    "## How",
    "",
    `The Floor's repository, ${request.floor.repository}, is checked out here at its default branch, ${request.floor.defaultBranch}. Find the answer by reading its code and docs, and its GitHub issues and pull requests with \`gh\` (its token can read, not write).`,
    "",
    "- Only read. Change no file, make no commit and run nothing that writes: this sandbox is read-only. An answer from a sandbox whose repository changed is not kept, and the changes are thrown away.",
    "- Answer from what the repository says, naming the files, issues or pull requests you read. If it does not say, answer that it does not, and what it says nearby.",
    "- Never put a credential, a token or a secret in your answer.",
    "",
    `When you have the answer, write it once, in a few sentences, between <${factTag}> and </${factTag}>.`,
  ].join("\n");
}

const factPattern = new RegExp(`<${factTag}>([\\s\\S]*?)</${factTag}>`, "g");

/** The last answer written between the tags in `text`, if any. */
export function readFact(text: string): string | undefined {
  const found = [...text.matchAll(factPattern)].at(-1)?.[1]?.trim();
  if (found === undefined || found === "") {
    return undefined;
  }
  return found.length <= maxGrillingFactLength
    ? found
    : `${found.slice(0, maxGrillingFactLength - 1)}…`;
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

/** Facts found in read-only sandboxes, with Sandcastle (FR-79). */
export function createSandboxFactFinder(
  options: SandboxFactFinderOptions,
): FactFinder {
  const { github, events } = options;
  const runSandcastle = options.runSandcastle ?? sandcastleRun;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  // Sandcastle's own Git on the host runs nothing the Agent's repository
  // names (S1-2).
  guardSandcastleGit();

  return {
    async find(request) {
      const sandboxId = `sbx-${randomUUID()}`;
      const workspace = join(options.workDir, sandboxId);
      // Its own branch, deleted with the clone.
      const branch = `ai-office/fact-${sandboxId}`;
      // Beside the clone, so the clone holds only what the Agent did.
      const log = join(options.workDir, `${sandboxId}.log`);
      const { sessionId } = request;
      // A Grilling Session's fact-finding is shown as it happens (FR-83);
      // a chat request's research by its Contractor's arrival and leaving.
      const publish = async (
        event:
          | { readonly type: "grilling.fact_finding_started" }
          | {
              readonly type: "grilling.fact_finding_stopped";
              readonly outcome:
                "found" | "unanswered" | "failed" | "cancelled" | "timed_out";
            },
      ): Promise<void> => {
        if (sessionId === null) {
          return;
        }
        await events.publish({
          ...event,
          version: 1,
          floorId: request.floor.id,
          agentId: request.agent.id,
          sessionId,
          sandboxId,
        });
      };
      // Each tool call's verdict, asked once whether its agent tool asks
      // before it runs or it is seen as it streams; and why the first
      // unsafe one was, which stops the sandbox.
      const check = options.toolCallCheck;
      const screens = check === undefined ? undefined : options.screens;
      const verdicts = new Map<string, Promise<string | undefined>>();
      const screening: Promise<unknown>[] = [];
      let unsafe: string | undefined;
      const stop = new AbortController();
      const judge = (call: {
        readonly name: string;
        readonly args: string;
      }): Promise<string | undefined> => {
        if (check === undefined) {
          return Promise.resolve(undefined);
        }
        const key = `${call.name}\u0000${call.args}`;
        const verdict =
          verdicts.get(key) ??
          check(call).then((reason) => {
            if (reason !== undefined && unsafe === undefined) {
              unsafe = reason;
              stop.abort();
            }
            return reason;
          });
        verdicts.set(key, verdict);
        return verdict;
      };
      let said = "";
      const onAgentStreamEvent = (event: AgentStreamEvent): void => {
        if (event.type === "text") {
          said = `${said}${event.message}\n`;
        } else if (event.type === "toolCall") {
          screening.push(
            judge({ name: event.name, args: event.formattedArgs }).catch(
              () => undefined,
            ),
          );
        }
      };
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([
        ...(request.signal === undefined ? [] : [request.signal]),
        timeout,
        stop.signal,
      ]);

      await publish({ type: "grilling.fact_finding_started" });
      let outcome:
        "found" | "unanswered" | "failed" | "cancelled" | "timed_out";
      let result: FactResult;
      const repositoryClient = github.repository(request.floor.repository);
      // The run's own read-only token, revoked once its sandbox has
      // stopped, whatever the outcome (W1-3).
      let readOnly: InstallationToken | undefined;
      try {
        signal.throwIfAborted();
        const [repository, minted, gateway] = await Promise.all([
          repositoryClient.get(),
          repositoryClient.readOnlyToken(),
          options.gateway(request.agent),
        ]);
        readOnly = minted;
        // Its model calls name its sandbox as their session (FR-37, FR-84),
        // and no issue: it works none.
        const tool = agentToolSetup(
          request.agent,
          gateway,
          { session: sandboxId },
          { beforeCalls: screens !== undefined },
        );
        const environment = sandboxEnvironment({
          githubToken: minted.token,
          model: tool.environment,
        });
        if (options.isAiAccountCredential !== undefined) {
          await refuseAiAccountCredentials(
            environment,
            options.isAiAccountCredential,
          );
        }
        await makeWorkDir(options.workDir);
        await cloneRepository({
          url: options.cloneUrl?.(repository) ?? `${repository.htmlUrl}.git`,
          token: minted.token,
          branch: request.floor.defaultBranch,
          into: workspace,
          signal,
        });
        // Sandcastle reads `.sandcastle/.env` from the clone; a repository
        // must not choose what the sandbox gets.
        await rm(join(workspace, ".sandcastle", ".env"), { force: true });
        const head = await runGit(
          "read the default branch",
          ["rev-parse", "HEAD"],
          {
            cwd: workspace,
          },
        );
        const close = screens?.open(sandboxId, request.agent.id, judge);
        await runSandcastle({
          agent: tool.provider,
          sandbox: allowListed(options.sandbox(environment, tool.tool)),
          cwd: workspace,
          // Inline, so Sandcastle never runs shell blocks in it.
          prompt: factFindingPrompt(request),
          name:
            sessionId === null
              ? `${request.floor.id} research`
              : `${request.floor.id} grilling ${String(sessionId)}`,
          branchStrategy: {
            type: "branch",
            branch,
            baseBranch: request.floor.defaultBranch,
          },
          logging: { type: "file", path: log, onAgentStreamEvent },
          idleTimeoutSeconds: options.idleTimeoutSeconds ?? 300,
          signal,
        }).finally(() => close?.());
        await repositoryClient.revokeToken(minted.token).catch(() => undefined);
        readOnly = undefined;
        // A call still being screened may yet be judged unsafe.
        await Promise.all(screening);
        if (unsafe !== undefined) {
          throw new Error(unsafe);
        }
        // Sandcastle keeps the worktree only when something in it is
        // left uncommitted.
        const worktree = worktreeOf(workspace, branch);
        const [after, changed] = await Promise.all([
          runGit(
            "read the branch's head",
            ["rev-parse", `refs/heads/${branch}`],
            {
              cwd: workspace,
            },
          ),
          existsSync(worktree)
            ? runGit("read the worktree's changes", ["status", "--porcelain"], {
                cwd: worktree,
              })
            : Promise.resolve(""),
        ]);
        const answer = readFact(said);
        if (after !== head || changed !== "") {
          outcome = "failed";
          result = {
            status: "failed",
            answer: `${request.agent.name} changed the repository, though asked only to read, so the answer was not kept. The changes were thrown away.`,
          };
        } else if (answer === undefined) {
          outcome = "unanswered";
          result = {
            status: "failed",
            answer: `${request.agent.name} finished without an answer.`,
          };
        } else {
          outcome = "found";
          result = { status: "found", answer };
        }
      } catch (error) {
        if (readOnly !== undefined) {
          await repositoryClient
            .revokeToken(readOnly.token)
            .catch(() => undefined);
        }
        await Promise.all(screening);
        outcome =
          request.signal?.aborted === true
            ? "cancelled"
            : timeout.aborted
              ? "timed_out"
              : "failed";
        result = {
          status: "failed",
          answer:
            outcome === "cancelled"
              ? "Finding it was cancelled."
              : outcome === "timed_out"
                ? `${request.agent.name} ran out of time to find it.`
                : unsafe !== undefined
                  ? `${request.agent.name}'s sandbox was stopped: ${unsafe}`
                  : `${request.agent.name}'s sandbox failed: ${reasonOf(error)}`,
        };
      }
      // Whatever it did, nothing of it is kept.
      const removed = { recursive: true, force: true, maxRetries: 5 };
      await rm(workspace, removed);
      await rm(log, { force: true });
      await publish({ type: "grilling.fact_finding_stopped", outcome });
      return result;
    },
  };
}
