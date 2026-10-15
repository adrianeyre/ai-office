import type { EventBus } from "@ai-office/events";
import { isGitHubError, type GitHubApp, type Issue } from "@ai-office/github";
import {
  batchErrorCodes,
  createRedactor,
  floorErrorCodes,
  roleName,
  whiteboardPath,
  type IntakeSettings,
  type PlanDraft,
  type PlanEdit,
  type PlanLeftOut,
  type Redactor,
  type TokenUsageRow,
  type WrapUp,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { approvedIssue, UnapprovedIssueError } from "../intake/approved.ts";
import { fromOwner, pickUpIssue, type IntakeQueue } from "../intake/intake.ts";
import { managerGitHub } from "../manager/authority.ts";
import { issueList } from "../manager/commands.ts";
import { loads } from "../manager/dispatch.ts";
import type { Triage, WorkRole } from "../manager/triage.ts";
import type { RepositoryMemory } from "../memory/memory.ts";
import type { ModelClient, ModelMessage } from "../models/client.ts";
import { NoticeError, type Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";
import { positionOf, type Pipeline } from "../pipeline/pipeline.ts";
import { createRounds } from "../rounds.ts";
import { batchBranch } from "../sandbox/branch.ts";
import type { WorkQueueStore } from "../work/store.ts";
import type { WorkTurns } from "../work/turns.ts";
import { BatchError } from "./errors.ts";
import {
  acknowledgementTokens,
  kickoffPrompt,
  parseAcknowledgement,
} from "./kickoff.ts";
import { oneAtATime, onePullRequestLine } from "./one-pull-request.ts";
import {
  changedOrder,
  planByRules,
  planFromDraft,
  plannableCoders,
  replanByRules,
  replanFromDraft,
  replanMidBatch,
  type BatchChange,
  type EditedIssue,
  type PlanIssue,
  type PlanTeam,
} from "./plan.ts";
import { parsePlanDraft, planPrompt, planRetryMessage } from "./prompt.ts";
import type {
  AcknowledgementRecord,
  BatchRecord,
  BatchStore,
  PlanContent,
  PlanRecord,
} from "./store.ts";
import {
  batchOutcomes,
  issueRecord,
  issueRecordTypes,
  wrapUpLine,
  wrapUpOf,
  type IssueNow,
  type IssueRecord,
} from "./wrap-up.ts";

// Batches (PRD FR-25 (1), §5 scenario 1). "complete issues 1 to 5" in the
// Manager chat hands the Floor's Manager a Batch. The Manager reads the
// issues (with its own GitHub client, which only reads, labels and
// comments) and drafts a Plan with its Model, through the AI Gateway with
// its own Gateway Key: the order, the dependencies, the likely files and
// the assignments, which plain code checks and completes (`plan.ts`). An
// answer that is not a Plan is sent back once; when the Model cannot be
// asked or answers twice with no Plan, AI Office's own rules draft one
// (FR-17). The Plan is kept as version 1 of the Batch's Plan.
//
// Issue text is untrusted (PRD §4): only the Owner's issues go into a
// Batch (opened by the Owner, or labelled `ai-office` by them, or filed by
// the GitHub App as the Owner approved them in a Grilling Session, FR-81),
// and their text is redacted before the Model reads it. An issue that is closed,
// already in the pipeline or held by another open Batch is left out,
// saying why.
//
// With the Floor's plan approval on (the default), the Batch waits for
// the Owner to approve its Plan (FR-25.3). With it off, work starts at
// once: each issue whose dependencies are done (closed, by their merged
// pull requests) goes into the pipeline at `needs-work` through the
// Manager's triage, queued for the coder its Plan gives it to. The rest
// wait in the Batch, which checks every minute for issues to start. Intake
// leaves the issues a Batch holds alone.
//
// A Plan awaiting approval raises an action Notice, "Plan awaiting
// approval", whose "Open Plan" opens the Floor's whiteboard (FR-49). There
// the Owner can edit the Plan (reorder, drop and annotate its issues) and
// the Manager replans, as the next version: its Model, told the Owner's
// order (which it must keep), the issues dropped and the annotations, or
// else AI Office's rules. Dropped issues leave the Batch, so intake may
// take them again. Approving the latest version starts the work as it
// says, and closes the Notice. Edits and approvals name the version they
// were made on, so a Plan that changed meanwhile is never approved unseen.
//
// "skip 4" and "move 5 up" in the Manager chat change the Floor's open
// Batch holding the issue (FR-24, FR-25.4). Before approval they are edits
// like the whiteboard's, which the Manager replans. Once work is under way
// AI Office's rules replan it as the next version, without restarting
// finished work: the issues started keep their place and everything the
// Plan said of them, and only those still to start are skipped or
// reordered. Whatever the new version lets start, starts. Overlapping
// issues run one after another (FR-25.5): a later one starts once the
// earlier is closed by its merged pull request, and the coder flow rebases
// each branch onto the work merged meanwhile before review.
//
// On a Floor with several work Roles, the Plan may give an issue an ordered
// list of them (FR-25 (1); §5 scenario 11), which the Owner can reorder or
// cut down on the whiteboard before approving. As the issue starts, its
// Roles settle its triage's routing, and its turns are recorded: the first
// Role works it first, on its one branch, and hands it to the next; review
// starts after the last (`work/turns.ts`).
// Once the Plan is drafted, the Manager holds the Kickoff (FR-25.2,
// FR-60): each Agent the Plan assigns acknowledges it once, through its
// own Model and Gateway Key, with "OK" or one concern, which the
// whiteboard shows; an Agent that is paused, has no Model or cannot be
// asked is acknowledged for by AI Office's rules, with "OK". Agents do not
// converse. When every issue is closed or blocked (`wrap-up.ts`), the
// Batch finishes: its Wrap-up's results (each issue's outcome, pull
// request, rounds, tokens and estimated cost) are kept, a `batch.finished`
// event gathers the Agents again, and an info Notice tells the Owner
// (FR-25.6, FR-49).
//
// A request the Owner makes in the Manager chat is a Batch too (FR-24,
// ADR 0004): the Manager files its issues, and hands them over with the
// Plan it settled in the chat (`ChatBatchRequest`), which plain code
// checks like any draft. The request stands as the Plan's approval, so its
// work starts at once whatever the Floor's plan approval says; "pause",
// "skip" and "move" work on it as on any other. Each chat request is its
// own Batch, running alongside the Floor's others, and only its Plan gives
// work to the Contractors in one-off Roles the Manager added for it: a
// Batch handed over by command plans without them.
//
// "complete issues 1 to 10 in one PR" hands over a Batch whose issues go
// in one pull request (ADR 0010, `one-pull-request.ts`): its Plan runs one
// issue at a time, in its order, each starting once every issue before it
// is ready to merge (rather than closed, as its pull request merges only
// with theirs), and recording where the shared branch stood as it started.
// An issue handed to the Owner holds the rest, which never start, and the
// Batch finishes as its pull request merges or the Owner decides.

/** A Batch the Manager files from one of the Owner's chat requests. */
export interface ChatBatchRequest {
  /** The Owner's chat message it is for. */
  readonly messageId: number;
  /**
   * The Plan settled in the chat, by issue number: its order, dependencies,
   * likely files, Agents and work Roles, checked as any draft is.
   */
  readonly plan: PlanDraft;
}

/** How the Owner asked for a Batch to be worked. */
export interface BatchOptions {
  /** Its issues go in one pull request, from one branch (ADR 0010). */
  readonly onePullRequest?: boolean;
}

/** What handing the Manager a Batch did. */
export type BatchOutcome =
  | {
      readonly batch: BatchRecord;
      readonly plan: PlanRecord;
      /** The issues whose work started with it. */
      readonly started: readonly number[];
      /** Why the Manager's Model did not draft the Plan, if it did not. */
      readonly fallback?: string;
    }
  /** None of the issues named can be worked, so no Batch was made. */
  | { readonly batch: undefined; readonly leftOut: readonly PlanLeftOut[] };

export interface Batches {
  /**
   * Hands the Floor's Manager a Batch of `issues`, in the order named: the
   * Manager drafts its Plan, and with plan approval off its work starts.
   * With `request`, the issues the Manager filed for the Owner's chat
   * message, with the Plan it settled there: its work starts at once.
   * With `options.onePullRequest`, its issues go in one pull request.
   */
  create(
    floorId: string,
    issues: readonly number[],
    request?: ChatBatchRequest,
    options?: BatchOptions,
  ): Promise<BatchOutcome>;
  /** `create`, answering what was done in words, for the Manager chat. */
  command(
    floorId: string,
    issues: readonly number[],
    options?: BatchOptions,
  ): Promise<string>;
  /** What `create` did, in the Manager chat's words: the Plan, and what started. */
  describe(floorId: string, outcome: BatchOutcome): Promise<string>;
  /**
   * Keeps the Owner's edits to a Batch's Plan awaiting approval (FR-25.3),
   * which the Manager replans as the next version.
   */
  edit(floorId: string, batchId: number, edit: PlanEdit): Promise<PlanChange>;
  /**
   * Approves `version` of a Batch's Plan, its latest: the Batch's work
   * starts, each issue once the issues it depends on are done.
   */
  approve(
    floorId: string,
    batchId: number,
    version: number,
  ): Promise<PlanChange & { readonly started: readonly number[] }>;
  /**
   * Skips or moves issues of the Floor's open Batch holding them, from the
   * Manager chat (FR-24, FR-25.4): before approval as an edit the Manager
   * replans; once work is under way, replanned by AI Office's rules
   * without restarting what has started. Answers the new version and the
   * issues it let start.
   */
  change(
    floorId: string,
    change: BatchChange,
  ): Promise<PlanChange & { readonly started: readonly number[] }>;
  /** `change`, answering what was done in words, for the Manager chat. */
  changeCommand(floorId: string, change: BatchChange): Promise<string>;
  /** The issues the Floor's open Batches hold back, not started yet. */
  held(floorId: string): Promise<ReadonlySet<number>>;
  /**
   * Starts each issue of every Batch in progress whose dependencies are
   * done, and finishes each whose issues are all closed or blocked;
   * answers those started, by Batch id.
   */
  check(): Promise<Map<number, number[]>>;
  /** Finishes the Batch if its issues are all closed or blocked: its Wrap-up. */
  finish(batchId: number): Promise<WrapUp | undefined>;
  /** Checks every minute, until stopped. */
  start(): void;
  /**
   * Checks now, as a GitHub webhook asks when a pull request closes (FR-8),
   * or straight after the check running. Resolves once it has finished.
   */
  trigger(): Promise<void>;
  /** Stops checking, waiting for a check in progress. */
  stop(): Promise<void>;
}

/** A Batch, and the version of its Plan an edit or an approval left it with. */
export interface PlanChange {
  readonly batch: BatchRecord;
  readonly plan: PlanRecord;
  /** Why the Manager's Model did not replan the Owner's edits, if it did not. */
  readonly fallback?: string;
}

/** The Owner's edits, for the Manager to replan. */
interface Replanning {
  /** The version the Owner edited. */
  readonly previous: PlanRecord;
  /** The issues the Owner kept, in their order, with their annotations. */
  readonly kept: readonly EditedIssue[];
  /** The issues the Owner dropped from the Batch. */
  readonly dropped: readonly number[];
}

/** The action on a "Plan awaiting approval" Notice: open the whiteboard. */
export const openPlanAction = "open_plan";

/** The Batch a "Plan awaiting approval" Notice is about, from its action. */
const batchOfNotice = (notice: NoticeRecord): number | undefined => {
  const href = notice.actions.find(({ id }) => id === openPlanAction)?.href;
  const batch =
    href === undefined
      ? null
      : new URL(href, "http://ai-office.invalid").searchParams.get("batch");
  return batch === null ? undefined : Number(batch);
};

export interface BatchesOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** The GitHub App: the Manager reads with its own client of it. */
  readonly github: GitHubApp;
  /** Makes the Manager's model calls, through the AI Gateway. */
  readonly models: ModelClient;
  /** Each AI Provider's default Model, for a Manager without its own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  readonly store: BatchStore;
  /** The work queued or running, which the Plan's assignments balance. */
  readonly work: Pick<WorkQueueStore, "active">;
  /** Moves started issues to `needs-work`. */
  readonly pipeline: Pipeline;
  /** Where started issues' work is queued. */
  readonly queue: IntakeQueue;
  readonly events: EventBus;
  readonly notices: Notices;
  /**
   * The Manager's triage, before an issue's work starts; and the Floor's
   * work Roles, which a Plan may give issues in turn.
   */
  readonly triage?: Triage;
  /** Where an issue's work Roles take their turns, as it starts (FR-25 (1)). */
  readonly turns?: Pick<WorkTurns, "plan">;
  /** The Owner's login, whose issues alone may be worked. */
  readonly settings: () => Promise<Pick<IntakeSettings, "ownerLogin">>;
  /**
   * The issues the GitHub App filed on a Floor as the Owner approved them
   * in a Grilling Session (FR-81): the Owner's, though the App opened them.
   */
  readonly approved?: (floorId: string) => Promise<ReadonlySet<number>>;
  /** The Agents paused at a Token Cap: the Plan gives work to others first. */
  readonly pausedAgents?: () => readonly string[];
  /** Where AI Office is reached, for the Notice's link to the Manager chat. */
  readonly publicUrl?: string;
  /** Removes credentials from issue text before the Model reads it. */
  readonly redactor?: Redactor;
  /** The repository's memory, which the Manager reads to plan (FR-53). */
  readonly memory?: Pick<RepositoryMemory, "read">;
  /**
   * What requests through the AI Gateway used in [`from`, `to`), for each
   * issue's tokens and estimated cost in a Wrap-up; none without it.
   */
  readonly usage?: (from: Date, to: Date) => Promise<TokenUsageRow[]>;
  readonly now?: () => Date;
  /** How often to look for issues to start; a minute. */
  readonly intervalMs?: number;
  /** Told when an issue could not be started, or a check failed. */
  readonly onError?: (error: unknown) => void;
}

/** The most tokens the Manager's Plan may use. */
const maxAnswerTokens = 8192;
/** The longest title a chat answer quotes. */
const titleLength = 60;

const shorten = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

export function createBatches(options: BatchesOptions): Batches {
  const { store, events, notices, models } = options;
  const github = managerGitHub(options.github);
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  /** One edit or approval of a Batch at a time. */
  const locks = new Map<number, Promise<unknown>>();
  const onBatch = <Value>(
    batchId: number,
    work: () => Promise<Value>,
  ): Promise<Value> => {
    const next = (locks.get(batchId) ?? Promise.resolve()).then(work, work);
    const settled: Promise<unknown> = next
      .catch(() => undefined)
      .then(() => {
        if (locks.get(batchId) === settled) {
          locks.delete(batchId);
        }
      });
    locks.set(batchId, settled);
    return next;
  };

  // The Notice's "Open Plan" only opens the whiteboard; the Notice closes
  // once the Plan is approved there.
  const unregister = notices.registerAction(openPlanAction, async (notice) => {
    const batchId = batchOfNotice(notice);
    const batch = batchId === undefined ? undefined : await store.get(batchId);
    if (batch?.status === "awaiting_approval") {
      throw new Error(
        "The Plan still awaits your approval: approve it on the whiteboard.",
      );
    }
  });

  /** One Batch's issues start at a time, so none starts twice. */
  let starting: Promise<unknown> = Promise.resolve();
  const exclusive = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const next = starting.then(work, work);
    starting = next.catch(() => undefined);
    return next;
  };

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    if (floor.archivedAt !== null) {
      throw new FloorError(
        floorErrorCodes.floorArchived,
        `The Floor "${floor.name}" is archived.`,
      );
    }
    return floor;
  };

  /**
   * The Floor's team as a Batch's Plan may use it: a chat request's Batch
   * (`chat`) with the Contractors in one-off Roles and their Roles, any
   * other without them (ADR 0004).
   */
  const teamOf = async (
    floor: FloorRecord,
    chat = false,
  ): Promise<{
    manager: AgentRecord;
    agents: AgentRecord[];
    roles: WorkRole[];
  }> => {
    const agents = (await options.agents.list(floor.id)).filter(
      ({ contractor }) => chat || contractor?.oneOffRole !== true,
    );
    const manager = agents.find(({ role }) => role === "manager");
    if (manager === undefined) {
      throw new Error(`The Floor "${floor.name}" has no Manager to plan.`);
    }
    const roles = ((await options.triage?.workRoles(floor)) ?? []).filter(
      ({ oneOff }) => chat || oneOff !== true,
    );
    return { manager, agents, roles };
  };

  /** The Floor's team, as a Plan shares work out across it. */
  const planTeam = async (team: {
    agents: AgentRecord[];
    roles: WorkRole[];
  }): Promise<PlanTeam> => ({
    agents: team.agents,
    active: await options.work.active(),
    paused: options.pausedAgents?.() ?? [],
    roles: team.roles,
  });

  /** The issues the Floor's open Batches hold back, by Batch. */
  const holding = async (floorId: string): Promise<Map<number, number>> => {
    const held = new Map<number, number>();
    for (const batch of await store.open(floorId)) {
      const plan = await store.latestPlan(batch.id);
      const started = new Set(
        (await store.started(batch.id)).map(({ issue }) => issue),
      );
      for (const { issue } of plan?.items ?? []) {
        if (!started.has(issue)) {
          held.set(issue, batch.id);
        }
      }
    }
    return held;
  };

  /**
   * Reads the issues named: those the Batch can hold, redacted, and those
   * it leaves out, with why.
   */
  const readIssues = async (
    floor: FloorRecord,
    numbers: readonly number[],
    /** Issues the Manager just filed for the Owner's chat request: the Owner's. */
    filed: ReadonlySet<number> = new Set(),
  ): Promise<{ issues: Issue[]; leftOut: PlanLeftOut[] }> => {
    const { ownerLogin } = await options.settings();
    const held = await holding(floor.id);
    const approved = new Set([
      ...((await options.approved?.(floor.id)) ?? []),
      ...filed,
    ]);
    const repository = github.repository(floor.repository);
    const issues: Issue[] = [];
    const leftOut: PlanLeftOut[] = [];
    for (const number of numbers) {
      const leave = (reason: string) => leftOut.push({ issue: number, reason });
      let issue: Issue;
      try {
        issue = await repository.getIssue(number);
      } catch (error) {
        if (isGitHubError(error, 404)) {
          leave("it was not found on GitHub");
          continue;
        }
        throw error;
      }
      const otherBatch = held.get(number);
      if (issue.state === "closed") {
        leave("it is closed");
      } else if (
        !approved.has(number) &&
        !(await fromOwner(github, floor, issue, ownerLogin))
      ) {
        leave(
          "someone else opened it, and you have not labelled it ai-office yourself",
        );
      } else if (otherBatch !== undefined) {
        leave(`it waits in Batch ${String(otherBatch)}`);
      } else {
        let stage: string | null;
        try {
          stage = positionOf(number, issue.labels).stage;
        } catch (error) {
          leave(reasonOf(error));
          continue;
        }
        if (stage === null) {
          // Planned from the text the Owner approved, not an edit since
          // (P1-5).
          let approved: Issue;
          try {
            approved = await approvedIssue(repository, number, ownerLogin);
          } catch (error) {
            if (!(error instanceof UnapprovedIssueError)) {
              throw error;
            }
            leave(
              "someone else edited it after you approved it: remove its ai-office label and add it again to approve it as it is",
            );
            continue;
          }
          issues.push({
            ...approved,
            title: redactor.redactText(approved.title),
            body: redactor.redactText(approved.body),
          });
        } else {
          leave(`it is already in the pipeline, at ${stage}`);
        }
      }
    }
    return { issues, leftOut };
  };

  /**
   * The Manager's Model's Plan, asked again once; or the rules'. With
   * `replanning`, the Manager replans the Owner's edits to a Plan instead,
   * and `issues` are those the Owner kept, in their order.
   */
  const draft = async (
    floor: FloorRecord,
    manager: AgentRecord,
    issues: readonly Issue[],
    team: PlanTeam,
    leftOut: readonly PlanLeftOut[],
    replanning?: Replanning,
  ): Promise<{ plan: PlanContent; fallback?: string }> => {
    const named: PlanIssue[] = issues.map(({ number, title }) => ({
      number,
      title,
    }));
    const byRules = (fallback: string) => ({
      plan:
        replanning === undefined
          ? planByRules(named, team, leftOut, fallback)
          : replanByRules(
              replanning.previous,
              replanning.kept,
              team,
              leftOut,
              fallback,
            ),
      fallback,
    });
    if (!manager.enabled) {
      return byRules(`${manager.name} is paused`);
    }
    const defaults = await options.defaultModels?.();
    const model = modelOf(manager, defaults);
    if (model === undefined) {
      return byRules(
        `${manager.name} has no Model (choose a default Model for ${manager.aiProvider} in General Settings)`,
      );
    }
    const load = loads(team.active);
    const memory = await options.memory?.read(floor);
    const coderName = (agentId: string | null): string | null =>
      team.agents.find(({ id }) => id === agentId)?.name ?? null;
    const roleNames = (ids: readonly string[] | undefined): string[] =>
      (ids ?? []).map(
        (id) => team.roles?.find((role) => role.id === id)?.name ?? id,
      );
    const prompt = planPrompt({
      floor,
      manager,
      coders: plannableCoders(team.agents).map((coder) => ({
        name: coder.name,
        aiProvider: coder.aiProvider,
        model: modelOf(coder, defaults),
        load: load.get(coder.id) ?? 0,
      })),
      issues,
      roles: (team.roles ?? []).map((role) => ({
        name: role.name,
        description: role.description,
        coders: plannableCoders(team.agents)
          .filter((coder) => coder.role === role.id)
          .map(({ name }) => name),
      })),
      ...(memory === undefined ? {} : { memory }),
      ...(replanning === undefined
        ? {}
        : {
            edit: {
              version: replanning.previous.version,
              issues: replanning.kept.map(({ number, annotation, roles }) => {
                const item = replanning.previous.items.find(
                  (candidate) => candidate.issue === number,
                );
                return {
                  number,
                  dependsOn: item?.dependsOn ?? [],
                  files: item?.files ?? [],
                  agent: coderName(item?.agentId ?? null),
                  roles: roleNames(roles),
                  note: item?.note ?? "",
                  annotation,
                };
              }),
              dropped: replanning.dropped,
            },
          }),
    });
    const messages: ModelMessage[] = [{ role: "user", content: prompt.user }];
    const read = (text: string) => {
      const parsed = parsePlanDraft(text);
      if (!parsed.ok) {
        return parsed;
      }
      return replanning === undefined
        ? planFromDraft(parsed.value, named, team, leftOut)
        : replanFromDraft(parsed.value, replanning.kept, team, leftOut);
    };
    const ask = () =>
      models.complete({
        agentId: manager.id,
        model,
        system: prompt.system,
        messages,
        maxTokens: maxAnswerTokens,
      });
    try {
      const first = await ask();
      let planned = read(first.text);
      if (!planned.ok) {
        messages.push(
          { role: "assistant", content: first.text },
          { role: "user", content: planRetryMessage(planned.problem) },
        );
        planned = read((await ask()).text);
      }
      return planned.ok
        ? { plan: planned.value }
        : byRules(`${manager.name} gave no valid Plan: ${planned.problem}`);
    } catch (error) {
      return byRules(`${manager.name} could not be asked: ${reasonOf(error)}`);
    }
  };

  /**
   * Starts each of the Batch's issues whose dependencies are done, as its
   * latest Plan has them, and answers those started, in the Plan's order.
   * An issue closed meanwhile needs no work; one already in the pipeline is
   * counted as started; one the Manager's triage finds unclear waits for
   * the Owner, and is tried again later. Only while starting is held
   * (`exclusive`).
   */
  const startReady = async (
    floor: FloorRecord,
    batch: BatchRecord,
  ): Promise<Issue[]> => {
    const plan = await store.latestPlan(batch.id);
    if (plan === undefined) {
      return [];
    }
    const repository = github.repository(floor.repository);
    const read = new Map<number, Promise<Issue>>();
    const issueOf = (number: number): Promise<Issue> => {
      let issue = read.get(number);
      if (issue === undefined) {
        issue = repository.getIssue(number);
        read.set(number, issue);
      }
      return issue;
    };
    const started = new Set(
      (await store.started(batch.id)).map(({ issue }) => issue),
    );
    const startedNow: Issue[] = [];
    for (const [index, item] of plan.items.entries()) {
      if (started.has(item.issue)) {
        continue;
      }
      try {
        if (batch.onePullRequest) {
          // One at a time, in the Plan's order: once every issue before it
          // has passed its pipeline, or is closed (ADR 0010).
          const before = await Promise.all(
            plan.items.slice(0, index).map(({ issue }) => issueOf(issue)),
          );
          if (
            before.some(
              ({ number, state, labels }) =>
                state !== "closed" &&
                positionOf(number, labels).stage !== "ready-to-merge",
            )
          ) {
            continue;
          }
        } else {
          const dependencies = await Promise.all(item.dependsOn.map(issueOf));
          if (dependencies.some(({ state }) => state !== "closed")) {
            continue;
          }
        }
        const current = await issueOf(item.issue);
        if (current.state === "closed") {
          continue;
        }
        // Where the Batch's shared branch stands as the issue starts: its
        // own work is what comes after.
        const base = batch.onePullRequest
          ? ((await repository.getBranch(batchBranch(batch.id)))?.sha ?? null)
          : null;
        if (positionOf(current.number, current.labels).stage !== null) {
          await store.markStarted(batch.id, item.issue, now(), base);
          continue;
        }
        // Triaged and started as the Owner approved it (P1-5): an issue
        // edited by someone else since waits, unstarted, until the Owner
        // labels it again.
        const issue = await approvedIssue(
          repository,
          item.issue,
          (await options.settings()).ownerLogin,
        );
        const roles = item.roles ?? [];
        if (
          options.triage !== undefined &&
          !(
            await options.triage.check(
              floor,
              issue,
              roles.length === 0 ? {} : { planned: roles },
            )
          ).proceed
        ) {
          continue;
        }
        // Its work Roles take turns, from the first (FR-25 (1)).
        if (roles.length > 0) {
          await options.turns?.plan(floor.id, item.issue, roles, batch.id);
        }
        await pickUpIssue(
          {
            pipeline: options.pipeline,
            queue: options.queue,
            events,
          },
          floor,
          issue,
          item.agentId ?? undefined,
        );
        await store.markStarted(batch.id, item.issue, now(), base);
        startedNow.push(issue);
      } catch (error) {
        report(error);
      }
    }
    return startedNow;
  };
  const advance = (floor: FloorRecord, batch: BatchRecord): Promise<Issue[]> =>
    exclusive(() => startReady(floor, batch));

  /** Tells the Owner the Batch's work started (FR-49). */
  const announce = async (
    floor: FloorRecord,
    manager: AgentRecord,
    batch: BatchRecord,
    started: readonly number[],
    urls: ReadonlyMap<number, string>,
  ): Promise<void> => {
    await events.publish({
      type: "batch.started",
      version: 1,
      floorId: floor.id,
      batchId: batch.id,
      agentId: manager.id,
      issues: [...started],
    });
    try {
      await notices.raise({
        kind: "info",
        title:
          `Batch started on ${floor.name}: ${String(batch.issues.length)} issue${batch.issues.length === 1 ? "" : "s"}, ${
            started.length === 0
              ? "none ready to start yet"
              : `work started on ${issueList(started)}`
          }`.slice(0, 200),
        floorId: floor.id,
        agentId: manager.id,
        links: [
          ...(options.publicUrl === undefined
            ? []
            : [
                {
                  label: "The Plan, in the Manager chat",
                  url: `${options.publicUrl.replace(/\/$/, "")}/floors/${encodeURIComponent(floor.id)}/manager`,
                },
              ]),
          ...started.flatMap((issue) => {
            const url = urls.get(issue);
            return url === undefined
              ? []
              : [{ label: `#${String(issue)}`, url }];
          }),
        ].slice(0, 10),
      });
    } catch (error) {
      // The work has started; a Notice that cannot be raised undoes none of it.
      report(error);
    }
  };

  /**
   * One assigned Agent's acknowledgement of the Plan at the Kickoff: its
   * Model's "OK" or one concern, or AI Office's "OK" for it.
   */
  const acknowledgementOf = async (
    floor: FloorRecord,
    manager: AgentRecord,
    agent: AgentRecord,
    agents: readonly AgentRecord[],
    batch: BatchRecord,
    plan: PlanRecord,
  ): Promise<AcknowledgementRecord> => {
    const byRules = (): AcknowledgementRecord => ({
      agentId: agent.id,
      planVersion: plan.version,
      response: "ok",
      concern: null,
      by: "rules",
      createdAt: now(),
    });
    const model = modelOf(agent, await options.defaultModels?.());
    if (
      !agent.enabled ||
      model === undefined ||
      (options.pausedAgents?.() ?? []).includes(agent.id)
    ) {
      return byRules();
    }
    const workRoles = (await options.triage?.workRoles(floor)) ?? [];
    const prompt = kickoffPrompt({
      floor,
      manager,
      agent,
      batchId: batch.id,
      plan,
      nameOf: (agentId) =>
        agents.find(({ id }) => id === agentId)?.name ?? "no coder yet",
      roleNameOf: (role) =>
        workRoles.find(({ id }) => id === role)?.name ?? roleName(role),
    });
    try {
      const reply = await models.complete({
        agentId: agent.id,
        model,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        maxTokens: acknowledgementTokens,
      });
      const parsed = parseAcknowledgement(redactor.redactText(reply.text));
      return {
        ...byRules(),
        by: "model",
        response: parsed.response,
        concern: parsed.response === "concern" ? parsed.concern : null,
      };
    } catch (error) {
      report(error);
      return byRules();
    }
  };

  /**
   * The Kickoff (FR-25.2): the Manager presents the Plan, and each Agent it
   * assigns acknowledges it once, one after another, as the whiteboard
   * fills in. A Kickoff that fails part-way leaves the Batch as it is.
   */
  const kickoff = async (
    floor: FloorRecord,
    manager: AgentRecord,
    agents: readonly AgentRecord[],
    batch: BatchRecord,
    plan: PlanRecord,
  ): Promise<void> => {
    try {
      const assigned = [
        ...new Set(
          plan.items.flatMap(({ agentId }) =>
            agentId === null ? [] : [agentId],
          ),
        ),
      ].flatMap((agentId) => agents.filter(({ id }) => id === agentId));
      await events.publish({
        type: "batch.kickoff_started",
        version: 1,
        floorId: floor.id,
        batchId: batch.id,
        planVersion: plan.version,
        agentId: manager.id,
        agentIds: assigned.map(({ id }) => id),
      });
      let concerns = 0;
      for (const agent of assigned) {
        const acknowledgement = await acknowledgementOf(
          floor,
          manager,
          agent,
          agents,
          batch,
          plan,
        );
        // Once per Agent: one already kept stands.
        if (!(await store.acknowledge(batch.id, acknowledgement))) {
          continue;
        }
        if (acknowledgement.response === "concern") {
          concerns += 1;
        }
        await events.publish({
          type: "batch.acknowledged",
          version: 1,
          floorId: floor.id,
          batchId: batch.id,
          planVersion: plan.version,
          agentId: agent.id,
          response: acknowledgement.response,
          ...(acknowledgement.concern === null
            ? {}
            : { concern: acknowledgement.concern }),
          by: acknowledgement.by,
        });
      }
      await events.publish({
        type: "batch.kickoff_ended",
        version: 1,
        floorId: floor.id,
        batchId: batch.id,
        agentId: manager.id,
        concerns,
      });
    } catch (error) {
      report(error);
    }
  };

  /** What the event log says of each of the Batch's issues since it was made. */
  const recordsOf = async (
    floor: FloorRecord,
    batch: BatchRecord,
    issues: readonly number[],
  ): Promise<Map<number, IssueRecord>> => {
    const records = new Map<number, IssueRecord>();
    for (const issue of issues) {
      const history = await events.history({
        filter: { floorId: floor.id, issue, types: issueRecordTypes },
        from: batch.createdAt,
      });
      records.set(issue, issueRecord(history));
    }
    return records;
  };

  /** Tells the Owner the Batch finished, with its Wrap-up's results (FR-49). */
  const announceWrapUp = async (
    floor: FloorRecord,
    batch: BatchRecord,
    wrapUp: WrapUp,
  ): Promise<void> => {
    try {
      await notices.raise({
        kind: "info",
        title:
          `Batch ${String(batch.id)} finished on ${floor.name}: ${wrapUpLine(wrapUp)}`.slice(
            0,
            200,
          ),
        floorId: floor.id,
        agentId: batch.agentId,
        links: [
          ...(options.publicUrl === undefined
            ? []
            : [
                {
                  label: "The Wrap-up, on the whiteboard",
                  url: `${options.publicUrl.replace(/\/$/, "")}${whiteboardPath(floor.id, batch.id)}`,
                },
              ]),
          // A Batch's one pull request, linked once (ADR 0010).
          ...[
            ...new Map(
              wrapUp.issues.flatMap(({ pullRequest }) =>
                pullRequest === null
                  ? []
                  : [[pullRequest.number, pullRequest.url] as const],
              ),
            ),
          ].map(([number, url]) => ({ label: `PR #${String(number)}`, url })),
        ].slice(0, 10),
      });
    } catch (error) {
      // The Batch has finished; the whiteboard shows its Wrap-up all the same.
      report(error);
    }
  };

  /**
   * Finishes the Batch if every issue of its latest Plan is closed or
   * blocked: its Wrap-up's results are kept, `batch.finished` gathers its
   * Agents for the Wrap-up, and an info Notice tells the Owner. Answers the
   * Wrap-up, or undefined while work remains (or it is not in progress).
   */
  const finishBatch = async (
    floor: FloorRecord,
    batch: BatchRecord,
  ): Promise<WrapUp | undefined> => {
    const plan = await store.latestPlan(batch.id);
    if (batch.status !== "in_progress" || plan === undefined) {
      return undefined;
    }
    const repository = github.repository(floor.repository);
    const issues = new Map<number, IssueNow>();
    for (const { issue } of plan.items) {
      const read = await repository.getIssue(issue);
      issues.set(issue, { state: read.state, labels: read.labels });
    }
    const numbers = plan.items.map(({ issue }) => issue);
    const records = await recordsOf(floor, batch, numbers);
    // A pull request merged on GitHub, not by AI Office, is merged all the same.
    const mergedOnGitHub = new Set<number>();
    for (const [issue, record] of records) {
      if (
        issues.get(issue)?.state === "closed" &&
        !record.merged &&
        record.pullRequest !== null &&
        (await repository.getPullRequest(record.pullRequest.number)).merged
      ) {
        mergedOnGitHub.add(issue);
      }
    }
    const outcomes = batchOutcomes(
      // In one pull request, each issue waits on every issue before it.
      batch.onePullRequest
        ? plan.items.map((item, index) => ({
            issue: item.issue,
            dependsOn: plan.items.slice(0, index).map(({ issue }) => issue),
          }))
        : plan.items,
      issues,
      (issue) =>
        records.get(issue)?.merged === true || mergedOnGitHub.has(issue),
    );
    if (outcomes === undefined) {
      return undefined;
    }
    const at = now();
    const wrapUp = wrapUpOf({
      floorId: floor.id,
      planVersion: plan.version,
      items: plan.items,
      leftOut: plan.leftOut,
      outcomes,
      records,
      usage: (await options.usage?.(batch.createdAt, at)) ?? [],
    });
    if (!(await store.markFinished(batch.id, at, wrapUp))) {
      return undefined;
    }
    await events.publish({
      type: "batch.finished",
      version: 1,
      floorId: floor.id,
      batchId: batch.id,
      agentId: batch.agentId,
      agentIds: [
        ...new Set(
          plan.items.flatMap(({ agentId }) =>
            agentId === null ? [] : [agentId],
          ),
        ),
      ],
      issues: numbers,
      merged: wrapUp.totals.merged,
      closed: wrapUp.totals.closed,
      blocked: wrapUp.totals.blocked,
      notStarted: wrapUp.totals.notStarted,
      tokens: wrapUp.totals.tokens,
    });
    await announceWrapUp(floor, batch, wrapUp);
    return wrapUp;
  };

  /** Asks the Owner to approve the Batch's Plan on the whiteboard (FR-49). */
  const askApproval = async (
    floor: FloorRecord,
    manager: AgentRecord,
    batch: BatchRecord,
    urls: ReadonlyMap<number, string>,
  ): Promise<void> => {
    try {
      await notices.raise({
        kind: "action",
        title:
          `Plan awaiting approval on ${floor.name}: Batch ${String(batch.id)}, ${String(batch.issues.length)} issue${batch.issues.length === 1 ? "" : "s"}`.slice(
            0,
            200,
          ),
        floorId: floor.id,
        agentId: manager.id,
        links: batch.issues
          .flatMap((issue) => {
            const url = urls.get(issue);
            return url === undefined
              ? []
              : [{ label: `#${String(issue)}`, url }];
          })
          .slice(0, 10),
        actions: [
          {
            id: openPlanAction,
            label: "Open Plan",
            href: whiteboardPath(floor.id, batch.id),
          },
        ],
      });
    } catch (error) {
      // The Plan is kept, and the whiteboard shows it all the same.
      report(error);
    }
  };

  /** Closes the Batch's "Plan awaiting approval" Notices, as acted on. */
  const closeApproval = async (
    floorId: string,
    batchId: number,
  ): Promise<void> => {
    for (const notice of await notices.open({ floorId })) {
      if (batchOfNotice(notice) !== batchId) {
        continue;
      }
      try {
        await notices.act(notice.id, openPlanAction);
      } catch (error) {
        // Dismissed or closed meanwhile: nothing to close.
        if (!(error instanceof NoticeError)) {
          report(error);
        }
      }
    }
  };

  /**
   * The Floor's Batch `batchId`, awaiting approval, and its Plan, whose
   * latest version must be `version`; or why not.
   */
  const awaitingApproval = async (
    floor: FloorRecord,
    batchId: number,
    version: number,
  ): Promise<{ batch: BatchRecord; plan: PlanRecord }> => {
    const batch = await store.get(batchId);
    const plan =
      batch?.floorId === floor.id ? await store.latestPlan(batchId) : undefined;
    if (batch === undefined || plan === undefined) {
      throw new BatchError(
        batchErrorCodes.batchNotFound,
        "The Floor has no such Batch.",
      );
    }
    if (batch.status !== "awaiting_approval") {
      throw new BatchError(
        batchErrorCodes.notAwaitingApproval,
        `Batch ${String(batch.id)}'s Plan was already approved, and its work has started.`,
      );
    }
    if (plan.version !== version) {
      throw new BatchError(
        batchErrorCodes.planChanged,
        `The Plan has changed: version ${String(plan.version)} is the latest, not ${String(version)}. Read it again first.`,
      );
    }
    return { batch, plan };
  };

  /** Checks the Owner's edits fit `plan`, and that they change it. */
  const checkEdit = (plan: PlanRecord, changes: PlanEdit): void => {
    const refuse = (message: string) =>
      new BatchError(batchErrorCodes.invalidPlanEdit, message);
    const seen = new Set<number>();
    for (const { issue, roles } of changes.items) {
      const item = plan.items.find((candidate) => candidate.issue === issue);
      if (item === undefined) {
        throw refuse(`#${String(issue)} is not in the Plan.`);
      }
      if (seen.has(issue)) {
        throw refuse(`#${String(issue)} is in the edit twice.`);
      }
      seen.add(issue);
      // An issue's work Roles may be reordered or cut down, never added to.
      if (
        roles !== undefined &&
        (new Set(roles).size !== roles.length ||
          roles.some((role) => !(item.roles ?? []).includes(role)))
      ) {
        throw refuse(
          `#${String(issue)}'s work Roles can only be reordered or removed, each kept once: it has ${
            (item.roles ?? []).length === 0
              ? "none"
              : (item.roles ?? []).join(", ")
          }.`,
        );
      }
    }
    const sameRoles = (
      before: readonly string[] | undefined,
      after: readonly string[] | undefined,
    ): boolean =>
      after === undefined ||
      (after.length === (before ?? []).length &&
        after.every((role, at) => role === before?.[at]));
    const unchanged =
      changes.items.length === plan.items.length &&
      changes.items.every(({ issue, annotation, roles }, index) => {
        const item = plan.items[index];
        return (
          item?.issue === issue &&
          (item.annotation ?? "") === annotation &&
          sameRoles(item.roles, roles)
        );
      });
    if (unchanged) {
      throw refuse("The edit changes nothing in the Plan.");
    }
  };

  /**
   * The Manager's replan of the Owner's `changes` to `plan`, awaiting
   * approval, kept as the next version; `reason` is why the issues left out
   * of `changes` are dropped. Only while the Batch is held (`onBatch`).
   */
  const replanEdit = async (
    floor: FloorRecord,
    batch: BatchRecord,
    plan: PlanRecord,
    changes: PlanEdit,
    reason: string,
  ): Promise<PlanChange> => {
    checkEdit(plan, changes);
    const kept: EditedIssue[] = changes.items.map(
      ({ issue, annotation, roles }) => {
        const item = plan.items.find((candidate) => candidate.issue === issue);
        const kept = roles ?? item?.roles ?? [];
        return {
          number: issue,
          title: item?.title ?? "",
          annotation: redactor.redactText(annotation).trim(),
          ...(kept.length === 0 ? {} : { roles: kept }),
        };
      },
    );
    const dropped = plan.items
      .map(({ issue }) => issue)
      .filter((issue) => !kept.some(({ number }) => number === issue));
    const leftOut: PlanLeftOut[] = [
      ...plan.leftOut,
      ...dropped.map((issue) => ({ issue, reason })),
    ];
    const { manager, ...members } = await teamOf(
      floor,
      batch.chatMessageId !== null,
    );
    const team = await planTeam(members);
    const replanning: Replanning = { previous: plan, kept, dropped };
    let drafted: { plan: PlanContent; fallback?: string };
    try {
      // The Manager reads the issues again, to replan from their text: the
      // text the Owner approved (P1-5).
      const repository = github.repository(floor.repository);
      const { ownerLogin } = await options.settings();
      const issues = await Promise.all(
        kept.map(async ({ number }) => {
          const issue = await approvedIssue(repository, number, ownerLogin);
          return {
            ...issue,
            title: redactor.redactText(issue.title),
            body: redactor.redactText(issue.body),
          };
        }),
      );
      drafted = await draft(floor, manager, issues, team, leftOut, replanning);
    } catch (error) {
      const fallback = `${manager.name} could not read the issues: ${reasonOf(error)}`;
      drafted = {
        plan: replanByRules(plan, kept, team, leftOut, fallback),
        fallback,
      };
    }
    const content = { ...drafted.plan, editedFrom: plan.version };
    const replanned = await store.addPlan(
      batch.id,
      batch.onePullRequest ? oneAtATime(content) : content,
      manager.id,
      now(),
    );
    await events.publish({
      type: "batch.planned",
      version: 1,
      floorId: floor.id,
      batchId: batch.id,
      planVersion: replanned.version,
      agentId: manager.id,
      draftedBy: replanned.draftedBy,
      issues: replanned.items.map(({ issue }) => issue),
      editedFrom: plan.version,
    });
    return {
      batch,
      plan: replanned,
      ...(drafted.fallback === undefined ? {} : { fallback: drafted.fallback }),
    };
  };

  const edit = (
    floorId: string,
    batchId: number,
    changes: PlanEdit,
  ): Promise<PlanChange> =>
    onBatch(batchId, async () => {
      const floor = await floorOf(floorId);
      const { batch, plan } = await awaitingApproval(
        floor,
        batchId,
        changes.version,
      );
      return replanEdit(
        floor,
        batch,
        plan,
        changes,
        "you dropped it from the Plan",
      );
    });

  /**
   * The Floor's open Batch holding `issues` in its latest Plan, the newest
   * if more than one does; or why there is none.
   */
  const batchHolding = async (
    floor: FloorRecord,
    issues: readonly number[],
  ): Promise<BatchRecord> => {
    const holders = new Map<number, BatchRecord>();
    for (const batch of (await store.open(floor.id)).reverse()) {
      const plan = await store.latestPlan(batch.id);
      for (const { issue } of plan?.items ?? []) {
        if (issues.includes(issue) && !holders.has(issue)) {
          holders.set(issue, batch);
        }
      }
    }
    const missing = issues.filter((issue) => !holders.has(issue));
    if (missing.length > 0) {
      throw new BatchError(
        batchErrorCodes.batchNotFound,
        `${issueList(missing)} ${missing.length === 1 ? "is" : "are"} in none of ${floor.name}'s open Batches.`,
      );
    }
    const batches = [
      ...new Map(
        [...holders.values()].map((batch) => [batch.id, batch]),
      ).values(),
    ];
    const [batch] = batches;
    if (batch === undefined || batches.length > 1) {
      throw new BatchError(
        batchErrorCodes.invalidPlanEdit,
        `${issueList(issues)} are in different Batches, ${batches
          .map(({ id }) => String(id))
          .join(" and ")}: skip one Batch's issues at a time.`,
      );
    }
    return batch;
  };

  /** What a change did, in words: "skipped #4", "moved #5 up". */
  const changeDone = (requested: BatchChange, skipped: readonly number[]) =>
    requested.kind === "skip"
      ? `skipped ${issueList(skipped)}`
      : `moved #${String(requested.issue)} ${requested.direction}`;

  const change = async (
    floorId: string,
    requested: BatchChange,
  ): Promise<PlanChange & { started: number[] }> => {
    const floor = await floorOf(floorId);
    const holder = await batchHolding(
      floor,
      requested.kind === "skip" ? requested.issues : [requested.issue],
    );
    return onBatch(holder.id, async () => {
      const batch = await store.get(holder.id);
      const plan = await store.latestPlan(holder.id);
      if (batch === undefined || plan === undefined) {
        throw new BatchError(
          batchErrorCodes.batchNotFound,
          "The Floor has no such Batch.",
        );
      }
      const refuse = (problem: string) =>
        new BatchError(
          batchErrorCodes.invalidPlanEdit,
          `Batch ${String(batch.id)}: ${problem}`,
        );
      const order = plan.items.map(({ issue }) => issue);
      if (batch.status === "awaiting_approval") {
        // Before approval, an edit like the whiteboard's.
        const changed = changedOrder(order, new Set(), requested);
        if (!changed.ok) {
          throw refuse(changed.problem);
        }
        const replanned = await replanEdit(
          floor,
          batch,
          plan,
          {
            version: plan.version,
            items: changed.value.order.map((issue) => {
              const item = plan.items.find(
                (candidate) => candidate.issue === issue,
              );
              return {
                issue,
                annotation: item?.annotation ?? "",
                ...(item?.roles === undefined ? {} : { roles: item.roles }),
              };
            }),
          },
          "you skipped it",
        );
        return { ...replanned, started: [] };
      }
      // Under way: nothing that has started is touched, or starts twice.
      return exclusive(async () => {
        const started = new Set(
          (await store.started(batch.id)).map(({ issue }) => issue),
        );
        const changed = changedOrder(order, started, requested);
        if (!changed.ok) {
          throw refuse(changed.problem);
        }
        const { skipped } = changed.value;
        const { manager, ...members } = await teamOf(
          floor,
          batch.chatMessageId !== null,
        );
        const team = await planTeam(members);
        const carryingOn = order.filter((issue) => started.has(issue));
        const content = replanMidBatch(
          plan,
          changed.value.order,
          started,
          team,
          [
            ...plan.leftOut,
            ...skipped.map((issue) => ({
              issue,
              reason: "you skipped it while the Batch was under way",
            })),
          ],
          `AI Office's rules replanned the Batch, as you ${changeDone(requested, skipped)} while its work was under way. ${
            carryingOn.length === 0
              ? "None of its issues had started yet."
              : `The issues already started (${issueList(carryingOn)}) carry on as they were, none of them restarted.`
          } The issues still to start keep their likely files, their coders and the issues they depend on that still come before them, in your order; issues that share a likely file run one after another.`,
        );
        const edited = { ...content, editedFrom: plan.version };
        const replanned = await store.addPlan(
          batch.id,
          batch.onePullRequest ? oneAtATime(edited) : edited,
          manager.id,
          now(),
        );
        await events.publish({
          type: "batch.planned",
          version: 1,
          floorId: floor.id,
          batchId: batch.id,
          planVersion: replanned.version,
          agentId: manager.id,
          draftedBy: replanned.draftedBy,
          issues: replanned.items.map(({ issue }) => issue),
          editedFrom: plan.version,
        });
        const startedNow = await startReady(floor, batch);
        return {
          batch,
          plan: replanned,
          started: startedNow.map(({ number }) => number),
        };
      });
    });
  };

  const approve = (
    floorId: string,
    batchId: number,
    version: number,
  ): Promise<PlanChange & { started: number[] }> =>
    onBatch(batchId, async () => {
      const floor = await floorOf(floorId);
      const { batch, plan } = await awaitingApproval(floor, batchId, version);
      const { manager } = await teamOf(floor);
      const at = now();
      if (!(await store.markInProgress(batch.id, at))) {
        throw new BatchError(
          batchErrorCodes.notAwaitingApproval,
          `Batch ${String(batch.id)}'s Plan was already approved, and its work has started.`,
        );
      }
      const approved: BatchRecord = {
        ...batch,
        status: "in_progress",
        startedAt: at,
      };
      await events.publish({
        type: "batch.approved",
        version: 1,
        floorId: floor.id,
        batchId: batch.id,
        planVersion: plan.version,
        agentId: manager.id,
      });
      const started = await advance(floor, approved);
      await announce(
        floor,
        manager,
        approved,
        started.map(({ number }) => number),
        new Map(started.map(({ number, htmlUrl }) => [number, htmlUrl])),
      );
      await closeApproval(floor.id, batch.id);
      return {
        batch: approved,
        plan,
        started: started.map(({ number }) => number),
      };
    });

  const create = async (
    floorId: string,
    numbers: readonly number[],
    request?: ChatBatchRequest,
    batchOptions: BatchOptions = {},
  ): Promise<BatchOutcome> => {
    const onePullRequest = batchOptions.onePullRequest === true;
    const floor = await floorOf(floorId);
    const { manager, ...members } = await teamOf(floor, request !== undefined);
    const { issues, leftOut } = await readIssues(
      floor,
      numbers,
      new Set(request === undefined ? [] : numbers),
    );
    if (issues.length === 0) {
      return { batch: undefined, leftOut };
    }
    const team = await planTeam(members);
    // A chat request's Plan was settled in the chat; plain code checks it,
    // and the Manager drafts one only if it does not hold.
    const settled =
      request === undefined
        ? undefined
        : planFromDraft(
            request.plan,
            issues.map(({ number, title }) => ({ number, title })),
            team,
            leftOut,
          );
    const drafted = settled?.ok
      ? { plan: settled.value }
      : await draft(floor, manager, issues, team, leftOut);
    const { batch, plan } = await store.create(
      {
        floorId: floor.id,
        issues: issues.map(({ number }) => number),
        // The chat request stands as the Plan's approval (ADR 0004).
        status:
          floor.planApproval && request === undefined
            ? "awaiting_approval"
            : "in_progress",
        agentId: manager.id,
        createdAt: now(),
        chatMessageId: request?.messageId ?? null,
        onePullRequest,
      },
      onePullRequest ? oneAtATime(drafted.plan) : drafted.plan,
    );
    await events.publish({
      type: "batch.planned",
      version: 1,
      floorId: floor.id,
      batchId: batch.id,
      planVersion: plan.version,
      agentId: manager.id,
      draftedBy: plan.draftedBy,
      issues: plan.items.map(({ issue }) => issue),
    });
    await kickoff(floor, manager, members.agents, batch, plan);
    let started: number[] = [];
    const urls = new Map(
      issues.map(({ number, htmlUrl }) => [number, htmlUrl]),
    );
    if (batch.status === "in_progress") {
      started = (await advance(floor, batch)).map(({ number }) => number);
      await announce(floor, manager, batch, started, urls);
    } else {
      await askApproval(floor, manager, batch, urls);
    }
    return {
      batch,
      plan,
      started,
      ...(drafted.fallback === undefined ? {} : { fallback: drafted.fallback }),
    };
  };

  /**
   * The Floor's Agents' names, by id ("no coder yet" for none), each with
   * the work Roles an issue's Plan gives it, if any.
   */
  const namesOn = async (
    floorId: string,
  ): Promise<(agentId: string | null, roles?: readonly string[]) => string> => {
    const agents = await options.agents.list(floorId);
    const floor = await options.floors.get(floorId);
    const workRoles =
      floor === undefined
        ? []
        : ((await options.triage?.workRoles(floor)) ?? []);
    return (agentId, roles = []) =>
      `${agents.find(({ id }) => id === agentId)?.name ?? "no coder yet"}${
        roles.length === 0
          ? ""
          : ` (${roles
              .map(
                (role) => workRoles.find(({ id }) => id === role)?.name ?? role,
              )
              .join(", then ")})`
      }`;
  };

  const leftOutLines = (list: readonly PlanLeftOut[]): string[] =>
    list.map(({ issue, reason }) => `#${String(issue)}: ${reason}.`);

  /**
   * A Plan in the chat's words: its summary, its issues in order (marking
   * those in `started`), its parallel groups and what it leaves out.
   */
  const planLines = (
    plan: PlanRecord,
    nameOf: (agentId: string | null, roles?: readonly string[]) => string,
    started: ReadonlySet<number> = new Set(),
  ): string[] => [
    plan.summary,
    "",
    ...plan.items.flatMap((item, index) => {
      const overlaps = plan.overlaps
        .filter(({ issues }) => issues[1] === item.issue)
        .map(({ issues: [earlier] }) => earlier);
      return [
        `${String(index + 1)}. #${String(item.issue)} ${shorten(item.title, titleLength)}${
          started.has(item.issue) ? " (started)" : ""
        }: ${nameOf(item.agentId, item.roles)}${
          item.dependsOn.length === 0
            ? ""
            : `, after ${issueList(item.dependsOn)}`
        }${
          overlaps.length === 0
            ? ""
            : ` (shares files with ${issueList(overlaps)})`
        }.${
          item.files.length === 0
            ? ""
            : ` Likely files: ${item.files.join(", ")}.`
        }${item.note === "" ? "" : ` ${item.note}`}`,
      ];
    }),
    "",
    `In parallel: ${plan.parallel.map((group) => issueList(group)).join("; then ")}.`,
    ...(plan.leftOut.length === 0
      ? []
      : ["", "Left out:", ...leftOutLines(plan.leftOut)]),
    "",
  ];

  /** What the Manager chat answers: the Plan, and what started. */
  const describe = async (
    floorId: string,
    outcome: BatchOutcome,
  ): Promise<string> => {
    if (outcome.batch === undefined) {
      return [
        "No Batch was made: none of these issues can be worked.",
        "",
        ...leftOutLines(outcome.leftOut),
      ].join("\n");
    }
    const { batch, plan, started } = outcome;
    const nameOf = await namesOn(floorId);
    const manager = nameOf(batch.agentId);
    const done = new Set(started);
    const fromChat = batch.chatMessageId !== null;
    const lines = [
      `Batch ${String(batch.id)}: ${manager} drafted its Plan (version ${String(plan.version)})${
        plan.draftedBy === "rules" ? " by AI Office's rules" : ""
      }.`,
      "",
      ...planLines(plan, nameOf),
      ...(batch.onePullRequest ? [onePullRequestLine(batch.id), ""] : []),
    ];
    if (batch.status === "awaiting_approval") {
      lines.push(
        "Plan approval is on for this Floor, so work starts once you approve the Plan on the Floor's whiteboard, where you can first reorder, drop and annotate its issues, and I replan.",
      );
    } else {
      const waiting = plan.items.filter(({ issue }) => !done.has(issue));
      lines.push(
        [
          `${
            fromChat
              ? "Your request stands as the Plan's approval"
              : "Plan approval is off for this Floor"
          }, so work has started${
            started.length === 0 ? "" : ` on ${issueList(started)}`
          }.`,
          ...waiting.map(({ issue, dependsOn }) => {
            // In one pull request, each waits for every issue before it.
            const before = plan.items
              .slice(
                0,
                plan.items.findIndex((item) => item.issue === issue),
              )
              .map((item) => item.issue);
            if (batch.onePullRequest && before.length > 0) {
              return `#${String(issue)} starts once ${issueList(before)} ${before.length === 1 ? "is" : "are"} ready to merge.`;
            }
            return dependsOn.length === 0
              ? `#${String(issue)} did not start: see its triage on GitHub, or the Notice Board.`
              : `#${String(issue)} starts once ${issueList(dependsOn)} ${dependsOn.length === 1 ? "is" : "are"} closed.`;
          }),
        ].join(" "),
      );
    }
    return lines.join("\n");
  };

  /** What the Manager chat answers to a change: the new version, and what started. */
  const describeChange = async (
    floorId: string,
    requested: BatchChange,
    changed: PlanChange & { readonly started: readonly number[] },
  ): Promise<string> => {
    const { batch, plan } = changed;
    const nameOf = await namesOn(floorId);
    const skipped = plan.leftOut
      .map(({ issue }) => issue)
      .filter(
        (issue) =>
          requested.kind === "skip" && requested.issues.includes(issue),
      );
    const started = new Set(
      (await store.started(batch.id)).map(({ issue }) => issue),
    );
    const lines = [
      `Batch ${String(batch.id)}: you ${changeDone(requested, skipped)}, so ${nameOf(batch.agentId)} replanned it as version ${String(plan.version)}${
        plan.draftedBy === "rules" ? " by AI Office's rules" : ""
      }.`,
      "",
      ...planLines(plan, nameOf, started),
    ];
    if (batch.status === "awaiting_approval") {
      lines.push(
        "Work starts once you approve the Plan on the Floor's whiteboard.",
      );
    } else {
      const carryingOn = [...started].filter(
        (issue) => !changed.started.includes(issue),
      );
      lines.push(
        [
          carryingOn.length === 0
            ? "No work had started yet, so none was restarted."
            : `The work already started on ${issueList(carryingOn)} carries on, none of it restarted.`,
          ...(changed.started.length === 0
            ? []
            : [`Work started now on ${issueList(changed.started)}.`]),
        ].join(" "),
      );
    }
    return lines.join("\n");
  };

  const check = async (): Promise<Map<number, number[]>> => {
    const startedBy = new Map<number, number[]>();
    for (const batch of await store.open()) {
      if (batch.status !== "in_progress") {
        continue;
      }
      try {
        const floor = await options.floors.get(batch.floorId);
        // Work on archived Floors stops (FR-9).
        if (floor?.archivedAt !== null) {
          continue;
        }
        const started = await advance(floor, batch);
        if (started.length > 0) {
          startedBy.set(
            batch.id,
            started.map(({ number }) => number),
          );
        }
        await exclusive(() => finishBatch(floor, batch));
      } catch (error) {
        report(error);
      }
    }
    return startedBy;
  };

  const finish = async (batchId: number): Promise<WrapUp | undefined> => {
    const batch = await store.get(batchId);
    const floor =
      batch === undefined ? undefined : await options.floors.get(batch.floorId);
    // Work on archived Floors stops (FR-9).
    if (batch === undefined || floor?.archivedAt !== null) {
      return undefined;
    }
    return exclusive(() => finishBatch(floor, batch));
  };

  let unsubscribe: (() => void) | undefined;

  const rounds = createRounds({
    run: async () => {
      await check().catch(report);
    },
    intervalMs: () => Promise.resolve(options.intervalMs ?? 60_000),
  });

  return {
    create,
    describe,
    async command(floorId, issues, batchOptions) {
      return describe(
        floorId,
        await create(floorId, issues, undefined, batchOptions),
      );
    },
    edit,
    approve,
    change,
    async changeCommand(floorId, requested) {
      return describeChange(
        floorId,
        requested,
        await change(floorId, requested),
      );
    },
    async held(floorId) {
      return new Set((await holding(floorId)).keys());
    },
    check,
    finish,
    start() {
      if (unsubscribe !== undefined) {
        return;
      }
      rounds.start({ now: false });
      // A merge, or an issue handed to the Owner, may let the next issues
      // start or finish a Batch: checked at once rather than at the next
      // minute, as a round run straight after the one running (if any). So
      // may an issue ready to merge, in a Batch that goes in one pull
      // request (ADR 0010).
      unsubscribe = events.subscribe(
        ({ event }) => {
          if (
            event.type === "pull_request.merged" ||
            (event.type === "issue.label_changed" &&
              (event.to === "needs-human" || event.to === "ready-to-merge"))
          ) {
            void rounds.trigger();
          }
        },
        { types: ["pull_request.merged", "issue.label_changed"] },
      );
    },
    trigger: () => rounds.trigger(),
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      unregister();
      await rounds.stop();
    },
  };
}
