import {
  contextUsagePercent,
  createRedactor,
  draftGrillingIssuesText,
  endGrillingText,
  floorErrorCodes,
  grillingErrorCodes,
  grillingSkillName,
  grillingSourcePaths,
  grillingWritesDocuments,
  isGrillingSkillName,
  isSandboxRole,
  issueDraftsProblem,
  managerChatErrorCodes,
  maxChatToolUses,
  maxGrillingSourceLength,
  maxGrillingTopicLength,
  mentionedFiles,
  readGrillingAnswers,
  readChatControl,
  readGrillingControl,
  readSkillCommand,
  skillAnnouncement,
  toTicketsSkillName,
  type ChatAttachment,
  type FloorSkillSource,
  type GrillingControl,
  type GrillingErrorCode,
  type GrillingIssueDraftEdit,
  type GrillingIssuesTurn,
  type GrillingMessageRef,
  type GrillingSkillName,
  type GrillingSource,
  type GrillingTurn,
  type ManagerChatCompaction,
  type ManagerChatErrorCode,
  type ManagerCommand,
  type ManagerCommandKind,
  type ManagerChatToolUse,
  type Redactor,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { ContextUsage, ContextUsageState } from "../context/usage.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import {
  documentsText,
  type GrillingDocumentsWriter,
  type WrittenDocuments,
} from "../grilling/documents.ts";
import type { FactFinder } from "../grilling/fact-finding.ts";
import {
  draftIssues,
  grillingIssuesInstructions,
  issuesDraftedText,
  issuesFiledText,
  parseGrillingIssues,
  type GrillingIssuesFiler,
} from "../grilling/issues.ts";
import {
  confirmationText,
  factsFoundText,
  findingFactsText,
  grillingRetryMessage,
  grillingSessionSection,
  grillingTurnInstructions,
  parseGrillingTurn,
  roundText,
  type FactLookups,
} from "../grilling/prompt.ts";
import {
  applyAnswers,
  applyTurn,
  numbersInWords,
  openInRound,
  recordFacts,
  type FoundFact,
  type GrillingSessionRecord,
} from "../grilling/session.ts";
import { grillingSkillInstructions } from "../grilling/skill.ts";
import type { GrillingStore } from "../grilling/store.ts";
import type { RepositoryMemory } from "../memory/memory.ts";
import type {
  ModelClient,
  ModelMessage,
  ModelReply,
} from "../models/client.ts";
import {
  grillingSkillInstructionsOf,
  sessionSkillInstructions,
} from "../skills/built-in.ts";
import type { ManagerChatSessions } from "./chat-sessions.ts";
import { editDistance, readManagerCommand } from "./commands.ts";
import { compactionPrompt, maxSummaryTokens } from "./compaction.ts";
import {
  ChatAttachmentsTakenError,
  type ChatAttachmentStore,
} from "./attachments.ts";
import { sessionImagePath } from "../models/agent-tool-session.ts";
import { chatTurn, withChatTurn, type ChatTurn } from "./chat-turn.ts";
import type { ChatRepositoryFiles } from "./repository-files.ts";
import {
  parseChatRequest,
  readRequestStart,
  requestRetryMessage,
  requestsSection,
  type ChatRequests,
  type CheckedRequest,
} from "./requests.ts";
import {
  conversation,
  managerSystemPrompt,
  readSkillChoice,
  type PromptSkill,
} from "./prompt.ts";
import type {
  ChatMessageRecord,
  ConversationStart,
  LoadedSkill,
  ManagerChatStore,
  NewChatMessage,
} from "./store.ts";

// The Manager chat (PRD FR-24): the Owner talks with a Floor's Manager,
// and the conversation is kept per Floor. Each message is read by plain
// code first (`readManagerCommand`): a command is answered at once with
// what it was understood as, and one that cannot be read (a typo, a range
// that runs backwards) with a hint; neither reaches a model. Anything else
// goes to the Manager's Model through the AI Gateway, with the Manager's
// own Gateway Key, so it is attributed to the Manager and counted against
// its Token Caps (FR-33, FR-42). Its reply is told to listeners a piece
// at a time as it is written, and kept once it is finished. A Floor's
// Manager answers one message at a time. "status" is answered with the
// Manager's status report (FR-23), which `report` writes in plain code;
// the daily report is posted with `postReport`, answering nothing.
// "complete issues 1 to 5" hands the Manager a Batch (FR-25), whose Plan
// `carryOut` drafts, answering with the Plan; "skip 4" and "move 5 up"
// change the Batch holding the issue, answering with its new version.
// "/skill-name [arguments]" runs one of the Floor's Skills (FR-74): its
// instructions are loaded into the Manager's prompt for the rest of the
// conversation, and the Model answers. The Manager may also choose one of
// the Floor's Skills itself, when a request matches its description, by
// starting its reply `[use skill: name]`: AI Office then loads that Skill,
// asks again, and the reply starts by saying which Skill it used.
// "/grilling [topic]", the built-in Skill, starts a Grilling Session (FR-77,
// FR-78, FR-82): the Manager's Model asks rounds of numbered questions
// with recommended answers, which AI Office keeps as structured data
// (`GrillingStore`) and asks once their prerequisites are settled. The
// Owner's answers ("3: Postgres", "3: recommended", "recommended to all")
// are read in plain code; once a round is answered the Model writes the
// next, and when no open questions remain the Owner confirms to end it.
// "pause the session" and "resume the session" pause and resume it, with
// its full history kept. The Manager finds facts itself rather than asking
// the Owner (FR-79): a turn may name facts to find in the Floor's
// repository, each by the Manager or an Agent it sends, which AI Office
// has found in read-only sandboxes (`FactFinder`) and keeps with the
// session; the Model then writes its turn again knowing them. As
// decisions settle, the Floor's documents are kept current on the
// session's branch (FR-80): each turn kept writes its PRD outline, ADRs,
// glossary terms and process docs there at once (`GrillingDocumentsWriter`),
// and "confirm" ends the session only once the one pull request with all
// of them is open. The Manager's Model then drafts the issues that build
// it (FR-81), kept with the session for the Owner to edit, reorder, merge
// and drop (`saveGrillingIssues`); "draft the issues of session 3" drafts
// them again, and "file the issues of session 3" approves them, and the
// GitHub App files them in order (`GrillingIssuesFiler`).
// "/grill-with-docs", "/wayfinder", "/to-tickets" and "/to-spec", built-in
// Skills adapted from Matt Pocock's (FR-83b), start a Grilling Session too,
// which keeps the Skill that started it and loads its instructions beside
// `/grilling`'s. "/to-tickets" reads the PRDs and ADRs it names from the
// repository into the session, writes no documents, and on "confirm" ends
// and has the issues drafted at once, with no pull request to open.
// "/clear" wipes the conversation the Model is given, and "/compact"
// replaces its older history with a summary the Manager's Model writes
// (FR-87); the chat also compacts itself before a reply once the
// Manager's Context Usage in it reaches its threshold (its Fresh Start
// threshold, 85% by default). Nothing stored apart from the conversation
// is touched: decisions, Plans, Batches, and a Grilling Session's data,
// which is put back into every prompt word for word (FR-88). Each
// conversation's calls name their own session, so its Context Usage
// starts afresh after a clear or a compaction.
//
// The Manager is the chat's orchestrator, as a coding assistant spins work
// off to sub-agents (ADR 0004). With the Floor's "Manager spins off work
// from chat" on, its Model decides for each plain message: a question, a
// status request or a discussion gets an ordinary reply; a request too
// unclear to act on, one clarifying question; research, a read-only
// Contractor whose findings the Model is then asked again with; and a
// request to change the repository, a Batch (`ChatRequests`): the
// Manager says its Plan, files the issues, adds the Contractors and starts
// it at once, the request standing as the Plan's approval. A decision is
// one JSON object in a fenced block, held back from listeners while it is
// written, and asked for once more if it cannot be acted on. As the Batch
// goes on, the Manager reports back in the chat (`postProgress`).

/** Why the chat refused a message; `code` is one of `managerChatErrorCodes`. */
export class ManagerChatError extends Error {
  readonly code: ManagerChatErrorCode;

  constructor(code: ManagerChatErrorCode, message: string) {
    super(message);
    this.name = "ManagerChatError";
    this.code = code;
  }
}

/** Why a Grilling Session could not be read; `code` is one of `grillingErrorCodes`. */
export class GrillingError extends Error {
  readonly code: GrillingErrorCode;

  constructor(code: GrillingErrorCode, message: string) {
    super(message);
    this.name = "GrillingError";
    this.code = code;
  }
}

/** What happens in a Floor's chat, as it happens. */
export type ManagerChatUpdate =
  /** A message was kept. */
  | { readonly type: "message"; readonly message: ChatMessageRecord }
  /** More of a reply the Manager's Model is writing. */
  | { readonly type: "delta"; readonly replyTo: number; readonly text: string }
  /** The chat's task list changed (FR-24): clients fetch it again. */
  | { readonly type: "tasks" }
  /** A tool the Manager's session used for the reply it is writing. */
  | {
      readonly type: "tool";
      readonly replyTo: number;
      readonly tool: ManagerChatToolUse;
    };

/** One of a Floor's Skills, as the chat runs it. */
export interface ChatSkill {
  readonly name: string;
  readonly description: string;
  readonly source: FloorSkillSource;
  /** Its `SKILL.md`'s instructions, below the frontmatter. */
  readonly instructions: string;
}

/** A Floor's Skills, and why the repository's could not be read. */
export interface ChatSkills {
  readonly skills: readonly ChatSkill[];
  readonly repositoryError: string | null;
}

/** A reply the Manager's Model is still writing: the text so far. */
export interface PendingReply {
  readonly replyTo: number;
  readonly text: string;
}

export interface ManagerChatHistory {
  readonly manager: AgentRecord;
  /** The Model the Manager answers with, if its AI Provider has one. */
  readonly model: string | undefined;
  /** The latest messages, oldest first. */
  readonly messages: ChatMessageRecord[];
  readonly pending: PendingReply[];
}

/** A Floor's Manager at work: what it answers, how, and since when. */
export interface ManagerWorking {
  readonly floorId: string;
  /** The Owner's message it answers. */
  readonly replyTo: number;
  readonly phase: "writing" | "acting" | "busy";
  readonly since: Date;
}

export interface ManagerChat {
  /** The Floor's Manager, its latest messages, and a reply being written. */
  history(floorId: string, limit?: number): Promise<ManagerChatHistory>;
  /** The Floor's messages after `id`, oldest first. */
  after(floorId: string, id: number): Promise<ChatMessageRecord[]>;
  /**
   * Sends the Owner's message. A command (or a refused one) is answered at
   * once (`reply`); otherwise `reply` is undefined, and the Manager's
   * Model's reply is told to listeners as it is written.
   */
  send(
    floorId: string,
    text: string,
    /**
     * Attachments uploaded first, by id, sent with it (FR-24); refused with
     * `attachment_not_found` unless each is this Floor's and unsent.
     */
    attachments?: readonly string[],
  ): Promise<{
    readonly message: ChatMessageRecord;
    readonly reply: ChatMessageRecord | undefined;
  }>;
  /**
   * Listens to a Floor's chat. Answers the reply being written now, if
   * any, so a new listener can start from its text so far.
   */
  subscribe(
    floorId: string,
    listener: (update: ManagerChatUpdate) => void,
  ): { readonly pending: PendingReply[]; unsubscribe(): void };
  /**
   * What each Floor's Manager is doing now, if anything: writing a reply,
   * carrying out a request, or otherwise busy (a compaction, a report).
   */
  working(): ManagerWorking[];
  /**
   * Ends what the Manager of a Floor removed is doing: the reply it is
   * writing, or the request it is carrying out (research, fact-finding, a
   * Grilling Session's turn), keeping why. Resolves once it has ended.
   */
  end(floorId: string): Promise<void>;
  /**
   * Keeps one of the Manager's status reports in the Floor's chat, and
   * tells listeners: in answer to the Owner's message `replyTo`, or, with
   * none, of its own accord (the daily report).
   */
  postReport(
    floorId: string,
    text: string,
    replyTo?: number,
  ): Promise<ChatMessageRecord>;
  /**
   * Keeps the Manager's report on one of the Owner's chat requests (ADR
   * 0004), in answer to its message `replyTo`, and tells listeners: an
   * issue done or blocked, a Contractor arriving or leaving, a Wrap-up.
   */
  postProgress(
    floorId: string,
    text: string,
    replyTo: number,
  ): Promise<ChatMessageRecord>;
  /** The Floor's Grilling Sessions, newest first (FR-82). */
  grillingSessions(floorId: string): Promise<GrillingSessionRecord[]>;
  /**
   * One of the Floor's Grilling Sessions in full, with every chat message
   * it holds; `grilling_session_not_found` if there is none.
   */
  grillingSession(
    floorId: string,
    sessionId: number,
  ): Promise<{
    readonly session: GrillingSessionRecord;
    readonly messages: ChatMessageRecord[];
  }>;
  /**
   * Keeps the Owner's edits to an ended session's draft issues (FR-81):
   * the drafts in their order, edited, merged or dropped. Refused once one
   * is filed (`grilling_issues_not_editable`), for drafts that cannot be
   * filed as they are (`grilling_issues_invalid`), and while the Manager
   * answers (`reply_in_progress`).
   */
  saveGrillingIssues(
    floorId: string,
    sessionId: number,
    drafts: readonly GrillingIssueDraftEdit[],
  ): Promise<GrillingSessionRecord>;
  /**
   * Tells the Floor's listeners its chat's task list changed (FR-24), so
   * clients fetch it again.
   */
  tasksChanged(floorId: string): void;
  /** Stops the replies being written, keeping why, and waits for them. */
  stop(): Promise<void>;
}

/**
 * What a Floor's Manager is doing in answer to a message (FR-24): `writing`
 * its Model's reply, which a new message interrupts; `acting`, carrying out
 * a request (filing issues, starting a Batch, research), which a new
 * message waits for; or `busy` with any other answer (a Grilling Session's
 * turn, a compaction), which it waits for too.
 */
interface Answering {
  readonly replyTo: number;
  /** The reply so far, as listeners were told it. */
  text: string;
  readonly controller: AbortController;
  phase: "writing" | "acting" | "busy";
  /** When the Manager started on it. */
  readonly since: Date;
  /** Whether the Owner's next message interrupted it. */
  interrupted: boolean;
  /** Settles once the answer is kept and the Floor let go. */
  done: Promise<void>;
}

export interface ManagerChatOptions {
  readonly store: ManagerChatStore;
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** Makes the Manager's model calls, through the AI Gateway. */
  readonly models: ModelClient;
  /** Each AI Provider's default Model, for a Manager without its own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /**
   * Carries out a command, answering what it did in words: "complete
   * issues 1 to 5" hands the Manager a Batch (FR-25). Undefined for a
   * command it cannot carry out yet (pausing a Floor, say), and without
   * it: then the chat says that nothing changed. If it fails, the answer
   * is an `error` saying why.
   */
  readonly carryOut?: (
    floorId: string,
    command: ManagerCommand,
  ) => Promise<string | undefined>;
  /**
   * Writes the Floor's status report in answer to the Owner's message
   * `replyTo` (with `postReport`), and returns it as kept. Without it,
   * "status" is answered that no report can be written.
   */
  readonly report?: (
    floorId: string,
    replyTo: number,
  ) => Promise<ChatMessageRecord>;
  /** The repository's memory, which the Manager reads for each reply (FR-53). */
  readonly memory?: Pick<RepositoryMemory, "read">;
  /**
   * The Floor's Skills (FR-74): what `/name` runs, and what the Manager
   * may choose. Without it, the Floor has none.
   */
  readonly skills?: (floorId: string) => Promise<ChatSkills>;
  /**
   * Where Grilling Sessions are kept (FR-77). Without it, `/grilling`
   * loads the built-in Skill's instructions like any other Skill.
   */
  readonly grilling?: GrillingStore;
  /**
   * Finds the facts a Grilling Session's Manager asks for in the Floor's
   * repository, in read-only sandboxes (FR-79). Without it, the Manager
   * is not offered to look facts up.
   */
  readonly facts?: FactFinder;
  /**
   * Keeps a Grilling Session's documents on its branch, and opens their
   * pull request when it ends (FR-80). Without it, they are kept with the
   * session only.
   */
  readonly documents?: GrillingDocumentsWriter;
  /**
   * Files a Grilling Session's issues once the Owner approves them
   * (FR-81). Without it, no issues are drafted when a session ends.
   */
  readonly issues?: GrillingIssuesFiler;
  /**
   * The Agents' Context Usage (FR-84): the chat compacts itself at the
   * Manager's threshold, and ends a conversation's session when it is
   * cleared or compacted.
   */
  readonly contextUsage?: Pick<ContextUsage, "subscribe" | "endSession">;
  /**
   * The Owner's requests (FR-24, ADR 0004): with it, and the Floor's "Manager
   * spins off work from chat" on, the Manager's Model decides for each
   * plain message whether to answer, ask one clarifying question, send
   * research, or file a Batch, which it carries out at once. Without it,
   * the Manager only talks and takes typed commands.
   */
  readonly requests?: ChatRequests;
  /**
   * The files and images the Owner attaches (FR-24): bound to the message
   * that sends them, and given to the Model with it. Without it, a message
   * with attachments is refused.
   */
  readonly attachments?: ChatAttachmentStore;
  /**
   * Reads the repository files a message mentions with `@path` (FR-24),
   * given to the Model with it; without it, mentions are plain text.
   */
  readonly files?: Pick<ChatRepositoryFiles, "read">;
  /**
   * The Manager's continuing, read-only agent sessions (FR-24, ADR 0004):
   * with them, a Manager whose AI Provider has an agent tool answers plain
   * messages as turns of its conversation's session, reading the Floor's
   * repository and the web. Grilling turns, issue drafting and compaction
   * summaries are structured one-shots, and stay with `models`; so does a
   * Manager whose AI Provider has no such tool.
   */
  readonly sessions?: ManagerChatSessions;
  /** Removes credentials from what is kept and sent. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** Told of a listener that failed. */
  readonly onError?: (error: unknown) => void;
}

/** How many earlier messages the history (and the Model) is given. */
const historySize = 200;
const conversationSize = 50;

/**
 * How many of the Owner's earlier messages a request is bound to with the
 * one that made it (P2-3), as a request may take a clarifying answer.
 */
const ownerWordsKept = 4;
/** The most tokens one of the Manager's replies may use. */
const maxReplyTokens = 4096;
/** The most tokens one of the Manager's turns in a Grilling Session may use. */
const maxTurnTokens = 8192;
/** The most tokens the Manager's draft issues may use. */
const maxIssuesTokens = 16_384;
/**
 * How many times one turn may have facts found before it must be written
 * with what it knows (FR-79).
 */
const maxFactPasses = 2;
/** The most Skills loaded at once: the latest loaded. */
const maxLoadedSkills = 5;

/** "a, b and c". */
const inWords = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** What `/name` is answered with when the Floor has no Skill of that name. */
function noSuchSkill(name: string, found: ChatSkills): string {
  const names = found.skills.map((skill) => skill.name);
  const near = names
    .map((candidate) => ({
      candidate,
      distance: editDistance(name, candidate),
    }))
    .filter(({ distance }) => distance <= (name.length <= 5 ? 1 : 2))
    .sort((a, b) => a.distance - b.distance)[0]?.candidate;
  return [
    `There is no Skill /${name} on this Floor.`,
    near === undefined ? "" : `Did you mean "/${near}"?`,
    names.length === 0
      ? "It has no Skills yet: add one to the office library in General Settings, or to the repository under .agents/skills/ or .claude/skills/."
      : `Its Skills are ${inWords(names.map((each) => `/${each}`))}.`,
    found.repositoryError ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** Each Skill once, as it was last loaded, the latest `maxLoadedSkills`. */
function latestLoaded(loaded: readonly LoadedSkill[]): PromptSkill[] {
  const byName = new Map<string, LoadedSkill>();
  for (const skill of loaded) {
    byName.delete(skill.name);
    byName.set(skill.name, skill);
  }
  return [...byName.values()]
    .slice(-maxLoadedSkills)
    .map(({ name, source, instructions }) => ({ name, source, instructions }));
}

/** The built-in grilling Skill, loaded while a session runs. */
const grillingLoaded: PromptSkill = {
  name: grillingSkillName,
  source: "built-in",
  instructions: grillingSkillInstructions,
};

/**
 * `loaded`, with the grilling Skill while a session runs, and the built-in
 * Skill that started it (`/wayfinder`, say), each unless loaded already.
 */
const withGrilling = (
  loaded: readonly PromptSkill[],
  session: GrillingSessionRecord | undefined,
): PromptSkill[] => {
  if (session === undefined) {
    return [...loaded];
  }
  const own = grillingSkillInstructionsOf(session.skill);
  return [
    ...loaded,
    ...[
      grillingLoaded,
      ...(own === undefined
        ? []
        : [
            {
              name: session.skill,
              source: "built-in" as const,
              instructions: own,
            },
          ]),
    ].filter(({ name }) => !loaded.some((skill) => skill.name === name)),
  ];
};

/** "the Grilling Session on <topic>". */
const sessionName = (session: Pick<GrillingSessionRecord, "id" | "topic">) =>
  `Grilling Session ${String(session.id)}${session.topic === "" ? "" : ` on ${session.topic}`}`;

/** The session ended at `at`, as the Owner confirmed or ended it (FR-83a). */
const endedSession = (
  session: GrillingSessionRecord,
  at: Date,
): GrillingSessionRecord => ({
  ...session,
  status: "ended",
  awaitingConfirmation: false,
  // A paused session can be ended too: it is paused no longer.
  pausedAt: null,
  endedAt: at,
  updatedAt: at,
});

/** What the chat says of a session that ended. */
function endedText(ended: GrillingSessionRecord): string {
  const terms = ended.terms.length;
  // Open only when the Owner ended it early (FR-83a).
  const open = openInRound(ended).map(({ number }) => number);
  const { pullRequest } = ended.documents ?? {};
  return [
    `Ended the ${sessionName(ended)}: ${String(ended.decisions.length)} ${ended.decisions.length === 1 ? "decision" : "decisions"} settled${terms === 0 ? "" : ` and ${String(terms)} glossary ${terms === 1 ? "term" : "terms"}`}.`,
    ...(open.length === 0
      ? []
      : [
          `${open.length === 1 ? "Question" : "Questions"} ${numbersInWords(open)} of round ${String(ended.round)} ${open.length === 1 ? "was" : "were"} left open.`,
        ]),
    ...(pullRequest == null || ended.documents === null
      ? []
      : [
          `Opened pull request #${String(pullRequest.number)} with its documents (${ended.documents.files.join(", ")}): ${pullRequest.url}`,
        ]),
    "It is kept with its full history in the Grilling Sessions list.",
  ].join(" ");
}

/** Where a session stands, in a sentence. */
function standing(session: GrillingSessionRecord): string {
  const open = openInRound(session).map(({ number }) => number);
  const decisions = `${String(session.decisions.length)} ${session.decisions.length === 1 ? "decision" : "decisions"} settled`;
  if (open.length > 0) {
    return `Round ${String(session.round)} has ${open.length === 1 ? "question" : "questions"} ${numbersInWords(open)} open, and ${decisions}.`;
  }
  if (session.awaitingConfirmation) {
    return `No open questions remain, and ${decisions}: reply "confirm" to end it.`;
  }
  return `${decisions[0]?.toUpperCase() ?? ""}${decisions.slice(1)}; send a message for the next round.`;
}

/** What a message is to a Grilling Session, before it is kept. */
type GrillingRoute =
  /** "/grilling": this session was just started. */
  | { readonly kind: "start"; readonly session: GrillingSessionRecord }
  /** "/grilling" while this session runs. */
  | { readonly kind: "running"; readonly session: GrillingSessionRecord }
  /**
   * "pause the session" and "confirm" (the running session's) or "resume
   * the session" (the paused one named, or the latest).
   */
  | {
      readonly kind: "control";
      readonly control: GrillingControl;
      readonly session: GrillingSessionRecord | undefined;
    }
  /** Anything else, while this session runs. */
  | { readonly kind: "in-session"; readonly session: GrillingSessionRecord };

/**
 * What became of it: the answer kept at once; a turn of the session to
 * write; the session to end (`close`); its issues to draft or file; or
 * `continue`, for a command, or the Model to answer.
 */
type GrillingOutcome =
  | ChatMessageRecord
  | "turn"
  | "close"
  | "draft-issues"
  | "file-issues"
  | "continue";

/**
 * The Floor's Agents the Manager may send to find facts (FR-79): those that
 * work in sandboxes, enabled and staying.
 */
const sendableAgents = (team: readonly AgentRecord[]): AgentRecord[] =>
  team.filter(
    ({ role, enabled, leavingAt }) =>
      isSandboxRole(role) && enabled && leavingAt === null,
  );

/** The Manager, as its commits' `Agent:` trailer names it (FR-69). */
const trailerOf = (manager: AgentRecord, model: string) => ({
  id: manager.id,
  name: manager.name,
  role: manager.role,
  aiProvider: manager.aiProvider,
  model,
});

/** The built-in Skill that starts a session, as `/name` runs it. */
const sessionStarter = (skill: GrillingSkillName): ChatSkill => ({
  name: skill,
  description: "",
  source: "built-in",
  instructions: sessionSkillInstructions(skill),
});

/** What the chat answers to a command until its work exists. */
const notYet: Record<ManagerCommandKind, string> = {
  complete: "Batches are not available here, so nothing was started.",
  skip: "Batches are not available here, so nothing changed.",
  move: "Batches are not available here, so nothing changed.",
  pause: "Pausing a Floor is not available yet, so nothing changed.",
  resume: "Pausing a Floor is not available yet, so nothing changed.",
  report: "Status reports are not available here, so none was written.",
};

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

export function createManagerChat(options: ManagerChatOptions): ManagerChat {
  const { store, models } = options;
  const now = options.now ?? (() => new Date());
  const redactor = options.redactor ?? createRedactor();
  const listeners = new Map<string, Set<(update: ManagerChatUpdate) => void>>();
  /**
   * Floors whose Manager is answering, and the reply so far; null while a
   * message is being taken.
   */
  const busy = new Map<string, Answering | null>();
  const replies = new Set<Promise<void>>();
  let stopped = false;

  /**
   * The session a conversation's model calls name (FR-84): one per
   * conversation, from its latest clear or compaction.
   */
  const sessionOf = (floorId: string, start: ConversationStart): string =>
    `manager-chat:${floorId}:${String(start.marker?.id ?? 0)}`;
  /** Each Manager's Context Usage in its chat's conversation, latest call. */
  const usage = new Map<string, ContextUsageState>();
  const unsubscribe = options.contextUsage?.subscribe((state) => {
    if (state.session?.startsWith("manager-chat:") === true) {
      usage.set(state.agentId, state);
    }
  });
  /** Ends a conversation's session: its Context Usage empties. */
  const endConversation = async (
    floorId: string,
    managerId: string,
    start: ConversationStart,
  ): Promise<void> => {
    usage.delete(managerId);
    await options.contextUsage?.endSession(
      managerId,
      sessionOf(floorId, start),
    );
  };

  const publish = (floorId: string, update: ManagerChatUpdate): void => {
    for (const listener of listeners.get(floorId) ?? []) {
      try {
        listener(update);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  const managerOf = async (
    floor: FloorRecord,
  ): Promise<{ manager: AgentRecord; team: AgentRecord[] }> => {
    const agents = await options.agents.list(floor.id);
    const manager = agents.find(({ role }) => role === "manager");
    if (manager === undefined) {
      throw new ManagerChatError(
        managerChatErrorCodes.managerNotFound,
        `The Floor "${floor.name}" has no Manager.`,
      );
    }
    return { manager, team: agents.filter((agent) => agent !== manager) };
  };

  const noSkills: ChatSkills = { skills: [], repositoryError: null };
  const skillsOf = async (floorId: string): Promise<ChatSkills> =>
    (await options.skills?.(floorId)) ?? noSkills;

  const keep = async (
    message: Omit<NewChatMessage, "createdAt">,
  ): Promise<ChatMessageRecord> => {
    const kept = await store.append({
      ...message,
      text: redactor.redactText(message.text),
      createdAt: now(),
    });
    publish(kept.floorId, { type: "message", message: kept });
    return kept;
  };

  /**
   * Keeps the Owner's message with the attachments it sends (FR-24), bound
   * to it as it is kept: refused if another message sent one first.
   */
  const keepOwner = async (
    message: Omit<NewChatMessage, "createdAt">,
  ): Promise<ChatMessageRecord> => {
    try {
      return await keep(message);
    } catch (error) {
      if (error instanceof ChatAttachmentsTakenError) {
        throw new ManagerChatError(
          managerChatErrorCodes.attachmentNotFound,
          "An attachment was sent already, or is gone: attach it again.",
        );
      }
      throw error;
    }
  };

  /**
   * The Floor's unsent attachments named by id, in order (FR-24); refused
   * unless each is there to send, once.
   */
  const attachmentsOf = async (
    floorId: string,
    ids: readonly string[],
  ): Promise<ChatAttachment[]> => {
    if (ids.length === 0) {
      return [];
    }
    const found =
      options.attachments === undefined
        ? []
        : await options.attachments.unsent(floorId, ids);
    if (found.length !== ids.length || new Set(ids).size !== ids.length) {
      throw new ManagerChatError(
        managerChatErrorCodes.attachmentNotFound,
        "An attachment is not this Floor's, was sent already, or was never sent within a day of uploading: attach it again.",
      );
    }
    return found;
  };

  /**
   * What the Owner's message `asked` gives the Model beyond its words
   * (FR-24): the text files it attached and the repository files it
   * mentions, quoted, and its images.
   */
  const turnOf = async (
    floor: FloorRecord,
    asked: ChatMessageRecord,
    seesImages: boolean,
  ): Promise<ChatTurn> => {
    const none: ChatTurn = { text: "", images: [] };
    if (asked.kind !== "owner") {
      return none;
    }
    const paths = mentionedFiles(asked.text);
    const [attachments, mentions] = await Promise.all([
      asked.attachments.length === 0 || options.attachments === undefined
        ? []
        : options.attachments.ofMessage(floor.id, asked.id),
      paths.length === 0 || options.files === undefined
        ? []
        : options.files.read(floor, paths),
    ]);
    // The Manager's agent session views images where it is told they are
    // (ADR 0004); a single Gateway call carries text only.
    return chatTurn({
      attachments,
      mentions,
      redactor,
      seesImages,
      ...(seesImages ? { imagePath: sessionImagePath } : {}),
    });
  };

  /**
   * Interrupts the reply the Floor's Manager is writing, for the Owner's
   * new message (FR-24), and waits until what it wrote so far is kept.
   * While it carries out a request (filing issues, starting a Batch,
   * research) or answers otherwise, the message is refused.
   */
  const interrupt = async (
    floorId: string,
    manager: AgentRecord,
  ): Promise<void> => {
    const answering = busy.get(floorId);
    if (answering === undefined) {
      return;
    }
    if (answering?.phase === "writing") {
      answering.interrupted = true;
      answering.controller.abort();
      await answering.done;
      if (!busy.has(floorId)) {
        return;
      }
    }
    throw new ManagerChatError(
      managerChatErrorCodes.replyInProgress,
      busy.get(floorId)?.phase === "acting"
        ? `${manager.name} is carrying out your last request: send this once it has.`
        : `${manager.name} is still answering your last message.`,
    );
  };

  /** Why the Manager cannot answer now, if it cannot. */
  const cannotAnswer = (
    manager: AgentRecord,
    model: string | undefined,
  ): string | undefined =>
    !manager.enabled
      ? `${manager.name} is paused, so does not answer. Turn ${manager.name} back on in Floor Settings.`
      : model === undefined
        ? `${manager.name} has no Model: choose a default Model for ${manager.aiProvider} in General Settings.`
        : undefined;

  /**
   * Compacts the Floor's conversation (FR-87): the Manager's own Model
   * summarises it (FR-89), and the summary is kept in place of the
   * messages it replaces. The Owner's `/compact` replaces everything up to
   * it; at the threshold, everything before `asked`, which is still to be
   * answered. Answers the summary, kept but not yet told to listeners, or
   * undefined when there is nothing to compact.
   */
  const compact = async (
    floor: FloorRecord,
    manager: AgentRecord,
    asked: ChatMessageRecord,
    how: Pick<ManagerChatCompaction, "trigger" | "contextUsage"> & {
      readonly focus: string | null;
    },
    signal: AbortSignal,
  ): Promise<ChatMessageRecord | undefined> => {
    const start = await store.conversationStart(floor.id);
    const upTo = how.trigger === "owner" ? asked.id : asked.id - 1;
    const replaced = (
      await store.latest(floor.id, historySize, start.after)
    ).filter(({ id }) => id <= upTo);
    // "/clear" and "/compact", and what they were answered, are replaced
    // but are nothing to summarise.
    const controls = new Set(
      replaced
        .filter(
          ({ kind, text }) =>
            kind === "owner" && readChatControl(text) !== undefined,
        )
        .map(({ id }) => id),
    );
    const said = replaced.filter(
      ({ id, kind, replyTo }) =>
        !controls.has(id) &&
        (replyTo === null || !controls.has(replyTo)) &&
        kind !== "clear" &&
        kind !== "summary",
    );
    const last = replaced.at(-1);
    if (said.length === 0 || last === undefined) {
      return undefined;
    }
    const model = modelOf(manager, await options.defaultModels?.());
    const cannot = cannotAnswer(manager, model);
    if (cannot !== undefined || model === undefined) {
      throw new Error(cannot ?? "");
    }
    const running = await options.grilling?.active(floor.id);
    const prompt = compactionPrompt({
      manager,
      floor,
      ...(start.summary === undefined ? {} : { previous: start.summary.text }),
      messages: said,
      ...(how.focus === null ? {} : { focus: redactor.redactText(how.focus) }),
      grilling: running !== undefined,
    });
    const written = await models.stream(
      {
        agentId: manager.id,
        model,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        maxTokens: maxSummaryTokens,
        // The conversation being replaced, which then ends.
        session: sessionOf(floor.id, start),
      },
      { signal, onText: () => undefined },
    );
    if (written.text.trim() === "") {
      throw new Error(`${manager.name} wrote no summary.`);
    }
    const summary = await store.append({
      floorId: floor.id,
      kind: "summary",
      text: redactor.redactText(written.text.trim()),
      command: null,
      // The Owner's /compact is answered; at the threshold, nothing is.
      replyTo: how.trigger === "owner" ? asked.id : null,
      agentId: manager.id,
      model,
      grilling:
        running === undefined ? null : { sessionId: running.id, round: null },
      compaction: {
        trigger: how.trigger,
        contextUsage: how.contextUsage,
        upTo: last.id,
        messages: replaced.length,
      },
      createdAt: now(),
    });
    await endConversation(floor.id, manager.id, start);
    return summary;
  };

  /**
   * Compacts the conversation before the Model answers `asked`, if the
   * Manager's Context Usage in it reached its threshold: the Manager's
   * own Fresh Start threshold, else its Floor's (85% by default). If compacting
   * fails, the Model answers from the conversation as it is.
   */
  const compactIfFull = async (
    floor: FloorRecord,
    manager: AgentRecord,
    asked: ChatMessageRecord,
    signal: AbortSignal,
  ): Promise<void> => {
    const state = usage.get(manager.id);
    if (state?.contextUsage == null) {
      return;
    }
    const start = await store.conversationStart(floor.id);
    const threshold = manager.freshStartThreshold ?? floor.freshStartThreshold;
    if (
      state.session !== sessionOf(floor.id, start) ||
      contextUsagePercent(state.contextUsage) < threshold
    ) {
      return;
    }
    try {
      const summary = await compact(
        floor,
        manager,
        asked,
        { trigger: "auto", contextUsage: state.contextUsage, focus: null },
        signal,
      );
      if (summary !== undefined) {
        publish(floor.id, { type: "message", message: summary });
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  /**
   * The conversation the Manager's Model is given in answer to `asked`,
   * compacted first if it is full: its latest messages since it was last
   * cleared or compacted, the summary it starts from, the Skills loaded in
   * it, and the session its calls name.
   */
  const conversationFor = async (
    floor: FloorRecord,
    manager: AgentRecord,
    asked: ChatMessageRecord,
    signal: AbortSignal,
  ) => {
    await compactIfFull(floor, manager, asked, signal);
    const start = await store.conversationStart(floor.id);
    const window = await store.latest(floor.id, conversationSize, start.after);
    // A compacted conversation keeps its Skills: they are stored apart.
    const loadedFrom =
      start.summary === undefined
        ? (window[0]?.id ?? asked.id)
        : start.cleared + 1;
    return {
      window,
      session: sessionOf(floor.id, start),
      summary: start.summary?.text,
      loaded: latestLoaded(await store.loadedSkills(floor.id, loadedFrom)),
    };
  };

  /**
   * The Manager's Model's reply to `asked`, kept when it is finished; in a
   * Grilling Session, `session`, which its prompt holds. With the Owner's
   * requests on (ADR 0004), the reply may instead be a decision in a fenced
   * block, which is held back from listeners and carried out: a clarifying
   * question kept as the reply, research sent before the Model is asked
   * again, or a Batch whose Plan is said and then started.
   */
  const answer = async (
    floor: FloorRecord,
    manager: AgentRecord,
    team: readonly AgentRecord[],
    asked: ChatMessageRecord,
    controller: AbortController,
    session?: GrillingSessionRecord,
  ): Promise<void> => {
    /**
     * Says what the Manager is doing in answer (FR-24): a new message
     * interrupts `writing` and waits for `acting`. One that interrupted
     * already stops it before it acts.
     */
    const phase = (now: Answering["phase"]): void => {
      controller.signal.throwIfAborted();
      const answering = busy.get(floor.id);
      if (answering?.controller === controller) {
        answering.phase = now;
      }
    };
    phase("writing");
    let model: string | undefined;
    /** The tools the Manager's session used for the reply (FR-24). */
    const tools: ManagerChatToolUse[] = [];
    const answered = (
      kind: "reply" | "error",
      text: string,
      chosen?: ChatSkill,
    ): Omit<NewChatMessage, "createdAt"> => ({
      floorId: floor.id,
      kind,
      text,
      command: null,
      replyTo: asked.id,
      agentId: manager.id,
      model: model ?? null,
      ...(tools.length === 0 ? {} : { tools: [...tools] }),
      ...(session === undefined
        ? {}
        : { grilling: { sessionId: session.id, round: null } }),
      ...(chosen === undefined
        ? {}
        : {
            skill: {
              name: chosen.name,
              source: chosen.source,
              arguments: null,
              chosenBy: "manager",
            },
            skillInstructions: redactor.redactText(chosen.instructions),
          }),
    });
    /** Tells listeners more of the reply, while it is being written. */
    const emit = (text: string): void => {
      const replying = busy.get(floor.id);
      if (replying != null && !controller.signal.aborted && text !== "") {
        replying.text += text;
        publish(floor.id, { type: "delta", replyTo: asked.id, text });
      }
    };
    // A chat request is the Model's to decide, outside a Grilling Session
    // and a Skill the Owner ran, while the Floor lets it spin work off.
    const requests =
      options.requests !== undefined &&
      floor.spinOffFromChat &&
      session === undefined &&
      asked.skill === null
        ? options.requests
        : undefined;
    // While a reply could still open a decision's block, it is held back
    // from listeners; a decision is never told as it is written.
    let opensDecision: boolean | undefined;
    let heldDecision = "";
    const startReply = () => {
      opensDecision = requests === undefined ? false : undefined;
      heldDecision = "";
    };
    startReply();
    const stream = (text: string): void => {
      if (opensDecision === false) {
        emit(text);
        return;
      }
      if (opensDecision === true) {
        return;
      }
      heldDecision += text;
      opensDecision = readRequestStart(heldDecision);
      if (opensDecision === false) {
        emit(heldDecision);
        heldDecision = "";
      }
    };
    /** Says something in answer to the Owner's request, as it is carried out. */
    const say = async (
      kind: "plan" | "progress" | "error",
      text: string,
    ): Promise<void> => {
      await keep({
        floorId: floor.id,
        kind,
        text,
        command: null,
        replyTo: asked.id,
        agentId: manager.id,
        model: kind === "plan" ? (model ?? null) : null,
      });
    };
    let kept: Omit<NewChatMessage, "createdAt"> | undefined;
    try {
      const defaults = await options.defaultModels?.();
      model = modelOf(manager, defaults);
      const cannot = cannotAnswer(manager, model);
      if (cannot !== undefined || model === undefined) {
        kept = answered("error", cannot ?? "");
      } else {
        const callModel = model;
        const memory = await options.memory?.read(floor);
        const given = await conversationFor(
          floor,
          manager,
          asked,
          controller.signal,
        );
        // The Skills loaded by the conversation the Model is given.
        const loaded = withGrilling(given.loaded, session);
        // Offered for the Manager to choose, unless the Owner ran one or
        // a Grilling Session runs. A built-in Skill that starts a session
        // is the Owner's to run (`/grilling`, `/wayfinder`); one that
        // loads instructions (`/pr`) may be chosen like any other.
        const offered =
          asked.skill === null && session === undefined
            ? (await skillsOf(floor.id).catch(() => noSkills)).skills.filter(
                ({ name, source }) =>
                  !(source === "built-in" && isGrillingSkillName(name)) &&
                  !loaded.some((skill) => skill.name === name),
              )
            : [];
        const workRoles =
          requests === undefined ? [] : await requests.workRoles(floor.id);
        // The Manager answers in its conversation's read-only agent session
        // when its AI Provider has an agent tool (ADR 0004); else in one
        // call through the Gateway, unable to read the repository.
        const sessions =
          options.sessions?.serves(callModel) === true
            ? options.sessions
            : undefined;
        // What the Owner attached and mentioned, with their turn (FR-24).
        // `turn.images` are the images, which the session is given; the
        // text of a single Gateway call says it cannot see them.
        const turn = await turnOf(floor, asked, sessions !== undefined);
        const messages = withChatTurn(conversation(given.window), turn);
        /** Keeps and tells a tool the session used. */
        const used = (tool: ManagerChatToolUse): void => {
          if (controller.signal.aborted || tools.length >= maxChatToolUses) {
            return;
          }
          tools.push(tool);
          publish(floor.id, { type: "tool", replyTo: asked.id, tool });
        };
        const call = (
          prompt: {
            loadedSkills: readonly PromptSkill[];
            offeredSkills: readonly ChatSkill[];
            chosenSkill?: string;
            /** What research found, once it has reported back. */
            findings?: readonly string[];
          },
          onText: (text: string) => void,
          signal: AbortSignal,
          more: readonly ModelMessage[] = [],
        ): Promise<ModelReply> => {
          const system = managerSystemPrompt({
            floor,
            manager,
            readsRepository: sessions !== undefined,
            team: team.map((agent) => ({
              ...agent,
              model: modelOf(agent, defaults),
            })),
            ...(memory === undefined ? {} : { memory }),
            loadedSkills: prompt.loadedSkills,
            offeredSkills: prompt.offeredSkills.map(
              ({ name, description }) => ({
                name,
                description: redactor.redactText(description),
              }),
            ),
            ...(prompt.chosenSkill === undefined
              ? {}
              : { chosenSkill: prompt.chosenSkill }),
            ...(session === undefined
              ? {}
              : { grilling: grillingSessionSection(session) }),
            ...(given.summary === undefined ? {} : { summary: given.summary }),
            ...(requests === undefined
              ? {}
              : {
                  requests: requestsSection({
                    roles: workRoles,
                    research:
                      requests.canResearch && prompt.findings === undefined,
                    ...(prompt.findings === undefined
                      ? {}
                      : { findings: prompt.findings }),
                  }),
                }),
          });
          const turns = [...messages, ...more];
          // A re-ask within one answer is a further turn of the session.
          return sessions === undefined
            ? models.stream(
                {
                  agentId: manager.id,
                  model: callModel,
                  system,
                  messages: turns,
                  maxTokens: maxReplyTokens,
                  session: given.session,
                },
                { signal, onText },
              )
            : sessions.turn({
                floor,
                manager,
                model: callModel,
                effort: manager.effort,
                system,
                messages: turns,
                conversation: given.session,
                // With each turn that carries the Owner's message.
                ...(more.length === 0 ? { images: turn.images } : {}),
                signal,
                onText,
                onTool: used,
              });
        };

        // While the reply could still be choosing a Skill, its start is
        // held back from listeners; once it is not, it is told.
        let deciding = offered.length > 0;
        let held = "";
        let chosen: ChatSkill | undefined;
        const first = new AbortController();
        const stopFirst = () => {
          first.abort();
        };
        controller.signal.addEventListener("abort", stopFirst);
        let reply: ModelReply | undefined;
        try {
          reply = await call(
            { loadedSkills: loaded, offeredSkills: offered },
            (text) => {
              if (chosen !== undefined) {
                return;
              }
              if (!deciding) {
                stream(text);
                return;
              }
              held += text;
              const choice = readSkillChoice(held);
              if (choice === undefined) {
                return;
              }
              deciding = false;
              if (choice !== false) {
                chosen = offered.find(({ name }) => name === choice.name);
                if (chosen !== undefined) {
                  // Its answer is asked for again, with the Skill loaded.
                  first.abort();
                  return;
                }
                // A Skill the Floor does not have: the line is left out.
                held = choice.rest;
              }
              stream(held);
            },
            first.signal,
          );
        } catch (error) {
          if (chosen === undefined || controller.signal.aborted) {
            throw error;
          }
        } finally {
          controller.signal.removeEventListener("abort", stopFirst);
        }
        let text = reply?.text ?? "";
        const choice = offered.length > 0 ? readSkillChoice(text) : false;
        if (chosen === undefined && choice !== undefined && choice !== false) {
          // A reply that came whole, choosing one.
          chosen = offered.find(({ name }) => name === choice.name);
          text = chosen === undefined ? choice.rest : text;
        } else if (chosen === undefined && deciding) {
          stream(held);
        }
        let skillLoaded = loaded;
        if (chosen !== undefined) {
          const announcement = `${skillAnnouncement(chosen.name)}\n\n`;
          emit(announcement);
          skillLoaded = [
            ...loaded,
            {
              name: chosen.name,
              source: chosen.source,
              instructions: redactor.redactText(chosen.instructions),
            },
          ];
          startReply();
          const again = await call(
            {
              loadedSkills: skillLoaded,
              offeredSkills: [],
              chosenSkill: chosen.name,
            },
            stream,
            controller.signal,
          );
          text = again.text.trim() === "" ? "" : announcement + again.text;
        }
        const chosenSkill = chosen;
        const plain = (reply: string) =>
          reply.trim() === ""
            ? answered("error", `${manager.name} gave no answer.`)
            : answered("reply", reply, chosenSkill);
        const prompt = {
          loadedSkills: skillLoaded,
          offeredSkills: [] as ChatSkill[],
          ...(chosenSkill === undefined
            ? {}
            : { chosenSkill: chosenSkill.name }),
        };
        const decisionOf = (reply: string): string | undefined => {
          const body =
            chosenSkill === undefined
              ? reply
              : reply.slice(
                  `${skillAnnouncement(chosenSkill.name)}\n\n`.length,
                );
          return requests !== undefined && readRequestStart(body) === true
            ? body
            : undefined;
        };
        /**
         * The decision in the block `written`, asked for once more if it
         * cannot be acted on: then the Model may answer plainly instead, or
         * its decision may still be unreadable, saying why.
         */
        const decide = async (
          written: string,
          findings?: readonly string[],
        ): Promise<
          | { readonly kind: "decision"; readonly value: CheckedRequest }
          | { readonly kind: "plain"; readonly text: string }
          | { readonly kind: "unreadable"; readonly problem: string }
        > => {
          // Research reports back once; the answer after it is final.
          const read = (block: string) => {
            const parsed = parseChatRequest(block, workRoles);
            return parsed.ok &&
              parsed.value.decision === "research" &&
              findings !== undefined
              ? {
                  ok: false as const,
                  problem:
                    "Your research has reported back: answer now, without sending more.",
                }
              : parsed;
          };
          const parsed = read(written);
          if (parsed.ok) {
            return { kind: "decision", value: parsed.value };
          }
          startReply();
          const again = await call(
            { ...prompt, ...(findings === undefined ? {} : { findings }) },
            stream,
            controller.signal,
            [
              { role: "assistant", content: written },
              { role: "user", content: requestRetryMessage(parsed.problem) },
            ],
          );
          const block = decisionOf(again.text);
          if (block === undefined) {
            return { kind: "plain", text: again.text };
          }
          const second = read(block);
          return second.ok
            ? { kind: "decision", value: second.value }
            : { kind: "unreadable", problem: second.problem };
        };
        /** Carries out what the reply holds: a decision, or a plain reply. */
        const carryOutReply = async (
          written: string,
          findings?: readonly string[],
        ): Promise<Omit<NewChatMessage, "createdAt"> | undefined> => {
          const block = decisionOf(written);
          if (requests === undefined || block === undefined) {
            return plain(written);
          }
          const decided = await decide(block, findings);
          if (decided.kind === "plain") {
            return plain(decided.text);
          }
          if (decided.kind === "unreadable") {
            return answered(
              "error",
              `${manager.name} meant to act on that, but its decision could not be read: ${decided.problem} Say it again, or file the issues yourself and say "complete issues …".`,
            );
          }
          const { value } = decided;
          if (value.decision === "clarify") {
            return answered("reply", value.question, chosenSkill);
          }
          // The Owner's own words, which what is filed or sent is bound to
          // (P2-3): their earlier messages in the conversation, and this one.
          const earlier = given.window
            .filter(({ kind, id }) => kind === "owner" && id !== asked.id)
            .slice(-ownerWordsKept)
            .map(({ text: words }) => words);
          if (value.decision === "research") {
            phase("acting");
            const found = await requests.research({
              floor,
              manager,
              message: asked,
              earlier,
              decision: value,
              say,
              signal: controller.signal,
            });
            phase("writing");
            startReply();
            const after = await call(
              { ...prompt, findings: found },
              stream,
              controller.signal,
            );
            return carryOutReply(after.text, found);
          }
          phase("acting");
          await requests.batch({
            floor,
            manager,
            message: asked,
            earlier,
            decision: value,
            say,
            signal: controller.signal,
          });
          return undefined;
        };
        kept = await carryOutReply(text);
      }
    } catch (error) {
      const answering = busy.get(floor.id);
      const sofar =
        answering?.controller === controller ? answering.text.trim() : "";
      kept =
        controller.signal.aborted && answering?.interrupted === true
          ? // The Owner's next message interrupted it (FR-24): what was
            // written so far is kept, for the conversation to go on from.
            sofar === ""
            ? answered(
                "error",
                `You interrupted ${manager.name} before it answered.`,
              )
            : answered("reply", `${sofar}\n\n(Interrupted by the Owner.)`)
          : answered(
              "error",
              controller.signal.aborted
                ? `AI Office stopped before ${manager.name} finished answering.`
                : `${manager.name} could not answer: ${reasonOf(error)}`,
            );
    }
    if (kept === undefined) {
      // A Batch's Plan and progress were kept as they were said.
      busy.delete(floor.id);
      return;
    }
    const reply = await store.append({
      ...kept,
      text: redactor.redactText(kept.text),
      createdAt: now(),
    });
    // The reply is no longer being written once it is kept.
    busy.delete(floor.id);
    publish(floor.id, { type: "message", message: reply });
  };

  /** A turn, with credentials removed from everything it would keep. */
  const redactTurn = (value: GrillingTurn): GrillingTurn => {
    const clean = (text: string) => redactor.redactText(text);
    return {
      message: clean(value.message),
      decisions: value.decisions.map((decision) => ({
        ...decision,
        text: clean(decision.text),
      })),
      terms: value.terms.map(({ term, definition, avoid }) => ({
        term: clean(term),
        definition: clean(definition),
        avoid: avoid.map(clean),
      })),
      withdraw: value.withdraw,
      questions: value.questions.map((question) => ({
        ...question,
        text: clean(question.text),
        recommended: clean(question.recommended),
      })),
      facts: value.facts.map((fact) => ({
        ...fact,
        question: clean(fact.question),
      })),
      outline: value.outline.map(({ heading, text }) => ({
        heading: clean(heading),
        text: clean(text),
      })),
      adrs: value.adrs.map((adr) => ({
        title: clean(adr.title),
        decision: clean(adr.decision),
        options: adr.options.map(clean),
        consequences: adr.consequences.map(clean),
        hardToReverse: clean(adr.hardToReverse),
        surprising: clean(adr.surprising),
        tradeOff: clean(adr.tradeOff),
      })),
      processes: value.processes.map(({ title, text }) => ({
        title: clean(title),
        text: clean(text),
      })),
    };
  };

  /** Draft issues, with credentials removed from everything they would file. */
  const redactDrafts = <Draft extends GrillingIssuesTurn["issues"][number]>(
    drafts: readonly Draft[],
  ): Draft[] => {
    const clean = (text: string) => redactor.redactText(text);
    return drafts.map((draft) => ({
      ...draft,
      title: clean(draft.title),
      whatToBuild: clean(draft.whatToBuild),
      acceptanceCriteria: draft.acceptanceCriteria.map(clean),
      prdSections: draft.prdSections.map(clean),
      adrs: draft.adrs.map(clean),
    }));
  };

  /**
   * Has the facts a turn asks for found in the Floor's repository (FR-79),
   * each by the Agent it names (one of the Floor's sandbox Agents, enabled
   * and staying) or else by the Manager, in read-only sandboxes at once.
   * The chat says what is being found, then what was, each in answer to
   * the Owner's message `replyTo`, before the round that answers it; the
   * facts are kept with the session, which is answered as saved.
   */
  const findFacts = async (
    floor: FloorRecord,
    manager: AgentRecord,
    team: readonly AgentRecord[],
    replyTo: number,
    session: GrillingSessionRecord,
    asked: GrillingTurn["facts"],
    finder: FactFinder,
    grilling: GrillingStore,
    signal: AbortSignal,
  ): Promise<GrillingSessionRecord> => {
    const defaults = await options.defaultModels?.();
    const sendable = sendableAgents(team);
    const notes: string[] = [];
    const wanted = asked.map(({ question, agent }) => {
      if (
        agent === undefined ||
        agent.toLowerCase() === manager.name.toLowerCase()
      ) {
        return { question, agent: manager };
      }
      const named = sendable.find(
        ({ name }) => name.toLowerCase() === agent.toLowerCase(),
      );
      if (named === undefined) {
        notes.push(
          `${agent} is not one of the Floor's Agents that can be sent to find facts, so ${manager.name} finds "${question}" itself.`,
        );
      }
      return { question, agent: named ?? manager };
    });
    const ref = { sessionId: session.id, round: null };
    await keep({
      floorId: floor.id,
      kind: "grilling",
      text: findingFactsText(
        session.round + 1,
        manager.name,
        wanted.map(({ question, agent }) => ({ question, agent: agent.name })),
        notes,
      ),
      command: null,
      replyTo,
      agentId: manager.id,
      model: null,
      grilling: ref,
    });
    const found = await Promise.all(
      wanted.map(async ({ question, agent }): Promise<FoundFact> => {
        const model = modelOf(agent, defaults);
        if (model === undefined) {
          return {
            question,
            agentId: agent.id,
            status: "failed",
            answer: `${agent.name} has no Model: choose a default Model for ${agent.aiProvider} in General Settings.`,
          };
        }
        const result = await finder.find({
          floor: {
            id: floor.id,
            repository: floor.repository,
            defaultBranch: floor.defaultBranch,
          },
          agent: {
            id: agent.id,
            name: agent.name,
            aiProvider: agent.aiProvider,
            model,
            effort: agent.effort,
          },
          sessionId: session.id,
          topic: session.topic,
          question,
          signal,
        });
        return {
          question,
          agentId: agent.id,
          status: result.status,
          answer: redactor.redactText(result.answer),
        };
      }),
    );
    signal.throwIfAborted();
    const saved = await grilling.save(recordFacts(session, found, now()));
    await keep({
      floorId: floor.id,
      kind: "grilling",
      text: factsFoundText(
        saved.facts.slice(-found.length),
        new Map([manager, ...team].map(({ id, name }) => [id, name])),
      ),
      command: null,
      replyTo,
      agentId: manager.id,
      model: null,
      grilling: ref,
    });
    return saved;
  };

  /**
   * One of the Manager's turns in the Grilling Session `sessionId`, in
   * answer to `asked` (FR-78): the next round of questions, or, with no
   * open questions left, the Owner asked to confirm. Its Model answers
   * with one JSON object, asked for once more if it cannot be kept; its
   * text is not told to listeners as it is written. While it may, a turn
   * that names facts to find has them found first (FR-79), and is then
   * asked for again, at most `maxFactPasses` times.
   */
  const turn = async (
    floor: FloorRecord,
    manager: AgentRecord,
    team: readonly AgentRecord[],
    asked: ChatMessageRecord,
    sessionId: number,
    controller: AbortController,
  ): Promise<void> => {
    let model: string | undefined;
    const reply = (
      kind: "reply" | "error",
      text: string,
      round: number | null,
    ): Omit<NewChatMessage, "createdAt"> => ({
      floorId: floor.id,
      kind,
      text,
      command: null,
      replyTo: asked.id,
      agentId: manager.id,
      model: model ?? null,
      grilling: { sessionId, round },
    });
    let kept: Omit<NewChatMessage, "createdAt">;
    try {
      const defaults = await options.defaultModels?.();
      model = modelOf(manager, defaults);
      let session = await options.grilling?.get(floor.id, sessionId);
      const cannot = cannotAnswer(manager, model);
      if (session === undefined || options.grilling === undefined) {
        throw new Error(`There is no Grilling Session ${String(sessionId)}.`);
      }
      if (cannot !== undefined || model === undefined) {
        kept = reply("error", cannot ?? "", null);
      } else {
        const memory = await options.memory?.read(floor);
        const given = await conversationFor(
          floor,
          manager,
          asked,
          controller.signal,
        );
        const messages = conversation(given.window);
        const finder = options.facts;
        const lookups: FactLookups = {
          manager: manager.name,
          agents: sendableAgents(team).map(({ name }) => name),
        };
        for (let passes = 0; ; passes += 1) {
          const canLookUp = finder !== undefined && passes < maxFactPasses;
          const current: GrillingSessionRecord = session;
          const system = managerSystemPrompt({
            floor,
            manager,
            team: team.map((agent) => ({
              ...agent,
              model: modelOf(agent, defaults),
            })),
            ...(memory === undefined ? {} : { memory }),
            ...(given.summary === undefined ? {} : { summary: given.summary }),
            loadedSkills: withGrilling(given.loaded, current),
            grilling: [
              ...grillingSessionSection(current),
              "",
              ...grillingTurnInstructions(
                current,
                canLookUp ? lookups : undefined,
              ),
            ],
          });
          const call = (turns: readonly ModelMessage[]) =>
            models.stream(
              {
                agentId: manager.id,
                model: model ?? "",
                system,
                messages: turns,
                maxTokens: maxTurnTokens,
                session: given.session,
              },
              { signal: controller.signal, onText: () => undefined },
            );
          const first = await call(messages);
          let parsed = parseGrillingTurn(first.text);
          if (!parsed.ok) {
            const again = await call([
              ...messages,
              { role: "assistant", content: first.text },
              { role: "user", content: grillingRetryMessage(parsed.problem) },
            ]);
            parsed = parseGrillingTurn(again.text);
          }
          if (!parsed.ok) {
            kept = reply(
              "error",
              `${manager.name} could not write the next round: ${parsed.problem} Send a message to ask again.`,
              null,
            );
            break;
          }
          const value = redactTurn(parsed.value);
          if (canLookUp && value.facts.length > 0) {
            // Found first; the turn is then written again knowing them.
            session = await findFacts(
              floor,
              manager,
              team,
              asked.id,
              current,
              value.facts,
              finder,
              options.grilling,
              controller.signal,
            );
            continue;
          }
          const applied = applyTurn(current, value, now());
          let saved = await options.grilling.save(applied.session);
          // The documents are written as soon as the turn is kept (FR-80);
          // `/to-tickets` writes none.
          let written: WrittenDocuments | undefined;
          if (
            options.documents !== undefined &&
            grillingWritesDocuments(saved.skill)
          ) {
            written = await options.documents.write({
              floor,
              manager: trailerOf(manager, model),
              session: saved,
              signal: controller.signal,
            });
            saved = await options.grilling.save({
              ...saved,
              documents: written.documents,
            });
          }
          const said = [
            value.message.trim(),
            documentsText(written, applied.leftOut),
          ]
            .filter((part) => part !== "")
            .join("\n\n");
          kept =
            applied.asked.length > 0
              ? reply(
                  "reply",
                  roundText(said, saved.round, applied.asked),
                  saved.round,
                )
              : reply("reply", confirmationText(said, saved), null);
          break;
        }
      }
    } catch (error) {
      kept = reply(
        "error",
        controller.signal.aborted
          ? `AI Office stopped before ${manager.name} finished the next round.`
          : `${manager.name} could not write the next round: ${reasonOf(error)}`,
        null,
      );
    }
    const message = await store.append({
      ...kept,
      text: redactor.redactText(kept.text),
      createdAt: now(),
    });
    busy.delete(floor.id);
    publish(floor.id, { type: "message", message });
  };

  /**
   * Ends the Grilling Session `sessionId`, as the Owner confirmed in
   * `asked`, once the one pull request with its documents is open (FR-80):
   * they are written a last time and the GitHub App opens it. If it cannot
   * be opened, the session stays open, awaiting confirmation, and the chat
   * says why, so "confirm" tries again. A session that writes no documents
   * (`/to-tickets`), or one with no `writer`, ends with no pull request.
   * Either way the Manager then drafts its issues, when they can be filed.
   */
  const close = async (
    floor: FloorRecord,
    manager: AgentRecord,
    team: readonly AgentRecord[],
    asked: ChatMessageRecord,
    sessionId: number,
    writer: GrillingDocumentsWriter | undefined,
    grilling: GrillingStore,
    controller: AbortController,
  ): Promise<void> => {
    const answer = (
      kind: "grilling" | "error",
      text: string,
    ): Omit<NewChatMessage, "createdAt"> => ({
      floorId: floor.id,
      kind,
      text,
      command: null,
      replyTo: asked.id,
      agentId: manager.id,
      model: null,
      grilling: { sessionId, round: null },
    });
    let kept: Omit<NewChatMessage, "createdAt">;
    let session: GrillingSessionRecord | undefined;
    let ended: GrillingSessionRecord | undefined;
    try {
      session = await grilling.get(floor.id, sessionId);
      if (session === undefined) {
        throw new Error(`There is no Grilling Session ${String(sessionId)}.`);
      }
      const model = modelOf(manager, await options.defaultModels?.()) ?? "";
      const proposed =
        writer === undefined || !grillingWritesDocuments(session.skill)
          ? undefined
          : await writer.propose({
              floor,
              manager: trailerOf(manager, model),
              session,
              signal: controller.signal,
            });
      ended = await grilling.save(
        endedSession(
          proposed === undefined
            ? session
            : { ...session, documents: proposed.documents },
          now(),
        ),
      );
      kept = answer("grilling", endedText(ended));
    } catch (error) {
      const why = controller.signal.aborted
        ? "AI Office stopped first."
        : reasonOf(error);
      if (session !== undefined && !controller.signal.aborted) {
        const { documents } = session;
        await grilling
          .save({
            ...session,
            documents:
              documents === null
                ? null
                : { ...documents, problem: why.slice(0, 500) },
            updatedAt: now(),
          })
          .catch((saveError: unknown) => options.onError?.(saveError));
      }
      kept = answer(
        "error",
        `The ${session === undefined ? `Grilling Session ${String(sessionId)}` : sessionName(session)} did not end${session === undefined || grillingWritesDocuments(session.skill) ? ": the pull request with its documents could not be opened" : ""}. ${why} It stays open: reply "${session?.awaitingConfirmation === false ? endGrillingText : "confirm"}" to try again.`,
      );
    }
    const message = await store.append({
      ...kept,
      text: redactor.redactText(kept.text),
      createdAt: now(),
    });
    // Then the Manager drafts the issues that build it (FR-81).
    const drafting = ended !== undefined && options.issues !== undefined;
    if (!drafting) {
      busy.delete(floor.id);
    }
    publish(floor.id, { type: "message", message });
    if (ended !== undefined && drafting) {
      const drafted = await writeIssues(
        floor,
        manager,
        team,
        asked,
        ended,
        grilling,
        controller,
      );
      busy.delete(floor.id);
      publish(floor.id, { type: "message", message: drafted });
    }
  };

  /** "draft the issues of session 3": what to reply to try again. */
  const draftAgain = (session: Pick<GrillingSessionRecord, "id">) =>
    `Reply "${draftGrillingIssuesText(session.id)}" to ask again.`;

  /**
   * The Manager's Model drafts the issues of the ended session `session`
   * in answer to `asked` (FR-81), as one JSON object, asked for once more
   * if it cannot be kept. They are kept with the session as drafts, in
   * place of any earlier ones, for the Owner to edit and approve, and the
   * chat lists them. Answers that message, kept but not yet told to
   * listeners.
   */
  const writeIssues = async (
    floor: FloorRecord,
    manager: AgentRecord,
    team: readonly AgentRecord[],
    asked: ChatMessageRecord,
    session: GrillingSessionRecord,
    grilling: GrillingStore,
    controller: AbortController,
  ): Promise<ChatMessageRecord> => {
    let model: string | undefined;
    const answer = (
      kind: "reply" | "error",
      text: string,
    ): Omit<NewChatMessage, "createdAt"> => ({
      floorId: floor.id,
      kind,
      text,
      command: null,
      replyTo: asked.id,
      agentId: manager.id,
      model: model ?? null,
      grilling: { sessionId: session.id, round: null },
    });
    let kept: Omit<NewChatMessage, "createdAt">;
    try {
      const defaults = await options.defaultModels?.();
      model = modelOf(manager, defaults);
      const cannot = cannotAnswer(manager, model);
      if (cannot !== undefined || model === undefined) {
        kept = answer(
          "error",
          `${manager.name} could not draft the issues: ${cannot ?? ""} ${draftAgain(session)}`,
        );
      } else {
        const callModel = model;
        const memory = await options.memory?.read(floor);
        const given = await conversationFor(
          floor,
          manager,
          asked,
          controller.signal,
        );
        // Up to the Owner's message: what AI Office said since is no answer.
        const messages = conversation(
          given.window.filter(({ id }) => id <= asked.id),
        );
        const system = managerSystemPrompt({
          floor,
          manager,
          team: team.map((agent) => ({
            ...agent,
            model: modelOf(agent, defaults),
          })),
          ...(memory === undefined ? {} : { memory }),
          ...(given.summary === undefined ? {} : { summary: given.summary }),
          loadedSkills: withGrilling(given.loaded, session),
          grilling: [
            ...grillingSessionSection(session),
            "",
            ...grillingIssuesInstructions(session),
          ],
        });
        const call = (turns: readonly ModelMessage[]) =>
          models.stream(
            {
              agentId: manager.id,
              model: callModel,
              system,
              messages: turns,
              maxTokens: maxIssuesTokens,
              session: given.session,
            },
            { signal: controller.signal, onText: () => undefined },
          );
        const first = await call(messages);
        let parsed = parseGrillingIssues(first.text);
        if (!parsed.ok) {
          const again = await call([
            ...messages,
            { role: "assistant", content: first.text },
            { role: "user", content: grillingRetryMessage(parsed.problem) },
          ]);
          parsed = parseGrillingIssues(again.text);
        }
        if (parsed.ok) {
          const value: GrillingIssuesTurn = {
            message: redactor.redactText(parsed.value.message),
            issues: redactDrafts(parsed.value.issues),
          };
          const issues = draftIssues(value, session, now());
          const saved = await grilling.save({
            ...session,
            issues,
            updatedAt: now(),
          });
          kept = answer(
            "reply",
            issuesDraftedText(value.message, saved, issues),
          );
        } else {
          kept = answer(
            "error",
            `${manager.name} could not draft the issues: ${parsed.problem} ${draftAgain(session)}`,
          );
        }
      }
    } catch (error) {
      kept = answer(
        "error",
        controller.signal.aborted
          ? `AI Office stopped before ${manager.name} finished drafting the issues.`
          : `${manager.name} could not draft the issues: ${reasonOf(error)} ${draftAgain(session)}`,
      );
    }
    return store.append({
      ...kept,
      text: redactor.redactText(kept.text),
      createdAt: now(),
    });
  };

  /**
   * Files the draft issues of the ended session `sessionId`, as the Owner
   * approved them in `asked` (FR-81): the GitHub App files each after
   * those it is blocked by, and the chat lists them, or says why filing
   * stopped short.
   */
  const fileIssues = async (
    floor: FloorRecord,
    manager: AgentRecord,
    asked: ChatMessageRecord,
    sessionId: number,
    filer: GrillingIssuesFiler,
    grilling: GrillingStore,
    controller: AbortController,
  ): Promise<void> => {
    let kept: Omit<NewChatMessage, "createdAt">;
    const answer = (
      kind: "grilling" | "error",
      text: string,
    ): Omit<NewChatMessage, "createdAt"> => ({
      floorId: floor.id,
      kind,
      text,
      command: null,
      replyTo: asked.id,
      agentId: manager.id,
      model: null,
      grilling: { sessionId, round: null },
    });
    try {
      const session = await grilling.get(floor.id, sessionId);
      if (session === undefined) {
        throw new Error(`There is no Grilling Session ${String(sessionId)}.`);
      }
      let latest = session;
      const issues = await filer.file({
        floor,
        manager,
        session,
        signal: controller.signal,
        record: async (current) => {
          latest = await grilling.save({ ...latest, issues: current });
        },
      });
      kept = answer(
        issues.problem === null ? "grilling" : "error",
        issuesFiledText(latest, issues),
      );
    } catch (error) {
      kept = answer(
        "error",
        controller.signal.aborted
          ? "AI Office stopped before the issues were filed. Those filed are kept, and filing again files only the rest."
          : `The issues could not be filed: ${reasonOf(error)}`,
      );
    }
    const message = await store.append({
      ...kept,
      text: redactor.redactText(kept.text),
      createdAt: now(),
    });
    busy.delete(floor.id);
    publish(floor.id, { type: "message", message });
  };

  /**
   * Starts the answer to `message` in the background (the Model's reply, a
   * Grilling Session's turn, a compaction), holding the Floor until it is
   * kept.
   */
  const inTheBackground = (
    message: ChatMessageRecord,
    work: (controller: AbortController) => Promise<void>,
  ): { readonly message: ChatMessageRecord; readonly reply: undefined } => {
    const { floorId } = message;
    const controller = new AbortController();
    const answering: Answering = {
      replyTo: message.id,
      text: "",
      controller,
      phase: "busy",
      since: now(),
      interrupted: false,
      done: Promise.resolve(),
    };
    busy.set(floorId, answering);
    const reply = work(controller)
      .catch((error: unknown) => {
        if (busy.get(floorId) === answering) {
          busy.delete(floorId);
        }
        options.onError?.(error);
      })
      .finally(() => {
        replies.delete(reply);
      });
    answering.done = reply;
    replies.add(reply);
    return { message, reply: undefined };
  };

  /**
   * "/clear" (at once, in plain code) and "/compact" (the Manager's Model
   * writes the summary): the Owner's message is kept, in the running
   * Grilling Session if there is one, which goes on either way.
   */
  const chatControl = async (
    floor: FloorRecord,
    manager: AgentRecord,
    text: string,
    control: NonNullable<ReturnType<typeof readChatControl>>,
    attached: readonly ChatAttachment[],
  ): Promise<{
    readonly message: ChatMessageRecord;
    readonly reply: ChatMessageRecord | undefined;
  }> => {
    let message: ChatMessageRecord;
    let running: GrillingSessionRecord | undefined;
    try {
      running = await options.grilling?.active(floor.id);
      const ref =
        running === undefined ? null : { sessionId: running.id, round: null };
      message = await keepOwner({
        floorId: floor.id,
        kind: "owner",
        text: text.trim(),
        command: null,
        replyTo: null,
        agentId: null,
        model: null,
        grilling: ref,
        attachments: attached,
      });
      if (control.kind === "clear") {
        const start = await store.conversationStart(floor.id);
        const reply = await keep({
          floorId: floor.id,
          kind: "clear",
          text: [
            `Cleared the conversation: ${manager.name} starts afresh from here. Decisions, Plans and Batches are kept.`,
            ...(running === undefined
              ? []
              : [
                  `The ${sessionName(running)} goes on, with its decisions, glossary terms and open questions.`,
                ]),
          ].join(" "),
          command: null,
          replyTo: message.id,
          agentId: manager.id,
          model: null,
          grilling: ref,
        });
        await endConversation(floor.id, manager.id, start);
        busy.delete(floor.id);
        return { message, reply };
      }
    } catch (error) {
      busy.delete(floor.id);
      throw error;
    }
    const asked = message;
    const ref =
      running === undefined ? null : { sessionId: running.id, round: null };
    return inTheBackground(asked, async (controller) => {
      let reply: ChatMessageRecord;
      try {
        const start = await store.conversationStart(floor.id);
        const state = usage.get(manager.id);
        const summary = await compact(
          floor,
          manager,
          asked,
          {
            trigger: "owner",
            contextUsage:
              state?.session === sessionOf(floor.id, start)
                ? state.contextUsage
                : null,
            focus: control.focus,
          },
          controller.signal,
        );
        reply =
          summary ??
          (await store.append({
            floorId: floor.id,
            kind: "hint",
            text: "There is nothing to compact yet: nothing was said since the conversation was last cleared or compacted.",
            command: null,
            replyTo: asked.id,
            agentId: manager.id,
            model: null,
            grilling: ref,
            createdAt: now(),
          }));
      } catch (error) {
        reply = await store.append({
          floorId: floor.id,
          kind: "error",
          text: redactor.redactText(
            controller.signal.aborted
              ? `AI Office stopped before ${manager.name} finished compacting the conversation.`
              : `${manager.name} could not compact the conversation: ${reasonOf(error)}`,
          ),
          command: null,
          replyTo: asked.id,
          agentId: manager.id,
          model: null,
          grilling: ref,
          createdAt: now(),
        });
      }
      busy.delete(floor.id);
      publish(floor.id, { type: "message", message: reply });
    });
  };

  /**
   * The documents a `/to-tickets` session breaks down: those `text` names
   * under the PRDs' and ADRs' directories, read from the repository's
   * default branch, redacted and cut short. One that cannot be read is
   * kept without its text, so the Manager can say so.
   */
  const sourcesOf = async (
    floor: FloorRecord,
    text: string,
  ): Promise<GrillingSource[]> => {
    const paths = grillingSourcePaths(text);
    if (paths.length === 0) {
      return [];
    }
    const read =
      options.files === undefined
        ? []
        : await options.files.read(floor, paths).catch(() => []);
    return paths.map((path) => {
      const content = read.find((file) => file.path === path)?.content;
      if (content === undefined) {
        return { path, content: null, truncated: false };
      }
      const redacted = redactor.redactText(content);
      return {
        path,
        content: redacted.slice(0, maxGrillingSourceLength),
        truncated:
          redacted.length > maxGrillingSourceLength ||
          read.some((file) => file.path === path && file.truncated),
      };
    });
  };

  /**
   * Whether ending `session` is `close`'s work: to open its documents'
   * pull request (FR-80), or, for one that writes none (`/to-tickets`),
   * to draft its issues at once (FR-81).
   */
  const closes = (session: GrillingSessionRecord): boolean =>
    grillingWritesDocuments(session.skill)
      ? options.documents !== undefined
      : options.issues !== undefined;

  /** Where a message stands with the Floor's Grilling Sessions. */
  const routeGrilling = async (
    floor: FloorRecord,
    text: string,
    skillCommand: ReturnType<typeof readSkillCommand>,
  ): Promise<GrillingRoute | undefined> => {
    const grilling = options.grilling;
    if (grilling === undefined) {
      return undefined;
    }
    const floorId = floor.id;
    const active = await grilling.active(floorId);
    // `/grilling`, or another built-in Skill that starts a session.
    if (skillCommand !== undefined && isGrillingSkillName(skillCommand.name)) {
      if (active !== undefined) {
        return { kind: "running", session: active };
      }
      const skill = skillCommand.name;
      const given = skillCommand.arguments ?? "";
      const sources =
        skill === toTicketsSkillName ? await sourcesOf(floor, given) : [];
      const at = now();
      const session = await grilling.create({
        floorId,
        topic: redactor.redactText(given).slice(0, maxGrillingTopicLength),
        skill,
        status: "active",
        round: 0,
        awaitingConfirmation: false,
        questions: [],
        decisions: [],
        terms: [],
        facts: [],
        outline: [],
        adrs: [],
        processes: [],
        documents: null,
        issues: null,
        sources,
        startedAt: at,
        updatedAt: at,
        pausedAt: null,
        endedAt: null,
      });
      return { kind: "start", session };
    }
    const control =
      skillCommand === undefined ? readGrillingControl(text) : undefined;
    // An ended session's issues: the one named, or the latest ended.
    if (control?.kind === "draft-issues" || control?.kind === "file-issues") {
      const session =
        control.session === null
          ? (await grilling.list(floorId)).find(
              ({ status }) => status === "ended",
            )
          : await grilling.get(floorId, control.session);
      return { kind: "control", control, session };
    }
    // Ending with none running ends the latest paused one (FR-83a).
    if (control?.kind === "end" && active === undefined) {
      const session = (await grilling.list(floorId)).find(
        ({ status }) => status === "paused",
      );
      return { kind: "control", control, session };
    }
    if (control?.kind === "resume" && active === undefined) {
      const session =
        control.session === null
          ? (await grilling.list(floorId)).find(
              ({ status }) => status === "paused",
            )
          : await grilling.get(floorId, control.session);
      return { kind: "control", control, session };
    }
    if (
      control !== undefined &&
      (active !== undefined || control.kind === "pause")
    ) {
      return { kind: "control", control, session: active };
    }
    return active === undefined
      ? undefined
      : { kind: "in-session", session: active };
  };

  /**
   * "draft the issues of session 3" and "file the issues of session 3"
   * (FR-81), in plain code: an ended session's issues are drafted (again,
   * until one is filed), or filed once they can be.
   */
  const issuesOutcome = async (
    control: Extract<
      GrillingControl,
      { readonly kind: "draft-issues" | "file-issues" }
    >,
    session: GrillingSessionRecord | undefined,
    say: (kind: "hint", text: string) => Promise<ChatMessageRecord>,
  ): Promise<GrillingOutcome> => {
    if (session === undefined) {
      return say(
        "hint",
        control.session === null
          ? "No Grilling Session has ended on this Floor, so there are no issues to draft or file."
          : `There is no Grilling Session ${String(control.session)} on this Floor.`,
      );
    }
    if (session.status !== "ended") {
      return say(
        "hint",
        `The ${sessionName(session)} has not ended: its issues are drafted once it ends and its documents' pull request is open.`,
      );
    }
    if (options.issues === undefined) {
      return say(
        "hint",
        "Issues are drafted and filed only once the GitHub App is set up.",
      );
    }
    const drafts = session.issues?.drafts ?? [];
    const filed = drafts.flatMap(({ filed: issue }) =>
      issue === null ? [] : [`#${String(issue.number)}`],
    );
    if (control.kind === "draft-issues") {
      return filed.length === 0
        ? "draft-issues"
        : say(
            "hint",
            `The issues of the ${sessionName(session)} are not drafted again: ${String(filed.length)} of ${String(drafts.length)} are filed already (${filed.join(", ")}).`,
          );
    }
    if (drafts.length === 0) {
      return say(
        "hint",
        `The ${sessionName(session)} has no draft issues yet: reply "${draftGrillingIssuesText(session.id)}".`,
      );
    }
    if (filed.length === drafts.length) {
      return say(
        "hint",
        `The issues of the ${sessionName(session)} are filed already: ${filed.join(", ")}.`,
      );
    }
    const problem = issueDraftsProblem(drafts);
    return problem === undefined
      ? "file-issues"
      : say(
          "hint",
          `The issues of the ${sessionName(session)} cannot be filed as they are: ${problem} Edit them under Issues when you read the session.`,
        );
  };

  /**
   * Carries out a message's part in a Grilling Session, in plain code:
   * pausing, resuming and ending it, and recording the Owner's answers.
   */
  const grillingOutcome = async (
    route: GrillingRoute,
    message: ChatMessageRecord,
    manager: AgentRecord,
    ran: ChatSkill | undefined,
  ): Promise<GrillingOutcome> => {
    const grilling = options.grilling;
    if (grilling === undefined || route.kind === "start") {
      return "turn";
    }
    const say = (
      kind: "hint" | "grilling",
      text: string,
      ref: GrillingMessageRef | null = route.session === undefined
        ? null
        : { sessionId: route.session.id, round: null },
    ) =>
      keep({
        floorId: message.floorId,
        kind,
        text,
        command: null,
        replyTo: message.id,
        agentId: manager.id,
        model: null,
        grilling: ref,
      });
    const { session } = route;
    if (route.kind === "running") {
      return say(
        "hint",
        `The ${sessionName(route.session)} is running: ${standing(route.session)} Say "pause the session" before starting another.`,
      );
    }
    if (route.kind === "control") {
      const { control } = route;
      if (control.kind === "pause") {
        if (session === undefined) {
          return say(
            "hint",
            "No Grilling Session is running, so none was paused.",
          );
        }
        const at = now();
        const paused = await grilling.save({
          ...session,
          status: "paused",
          pausedAt: at,
          updatedAt: at,
        });
        return say(
          "grilling",
          `Paused the ${sessionName(paused)}. ${standing(paused)} It is kept with its full history: say "resume session ${String(paused.id)}" to carry on.`,
        );
      }
      if (control.kind === "resume") {
        if (session === undefined) {
          return say(
            "hint",
            control.session === null
              ? "There is no paused Grilling Session to resume."
              : `There is no Grilling Session ${String(control.session)} on this Floor.`,
          );
        }
        if (session.status === "active") {
          return say("hint", `The ${sessionName(session)} is running already.`);
        }
        if (session.status === "ended") {
          return say(
            "hint",
            `The ${sessionName(session)} has ended, so it cannot be resumed. It can still be read from the Grilling Sessions list.`,
          );
        }
        const resumed = await grilling.save({
          ...session,
          status: "active",
          pausedAt: null,
          updatedAt: now(),
        });
        return say(
          "grilling",
          `Resumed the ${sessionName(resumed)}. ${standing(resumed)}`,
          {
            sessionId: resumed.id,
            round: openInRound(resumed).length > 0 ? resumed.round : null,
          },
        );
      }
      if (control.kind === "draft-issues" || control.kind === "file-issues") {
        return issuesOutcome(control, session, say);
      }
      if (control.kind === "end") {
        if (session === undefined) {
          return say(
            "hint",
            "No Grilling Session is running or paused, so none was ended.",
          );
        }
        // Ended now, whatever is still open (FR-83a): what has settled is
        // kept, and its documents' pull request opened, as on "confirm".
        if (closes(session)) {
          return "close";
        }
        const ended = await grilling.save(endedSession(session, now()));
        return say("grilling", endedText(ended));
      }
      if (session === undefined) {
        return "continue";
      }
      if (!session.awaitingConfirmation) {
        return say(
          "hint",
          `The ${sessionName(session)} has questions still to settle. ${standing(session)}`,
        );
      }
      if (closes(session)) {
        // It ends once its documents' pull request is open (FR-80), or,
        // writing none, has its issues drafted at once (FR-81).
        return "close";
      }
      const ended = await grilling.save(endedSession(session, now()));
      return say("grilling", endedText(ended));
    }
    // Anything else while a session runs.
    if (ran !== undefined) {
      return "continue";
    }
    const open = openInRound(route.session);
    const answers = readGrillingAnswers(message.text);
    if (answers !== undefined && open.length > 0) {
      const round = route.session.round;
      const applied = applyAnswers(route.session, answers, now());
      if (applied.unclear) {
        return say(
          "hint",
          `Questions ${numbersInWords(open.map(({ number }) => number))} are open in round ${String(round)}: say which you accept, as "${String(open[0]?.number ?? 1)}: recommended", or reply "recommended to all".`,
        );
      }
      const notInRound =
        applied.notInRound.length === 0
          ? ""
          : `${applied.notInRound.length === 1 ? "Question" : "Questions"} ${numbersInWords(applied.notInRound)} ${applied.notInRound.length === 1 ? "is" : "are"} not in round ${String(round)}, so ${applied.notInRound.length === 1 ? "was" : "were"} left.`;
      if (applied.answered.length === 0) {
        return say(
          "hint",
          `${notInRound} Its open ${open.length === 1 ? "question is" : "questions are"} ${numbersInWords(open.map(({ number }) => number))}.`,
        );
      }
      const saved = await grilling.save(applied.session);
      const still = openInRound(saved).map(({ number }) => number);
      if (still.length === 0) {
        return "turn";
      }
      return say(
        "grilling",
        [
          `Noted your ${applied.answered.length === 1 ? "answer" : "answers"} to ${numbersInWords(applied.answered)}. Still open in round ${String(round)}: ${numbersInWords(still)}.`,
          notInRound,
        ]
          .filter((part) => part !== "")
          .join(" "),
      );
    }
    if (readManagerCommand(message.text).kind !== "message") {
      return "continue";
    }
    // A question about the round is the Model's to answer; once every
    // question asked is answered, the next round is.
    return open.length > 0 ? "continue" : "turn";
  };

  return {
    async history(floorId, limit = historySize) {
      const floor = await floorOf(floorId);
      const { manager } = await managerOf(floor);
      const replying = busy.get(floorId);
      return {
        manager,
        model: modelOf(manager, await options.defaultModels?.()),
        messages: await store.latest(floorId, limit),
        pending:
          replying == null
            ? []
            : [{ replyTo: replying.replyTo, text: replying.text }],
      };
    },

    after: (floorId, id) => store.after(floorId, id, historySize),

    async send(floorId, text, attachmentIds = []) {
      const floor = await floorOf(floorId);
      if (floor.archivedAt !== null) {
        throw new FloorError(
          floorErrorCodes.floorArchived,
          `The Floor "${floor.name}" is archived.`,
        );
      }
      const { manager, team } = await managerOf(floor);
      if (stopped) {
        throw new Error("The Manager chat has stopped.");
      }
      // Its attachments are checked first: a message refused for them
      // interrupts nothing. They are bound to it as it is kept.
      const attached = await attachmentsOf(floorId, attachmentIds);
      // A reply being written is interrupted; anything else is waited for.
      await interrupt(floorId, manager);
      // Held from here, so the Floor's messages are answered one at a time.
      busy.set(floorId, null);
      // "/clear" and "/compact" (FR-87), before any Skill of their name.
      const control = readChatControl(text);
      if (control !== undefined) {
        return chatControl(floor, manager, text, control, attached);
      }
      // "/name [arguments]": one of the Floor's Skills, to load (FR-74).
      const skillCommand = readSkillCommand(text);
      let ran: ChatSkill | undefined;
      let noSkill: string | undefined;
      let message: ChatMessageRecord;
      let route: GrillingRoute | undefined;
      try {
        // A Grilling Session's own: "/grilling", "pause the session" and
        // the rest, and every message while one runs (FR-77).
        route = await routeGrilling(floor, text, skillCommand);
        if (route?.kind === "start") {
          ran = sessionStarter(route.session.skill);
        } else if (skillCommand !== undefined && route?.kind !== "running") {
          const found = await skillsOf(floorId).catch(
            (error: unknown): ChatSkills => ({
              skills: [],
              repositoryError: `The Floor's Skills could not be read: ${reasonOf(error)}`,
            }),
          );
          ran = found.skills.find(({ name }) => name === skillCommand.name);
          noSkill =
            ran === undefined
              ? noSuchSkill(skillCommand.name, found)
              : undefined;
        }
        const redactedArguments =
          skillCommand?.arguments == null
            ? null
            : redactor.redactText(skillCommand.arguments);
        message = await keepOwner({
          floorId,
          kind: "owner",
          text: text.trim(),
          command: null,
          replyTo: null,
          agentId: null,
          model: null,
          attachments: attached,
          ...(ran === undefined
            ? {}
            : {
                skill: {
                  name: ran.name,
                  source: ran.source,
                  arguments: redactedArguments,
                  chosenBy: "owner",
                },
                skillInstructions: redactor.redactText(ran.instructions),
              }),
          ...(route?.session === undefined
            ? {}
            : { grilling: { sessionId: route.session.id, round: null } }),
        });
      } catch (error) {
        busy.delete(floorId);
        throw error;
      }
      const inBackground = (
        work: (controller: AbortController) => Promise<void>,
      ) => inTheBackground(message, work);
      if (route !== undefined && noSkill === undefined) {
        let outcome: GrillingOutcome;
        try {
          outcome = await grillingOutcome(route, message, manager, ran);
        } catch (error) {
          busy.delete(floorId);
          throw error;
        }
        if (outcome === "turn") {
          const { session } = route;
          if (session === undefined) {
            throw new Error("A turn needs its Grilling Session.");
          }
          return inBackground((controller) =>
            turn(floor, manager, team, message, session.id, controller),
          );
        }
        if (outcome === "close") {
          const { session } = route;
          const writer = options.documents;
          const grilling = options.grilling;
          if (session === undefined || grilling === undefined) {
            throw new Error("Ending needs the Grilling Session.");
          }
          return inBackground((controller) =>
            close(
              floor,
              manager,
              team,
              message,
              session.id,
              writer,
              grilling,
              controller,
            ),
          );
        }
        if (outcome === "draft-issues") {
          const { session } = route;
          const grilling = options.grilling;
          if (session === undefined || grilling === undefined) {
            throw new Error("Drafting needs the Grilling Session.");
          }
          return inBackground(async (controller) => {
            const drafted = await writeIssues(
              floor,
              manager,
              team,
              message,
              session,
              grilling,
              controller,
            );
            busy.delete(floorId);
            publish(floorId, { type: "message", message: drafted });
          });
        }
        if (outcome === "file-issues") {
          const { session } = route;
          const filer = options.issues;
          const grilling = options.grilling;
          if (
            session === undefined ||
            filer === undefined ||
            grilling === undefined
          ) {
            throw new Error("Filing needs the Grilling Session's issues.");
          }
          return inBackground((controller) =>
            fileIssues(
              floor,
              manager,
              message,
              session.id,
              filer,
              grilling,
              controller,
            ),
          );
        }
        if (outcome !== "continue") {
          busy.delete(floorId);
          return { message, reply: outcome };
        }
      }
      // The Model answers within a session that runs, with it in its prompt.
      const inSession =
        route?.kind === "in-session" ? route.session : undefined;
      if (noSkill !== undefined) {
        try {
          const reply = await keep({
            floorId,
            kind: "hint",
            text: noSkill,
            command: null,
            replyTo: message.id,
            agentId: manager.id,
            model: null,
          });
          return { message, reply };
        } finally {
          busy.delete(floorId);
        }
      }
      const reading =
        ran === undefined
          ? readManagerCommand(message.text)
          : ({ kind: "message" } as const);
      if (reading.kind !== "message") {
        try {
          const answered = {
            floorId,
            replyTo: message.id,
            agentId: manager.id,
            model: null,
          };
          if (
            reading.kind === "command" &&
            reading.command.kind === "report" &&
            options.report !== undefined
          ) {
            const report = options.report;
            const reply = await report(floorId, message.id).catch(
              (error: unknown) =>
                keep({
                  ...answered,
                  kind: "error",
                  command: null,
                  text: `${manager.name} could not write a status report: ${reasonOf(error)}`,
                }),
            );
            return { message, reply };
          }
          if (reading.kind === "refused") {
            const reply = await keep({
              ...answered,
              kind: "hint",
              command: null,
              text: reading.hint,
            });
            return { message, reply };
          }
          const { command, understood } = reading;
          let done: string | undefined;
          try {
            done = await options.carryOut?.(floorId, command);
          } catch (error) {
            const reply = await keep({
              ...answered,
              kind: "error",
              command: null,
              text: `${understood} ${manager.name} could not carry it out: ${reasonOf(error)}`,
            });
            return { message, reply };
          }
          const reply = await keep({
            ...answered,
            kind: "command",
            command,
            text: `${understood} ${done ?? notYet[command.kind]}`,
          });
          return { message, reply };
        } finally {
          busy.delete(floorId);
        }
      }
      return inBackground((controller) =>
        answer(floor, manager, team, message, controller, inSession),
      );
    },

    grillingSessions: async (floorId) => {
      await floorOf(floorId);
      return (await options.grilling?.list(floorId)) ?? [];
    },

    async grillingSession(floorId, sessionId) {
      await floorOf(floorId);
      const session = await options.grilling?.get(floorId, sessionId);
      if (session === undefined) {
        throw new GrillingError(
          grillingErrorCodes.sessionNotFound,
          `There is no Grilling Session ${String(sessionId)} on this Floor.`,
        );
      }
      return {
        session,
        messages: await store.ofGrillingSession(floorId, sessionId),
      };
    },

    async saveGrillingIssues(floorId, sessionId, drafts) {
      const floor = await floorOf(floorId);
      const session = await options.grilling?.get(floorId, sessionId);
      if (session === undefined || options.grilling === undefined) {
        throw new GrillingError(
          grillingErrorCodes.sessionNotFound,
          `There is no Grilling Session ${String(sessionId)} on this Floor.`,
        );
      }
      if (busy.has(floorId)) {
        const { manager } = await managerOf(floor);
        throw new ManagerChatError(
          managerChatErrorCodes.replyInProgress,
          `${manager.name} is still answering your last message: edit the issues once it has.`,
        );
      }
      const { issues } = session;
      if (issues === null) {
        throw new GrillingError(
          grillingErrorCodes.issuesNotEditable,
          `The ${sessionName(session)} has no draft issues to edit.`,
        );
      }
      if (issues.drafts.some(({ filed }) => filed !== null)) {
        throw new GrillingError(
          grillingErrorCodes.issuesNotEditable,
          `The issues of the ${sessionName(session)} are being filed, so they can no longer be edited.`,
        );
      }
      const problem = issueDraftsProblem(drafts);
      if (problem !== undefined) {
        throw new GrillingError(grillingErrorCodes.issuesInvalid, problem);
      }
      return options.grilling.save({
        ...session,
        issues: {
          ...issues,
          drafts: redactDrafts(drafts).map((draft) => ({
            id: draft.id,
            title: draft.title,
            whatToBuild: draft.whatToBuild,
            acceptanceCriteria: [...draft.acceptanceCriteria],
            blockedBy: [...new Set(draft.blockedBy)],
            prdSections: [...draft.prdSections],
            adrs: [...draft.adrs],
            filed: null,
          })),
        },
        updatedAt: now(),
      });
    },

    async postProgress(floorId, text, replyTo) {
      const { manager } = await managerOf(await floorOf(floorId));
      return keep({
        floorId,
        kind: "progress",
        text,
        command: null,
        replyTo,
        agentId: manager.id,
        model: null,
      });
    },

    async postReport(floorId, text, replyTo) {
      const { manager } = await managerOf(await floorOf(floorId));
      return keep({
        floorId,
        kind: "report",
        text,
        command: null,
        replyTo: replyTo ?? null,
        agentId: manager.id,
        model: null,
      });
    },

    subscribe(floorId, listener) {
      let floorListeners = listeners.get(floorId);
      if (floorListeners === undefined) {
        floorListeners = new Set();
        listeners.set(floorId, floorListeners);
      }
      floorListeners.add(listener);
      const replying = busy.get(floorId);
      return {
        pending:
          replying == null
            ? []
            : [{ replyTo: replying.replyTo, text: replying.text }],
        unsubscribe() {
          floorListeners.delete(listener);
          if (floorListeners.size === 0) {
            listeners.delete(floorId);
          }
        },
      };
    },

    tasksChanged(floorId) {
      publish(floorId, { type: "tasks" });
    },

    working: () =>
      [...busy].flatMap(([floorId, answering]) =>
        answering == null
          ? []
          : [
              {
                floorId,
                replyTo: answering.replyTo,
                phase: answering.phase,
                since: answering.since,
              },
            ],
      ),

    async end(floorId) {
      const answering = busy.get(floorId);
      if (answering == null) {
        return;
      }
      answering.controller.abort();
      await answering.done;
    },

    async stop() {
      stopped = true;
      unsubscribe?.();
      for (const replying of busy.values()) {
        replying?.controller.abort();
      }
      await Promise.all([...replies]);
    },
  };
}
