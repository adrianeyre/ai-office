import { createHash } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import type { GitHubApp, Issue } from "@ai-office/github";
import {
  builtInRoles,
  createRedactor,
  defaultIssuePriority,
  maxRoleCandidates,
  roleLabelName,
  rolesLabelled,
  routingActions,
  triageActions,
  type IssuePriority,
  type Redactor,
  type RouteJudge,
  type TriageJudge,
  type TriageOutcome,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type {
  DecisionModel,
  IssueGap,
  IssueJudgement,
} from "../decision-model/decision-model.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { RepositoryMemory } from "../memory/memory.ts";
import type { ModelClient, ModelMessage } from "../models/client.ts";
import { NoticeError, type Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";
import type { RoleRecord, RoleStore } from "../roles/store.ts";
import {
  parseTriage,
  triagePrompt,
  triageRetryMessage,
} from "./triage-prompt.ts";
import type { TriageRecord, TriageStore } from "./triage-store.ts";

// The Manager's triage (PRD FR-23): before work starts on a picked-up
// issue, the Floor's Manager checks it is clear enough to work (acceptance
// criteria present, scope bounded) and sets its priority, which the work
// queue dispatches by. The judgement is the Manager's Model's, through the
// AI Gateway with the Manager's own Gateway Key (ADR 0001), so it counts
// against the Manager's Token Caps; or, while the Owner has the Decision
// Model on (FR-17), Jev's, likewise, with the Manager's Model asked only
// when Jev cannot be. Plain code decides what it can: an
// issue with no description is unclear without a model call, and when the
// Manager's Model cannot be asked (the Manager is paused, has no Model,
// the Gateway refuses, or it answers with no valid triage twice), AI
// Office's own rules judge instead: clear only with acceptance criteria
// (FR-17: deterministic rules where no model judges).
//
// An unclear issue waits, out of the pipeline. The Owner gets an action
// Notice (FR-49) and a comment on the issue with the Manager's questions.
// Once the issue's title or body changes it is triaged again; or the
// Owner has it worked as it is, from the Notice. Every decision is a
// comment on the issue (FR-23) and an `issue.triaged` event (FR-52).
//
// Routing between work Roles (FR-23, ADR 0003): when the Floor's team has
// more than one work-Stage Role, a clear issue also needs its Role, which
// the work queue then dispatches it to. A `role:<name>` label on the issue
// forces one. Otherwise the Manager's Model picks it in the same triage,
// from each Role's routing description. When it cannot tell (or no model
// judged), the issue waits for the Owner, with an action Notice offering
// each candidate Role; choosing one, or labelling the issue, lets it go on.
// A Floor with one work Role never asks. Each choice and its reason is a
// comment on the issue and an `issue.routed` event. A Batch's Plan may
// give an issue its work Roles itself, several in turn (FR-25 (1)): then
// they settle it, ahead of any label, and the Model is not asked to
// choose; the first Role works it first.

/** Whether a picked-up issue may go into the pipeline now. */
export type TriageDecision =
  | { readonly proceed: true; readonly priority: IssuePriority }
  | { readonly proceed: false };

export interface Triage {
  /**
   * Triages the issue, unless its title and body are as they were last
   * triaged: then the last decision stands. An unclear issue waits for
   * the Owner, with a Notice and a comment.
   */
  check(
    floor: FloorRecord,
    issue: Issue,
    options?: TriageCheckOptions,
  ): Promise<TriageDecision>;
  /** The priority the issue's triage set; normal without one. */
  priority(floorId: string, issue: number): Promise<IssuePriority>;
  /**
   * The work Role chosen for the issue (a library Role's id); null when
   * none was, and the work goes to any work-Stage Agent.
   */
  role(floorId: string, issue: number): Promise<string | null>;
  /**
   * The Floor's work Roles (those of its work-Stage Agents), each of which
   * gets a `role:<name>` label on its repository.
   */
  workRoles(floor: FloorRecord): Promise<WorkRole[]>;
  /** Removes the Notice actions' handlers. */
  stop(): void;
}

export interface TriageCheckOptions {
  /**
   * The work Roles (ids) its Batch's Plan gives the issue, in the order
   * they take turns (FR-25 (1)): they settle its Role. Those no longer on
   * the Floor's team are passed over.
   */
  readonly planned?: readonly string[];
}

export interface TriageOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly github: GitHubApp;
  /** Makes the Manager's model calls, through the AI Gateway. */
  readonly models: ModelClient;
  /** Jev's triage, while the Decision Model is on (FR-17). */
  readonly decisionModel?: Pick<DecisionModel, "issue">;
  /** Each AI Provider's default Model, for a Manager without its own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  readonly notices: Notices;
  readonly events: EventBus;
  readonly store: TriageStore;
  /**
   * Removes credentials from the issue text the Manager's Model reads, and
   * from what is written to the issue.
   */
  readonly redactor?: Redactor;
  /** The repository's memory, which the Manager reads to triage (FR-53). */
  readonly memory?: Pick<RepositoryMemory, "read">;
  /**
   * The Role library, for the names and routing descriptions of the
   * Floor's work Roles; the built-in Roles without it.
   */
  readonly roles?: Pick<RoleStore, "list" | "oneOffs">;
  readonly now?: () => Date;
  /** Told when a comment could not be written or a Notice closed. */
  readonly onError?: (error: unknown) => void;
}

/** The most tokens one triage answer may use. */
const maxAnswerTokens = 1024;

/** Marks AI Office's triage comments on an issue. */
export const triageCommentMarker = "<!-- ai-office:triage -->";

/** The issue's title and body, as a SHA-256: it changes when they do. */
export const issueFingerprint = (
  issue: Pick<Issue, "title" | "body">,
): string =>
  createHash("sha256")
    .update(JSON.stringify([issue.title, issue.body]))
    .digest("hex");

/**
 * Whether an issue lists acceptance criteria, as AI Office's rules see it:
 * a line naming them, or a task list.
 */
export const hasAcceptanceCriteria = (body: string): boolean =>
  /acceptance criteria/i.test(body) || /^\s*[-*+]\s+\[[ xX]\]\s+\S/m.test(body);

interface Judgement {
  readonly outcome: TriageOutcome;
  readonly priority: IssuePriority;
  readonly reason: string;
  readonly questions: readonly string[];
  readonly judgedBy: Exclude<TriageJudge, "owner">;
  /** Why the Manager's Model was not asked, when the rules judged instead. */
  readonly fallback?: string;
  /** The work Roles the Model named, best first, when it was asked to. */
  readonly roles?: readonly string[];
  readonly roleReason?: string;
}

/** A work Role on the Floor's team, as routing reads it. */
export type WorkRole = Pick<RoleRecord, "id" | "name" | "description"> & {
  /**
   * A one-off Role the Manager wrote for a Contractor's task (ADR 0004):
   * only a Plan gives it work, never a label or the Model's choice.
   */
  readonly oneOff?: true;
};

/** How a clear issue's work Role is settled. */
type Routing =
  /** No Role to choose: the Floor has no work Agents. */
  | { readonly kind: "none" }
  /** The Floor's one work Role, chosen without a word. */
  | { readonly kind: "only"; readonly role: WorkRole }
  | {
      readonly kind: "routed";
      readonly role: WorkRole;
      readonly by: Exclude<RouteJudge, "owner" | "plan">;
      readonly reason: string;
    }
  /** Its Batch's Plan gives it these Roles, in turn: the first works it first. */
  | {
      readonly kind: "planned";
      readonly role: WorkRole;
      readonly roles: readonly WorkRole[];
    }
  /** The Owner is asked, with an action Notice. */
  | {
      readonly kind: "ask";
      readonly candidates: readonly WorkRole[];
      readonly reason: string;
    };

/**
 * How an issue's work Role is settled: by its one `role:<name>` label;
 * the Floor's only work Role; or the Role the Manager's Model named alone.
 * Otherwise the Owner is asked to choose between the Roles labelled, the
 * Roles the Model named, or else every work Role on the Floor (at most
 * four: a Notice offers no more).
 */
function routingOf(
  workRoles: readonly WorkRole[],
  labelled: readonly WorkRole[],
  judgement: Pick<Judgement, "judgedBy" | "roles" | "roleReason"> | undefined,
): Routing {
  const [only] = labelled.length === 1 ? labelled : workRoles;
  if (only === undefined) {
    return { kind: "none" };
  }
  const ask = (candidates: readonly WorkRole[], reason: string): Routing => ({
    kind: "ask",
    candidates: candidates.slice(0, maxRoleCandidates),
    reason,
  });
  if (labelled.length === 1) {
    return {
      kind: "routed",
      role: only,
      by: "label",
      reason: `The \`${roleLabelName(only)}\` label on this issue gives it to the **${only.name}** Role.`,
    };
  }
  if (labelled.length > 1) {
    return ask(
      labelled,
      `This issue has a \`role:\` label for each of ${labelled.map(({ name }) => name).join(", ")}, and one Role works it.`,
    );
  }
  if (workRoles.length === 1) {
    return { kind: "only", role: only };
  }
  if (judgement?.judgedBy !== "model") {
    return ask(
      workRoles,
      judgement === undefined
        ? "No work Role was chosen for this issue when it was triaged."
        : "AI Office's rules triaged this issue, and they do not choose between work Roles.",
    );
  }
  const named = [...new Set(judgement.roles ?? [])].flatMap((id) =>
    workRoles.filter((role) => role.id === id),
  );
  const [chosen] = named;
  if (named.length === 1 && chosen !== undefined) {
    return {
      kind: "routed",
      role: chosen,
      by: "model",
      reason: judgement.roleReason ?? `${chosen.name}: ${chosen.description}`,
    };
  }
  return ask(
    named.length > 1 ? named : workRoles,
    judgement.roleReason ??
      "The Manager could not tell which Role should work it.",
  );
}

/**
 * How the Plan's work Roles (`planned`, ids) settle an issue's Role: those
 * on the Floor's team, in order; undefined for none, or on a Floor with
 * one work Role, which never needs one chosen.
 */
function plannedRouting(
  workRoles: readonly WorkRole[],
  planned: readonly string[] | undefined,
): Extract<Routing, { kind: "planned" }> | undefined {
  const roles = (planned ?? []).flatMap((id) =>
    workRoles.filter((role) => role.id === id),
  );
  const [first] = roles;
  return first === undefined || workRoles.length < 2
    ? undefined
    : { kind: "planned", role: first, roles };
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

/** Text as a Markdown quote, line by line. */
const blockQuote = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");

/** What the Owner is asked about what an issue most lacks, as Jev names it. */
const gapQuestions: Record<IssueGap, string> = {
  done: "What are its acceptance criteria: how will we tell that it is done?",
  what: "What exactly should be built or changed?",
  scope: "Where does the work stop: what is in scope, and what is not?",
  nothing: "What should be built, and how will we tell that it is done?",
};

/** How likely, as a percentage. */
const percent = (probability: number): string =>
  `${String(Math.round(probability * 100))}%`;

/** Jev's triage (FR-17), with its reason and question for the Owner. */
const byDecisionModel = (judged: IssueJudgement): Judgement => ({
  judgedBy: "decision_model",
  priority: judged.priority,
  ...(judged.clear
    ? {
        outcome: "clear",
        reason: `The Decision Model judged it clear enough to work (${percent(judged.probability)} likely).`,
        questions: [],
      }
    : {
        outcome: "unclear",
        reason: `The Decision Model judged it not clear enough to work (${percent(judged.probability)} likely to be clear).`,
        questions: [gapQuestions[judged.gap]],
      }),
});

/** AI Office's own rules, for when the Manager's Model gives no judgement. */
const byRules = (issue: Issue, fallback?: string): Judgement => {
  const base = {
    priority: defaultIssuePriority,
    judgedBy: "rules" as const,
    ...(fallback === undefined ? {} : { fallback }),
  };
  if (issue.body.trim() === "") {
    return {
      ...base,
      outcome: "unclear",
      reason: "The issue has no description.",
      questions: [
        "What should be built, and how will we tell that it is done?",
      ],
    };
  }
  return hasAcceptanceCriteria(issue.body)
    ? {
        ...base,
        outcome: "clear",
        reason: "The issue lists acceptance criteria.",
        questions: [],
      }
    : {
        ...base,
        outcome: "unclear",
        reason: "The issue lists no acceptance criteria.",
        questions: [
          "What are its acceptance criteria: how will we tell that it is done?",
        ],
      };
};

export function createTriage(options: TriageOptions): Triage {
  const { store, notices, events, github, models } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  const managerOf = async (floor: FloorRecord): Promise<AgentRecord> => {
    const manager = (await options.agents.list(floor.id)).find(
      ({ role }) => role === "manager",
    );
    if (manager === undefined) {
      throw new Error(`The Floor "${floor.name}" has no Manager to triage.`);
    }
    return manager;
  };

  /**
   * The Roles of the Floor's work-Stage Agents (leaving ones aside), in
   * the library's order.
   */
  const workRolesOf = async (floor: FloorRecord): Promise<WorkRole[]> => {
    const ids = new Set(
      (await options.agents.list(floor.id))
        .filter(
          ({ stage, leavingAt }) => stage === "work" && leavingAt === null,
        )
        .map(({ role }) => role),
    );
    const library = (await options.roles?.list()) ?? builtInRoles;
    const oneOffs = (await options.roles?.oneOffs(floor.id)) ?? [];
    const known = [...library, ...oneOffs];
    return [
      ...library.filter(({ id }) => ids.has(id)),
      ...oneOffs
        .filter(({ id }) => ids.has(id))
        .map(({ id, name, description }) => ({
          id,
          name,
          description,
          oneOff: true as const,
        })),
      ...[...ids]
        .filter((id) => !known.some((role) => role.id === id))
        .map((id) => ({ id, name: id, description: "" })),
    ];
  };

  /**
   * The Floor's work Roles a label or the Model may give an issue: its
   * one-off Roles are only a Plan's to give (ADR 0004).
   */
  const choosableRolesOf = async (floor: FloorRecord): Promise<WorkRole[]> =>
    (await workRolesOf(floor)).filter(({ oneOff }) => oneOff !== true);

  /** The Manager's Model's triage, asked again once; or the rules'. */
  const judge = async (
    floor: FloorRecord,
    manager: AgentRecord,
    issue: Issue,
    /** The work Roles to choose between, when the Model must choose. */
    roles: readonly WorkRole[],
  ): Promise<Judgement> => {
    // Nothing to judge: plain code can tell, and no model is asked.
    if (issue.body.trim() === "") {
      return byRules(issue);
    }
    if (!manager.enabled) {
      return byRules(issue, `${manager.name} is paused`);
    }
    // Jev, while the Decision Model is on; the Manager's Model if it
    // cannot be asked.
    const judged = await options.decisionModel?.issue(floor.id, issue);
    if (judged !== undefined) {
      return byDecisionModel(judged);
    }
    const model = modelOf(manager, await options.defaultModels?.());
    if (model === undefined) {
      return byRules(
        issue,
        `${manager.name} has no Model (choose a default Model for ${manager.aiProvider} in General Settings)`,
      );
    }
    // Issue text may hold a pasted credential: no prompt may (FR-5).
    const memory = await options.memory?.read(floor);
    const prompt = triagePrompt({
      floor,
      manager,
      issue: {
        number: issue.number,
        title: redactor.redactText(issue.title),
        body: redactor.redactText(issue.body),
      },
      ...(memory === undefined ? {} : { memory }),
      ...(roles.length > 1 ? { roles } : {}),
    });
    const messages: ModelMessage[] = [{ role: "user", content: prompt.user }];
    const ask = () =>
      models.complete({
        agentId: manager.id,
        model,
        system: prompt.system,
        messages,
        maxTokens: maxAnswerTokens,
        issue: issue.number,
      });
    try {
      const first = await ask();
      let parsed = parseTriage(first.text);
      if (!parsed.ok) {
        messages.push(
          { role: "assistant", content: first.text },
          { role: "user", content: triageRetryMessage(parsed.problem) },
        );
        parsed = parseTriage((await ask()).text);
      }
      if (!parsed.ok) {
        return byRules(
          issue,
          `${manager.name} gave no valid triage: ${parsed.problem}`,
        );
      }
      const {
        clear,
        priority,
        reason,
        questions,
        roles: named,
        roleReason,
      } = parsed.value;
      return {
        outcome: clear ? "clear" : "unclear",
        priority,
        reason,
        questions,
        judgedBy: "model",
        ...(named === undefined ? {} : { roles: named }),
        ...(roleReason === undefined ? {} : { roleReason }),
      };
    } catch (error) {
      return byRules(
        issue,
        `${manager.name} could not be asked: ${reasonOf(error)}`,
      );
    }
  };

  /** The lines that log the Manager's triage on the issue (FR-23). */
  const triageLines = (
    manager: AgentRecord,
    judgement: Judgement,
  ): string[] => {
    const by =
      judgement.judgedBy === "model"
        ? `${manager.name} (the Manager) triaged this issue`
        : judgement.judgedBy === "decision_model"
          ? `${manager.name} (the Manager) triaged this issue with the Decision Model`
          : `AI Office's rules triaged this issue${
              judgement.fallback === undefined
                ? ""
                : `, as ${judgement.fallback}`
            }`;
    const lines =
      judgement.outcome === "clear"
        ? [
            "### Triage: clear to work",
            "",
            `${by}: it is clear enough to work, at **${judgement.priority}** priority.`,
            "",
            blockQuote(judgement.reason),
          ]
        : [
            "### Triage: waiting for the Owner",
            "",
            `${by}: it is not clear enough to work yet, so work on it waits.`,
            "",
            blockQuote(judgement.reason),
            "",
            "Before work starts, please answer:",
            "",
            ...judgement.questions.map(
              (question, index) =>
                `${String(index + 1)}. ${question.replaceAll(/\s+/g, " ")}`,
            ),
            "",
            "Edit the issue to answer them, and it is triaged again. To have it worked as it is, choose **Work it as it is** on its Notice in AI Office.",
          ];
    return lines;
  };

  /** The lines that log how the issue's work Role was settled (FR-23). */
  const routingLines = (manager: AgentRecord, routing: Routing): string[] => {
    switch (routing.kind) {
      case "none":
      case "only":
        return [];
      case "planned": {
        const names = routing.roles.map(({ name }) => `**${name}**`);
        return [
          `### Role: ${routing.roles.map(({ name }) => name).join(", then ")}`,
          "",
          names.length === 1
            ? `Its Batch's Plan gives this issue to the ${names[0] ?? ""} Role.`
            : `Its Batch's Plan gives this issue to the ${names.join(", then the ")}: they take turns on its one branch, and review starts after the last.`,
        ];
      }
      case "routed":
        return routing.by === "label"
          ? [`### Role: ${routing.role.name}`, "", routing.reason]
          : [
              `### Role: ${routing.role.name}`,
              "",
              `${manager.name} (the Manager) gave this issue to the **${routing.role.name}** Role.`,
              "",
              blockQuote(routing.reason),
            ];
      case "ask": {
        const [first] = routing.candidates;
        return [
          "### Role: waiting for the Owner",
          "",
          "Which work Role should work this issue is not clear, so work on it waits.",
          "",
          blockQuote(routing.reason),
          "",
          "It could be:",
          "",
          ...routing.candidates.map(({ name, description }) =>
            description === ""
              ? `- **${name}**`
              : `- **${name}**: ${description.replaceAll(/\s+/g, " ")}`,
          ),
          "",
          `Choose one on its Notice in AI Office, or add a \`role:<name>\` label to the issue${
            first === undefined ? "" : `, such as \`${roleLabelName(first)}\``
          }.`,
        ];
      }
    }
  };

  /** A comment of AI Office's triage, from sections of lines. */
  const commentOf = (...sections: readonly string[][]): string =>
    redactor.redactText(
      [
        triageCommentMarker,
        ...sections
          .filter((lines) => lines.length > 0)
          .flatMap((lines, index) => (index === 0 ? lines : ["", ...lines])),
        "",
      ].join("\n"),
    );

  /** Writes a comment; a write GitHub refuses never stops triage. */
  const comment = async (
    floor: Pick<FloorRecord, "repository">,
    issue: number,
    body: string,
  ): Promise<void> => {
    try {
      await github.repository(floor.repository).createComment(issue, body);
    } catch (error) {
      report(error);
    }
  };

  /** Takes an earlier triage's Notice off the board, if it is still open. */
  const closeStale = async (noticeId: string | null | undefined) => {
    if (noticeId == null) {
      return;
    }
    try {
      await notices.dismiss(noticeId);
    } catch (error) {
      // Already dismissed, or acted on: nothing to close.
      if (!(error instanceof NoticeError)) {
        report(error);
      }
    }
  };

  const publish = (
    record: Pick<
      TriageRecord,
      "floorId" | "issue" | "agentId" | "priority" | "judgedBy"
    >,
    outcome: TriageOutcome,
  ): Promise<unknown> =>
    record.agentId === null
      ? Promise.resolve()
      : events.publish({
          type: "issue.triaged",
          version: 1,
          floorId: record.floorId,
          issue: record.issue,
          agentId: record.agentId,
          outcome,
          priority: record.priority,
          judgedBy: record.judgedBy,
        });

  const publishRouted = (
    floorId: string,
    issue: number,
    manager: AgentRecord,
    role: WorkRole,
    routedBy: RouteJudge,
  ): Promise<unknown> =>
    events.publish({
      type: "issue.routed",
      version: 1,
      floorId,
      issue,
      agentId: manager.id,
      role: role.id,
      roleName: role.name,
      routedBy,
    });

  /**
   * Keeps a clear issue's triage with its work Role settled, or asks the
   * Owner to choose one, with an action Notice: then the issue waits. The
   * comment is `before` (the triage's own lines, if any) and the routing's.
   */
  const settle = async (
    floor: FloorRecord,
    issue: Pick<Issue, "number" | "title" | "htmlUrl">,
    manager: AgentRecord,
    base: Omit<TriageRecord, "status" | "noticeId" | "role" | "candidates">,
    routing: Routing,
    before: string[],
  ): Promise<TriageDecision> => {
    const lines = routingLines(manager, routing);
    if (routing.kind === "ask") {
      const notice = await notices.raise({
        kind: "action",
        title:
          `Choose the Role to work #${String(issue.number)} ${issue.title}`.slice(
            0,
            200,
          ),
        floorId: floor.id,
        agentId: manager.id,
        issue: { number: issue.number, url: issue.htmlUrl },
        actions: routing.candidates.map((role, index) => ({
          id: routingActions[index] ?? routingActions[0],
          label: `Give it to the ${role.name}`.slice(0, 60),
        })),
      });
      await store.put({
        ...base,
        status: "routing",
        noticeId: notice.id,
        role: null,
        candidates: routing.candidates.map(({ id }) => id),
      });
      await comment(floor, issue.number, commentOf(before, lines));
      return { proceed: false };
    }
    await store.put({
      ...base,
      status: "clear",
      noticeId: null,
      role: routing.kind === "none" ? null : routing.role.id,
      candidates: [],
    });
    if (routing.kind === "routed" || routing.kind === "planned") {
      await publishRouted(
        floor.id,
        issue.number,
        manager,
        routing.role,
        routing.kind === "planned" ? "plan" : routing.by,
      );
    }
    if (before.length > 0 || lines.length > 0) {
      await comment(floor, issue.number, commentOf(before, lines));
    }
    return { proceed: true, priority: base.priority };
  };

  /**
   * Settles the work Role of an issue triaged clear before, whose text has
   * not changed: it has none yet (the Owner had it worked as it is), or
   * the Owner is asked for one. A `role:<name>` label, or a team with one
   * work Role left, settles it; otherwise it waits on the Notice there is.
   */
  const routeAgain = async (
    floor: FloorRecord,
    issue: Issue,
    previous: TriageRecord,
  ): Promise<TriageDecision> => {
    const workRoles = await choosableRolesOf(floor);
    const routing = routingOf(
      workRoles,
      rolesLabelled(issue.labels, workRoles),
      undefined,
    );
    if (previous.status === "routing" && routing.kind === "ask") {
      return { proceed: false };
    }
    await closeStale(previous.noticeId);
    return settle(floor, issue, await managerOf(floor), previous, routing, []);
  };

  /** The Owner chooses the issue's work Role on its Notice. */
  const chooseRole =
    (index: number) =>
    async (notice: NoticeRecord): Promise<void> => {
      const number = notice.issue?.number;
      if (notice.floorId === null || number === undefined) {
        throw new Error("That Notice names no issue.");
      }
      const record = await store.get(notice.floorId, number);
      if (record?.status !== "routing" || record.noticeId !== notice.id) {
        return;
      }
      const roleId = record.candidates[index];
      if (roleId === undefined) {
        throw new Error("That Notice offers no such Role.");
      }
      const floor = await options.floors.get(notice.floorId);
      if (floor === undefined) {
        throw new Error("That Notice's Floor is gone.");
      }
      const library = (await options.roles?.list()) ?? builtInRoles;
      const role = library.find(({ id }) => id === roleId) ?? {
        id: roleId,
        name: roleId,
        description: "",
      };
      const manager = await managerOf(floor);
      await store.put({
        ...record,
        status: "clear",
        noticeId: null,
        role: role.id,
        candidates: [],
      });
      await publishRouted(floor.id, number, manager, role, "owner");
      await comment(
        floor,
        number,
        commentOf([
          `### Role: ${role.name}`,
          "",
          `The Owner chose the **${role.name}** Role for this issue, on its Notice in AI Office.`,
        ]),
      );
    };

  /** The Owner has the issue worked as it is: picked up at the next check. */
  const workAsItIs = async (notice: NoticeRecord): Promise<void> => {
    const number = notice.issue?.number;
    if (notice.floorId === null || number === undefined) {
      throw new Error("That Notice names no issue.");
    }
    const record = await store.get(notice.floorId, number);
    if (record?.status !== "waiting") {
      return;
    }
    const cleared: TriageRecord = {
      ...record,
      status: "clear",
      judgedBy: "owner",
      noticeId: null,
      triagedAt: now(),
    };
    await store.put(cleared);
    await publish(cleared, "clear");
    const floor = await options.floors.get(notice.floorId);
    if (floor !== undefined) {
      await comment(
        floor,
        number,
        [
          triageCommentMarker,
          "### Triage: worked as it is",
          "",
          `The Owner chose to have this issue worked as it is, at **${cleared.priority}** priority. It is picked up at AI Office's next intake check.`,
          "",
        ].join("\n"),
      );
    }
  };

  const unregister = [
    notices.registerAction(triageActions.workAsItIs, workAsItIs),
    ...routingActions.map((action, index) =>
      notices.registerAction(action, chooseRole(index)),
    ),
  ];

  return {
    async check(floor, issue, given = {}) {
      const fingerprint = issueFingerprint(issue);
      const previous = await store.get(floor.id, issue.number);
      const planned =
        given.planned === undefined || given.planned.length === 0
          ? undefined
          : plannedRouting(await workRolesOf(floor), given.planned);
      if (previous?.fingerprint === fingerprint) {
        if (previous.status === "waiting") {
          return { proceed: false };
        }
        if (planned !== undefined) {
          // The Plan settles a Role chosen or asked for before.
          if (
            previous.status === "clear" &&
            previous.role === planned.role.id
          ) {
            return { proceed: true, priority: previous.priority };
          }
          await closeStale(previous.noticeId);
          return settle(
            floor,
            issue,
            await managerOf(floor),
            previous,
            planned,
            [],
          );
        }
        return previous.status === "clear" && previous.role !== null
          ? { proceed: true, priority: previous.priority }
          : routeAgain(floor, issue, previous);
      }
      const manager = await managerOf(floor);
      const workRoles = await choosableRolesOf(floor);
      const labelled = rolesLabelled(issue.labels, workRoles);
      // The Model chooses the Role only when neither the Plan nor a label
      // gives one.
      const judgement = await judge(
        floor,
        manager,
        issue,
        planned === undefined && labelled.length === 0 ? workRoles : [],
      );
      const base = {
        floorId: floor.id,
        issue: issue.number,
        priority: judgement.priority,
        judgedBy: judgement.judgedBy,
        agentId: manager.id,
        fingerprint,
        triagedAt: now(),
      };
      // The text changed since the Owner was asked: that Notice is stale.
      await closeStale(previous?.noticeId);
      if (judgement.outcome === "clear") {
        await publish(base, "clear");
        return settle(
          floor,
          issue,
          manager,
          base,
          planned ?? routingOf(workRoles, labelled, judgement),
          triageLines(manager, judgement),
        );
      }
      const notice = await notices.raise({
        kind: "action",
        title:
          `Unclear issue needs your input: #${String(issue.number)} ${issue.title}`.slice(
            0,
            200,
          ),
        floorId: floor.id,
        agentId: manager.id,
        issue: { number: issue.number, url: issue.htmlUrl },
        actions: [{ id: triageActions.workAsItIs, label: "Work it as it is" }],
      });
      const record: TriageRecord = {
        ...base,
        status: "waiting",
        noticeId: notice.id,
        role: null,
        candidates: [],
      };
      await store.put(record);
      await publish(record, "unclear");
      await comment(
        floor,
        issue.number,
        commentOf(triageLines(manager, judgement)),
      );
      return { proceed: false };
    },

    async priority(floorId, issue) {
      return (
        (await store.get(floorId, issue))?.priority ?? defaultIssuePriority
      );
    },

    async role(floorId, issue) {
      return (await store.get(floorId, issue))?.role ?? null;
    },

    workRoles: workRolesOf,

    stop() {
      for (const remove of unregister) {
        remove();
      }
    },
  };
}
