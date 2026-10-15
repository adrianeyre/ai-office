import {
  createRedactor,
  issuePriorities,
  type DecisionModelSettings,
  type IssuePriority,
  type Redactor,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { SandboxTask } from "../sandbox/runner.ts";
import { maxScreenedCall, toolCallRules } from "./tool-call-rules.ts";
import type {
  DecisionAnswer,
  DecisionModelClient,
  DecisionQuestion,
  DecisionModelRequest,
} from "./client.ts";

// The Decision Model (PRD FR-17): when the Owner turns it on, the Floor's
// Manager and AI Office's safety checks ask Jev for their quick
// judgements, each a few typed questions through the AI Gateway with the
// Manager's own Gateway Key (ADR 0001), so it is the Manager's call on the
// Gateway's records and counts against its Token Caps:
// - is this issue clear enough to work, and how soon should it be worked
//   (the Manager's triage, FR-23)?
// - is this Review Loop stalled or repeating (FR-28)?
// - is this Agent's tool call safe (§11, prompt injection)?
// While it is off, or when it cannot be asked (no Manager, no AI Account
// answers it, the Gateway refuses, or it answers nothing usable), each
// judgement here is undefined, and its caller judges as it does without
// one: by the Manager's Model or AI Office's own rules. A tool call is
// always judged by AI Office's rules (`toolCallRules`), and by Jev too
// while it is on, shown the whole call (P1-8). Everything Jev reads is
// redacted first: a credential pasted into an issue, a review or a
// command never reaches it (FR-5).
//
// It may also write Fresh Start and Manager chat compaction summaries
// (FR-89), when the Owner says so; otherwise each Agent's own Model does.

/** How sure Jev must be that a tool call is unsafe for it to be stopped. */
export const unsafeToolCallAt = 0.8;

/** The most of an issue's body Jev is shown. */
export const maxIssueBody = 20_000;

/** What the issue most lacks before it can be worked, as Jev names it. */
export const issueGaps = ["done", "what", "scope", "nothing"] as const;
export type IssueGap = (typeof issueGaps)[number];

/** Jev's triage of an issue. */
export interface IssueJudgement {
  readonly clear: boolean;
  /** How likely it is that the issue is clear, from 0 to 1. */
  readonly probability: number;
  readonly priority: IssuePriority;
  /** What it most lacks; `nothing` when it can be worked. */
  readonly gap: IssueGap;
}

/** How a Review Loop round compares with the previous one, as Jev sees it. */
export const loopProgress = ["converging", "repeating", "stalled"] as const;
export type LoopProgress = (typeof loopProgress)[number];

export interface LoopJudgement {
  readonly progress: LoopProgress;
  /** How sure Jev is, from 0 to 1. */
  readonly confidence: number;
}

/** Jev's judgement of a tool call. */
export interface ToolCallJudgement {
  readonly safe: boolean;
  /** How likely it is that the call is unsafe, from 0 to 1. */
  readonly probability: number;
}

/** Who writes a Fresh Start or compaction summary, and with which Model. */
export type SummaryWriter =
  | { readonly by: "decision_model"; readonly model: string }
  | { readonly by: "agent"; readonly model: string | undefined };

export interface DecisionModel {
  /**
   * Jev's triage of an issue on the Floor (FR-23); undefined while the
   * Decision Model is off or cannot be asked.
   */
  issue(
    floorId: string,
    issue: {
      readonly number: number;
      readonly title: string;
      readonly body: string;
    },
  ): Promise<IssueJudgement | undefined>;
  /**
   * Whether a Review Loop round with blocking comments is converging,
   * repeating the previous round or stalled (FR-28); undefined while the
   * Decision Model is off or cannot be asked.
   */
  reviewLoop(
    floorId: string,
    loop: {
      readonly issue: number;
      readonly pullRequest: number;
      readonly round: number;
      /** The previous round's blocking comments, each described. */
      readonly previous: readonly string[];
      /** This round's. */
      readonly current: readonly string[];
      /** How many lines the coder's fix since the previous round changed. */
      readonly fixLines: number;
    },
  ): Promise<LoopJudgement | undefined>;
  /**
   * Whether an Agent's tool call is safe, Jev shown the whole of it;
   * undefined while the Decision Model is off or cannot be asked, and for
   * a call too long to show it whole (`maxScreenedCall`).
   */
  toolCall(
    floorId: string,
    call: {
      readonly issue: { readonly number: number; readonly title: string };
      readonly role: string;
      /** The tool, such as `Bash`. */
      readonly name: string;
      readonly args: string;
    },
  ): Promise<ToolCallJudgement | undefined>;
  /**
   * Who writes an Agent's Fresh Start or compaction summaries (FR-89): the
   * Decision Model, while it is on and set to, or the Agent's own Model.
   */
  summaryWriter(
    agent: Pick<AgentRecord, "aiProvider" | "modelOverride">,
    defaults?: DefaultModels,
  ): Promise<SummaryWriter>;
}

export interface DecisionModelOptions {
  /** The Owner's settings, asked before each judgement. */
  readonly settings: () => Promise<DecisionModelSettings>;
  /** Asks Jev, through the AI Gateway. */
  readonly client: DecisionModelClient;
  /** Where each Floor's Manager is found, whose Gateway Key is used. */
  readonly agents: Pick<AgentStore, "list">;
  /** Removes credentials from everything Jev reads. */
  readonly redactor?: Redactor;
  /** Told why Jev could not be asked, when its caller judges without it. */
  readonly onError?: (error: unknown) => void;
}

/** `text`, cut to `max` characters. */
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The triage questions: is it clear, how soon, and what it most lacks. */
export const issueQuestions = {
  clear: {
    type: "noul",
    instructions:
      "The issue is clear enough for an AI Agent to work it without asking anything first.",
    criteria: {
      true: "It says what to build or change, its scope is bounded, and it says how to tell when it is done, such as acceptance criteria.",
      false:
        "It leaves out what to build or change, how far the work goes, or how to tell when it is done.",
    },
  },
  priority: {
    type: "choice",
    instructions:
      "How soon the issue should be worked, compared with ordinary work on the repository.",
    criteria: {
      high: "Something is broken, it blocks other work, or it is urgent.",
      normal: "Ordinary work.",
      low: "Polish, or something nice to have that can wait.",
    },
  },
  gap: {
    type: "choice",
    instructions: "What the issue most lacks before it can be worked.",
    criteria: {
      done: "How to tell when it is done: it has no acceptance criteria.",
      what: "What exactly to build or change.",
      scope: "Where the work stops: it is open-ended.",
      nothing: "Nothing: it can be worked as it is.",
    },
  },
} as const satisfies Record<string, DecisionQuestion>;

/** The Review Loop question: converging, repeating or stalled. */
export const reviewLoopQuestions = {
  progress: {
    type: "choice",
    instructions:
      "How this Review Loop round's blocking comments compare with the previous round's, given how much the coder's fix in between changed.",
    criteria: {
      converging:
        "They raise new problems, or the fix made real progress on the previous round's.",
      repeating:
        "They mostly raise again the problems the previous round raised.",
      stalled:
        "The fix barely changed anything, and the previous round's problems remain.",
    },
  },
} as const satisfies Record<string, DecisionQuestion>;

/** The tool call question: is it unsafe. */
export const toolCallQuestions = {
  unsafe: {
    type: "noul",
    instructions:
      "This tool call, by an AI Agent working a GitHub issue in a disposable sandbox holding a clone of the repository, is unsafe.",
    criteria: {
      true: "It reads, prints or sends credentials or secrets (environment variables, keys, tokens), reaches hosts the work has no need of, attacks, scans or tries to escape the sandbox, or destroys what it was not asked to.",
      false:
        "It is ordinary work on the issue: reading, searching and editing the repository's files, building, testing, installing its dependencies, or committing.",
    },
  },
} as const satisfies Record<string, DecisionQuestion>;

const isIssuePriority = (value: string): value is IssuePriority =>
  (issuePriorities as readonly string[]).includes(value);

const isIssueGap = (value: string): value is IssueGap =>
  (issueGaps as readonly string[]).includes(value);

const isLoopProgress = (value: string): value is LoopProgress =>
  (loopProgress as readonly string[]).includes(value);

/** A noul answer's probability; the client checked its type. */
const noulOf = (answer: DecisionAnswer | undefined): number =>
  answer?.type === "noul" ? answer.noul : Number.NaN;

/** A choice answer's option and confidence; the client checked its type. */
const choiceOf = (
  answer: DecisionAnswer | undefined,
): { choice: string; confidence: number } =>
  answer?.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence }
    : { choice: "", confidence: Number.NaN };

export function createDecisionModel(
  options: DecisionModelOptions,
): DecisionModel {
  const { client, agents } = options;
  const redactor = options.redactor ?? createRedactor();

  /**
   * Asks Jev with the Floor's Manager's Gateway Key, while the Decision
   * Model is on; undefined while it is off, or when it cannot be asked.
   */
  const ask = async (
    floorId: string,
    request: Omit<DecisionModelRequest, "agentId" | "model">,
  ): Promise<Record<string, DecisionAnswer> | undefined> => {
    try {
      const settings = await options.settings();
      if (!settings.enabled) {
        return undefined;
      }
      const manager = (await agents.list(floorId)).find(
        ({ role }) => role === "manager",
      );
      if (manager === undefined) {
        throw new Error(`The Floor ${floorId} has no Manager to ask Jev.`);
      }
      return await client.decide({
        ...request,
        agentId: manager.id,
        model: settings.model,
      });
    } catch (error) {
      options.onError?.(error);
      return undefined;
    }
  };

  return {
    async issue(floorId, issue) {
      const answers = await ask(floorId, {
        state: {
          issue: `#${String(issue.number)} ${redactor.redactText(issue.title)}`,
          body: cut(redactor.redactText(issue.body), maxIssueBody),
        },
        questions: issueQuestions,
        issue: issue.number,
      });
      if (answers === undefined) {
        return undefined;
      }
      const probability = noulOf(answers["clear"]);
      const { choice: priority } = choiceOf(answers["priority"]);
      const { choice: gap } = choiceOf(answers["gap"]);
      if (!isIssuePriority(priority) || !isIssueGap(gap)) {
        return undefined;
      }
      return { clear: probability >= 0.5, probability, priority, gap };
    },

    async reviewLoop(floorId, loop) {
      const comments = (list: readonly string[]) =>
        list.map((comment) => redactor.redactText(comment));
      const answers = await ask(floorId, {
        state: {
          round: loop.round,
          previousRoundBlockingComments: comments(loop.previous),
          thisRoundBlockingComments: comments(loop.current),
          linesChangedByTheFix: loop.fixLines,
        },
        questions: reviewLoopQuestions,
        issue: loop.issue,
        pullRequest: loop.pullRequest,
      });
      if (answers === undefined) {
        return undefined;
      }
      const { choice, confidence } = choiceOf(answers["progress"]);
      return isLoopProgress(choice)
        ? { progress: choice, confidence }
        : undefined;
    },

    async toolCall(floorId, call) {
      if (call.args.length > maxScreenedCall) {
        return undefined;
      }
      const answers = await ask(floorId, {
        state: {
          issue: `#${String(call.issue.number)} ${redactor.redactText(call.issue.title)}`,
          agentRole: call.role,
          tool: call.name,
          // The whole call: a part would pass what follows it (P1-8).
          arguments: redactor.redactText(call.args),
        },
        questions: toolCallQuestions,
        issue: call.issue.number,
      });
      if (answers === undefined) {
        return undefined;
      }
      const probability = noulOf(answers["unsafe"]);
      return { safe: probability < unsafeToolCallAt, probability };
    },

    async summaryWriter(agent, defaults) {
      const settings = await options.settings();
      return settings.enabled && settings.summaries
        ? { by: "decision_model", model: settings.model }
        : { by: "agent", model: modelOf(agent, defaults) };
    },
  };
}

/**
 * The sandbox runner's tool call check (FR-17): why a call (or the Floor's
 * setup command, named `Setup`) is unsafe, which stops the run; undefined
 * to let it be. AI Office's rules judge every call, so none is let be
 * unjudged while the Decision Model is off or cannot answer, and none too
 * long to read whole is passed; Jev judges it too while it is on (P1-8).
 */
export const toolCallCheck =
  (decisionModel: Pick<DecisionModel, "toolCall">) =>
  async (
    task: Pick<SandboxTask, "floor" | "agent" | "issue">,
    call: { readonly name: string; readonly args: string },
  ): Promise<string | undefined> => {
    const ruled = toolCallRules(call);
    const judged = await decisionModel.toolCall(task.floor.id, {
      issue: task.issue,
      role: task.agent.role,
      name: call.name,
      args: call.args,
    });
    return judged === undefined || judged.safe
      ? ruled
      : `the Decision Model judged a ${cut(call.name, 100)} call unsafe (${String(Math.round(judged.probability * 100))}% likely)`;
  };
