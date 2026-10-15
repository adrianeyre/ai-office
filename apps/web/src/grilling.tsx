import {
  composeGrillingAnswers,
  draftGrillingIssuesText,
  dropIssueDraft,
  fileGrillingIssuesText,
  grillingIssueDraftsRequestSchema,
  grillingSessionDetailSchema,
  grillingSessionListSchema,
  grillingSessionSchema,
  issueDraftsProblem,
  maxGrillingCriterionLength,
  maxGrillingIssueTextLength,
  maxGrillingIssueTitleLength,
  mergeIssueDrafts,
  moveIssueDraft,
  endGrillingText,
  pauseGrillingText,
  resumeGrillingText,
  type GrillingAnswer,
  type GrillingIssueDraftEdit,
  type GrillingIssues,
  type GrillingQuestion,
  type GrillingSession,
  type GrillingSessionSummary,
} from "@ai-office/shared";
import type { EventType } from "@ai-office/events/schema";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CheckCheck,
  FilePlus2,
  Pause,
  Play,
  RotateCcw,
  Square,
  Save,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import { useId, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { getJson, readApiError, sendJson } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { sessionQuery } from "./session.ts";

// Grilling Sessions in the Manager chat (PRD FR-77, FR-78, FR-82). `/grilling`
// starts one, as do `/grill-with-docs`, `/wayfinder`, `/to-tickets` and
// `/to-spec` (FR-83b), and each session says which started it; each round's questions are shown as cards, each with its own
// answer box and an "accept recommended" button, and "Recommended to all"
// accepts the rest of the round. The answers are sent as one chat message
// ("3: CSV", "4: recommended", "recommended to all"), which AI Office
// reads in plain code. A running session can be paused, and a paused one
// resumed; every session is kept and can be read in full. While one runs,
// the Floor's whiteboard shows its current round's questions (FR-83), its
// live outline and the decisions settled so far (FR-80), with the branch
// its documents are kept on. Once it ends,
// the Manager drafts its issues (FR-81), which the Owner edits, reorders,
// merges and drops when reading the session, then approves: the chat
// message "file the issues of session 3" has the GitHub App file them.

const sessionsUrl = (floorId: string) =>
  `/api/floors/${encodeURIComponent(floorId)}/grilling-sessions`;

/** Every query of a Floor's Grilling Sessions: invalidate this to read them again. */
export const grillingQueryKey = (floorId: string) =>
  ["floors", floorId, "grilling-sessions"] as const;

/** A Floor's Grilling Sessions, newest first. */
export const grillingSessionsQuery = (floorId: string) =>
  queryOptions({
    queryKey: grillingQueryKey(floorId),
    queryFn: () => getJson(sessionsUrl(floorId), grillingSessionListSchema),
  });

/** One session in full, with every chat message it holds. */
export const grillingSessionQuery = (floorId: string, sessionId: number) =>
  queryOptions({
    queryKey: [...grillingQueryKey(floorId), sessionId],
    queryFn: () =>
      getJson(
        `${sessionsUrl(floorId)}/${String(sessionId)}`,
        grillingSessionDetailSchema,
      ),
  });

/**
 * The green "paper" a Grilling Session is drawn on, on the whiteboard and
 * above the Manager chat: the success tone, as a success callout is. Its
 * fill and ink both come from the theme, so its text, and the muted text
 * on it, keep at least 4.5:1 in light and dark (theme-contrast.test.ts): a
 * fixed light tint here left dark mode's light text on light paper.
 */
export const grillingPaper =
  "border border-tone-success-foreground/40 bg-tone-success text-tone-success-foreground";

const statusLabels = {
  active: "Running",
  paused: "Paused",
  ended: "Ended",
} as const;

const statusTones = {
  active: "success",
  paused: "warning",
  ended: "neutral",
} as const satisfies Record<GrillingSession["status"], BadgeTone>;

export function GrillingStatus({
  status,
}: {
  status: GrillingSession["status"];
}) {
  return <Badge tone={statusTones[status]}>{statusLabels[status]}</Badge>;
}

/** "Grilling Session 3: exports". */
export const sessionTitle = (
  session: Pick<GrillingSessionSummary, "id" | "topic">,
) =>
  `Grilling Session ${String(session.id)}${session.topic === "" ? "" : `: ${session.topic}`}`;

/** What the Owner has written or accepted for a question, not yet sent. */
interface Draft {
  readonly text: string;
  readonly accepted: boolean;
}

function QuestionCard({
  question,
  draft,
  onDraft,
  interactive,
}: {
  question: GrillingQuestion;
  draft: Draft | undefined;
  onDraft: (draft: Draft) => void;
  interactive: boolean;
}) {
  const titleId = useId();
  const answerId = useId();
  const open = question.status === "open";
  return (
    <li
      aria-labelledby={titleId}
      data-question={question.number}
      className="space-y-2 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <p id={titleId} className="font-medium">
        <span className="mr-2 font-mono text-muted-foreground">
          {question.number}.
        </span>{" "}
        {question.text}
      </p>
      <p className="text-sm">
        <span className="text-muted-foreground">Recommended: </span>
        {question.recommended}
      </p>
      {question.status === "answered" && (
        <p className="text-sm">
          <span className="text-muted-foreground">Answered: </span>
          {question.acceptedRecommended ? (
            <Badge tone="success">Recommended</Badge>
          ) : (
            question.answer
          )}
        </p>
      )}
      {question.status === "withdrawn" && (
        <p className="text-sm text-muted-foreground">
          Withdrawn: earlier answers made it moot.
        </p>
      )}
      {interactive && open && (
        <div className="space-y-1">
          <Label htmlFor={answerId}>
            Your answer to question {question.number}
          </Label>
          <div className="flex flex-wrap items-start gap-2">
            <textarea
              id={answerId}
              rows={2}
              value={draft?.accepted === true ? "" : (draft?.text ?? "")}
              disabled={draft?.accepted === true}
              placeholder={
                draft?.accepted === true
                  ? "The recommended answer"
                  : "Write your answer"
              }
              onChange={(event) => {
                onDraft({ text: event.target.value, accepted: false });
              }}
              className="min-w-48 flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
            />
            <Button
              type="button"
              variant={draft?.accepted === true ? "secondary" : "outline"}
              size="sm"
              aria-pressed={draft?.accepted === true}
              onClick={() => {
                onDraft({ text: "", accepted: draft?.accepted !== true });
              }}
            >
              <CheckCheck aria-hidden />
              Accept recommended
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The drafts worth sending, as answers. */
const answersOf = (
  drafts: ReadonlyMap<number, Draft>,
  open: readonly GrillingQuestion[],
): GrillingAnswer[] =>
  open.flatMap(({ number }): GrillingAnswer[] => {
    const draft = drafts.get(number);
    if (draft?.accepted === true) {
      return [{ number, answer: null }];
    }
    const text = draft?.text.trim() ?? "";
    return text === "" ? [] : [{ number, answer: text }];
  });

/**
 * A round's questions as cards. While it is the running session's latest
 * round (`interactive`), each open question has an answer box and an
 * "Accept recommended" button; "Send answers" sends what was written or
 * accepted, and "Recommended to all" accepts the rest too.
 */
export function GrillingRound({
  floorId,
  sessionId,
  round,
  interactive,
  disabled,
  onSend,
}: {
  floorId: string;
  sessionId: number;
  round: number;
  interactive: boolean;
  disabled: boolean;
  /** Sends a chat message; true once it was sent. */
  onSend: (text: string) => Promise<boolean>;
}) {
  const { data, isError } = useQuery(grillingSessionQuery(floorId, sessionId));
  const [drafts, setDrafts] = useState<ReadonlyMap<number, Draft>>(new Map());
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The round&apos;s questions could not be read.
      </p>
    );
  }
  if (data === undefined) {
    return null;
  }
  const questions = data.session.questions.filter(
    (question) => question.round === round,
  );
  const live =
    interactive &&
    data.session.status === "active" &&
    data.session.round === round;
  const open = questions.filter(({ status }) => status === "open");
  const answers = answersOf(drafts, open);
  const submit = async (restRecommended: boolean) => {
    if (await onSend(composeGrillingAnswers(answers, restRecommended))) {
      setDrafts(new Map());
    }
  };
  return (
    <div className="mt-2 space-y-2">
      <ol aria-label={`Round ${String(round)} questions`} className="space-y-2">
        {questions.map((question) => (
          <QuestionCard
            key={question.number}
            question={question}
            draft={drafts.get(question.number)}
            interactive={live}
            onDraft={(draft) => {
              setDrafts((current) =>
                new Map(current).set(question.number, draft),
              );
            }}
          />
        ))}
      </ol>
      {live && open.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled || answers.length === 0}
            onClick={() => {
              void submit(false);
            }}
          >
            <Send aria-hidden />
            Send answers
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              void submit(true);
            }}
          >
            <CheckCheck aria-hidden />
            Recommended to all
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The running session, above the chat: its round, what is open, and
 * pausing it, confirming its end once no open questions remain, or ending
 * it now with End session (FR-83a), after the Owner says yes, as the Floor
 * then walks back to its desks.
 */
export function GrillingBar({
  floorId,
  disabled,
  onSend,
}: {
  floorId: string;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { data } = useQuery(grillingSessionsQuery(floorId));
  const [ending, setEnding] = useState(false);
  const session = data?.sessions.find(({ status }) => status === "active");
  if (session === undefined) {
    return null;
  }
  if (ending) {
    return (
      <section
        aria-label="Grilling Session"
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2 text-sm",
          grillingPaper,
        )}
      >
        <p className="w-full font-medium">
          End the {sessionTitle(session)} now?{" "}
          {session.openQuestions === 0
            ? "What has settled is kept"
            : `${String(session.openQuestions)} ${session.openQuestions === 1 ? "question is" : "questions are"} left open; what has settled is kept`}
          , its documents' pull request opens, and everyone walks back to their
          desk.
        </p>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            void onSend(endGrillingText).then(() => {
              setEnding(false);
            });
          }}
        >
          Yes, end the session
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setEnding(false);
          }}
        >
          Cancel
        </Button>
      </section>
    );
  }
  return (
    <section
      aria-label="Grilling Session"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2 text-sm",
        grillingPaper,
      )}
    >
      <p className="font-medium">{sessionTitle(session)}</p>
      <p>
        {session.round === 0 ? "Starting" : `Round ${String(session.round)}`} ·{" "}
        {session.openQuestions} open · {session.decisionCount}{" "}
        {session.decisionCount === 1 ? "decision" : "decisions"}
      </p>
      <div className="ml-auto flex gap-2">
        {session.awaitingConfirmation && (
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => {
              void onSend("confirm");
            }}
          >
            Confirm and end
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void onSend(pauseGrillingText);
          }}
        >
          <Pause aria-hidden />
          Pause session
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setEnding(true);
          }}
        >
          <Square aria-hidden />
          End session
        </Button>
      </div>
    </section>
  );
}

/** Where the session's documents are kept on GitHub, and their pull request. */
function DocumentsState({
  documents,
}: {
  documents: GrillingSession["documents"];
}) {
  if (documents === null) {
    return (
      <p className="text-muted-foreground">
        Not written yet: they are written on a branch of their own as decisions
        settle.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p>
        Kept on <code>{documents.branch}</code>
        {documents.files.length > 0 && (
          <>
            :{" "}
            {documents.files.map((file, index) => (
              <span key={file}>
                {index > 0 && ", "}
                <code>{file}</code>
              </span>
            ))}
          </>
        )}
        .
      </p>
      {documents.pullRequest !== null && (
        <p>
          <a
            href={documents.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            Pull request #{documents.pullRequest.number}
          </a>{" "}
          proposes them.
        </p>
      )}
      {documents.problem !== null && (
        <p role="status" className="text-destructive">
          Not written last time: {documents.problem}
        </p>
      )}
    </div>
  );
}

/** The PRD's live outline: each section's heading and what it says. */
function Outline({
  outline,
  level,
}: {
  outline: GrillingSession["outline"];
  level: 3 | 4 | 5;
}) {
  const Heading = `h${String(level)}` as "h3" | "h4" | "h5";
  if (outline.length === 0) {
    return <p className="text-muted-foreground">None yet.</p>;
  }
  return (
    <div className="space-y-2">
      {outline.map((section) => (
        <section key={section.heading} className="space-y-0.5">
          <Heading className="font-medium">{section.heading}</Heading>
          <p className="whitespace-pre-wrap">{section.text}</p>
        </section>
      ))}
    </div>
  );
}

/** The events that change what the whiteboard shows of a session. */
const whiteboardEventTypes: readonly EventType[] = [
  "grilling.session_changed",
  "grilling.documents_written",
  "grilling.pull_request_opened",
];

/** The current round's questions, as the whiteboard lists them. */
function RoundQuestions({ session }: { session: GrillingSession }) {
  const questions = session.questions.filter(
    ({ round }) => round === session.round && session.round > 0,
  );
  if (questions.length === 0) {
    return (
      <p className="text-muted-foreground">
        {session.round === 0 ? "None asked yet." : "No open questions remain."}
      </p>
    );
  }
  return (
    <ol className="space-y-1">
      {questions.map((question) => (
        <li key={question.number} data-question={question.number}>
          <span className="mr-1 font-mono text-muted-foreground">
            {question.number}.
          </span>
          {question.text}{" "}
          <Badge
            tone={
              (
                {
                  open: "warning",
                  answered: "success",
                  withdrawn: "neutral",
                } as const
              )[question.status]
            }
          >
            {question.status === "open"
              ? "Open"
              : question.status === "answered"
                ? "Answered"
                : "Withdrawn"}
          </Badge>
        </li>
      ))}
    </ol>
  );
}

/**
 * The running Grilling Session on the Floor's whiteboard (FR-80, FR-83):
 * its current round's questions, its live outline and the decisions
 * settled so far, with where its documents are kept. Nothing while none
 * runs. It changes as the session and its documents do.
 */
export function GrillingWhiteboard({
  floorId,
  headingLevel = 3,
}: {
  floorId: string;
  headingLevel?: 2 | 3;
}) {
  const queryClient = useQueryClient();
  useEventStream(
    { floorId, types: whiteboardEventTypes },
    {
      onEvent: () => {
        void queryClient.invalidateQueries({
          queryKey: grillingQueryKey(floorId),
        });
      },
    },
  );
  const { data: list } = useQuery(grillingSessionsQuery(floorId));
  const running = list?.sessions.find(({ status }) => status === "active");
  const { data } = useQuery({
    ...grillingSessionQuery(floorId, running?.id ?? 0),
    enabled: running !== undefined,
  });
  const session = data?.session;
  if (running === undefined || session === undefined) {
    return null;
  }
  const Title = `h${String(headingLevel)}` as "h2" | "h3";
  const Part = `h${String(headingLevel + 1)}` as "h3" | "h4";
  return (
    <section
      aria-label="Grilling Session on the whiteboard"
      className={cn("space-y-3 rounded-xl p-4 text-sm", grillingPaper)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Title className="text-lg font-semibold">{sessionTitle(session)}</Title>
        <GrillingStatus status={session.status} />
      </div>
      <section className="space-y-1">
        <Part className="font-semibold">
          {session.round === 0
            ? "The questions"
            : `Round ${String(session.round)}'s questions`}
        </Part>
        <RoundQuestions session={session} />
      </section>
      <section className="space-y-1">
        <Part className="font-semibold">The outline</Part>
        <Outline outline={session.outline} level={headingLevel === 2 ? 4 : 5} />
      </section>
      <section className="space-y-1">
        <Part className="font-semibold">Decisions settled so far</Part>
        {session.decisions.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ol className="list-decimal space-y-1 pl-6">
            {session.decisions.map((decision) => (
              <li key={decision.number}>{decision.text}</li>
            ))}
          </ol>
        )}
      </section>
      <section className="space-y-1">
        <Part className="font-semibold">The documents</Part>
        <DocumentsState documents={session.documents} />
      </section>
    </section>
  );
}

/** A draft as the editor holds it: its parts, without the issue filed. */
const editsOf = (issues: GrillingIssues): GrillingIssueDraftEdit[] =>
  issues.drafts.map(
    ({
      id,
      title,
      whatToBuild,
      acceptanceCriteria,
      blockedBy,
      prdSections,
      adrs,
    }) => ({
      id,
      title,
      whatToBuild,
      acceptanceCriteria: [...acceptanceCriteria],
      blockedBy: [...blockedBy],
      prdSections: [...prdSections],
      adrs: [...adrs],
    }),
  );

/** The drafts as they are sent: each criterion trimmed, blank lines left out. */
const tidyDrafts = (
  drafts: readonly GrillingIssueDraftEdit[],
): GrillingIssueDraftEdit[] =>
  drafts.map((draft) => ({
    ...draft,
    title: draft.title.trim(),
    whatToBuild: draft.whatToBuild.trim(),
    acceptanceCriteria: draft.acceptanceCriteria
      .map((criterion) => criterion.trim())
      .filter((criterion) => criterion !== ""),
  }));

/** "Issue 2: Build the CSV". */
const draftName = (index: number, draft: GrillingIssueDraftEdit) =>
  `Issue ${String(index + 1)}${draft.title.trim() === "" ? "" : `: ${draft.title.trim()}`}`;

/**
 * The issues drafted from an ended session, before any is filed (FR-81):
 * each can be edited (its title, what to build, acceptance criteria and
 * what it is blocked by), moved, merged into another or dropped. Edits are
 * saved with the session; approving saves them, then asks in the chat for
 * them to be filed.
 */
function IssueDraftsEditor({
  floorId,
  session,
  issues,
  disabled,
  onSend,
}: {
  floorId: string;
  session: GrillingSession;
  issues: GrillingIssues;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const queryClient = useQueryClient();
  const { data: signedIn } = useQuery(sessionQuery);
  const [drafts, setDrafts] = useState(() => editsOf(issues));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const tidy = tidyDrafts(drafts);
  const edited = JSON.stringify(tidy) !== JSON.stringify(editsOf(issues));
  const parsed = grillingIssueDraftsRequestSchema.safeParse({ drafts: tidy });
  const problem = parsed.success
    ? issueDraftsProblem(tidy)
    : (parsed.error.issues[0]?.message ?? "Some issues are not complete.");
  const off = disabled || busy || signedIn === undefined;

  const update = (id: number, change: Partial<GrillingIssueDraftEdit>) => {
    setDrafts(
      drafts.map((draft) =>
        draft.id === id ? { ...draft, ...change } : draft,
      ),
    );
  };

  /** Saves the edits; answers whether they were kept. */
  const save = async (): Promise<boolean> => {
    setBusy(true);
    setRefused(null);
    const response = await sendJson(
      "PUT",
      `${sessionsUrl(floorId)}/${String(session.id)}/issues`,
      { drafts: tidy },
      signedIn?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      const body = await readApiError(response);
      setRefused(
        body.message ??
          body.problems?.join(" ") ??
          "Your edits were not saved.",
      );
      return false;
    }
    const saved = grillingSessionSchema.parse(await response.json());
    queryClient.setQueryData(
      grillingSessionQuery(floorId, session.id).queryKey,
      (current) =>
        current === undefined ? current : { ...current, session: saved },
    );
    return true;
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Edit, reorder, merge or drop them, then approve: the GitHub App files
        them on GitHub in order, labelled ai-office, each after those it is
        blocked by, ready to become a Batch.
      </p>
      <ol aria-label="The draft issues, in order" className="space-y-2">
        {drafts.map((draft, index) => {
          const name = draftName(index, draft);
          const field = `issue-${String(session.id)}-${String(draft.id)}`;
          const others = drafts.filter(({ id }) => id !== draft.id);
          return (
            <li
              key={draft.id}
              aria-label={name}
              className="space-y-2 rounded-md border p-2"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{name}</p>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move issue ${String(index + 1)} up`}
                    disabled={off || index === 0}
                    onClick={() => {
                      setDrafts(moveIssueDraft(drafts, draft.id, -1));
                    }}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move issue ${String(index + 1)} down`}
                    disabled={off || index === drafts.length - 1}
                    onClick={() => {
                      setDrafts(moveIssueDraft(drafts, draft.id, 1));
                    }}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Drop issue ${String(index + 1)}`}
                    disabled={off || drafts.length === 1}
                    onClick={() => {
                      setDrafts(dropIssueDraft(drafts, draft.id));
                    }}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${field}-title`} className="text-xs">
                  Title
                </Label>
                <Input
                  id={`${field}-title`}
                  value={draft.title}
                  maxLength={maxGrillingIssueTitleLength}
                  disabled={off}
                  onChange={(event) => {
                    update(draft.id, { title: event.target.value });
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${field}-build`} className="text-xs">
                  What to build
                </Label>
                <textarea
                  id={`${field}-build`}
                  value={draft.whatToBuild}
                  maxLength={maxGrillingIssueTextLength}
                  rows={3}
                  disabled={off}
                  onChange={(event) => {
                    update(draft.id, { whatToBuild: event.target.value });
                  }}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${field}-criteria`} className="text-xs">
                  Acceptance criteria, one per line
                </Label>
                <textarea
                  id={`${field}-criteria`}
                  value={draft.acceptanceCriteria.join("\n")}
                  maxLength={maxGrillingCriterionLength * 10}
                  rows={Math.max(2, draft.acceptanceCriteria.length)}
                  disabled={off}
                  onChange={(event) => {
                    update(draft.id, {
                      acceptanceCriteria: event.target.value.split("\n"),
                    });
                  }}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs"
                />
              </div>
              {others.length > 0 && (
                <fieldset className="space-y-1">
                  <legend className="text-xs font-medium">Blocked by</legend>
                  {others.map((other) => {
                    const otherName = draftName(drafts.indexOf(other), other);
                    return (
                      <label
                        key={other.id}
                        className="flex items-center gap-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          aria-label={`${name} is blocked by ${otherName}`}
                          checked={draft.blockedBy.includes(other.id)}
                          disabled={off}
                          onChange={(event) => {
                            update(draft.id, {
                              blockedBy: event.target.checked
                                ? [...draft.blockedBy, other.id]
                                : draft.blockedBy.filter(
                                    (id) => id !== other.id,
                                  ),
                            });
                          }}
                        />
                        {otherName}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {(draft.prdSections.length > 0 || draft.adrs.length > 0) && (
                <p className="text-xs text-muted-foreground">
                  Cites{" "}
                  {[
                    ...draft.prdSections.map(
                      (heading) => `the PRD's § ${heading}`,
                    ),
                    ...draft.adrs.map((title) => `the ADR "${title}"`),
                  ].join(", ")}
                  .
                </p>
              )}
              {others.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <Label htmlFor={`${field}-merge`} className="text-xs">
                    Merge it into
                  </Label>
                  <select
                    id={`${field}-merge`}
                    value=""
                    disabled={off}
                    onChange={(event) => {
                      const into = Number(event.target.value);
                      if (into > 0) {
                        setDrafts(mergeIssueDrafts(drafts, into, draft.id));
                      }
                    }}
                    className={cn(selectClass, "w-auto min-w-0 flex-1")}
                  >
                    <option value="">Choose an issue…</option>
                    {others.map((other) => (
                      <option key={other.id} value={other.id}>
                        {draftName(drafts.indexOf(other), other)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {problem !== undefined && (
        <p role="status" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {refused !== null && (
        <p role="alert" className="text-sm text-destructive">
          {refused}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={off || problem !== undefined}
          onClick={() => {
            void (async () => {
              if (
                (!edited || (await save())) &&
                !(await onSend(fileGrillingIssuesText(session.id)))
              ) {
                setRefused("The issues were not filed.");
              }
            })();
          }}
        >
          <CheckCheck aria-hidden />
          Approve and file {drafts.length}{" "}
          {drafts.length === 1 ? "issue" : "issues"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={off || !edited || problem !== undefined}
          onClick={() => void save()}
        >
          <Save aria-hidden />
          Save edits
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={off || !edited}
          onClick={() => {
            setDrafts(editsOf(issues));
            setRefused(null);
          }}
        >
          <Undo2 aria-hidden />
          Undo edits
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={off}
          onClick={() => void onSend(draftGrillingIssuesText(session.id))}
        >
          <RotateCcw aria-hidden />
          Draft again
        </Button>
      </div>
    </div>
  );
}

/**
 * An ended session's issues (FR-81): drafted by the Manager, edited and
 * approved by the Owner, then filed by the GitHub App, each with a link.
 */
function GrillingIssuesPart({
  floorId,
  session,
  disabled,
  onSend,
}: {
  floorId: string;
  session: GrillingSession;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { issues } = session;
  if (issues === null) {
    return session.status === "ended" ? (
      <div className="space-y-1">
        <p className="text-muted-foreground">Not drafted yet.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void onSend(draftGrillingIssuesText(session.id))}
        >
          <FilePlus2 aria-hidden />
          Draft the issues
        </Button>
      </div>
    ) : (
      <p className="text-muted-foreground">
        Drafted once the session ends and its documents&apos; pull request is
        open.
      </p>
    );
  }
  const filed = issues.drafts.filter(({ filed: issue }) => issue !== null);
  if (filed.length === 0) {
    return (
      <IssueDraftsEditor
        // Drafted again: the editor starts afresh.
        key={issues.draftedAt}
        floorId={floorId}
        session={session}
        issues={issues}
        disabled={disabled}
        onSend={onSend}
      />
    );
  }
  return (
    <div className="space-y-2">
      <ol aria-label="The issues filed" className="space-y-1">
        {issues.drafts.map((draft) => (
          <li key={draft.id}>
            {draft.filed === null ? (
              <span className="text-muted-foreground">Not filed yet:</span>
            ) : (
              <a
                href={draft.filed.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                #{draft.filed.number}
              </a>
            )}{" "}
            {draft.title}
          </li>
        ))}
      </ol>
      {issues.problem !== null && (
        <p role="status" className="text-destructive">
          Filing stopped: {issues.problem}
        </p>
      )}
      {filed.length < issues.drafts.length && (
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => void onSend(fileGrillingIssuesText(session.id))}
        >
          <Send aria-hidden />
          File the rest
        </Button>
      )}
    </div>
  );
}

/**
 * One session in full: its decisions, terms, the facts found in the
 * repository (FR-79), its documents (FR-80), its issues (FR-81), its
 * questions and every message.
 */
function GrillingSessionDialog({
  floorId,
  sessionId,
  disabled,
  onSend,
  onClose,
}: {
  floorId: string;
  sessionId: number | undefined;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { data, isError } = useQuery({
    ...grillingSessionQuery(floorId, sessionId ?? 0),
    enabled: sessionId !== undefined,
  });
  const session = data?.session;
  const rounds = [
    ...new Set(
      (session?.questions ?? []).flatMap(({ round }) =>
        round === null ? [] : [round],
      ),
    ),
  ];
  const waiting = (session?.questions ?? []).filter(
    ({ round }) => round === null,
  );
  return (
    <Dialog
      open={sessionId !== undefined}
      onClose={onClose}
      title={session === undefined ? "Grilling Session" : sessionTitle(session)}
      closeLabel="Close the Grilling Session"
      className="w-[min(60rem,calc(100vw-2rem))]"
    >
      {isError && (
        <p role="alert" className="text-destructive">
          The session could not be read.
        </p>
      )}
      {session !== undefined && data !== undefined && (
        <div className="space-y-5 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <GrillingStatus status={session.status} />
            Started with <code>/{session.skill}</code>{" "}
            {new Date(session.startedAt).toLocaleString("en-GB")}
            {session.endedAt !== null &&
              `, ended ${new Date(session.endedAt).toLocaleString("en-GB")}`}
          </p>
          {session.sources.length > 0 && (
            <section className="space-y-1">
              <h3 className="font-semibold">The plan it broke down</h3>
              <ul className="list-disc space-y-1 pl-6">
                {session.sources.map((source) => (
                  <li key={source.path}>
                    <code>{source.path}</code>
                    {source.content === null && (
                      <span className="text-muted-foreground">
                        {" "}
                        (could not be read)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="space-y-1">
            <h3 className="font-semibold">Settled decisions</h3>
            {session.decisions.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <ol className="list-decimal space-y-1 pl-6">
                {session.decisions.map((decision) => (
                  <li key={decision.number}>{decision.text}</li>
                ))}
              </ol>
            )}
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold">Glossary terms</h3>
            {session.terms.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <dl className="space-y-1">
                {session.terms.map((term) => (
                  <div key={term.term}>
                    <dt className="font-medium">{term.term}</dt>
                    <dd>
                      {term.definition}
                      {term.avoid.length > 0 && (
                        <span className="text-muted-foreground">
                          {" "}
                          Avoid: {term.avoid.join(", ")}.
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold">Facts found in the repository</h3>
            {session.facts.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <ol className="space-y-2">
                {session.facts.map((fact) => (
                  <li
                    key={fact.number}
                    aria-label={`F${String(fact.number)}. ${fact.question}`}
                    className="rounded-md border p-2"
                  >
                    <p className="font-medium">
                      F{fact.number}. {fact.question}
                    </p>
                    <p className="whitespace-pre-wrap">
                      {fact.status === "failed" && (
                        <span className="text-muted-foreground">
                          Not found:{" "}
                        </span>
                      )}
                      {fact.answer}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold">The documents</h3>
            <DocumentsState documents={session.documents} />
            <h4 className="font-medium">The PRD&apos;s outline</h4>
            <Outline outline={session.outline} level={5} />
            {session.adrs.length > 0 && (
              <>
                <h4 className="font-medium">ADRs</h4>
                <ul className="list-disc space-y-1 pl-6">
                  {session.adrs.map((adr) => (
                    <li key={adr.title}>
                      <span className="font-medium">{adr.title}</span>:{" "}
                      {adr.decision}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {session.processes.length > 0 && (
              <>
                <h4 className="font-medium">Process docs</h4>
                <ul className="list-disc space-y-1 pl-6">
                  {session.processes.map((process) => (
                    <li key={process.title}>{process.title}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold">Issues</h3>
            <GrillingIssuesPart
              floorId={floorId}
              session={session}
              disabled={disabled}
              onSend={onSend}
            />
          </section>
          {rounds.map((round) => (
            <section key={round} className="space-y-1">
              <h3 className="font-semibold">Round {round}</h3>
              <ol className="space-y-2">
                {session.questions
                  .filter((question) => question.round === round)
                  .map((question) => (
                    <QuestionCard
                      key={question.number}
                      question={question}
                      draft={undefined}
                      onDraft={() => undefined}
                      interactive={false}
                    />
                  ))}
              </ol>
            </section>
          ))}
          {waiting.length > 0 && (
            <section className="space-y-1">
              <h3 className="font-semibold">Not yet asked</h3>
              <ol className="space-y-2">
                {waiting.map((question) => (
                  <QuestionCard
                    key={question.number}
                    question={question}
                    draft={undefined}
                    onDraft={() => undefined}
                    interactive={false}
                  />
                ))}
              </ol>
            </section>
          )}
          <section className="space-y-1">
            <h3 className="font-semibold">Conversation</h3>
            <ol className="space-y-2">
              {data.messages.map((message) => (
                <li key={message.id} data-kind={message.kind}>
                  <p className="text-xs text-muted-foreground">
                    {message.kind === "owner" ? "You" : "The Manager"}
                  </p>
                  <p className="whitespace-pre-wrap">{message.text}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Dialog>
  );
}

/**
 * The Floor's Grilling Sessions, newest first, beside the chat: each can be
 * read in full, and a paused one resumed.
 */
export function GrillingSessionList({
  floorId,
  disabled,
  onSend,
}: {
  floorId: string;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { data, isError } = useQuery(grillingSessionsQuery(floorId));
  const [reading, setReading] = useState<number | undefined>();
  const running = data?.sessions.some(({ status }) => status === "active");
  return (
    <>
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          The Grilling Sessions could not be read.
        </p>
      )}
      {data?.sessions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          None yet. Run <code>/grilling</code> with what to grill, or{" "}
          <code>/grill-with-docs</code>, <code>/wayfinder</code>,{" "}
          <code>/to-tickets</code> or <code>/to-spec</code>.
        </p>
      )}
      <ul className="space-y-2">
        {data?.sessions.map((session) => (
          <li
            key={session.id}
            className="space-y-1 rounded-lg border p-2 text-sm"
          >
            <p className="flex items-center gap-2">
              <span className="font-medium">{sessionTitle(session)}</span>
              <GrillingStatus status={session.status} />
            </p>
            <p className="text-xs text-muted-foreground">
              <code>/{session.skill}</code> · {session.round}{" "}
              {session.round === 1 ? "round" : "rounds"} ·{" "}
              {session.decisionCount}{" "}
              {session.decisionCount === 1 ? "decision" : "decisions"} ·{" "}
              {session.openQuestions} open
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Read ${sessionTitle(session)}`}
                onClick={() => {
                  setReading(session.id);
                }}
              >
                Read
              </Button>
              {session.status === "paused" && (
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Resume ${sessionTitle(session)}`}
                  disabled={disabled || running === true}
                  onClick={() => {
                    void onSend(resumeGrillingText(session.id));
                  }}
                >
                  <Play aria-hidden />
                  Resume
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <GrillingSessionDialog
        floorId={floorId}
        sessionId={reading}
        disabled={disabled}
        onSend={onSend}
        onClose={() => {
          setReading(undefined);
        }}
      />
    </>
  );
}
