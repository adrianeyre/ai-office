import { AsyncLocalStorage } from "node:async_hooks";

import {
  subjectOf,
  type EventBus,
  type OfficeEvent,
  type StoredEvent,
} from "@ai-office/events";
import type { GitHubApp, RepositoryClient } from "@ai-office/github";
import {
  createRedactor,
  floorHooksPath,
  hookFailuresToTurnOff,
  hookStages,
  hookTriggerLabels,
  maxHookResultLength,
  type HookSkipReason,
  type HookStage,
  type Redactor,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { matchesPattern } from "../guidelines/choose.ts";
import { ModelCallError, type ModelClient } from "../models/client.ts";
import type { Notices } from "../notices/notices.ts";
import { memoryRoleStore, type RoleStore } from "../roles/store.ts";
import { builtInOverridesAll } from "../skills/built-in.ts";
import type { FloorSkills } from "../skills/floor.ts";
import {
  hookAnswerTokens,
  hookPrompt,
  maxHookEventFiles,
  skillInstructions,
  type HookAnswerTarget,
  type HookEventDetails,
  type HookEventIssue,
} from "./prompt.ts";
import type { HookRecord, HookRunRecord, HookStore } from "./store.ts";

// Hooks at work (Guidelines, Specs and Hooks PRD, FR-118 to FR-120; ADR
// 0016). The runner listens to the event bus for the events Hooks watch:
// an issue moving to a Stage (`issue.label_changed`), a pull request
// opened, a push to the default branch (found by comparing its head with
// the one last seen, on GitHub's push webhook, on every merge and every
// minute), a Batch's Wrap-up (`batch.finished`) and a Spec's issues filed
// (`batch.planned` naming its session); and Run now, which the Owner
// presses. Each Hook on the Floor that is on, watches that trigger and
// whose label and file-pattern filters let the event through is run.
//
// A run is one model call, made as the Agent the Hook names (or the least
// busy Agent of its Role) through the AI Gateway, so it counts against
// that Agent's Token Caps: the Skill's instructions, and the event's
// details as untrusted data. The answer, redacted, is posted by the GitHub
// App as a comment on the issue or pull request, and kept with the run.
// Nothing is run and nothing in the answer is acted on.
//
// Limits (FR-120): at most the Hook's runs an hour (12 by default); never
// two runs of one Hook at once on the same issue or pull request (nor two
// Run nows), the second skipped; a pull request opened runs a Hook once,
// however many issues join it. A failed run raises an info Notice, and
// three in a row turn the Hook off with an action Notice.
//
// A Hook never fires on an event its own run caused (FR-119): each run
// goes on in an async context that names the Hooks whose runs led to it,
// which every event published within it carries through the bus to the
// runner's listener.

const causes = new AsyncLocalStorage<readonly number[]>();

/** The Hooks whose runs led to what is going on now, if any. */
export const hookCauses = (): readonly number[] => causes.getStore() ?? [];

/** The Notice action that sends the Owner to a Floor's Hooks card. */
export const openHooksAction = "open_hooks";

/** How often the default branch of a Floor with a push Hook is looked at. */
export const hookPushPollMs = 60_000;

/** An event as a Hook watches it, before its details are read. */
export type HookOccurrence =
  | {
      readonly trigger: "stage";
      readonly stage: HookStage;
      readonly issue: number;
    }
  | {
      readonly trigger: "pull_request_opened";
      readonly issue: number;
      readonly pullRequest: number;
      readonly url: string;
      readonly branch: string;
    }
  | {
      readonly trigger: "push";
      readonly branch: string;
      readonly before: string;
      readonly after: string;
      readonly files: readonly string[];
    }
  | {
      readonly trigger: "wrap_up";
      readonly batch: NonNullable<HookEventDetails["batch"]>;
    }
  | {
      readonly trigger: "spec_filed";
      readonly batch: NonNullable<HookEventDetails["batch"]>;
    }
  | { readonly trigger: "run_now" };

/** Why Run now did not start a run. */
export type RunNowRefusal = HookSkipReason;

export interface HookRunner {
  /**
   * Listens for the events Hooks watch, and looks at the default branch
   * of each Floor with a push Hook every minute. Ends any run a previous
   * start left going as failed. Returns a function that stops it.
   */
  start(): Promise<() => void>;
  /**
   * Runs a Run now Hook that is on (the caller checks both): the run
   * started, or why not.
   */
  runNow(
    floor: FloorRecord,
    hook: HookRecord,
  ): Promise<HookRunRecord | RunNowRefusal>;
  /** Resolves once every run going has ended: for tests. */
  idle(): Promise<void>;
}

export interface HookRunnerOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly agents: Pick<AgentStore, "list">;
  /** The Role library, for each Role's name; the built-in Roles when absent. */
  readonly roles?: Pick<RoleStore, "get">;
  readonly store: HookStore;
  readonly events: EventBus;
  /** Reads issues, pull requests and pushes, and posts answers; without it, a Hook that needs GitHub does not run. */
  readonly github?: GitHubApp;
  readonly skills: Pick<FloorSkills, "get">;
  /** Makes each run's model call, through the AI Gateway, as its Agent. */
  readonly models: ModelClient;
  readonly notices: Notices;
  /** Each AI Provider's default Model, for Agents without their own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /** Knows the Owner's own secrets, which no answer or Notice holds. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** How often push Hooks look at the default branch; 0 for never. */
  readonly pushPollMs?: number;
  /** Told of anything that went wrong outside a run. */
  readonly onError?: (error: unknown) => void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A run that could not go on, saying why in the Owner's words. */
class HookRunFailure extends Error {}

/** How a run ended: its answer, or why it failed. */
type RunOutcome =
  | {
      readonly ok: true;
      readonly result: string;
      readonly commentUrl: string | null;
    }
  | { readonly ok: false; readonly error: string };

/** `text` cut to `most` characters, saying so. */
const cut = (text: string, most: number): string =>
  text.length <= most ? text : `${text.slice(0, most - 1)}…`;

/** The most characters of a comment GitHub takes, with room to spare. */
const maxCommentLength = 60_000;

/** The pieces of `value` read once, the first time they are asked for. */
const once = <Value>(read: () => Promise<Value>): (() => Promise<Value>) => {
  let value: Promise<Value> | undefined;
  return () => (value ??= read());
};

const isHookStage = (label: string | null): label is HookStage =>
  hookStages.some((stage) => stage === label);

/** What a run is on, for "never two at once": its pull request, its issue, or Run now. */
const subjectKey = (
  hook: HookRecord,
  occurrence: HookOccurrence,
): string | undefined => {
  switch (occurrence.trigger) {
    case "pull_request_opened":
      return `${String(hook.id)}:pull_request:${String(occurrence.pullRequest)}`;
    case "stage":
      return `${String(hook.id)}:issue:${String(occurrence.issue)}`;
    case "run_now":
      return `${String(hook.id)}:run_now`;
    default:
      return undefined;
  }
};

const issueOf = (occurrence: HookOccurrence): number | undefined =>
  occurrence.trigger === "stage" || occurrence.trigger === "pull_request_opened"
    ? occurrence.issue
    : undefined;

const pullRequestOf = (occurrence: HookOccurrence): number | undefined =>
  occurrence.trigger === "pull_request_opened"
    ? occurrence.pullRequest
    : undefined;

export function createHookRunner(options: HookRunnerOptions): HookRunner {
  const { store, events, notices, github } = options;
  const now = options.now ?? (() => new Date());
  const redactor = options.redactor ?? createRedactor();
  const roles = options.roles ?? memoryRoleStore();
  const pushPollMs = options.pushPollMs ?? hookPushPollMs;
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  /** Each Hook's decisions to run, one at a time, so its limits hold. */
  const deciding = new Map<number, Promise<unknown>>();
  /** What each run going is on (`subjectKey`). */
  const going = new Set<string>();
  /** How many runs each Agent has going. */
  const busy = new Map<string, number>();
  /** Runs going, and events being handled, for `idle`. */
  const inFlight = new Set<Promise<unknown>>();
  /** Each Floor's look at its default branch, one at a time. */
  const pushChecks = new Map<string, Promise<unknown>>();

  const oneAtATime = <Key, Value>(
    queues: Map<Key, Promise<unknown>>,
    key: Key,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    const done = (queues.get(key) ?? Promise.resolve()).then(task, task);
    const settled = done.catch(() => undefined);
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) {
        queues.delete(key);
      }
    });
    return done;
  };

  const clientOf = (floor: FloorRecord): RepositoryClient | undefined =>
    github?.repository(floor.repository);

  /** The details an event's Hooks share, each read from GitHub once. */
  const detailsOf = (floor: FloorRecord, occurrence: HookOccurrence) => {
    const client = clientOf(floor);
    const issue = once(async (): Promise<HookEventIssue | undefined> => {
      const number = issueOf(occurrence);
      if (number === undefined) {
        return undefined;
      }
      if (client === undefined) {
        return { number };
      }
      const read = await client.getIssue(number);
      return {
        number,
        title: read.title,
        labels: [...read.labels],
        url: read.htmlUrl,
      };
    });
    /** The pull request an issue that moved to a Stage has, as the App opened it. */
    const pullRequestOfIssue = once(
      async (): Promise<
        { number: number; url: string; branch: string } | undefined
      > => {
        if (occurrence.trigger === "pull_request_opened") {
          return {
            number: occurrence.pullRequest,
            url: occurrence.url,
            branch: occurrence.branch,
          };
        }
        if (occurrence.trigger !== "stage") {
          return undefined;
        }
        const [opened] = await events.history({
          filter: {
            floorId: floor.id,
            issue: occurrence.issue,
            types: ["pull_request.opened"],
          },
          limit: 1,
        });
        return opened?.event.type === "pull_request.opened"
          ? {
              number: opened.event.pullRequest,
              url: opened.event.url,
              branch: opened.event.branch,
            }
          : undefined;
      },
    );
    const files = once(async (): Promise<readonly string[] | undefined> => {
      if (occurrence.trigger === "push") {
        return occurrence.files;
      }
      const pullRequest = await pullRequestOfIssue();
      if (pullRequest === undefined || client === undefined) {
        return undefined;
      }
      return (await client.listPullRequestFiles(pullRequest.number)).map(
        ({ path }) => path,
      );
    });
    /** Every label the event's issues carry: its issue's, or its Batch's. */
    const labels = once(async (): Promise<readonly string[]> => {
      if (
        occurrence.trigger === "wrap_up" ||
        occurrence.trigger === "spec_filed"
      ) {
        if (client === undefined) {
          return [];
        }
        const read = await Promise.all(
          occurrence.batch.issues.map((number) => client.getIssue(number)),
        );
        return [...new Set(read.flatMap(({ labels: each }) => each))];
      }
      return (await issue())?.labels ?? [];
    });
    const details = once(async (): Promise<HookEventDetails> => {
      const base = { trigger: occurrence.trigger };
      switch (occurrence.trigger) {
        case "stage":
        case "pull_request_opened": {
          // What GitHub cannot tell is left out: the Agent still runs.
          const number = issueOf(occurrence) ?? 0;
          const [read, pullRequest, changed] = await Promise.all([
            issue().catch(() => ({ number })),
            pullRequestOfIssue().catch(() => undefined),
            files().catch(() => undefined),
          ]);
          return {
            ...base,
            ...(occurrence.trigger === "stage"
              ? { stage: occurrence.stage }
              : {}),
            ...(read === undefined ? {} : { issue: read }),
            ...(pullRequest === undefined ? {} : { pullRequest }),
            ...filesOf(changed),
          };
        }
        case "push":
          return {
            ...base,
            push: {
              branch: occurrence.branch,
              before: occurrence.before,
              after: occurrence.after,
            },
            ...filesOf(occurrence.files),
          };
        case "wrap_up":
        case "spec_filed":
          return { ...base, batch: occurrence.batch };
        case "run_now":
          return base;
      }
    });
    return { labels, files, details };
  };

  const filesOf = (
    files: readonly string[] | undefined,
  ): Pick<HookEventDetails, "files" | "fileCount"> =>
    files === undefined
      ? {}
      : {
          files: files.slice(0, maxHookEventFiles),
          ...(files.length > maxHookEventFiles
            ? { fileCount: files.length }
            : {}),
        };

  /** Whether the event passes the Hook's filters. */
  const passes = async (
    hook: HookRecord,
    read: ReturnType<typeof detailsOf>,
  ): Promise<boolean> => {
    if (hook.labels.length > 0) {
      const labels = await read.labels();
      if (!hook.labels.some((label) => labels.includes(label))) {
        return false;
      }
    }
    if (hook.filePatterns.length > 0) {
      const files = (await read.files()) ?? [];
      if (
        !hook.filePatterns.some((pattern) =>
          files.some((file) => matchesPattern(pattern, file)),
        )
      ) {
        return false;
      }
    }
    return true;
  };

  /** The Agent to run the Hook: the one it names, or its Role's least busy. */
  const agentFor = async (
    hook: HookRecord,
  ): Promise<AgentRecord | HookRunFailure> => {
    const team = await options.agents.list(hook.floorId);
    if (hook.agentId !== null) {
      const agent = team.find(({ id }) => id === hook.agentId);
      return (
        agent ??
        new HookRunFailure(
          "The Agent it names is no longer on the Floor: choose another in the Hooks card.",
        )
      );
    }
    const inRole = team.filter(({ role }) => role === hook.role);
    const free = inRole
      .filter(({ enabled, leavingAt }) => enabled && leavingAt === null)
      .sort(
        (a, b) =>
          (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
    const [chosen] = free;
    if (chosen !== undefined) {
      return chosen;
    }
    const roleName =
      (await roles.get(hook.role ?? "").catch(() => undefined))?.name ??
      hook.role ??
      "its Role";
    return new HookRunFailure(
      inRole.length === 0
        ? `The Floor has no Agent in the ${roleName} Role to run it.`
        : `Every Agent in the ${roleName} Role on the Floor is paused or leaving.`,
    );
  };

  /** Turns a run's outcome into its record, its events and its Notices. */
  const finish = async (
    floor: FloorRecord,
    hook: HookRecord,
    run: HookRunRecord,
    outcome: RunOutcome,
  ): Promise<void> => {
    const at = now();
    const error = outcome.ok ? null : cut(redactor.redact(outcome.error), 500);
    await store.finishRun(run.id, {
      status: outcome.ok ? "succeeded" : "failed",
      finishedAt: at,
      error,
      result: outcome.ok ? outcome.result : null,
      commentUrl: outcome.ok ? outcome.commentUrl : null,
    });
    let failures = 0;
    let turnedOff = false;
    if (outcome.ok) {
      await store.recordSuccess(floor.id, hook.id);
    } else {
      const after = await store.recordFailure(
        floor.id,
        hook.id,
        hookFailuresToTurnOff,
        at,
      );
      failures = after?.failures ?? 1;
      turnedOff = after !== undefined && hook.enabled && !after.enabled;
    }
    const subject = {
      ...(run.issue === null ? {} : { issue: run.issue }),
      ...(run.pullRequest === null ? {} : { pullRequest: run.pullRequest }),
    };
    await events.publish({
      type: "hook.run_finished",
      version: 1,
      floorId: floor.id,
      hookId: hook.id,
      name: hook.name,
      trigger: hook.trigger,
      ...subject,
      runId: run.id,
      ...(run.agentId === null ? {} : { agentId: run.agentId }),
      outcome: outcome.ok ? "succeeded" : "failed",
      ...(error === null ? {} : { error }),
      failures,
      turnedOff,
      ...(outcome.ok && outcome.commentUrl !== null
        ? { url: outcome.commentUrl }
        : {}),
    });
    if (error === null) {
      return;
    }
    const on =
      run.pullRequest !== null
        ? ` on PR #${String(run.pullRequest)}`
        : run.issue !== null
          ? ` on #${String(run.issue)}`
          : "";
    await notices
      .raise({
        kind: "info",
        title: cut(
          `The Hook "${hook.name}" failed${on} on ${floor.name}: ${error}`,
          200,
        ),
        floorId: floor.id,
        ...(run.agentId === null ? {} : { agentId: run.agentId }),
      })
      .catch(report);
    if (turnedOff) {
      await events.publish({
        type: "hook.changed",
        version: 1,
        floorId: floor.id,
        hookId: hook.id,
        name: hook.name,
        fields: ["enabled"],
        by: "failures",
        enabled: false,
      });
      await notices
        .raise({
          kind: "action",
          title: cut(
            `The Hook "${hook.name}" on ${floor.name} is off: its last ${String(hookFailuresToTurnOff)} runs failed`,
            200,
          ),
          floorId: floor.id,
          actions: [
            {
              id: openHooksAction,
              label: "Open Hooks",
              href: floorHooksPath(floor.id),
            },
          ],
        })
        .catch(report);
    }
  };

  /** One run, start to end. Never throws. */
  const execute = async (
    floor: FloorRecord,
    hook: HookRecord,
    run: HookRunRecord,
    agent: AgentRecord | HookRunFailure,
    occurrence: HookOccurrence,
    details: () => Promise<HookEventDetails>,
  ): Promise<void> => {
    let outcome: RunOutcome;
    try {
      if (agent instanceof HookRunFailure) {
        throw agent;
      }
      if (!agent.enabled) {
        throw new HookRunFailure(`${agent.name} is paused.`);
      }
      const skill = await options.skills
        .get(floor.id, hook.skillName)
        .catch((error: unknown) => {
          throw new HookRunFailure(
            `The Floor's Skill /${hook.skillName} could not be read: ${messageOf(error)}`,
          );
        });
      if (skill.source === "built-in" && builtInOverridesAll(skill.name)) {
        throw new HookRunFailure(
          `/${skill.name} starts a Grilling Session, which only the Manager chat runs.`,
        );
      }
      const model = modelOf(agent, await options.defaultModels?.());
      if (model === undefined) {
        throw new HookRunFailure(
          `${agent.name}'s AI Provider, ${agent.aiProvider}, has no default Model.`,
        );
      }
      const roleName =
        (await roles.get(agent.role).catch(() => undefined))?.name ??
        agent.role;
      const pullRequest = pullRequestOf(occurrence);
      const issue = issueOf(occurrence);
      const target: HookAnswerTarget =
        pullRequest !== undefined
          ? { kind: "pull request", number: pullRequest }
          : issue !== undefined
            ? { kind: "issue", number: issue }
            : null;
      const prompt = hookPrompt({
        floor,
        agent,
        roleName,
        hook,
        skill: { name: skill.name, instructions: skillInstructions(skill) },
        details: await details(),
        target,
      });
      const reply = await options.models
        .complete({
          agentId: agent.id,
          model,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          maxTokens: hookAnswerTokens,
          ...(issue === undefined ? {} : { issue }),
          ...(pullRequest === undefined ? {} : { pullRequest }),
        })
        .catch((error: unknown) => {
          throw new HookRunFailure(
            error instanceof ModelCallError
              ? `The AI Gateway did not answer ${agent.name}'s call: ${error.message}`
              : `${agent.name}'s model call failed: ${messageOf(error)}`,
          );
        });
      const answer = redactor.redact(reply.text.trim());
      if (answer === "") {
        throw new HookRunFailure(`${agent.name} gave no answer.`);
      }
      let commentUrl: string | null = null;
      const client = clientOf(floor);
      if (target !== null && client !== undefined) {
        const header = `**Hook "${hook.name}"**: ${agent.name} (${roleName}) followed \`/${skill.name}\` (${hookTriggerLabels[hook.trigger].toLowerCase()}).`;
        const footer =
          "<sub>Posted by AI Office for the Owner's Hook. Nothing in it is acted on.</sub>";
        const body = `${header}\n\n${cut(answer, maxCommentLength - header.length - footer.length - 4)}\n\n${footer}`;
        const comment = await client
          .createComment(target.number, body)
          .catch((error: unknown) => {
            throw new HookRunFailure(
              `The answer could not be posted on ${target.kind} #${String(target.number)}: ${messageOf(error)}`,
            );
          });
        commentUrl = comment.htmlUrl;
      }
      outcome = {
        ok: true,
        result: cut(answer, maxHookResultLength),
        commentUrl,
      };
    } catch (error) {
      outcome = {
        ok: false,
        error:
          error instanceof HookRunFailure
            ? error.message
            : `It went wrong: ${messageOf(error)}`,
      };
    }
    try {
      await finish(floor, hook, run, outcome);
    } catch (error) {
      report(error);
    }
  };

  /**
   * Starts a run of the Hook for the event, unless its limits say not to:
   * the run started, or why not. Its own events, and every event the run
   * goes on to cause, carry `chain` and the Hook itself.
   */
  const begin = (
    floor: FloorRecord,
    hook: HookRecord,
    occurrence: HookOccurrence,
    details: () => Promise<HookEventDetails>,
    chain: readonly number[],
  ): Promise<HookRunRecord | HookSkipReason | "ran_already"> =>
    oneAtATime(deciding, hook.id, async () => {
      const pullRequest = pullRequestOf(occurrence);
      const issue = issueOf(occurrence);
      // One run per pull request, however many issues join it (ADR 0010).
      if (
        pullRequest !== undefined &&
        (await store.ranOnPullRequest(hook.id, pullRequest))
      ) {
        return "ran_already";
      }
      const key = subjectKey(hook, occurrence);
      const subject = {
        ...(issue === undefined ? {} : { issue }),
        ...(pullRequest === undefined ? {} : { pullRequest }),
      };
      const skip = async (reason: HookSkipReason) => {
        if (occurrence.trigger !== "run_now") {
          await events.publish({
            type: "hook.run_skipped",
            version: 1,
            floorId: floor.id,
            hookId: hook.id,
            name: hook.name,
            trigger: hook.trigger,
            ...subject,
            reason,
          });
        }
        return reason;
      };
      if (key !== undefined && going.has(key)) {
        return skip("already_running");
      }
      const hourAgo = new Date(now().getTime() - 60 * 60 * 1000);
      if ((await store.runsSince(hook.id, hourAgo)) >= hook.runsPerHour) {
        return skip("rate_limited");
      }
      const agent = await agentFor(hook);
      const agentId = agent instanceof HookRunFailure ? null : agent.id;
      const run = await store.startRun({
        hookId: hook.id,
        floorId: floor.id,
        agentId,
        trigger: hook.trigger,
        issue: issue ?? null,
        pullRequest: pullRequest ?? null,
        startedAt: now(),
      });
      if (key !== undefined) {
        going.add(key);
      }
      if (agentId !== null) {
        busy.set(agentId, (busy.get(agentId) ?? 0) + 1);
      }
      const running = causes.run([...chain, hook.id], async () => {
        try {
          await events.publish({
            type: "hook.run_started",
            version: 1,
            floorId: floor.id,
            hookId: hook.id,
            name: hook.name,
            trigger: hook.trigger,
            ...subject,
            runId: run.id,
            ...(agentId === null ? {} : { agentId }),
            skillName: hook.skillName,
          });
        } catch (error) {
          report(error);
        }
        await execute(floor, hook, run, agent, occurrence, details);
      });
      const tracked = running.finally(() => {
        if (key !== undefined) {
          going.delete(key);
        }
        if (agentId !== null) {
          const left = (busy.get(agentId) ?? 1) - 1;
          if (left > 0) {
            busy.set(agentId, left);
          } else {
            busy.delete(agentId);
          }
        }
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
      return run;
    });

  /** Runs every Hook on the Floor that watches the event and lets it through. */
  const fire = async (
    floorId: string,
    occurrence: HookOccurrence,
    chain: readonly number[],
  ): Promise<void> => {
    const floor = await options.floors.get(floorId);
    if (floor?.archivedAt !== null) {
      return;
    }
    const watching = (await store.list(floorId)).filter(
      (hook) =>
        hook.enabled &&
        hook.trigger === occurrence.trigger &&
        (occurrence.trigger !== "stage" || hook.stage === occurrence.stage) &&
        // Never on an event its own run caused (FR-119).
        !chain.includes(hook.id),
    );
    if (watching.length === 0) {
      return;
    }
    const read = detailsOf(floor, occurrence);
    for (const hook of watching) {
      try {
        if (await passes(hook, read)) {
          await begin(floor, hook, occurrence, read.details, chain);
        }
      } catch (error) {
        report(error);
      }
    }
  };

  /**
   * Looks at a Floor's default branch: when it has moved since its push
   * Hooks last saw it, the files changed between are a push. The first
   * look only notes where it stands, as does `noteOnly`.
   */
  const checkPush = (
    floorId: string,
    chain: readonly number[],
    noteOnly = false,
  ): Promise<void> =>
    oneAtATime(pushChecks, floorId, async () => {
      const floor = await options.floors.get(floorId);
      const client = floor === undefined ? undefined : clientOf(floor);
      if (floor?.archivedAt !== null || client === undefined) {
        return;
      }
      const watching = (await store.list(floorId)).some(
        ({ trigger, enabled }) => enabled && trigger === "push",
      );
      if (!watching) {
        return;
      }
      const head = (await client.getBranch(floor.defaultBranch))?.sha;
      if (head === undefined) {
        return;
      }
      const last = await store.pushHead(floorId);
      if (last === head || (noteOnly && last !== undefined)) {
        return;
      }
      await store.setPushHead(floorId, head, now());
      if (last === undefined || noteOnly) {
        return;
      }
      const files = (await client.compareCommits(last, head)).map(
        ({ path }) => path,
      );
      if (files.length === 0) {
        return;
      }
      await fire(
        floorId,
        {
          trigger: "push",
          branch: floor.defaultBranch,
          before: last,
          after: head,
          files,
        },
        chain,
      );
    });

  const occurrenceOf = (event: OfficeEvent): HookOccurrence | undefined => {
    switch (event.type) {
      case "issue.label_changed":
        return isHookStage(event.to)
          ? { trigger: "stage", stage: event.to, issue: event.issue }
          : undefined;
      case "pull_request.opened":
        return {
          trigger: "pull_request_opened",
          issue: event.issue,
          pullRequest: event.pullRequest,
          url: event.url,
          branch: event.branch,
        };
      case "batch.finished":
        return {
          trigger: "wrap_up",
          batch: {
            id: event.batchId,
            issues: event.issues,
            merged: event.merged,
            closed: event.closed,
            blocked: event.blocked,
            notStarted: event.notStarted,
            tokens: event.tokens,
          },
        };
      case "batch.planned":
        return event.specSessionId === undefined
          ? undefined
          : {
              trigger: "spec_filed",
              batch: {
                id: event.batchId,
                issues: event.issues,
                specSessionId: event.specSessionId,
              },
            };
      default:
        return undefined;
    }
  };

  const onEvent = async ({ event }: StoredEvent): Promise<void> => {
    // The Hooks whose runs led to this event, carried through the bus.
    const chain = hookCauses();
    try {
      if (
        (event.type === "repository.changed" && event.change === "push") ||
        event.type === "pull_request.merged"
      ) {
        await checkPush(event.floorId, chain);
        return;
      }
      if (
        (event.type === "hook.added" && event.trigger === "push") ||
        (event.type === "hook.changed" && event.enabled)
      ) {
        // A push Hook starts from where the default branch stands now.
        await checkPush(event.floorId, chain, true);
        return;
      }
      const occurrence = occurrenceOf(event);
      const { floorId } = subjectOf(event);
      if (occurrence !== undefined && floorId !== null) {
        await fire(floorId, occurrence, chain);
      }
    } catch (error) {
      report(error);
    }
  };

  const watched = [
    "issue.label_changed",
    "pull_request.opened",
    "pull_request.merged",
    "repository.changed",
    "batch.finished",
    "batch.planned",
    "hook.added",
    "hook.changed",
  ] as const;

  return {
    async start() {
      await store
        .failRunning("AI Office stopped while it ran.", now())
        .catch(report);
      const unsubscribe = events.subscribe(
        (stored) => {
          const handling = onEvent(stored).finally(() => {
            inFlight.delete(handling);
          });
          inFlight.add(handling);
          return handling;
        },
        { types: [...watched] },
      );
      // The Notice a Hook turned off raises leaves the board once the Owner
      // has turned it on again, or deleted it.
      const unregister = notices.registerAction(
        openHooksAction,
        async (notice) => {
          if (notice.floorId === null) {
            return;
          }
          const off = (await store.list(notice.floorId)).filter(
            ({ enabled, failures }) =>
              !enabled && failures >= hookFailuresToTurnOff,
          );
          if (off.length > 0) {
            throw new Error(
              `${off.map(({ name }) => `"${name}"`).join(", ")} ${off.length === 1 ? "is" : "are"} still off: turn ${off.length === 1 ? "it" : "them"} on again in the Hooks card, or delete ${off.length === 1 ? "it" : "them"}.`,
            );
          }
        },
      );
      const poll =
        pushPollMs > 0
          ? setInterval(() => {
              void store
                .floorsWatchingPushes()
                .then((floorIds) =>
                  Promise.all(floorIds.map((id) => checkPush(id, []))),
                )
                .catch(report);
            }, pushPollMs)
          : undefined;
      poll?.unref();
      return () => {
        unsubscribe();
        unregister();
        if (poll !== undefined) {
          clearInterval(poll);
        }
      };
    },

    async runNow(floor, hook) {
      const occurrence: HookOccurrence = { trigger: "run_now" };
      const started = await begin(
        floor,
        hook,
        occurrence,
        () => Promise.resolve({ trigger: "run_now" }),
        hookCauses(),
      );
      // Run now is never on a pull request.
      return started === "ran_already" ? "already_running" : started;
    },

    async idle() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  };
}
