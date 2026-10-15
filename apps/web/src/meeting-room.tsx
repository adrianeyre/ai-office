import {
  draftGrillingIssuesText,
  grillWithDocsSkillName,
  managerChatFileListSchema,
  toTicketsSkillName,
  wayfinderSkillName,
  type GrillingSessionSummary,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  ListChecks,
  Megaphone,
  MessageSquare,
  OctagonPause,
  Play,
  Rocket,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { cn } from "@/lib/utils.ts";

import { getJson } from "./api.ts";
import {
  grillingQueryKey,
  grillingSessionQuery,
  grillingSessionsQuery,
} from "./grilling.tsx";
import { HourlyStatusUpdatesSwitch } from "./hourly-status-setting.tsx";
import { useChatSender } from "./manager-chat.tsx";
import type { InspectableObject } from "./scene/inspectable.ts";
import { openAgentChat, openInspectable } from "./scene/inspection.ts";
import { useMeetingRoomCall } from "./scene/meeting-room-call.ts";
import { MovablePanel } from "./scene/movable-panel.tsx";
import { StopEverything } from "./floor-stop.tsx";
import { StatusUpdateButton } from "./status-update.tsx";

// The Meeting Room (over a Floor's 3D view): the Owner calls the whole
// Floor to the meeting room (meeting-room-call.ts) and this panel lays out
// the day's work there, each a card that says what it does and where its
// result goes:
//
// 1. Write a PRD: a Grilling Session, as Matt Pocock's grill-with-docs
//    (one feature) or wayfinder (a large effort) runs it, the PRD going to
//    docs/product-requirements-document and any ADRs to
//    docs/architectural-decision-record, in one pull request.
// 2. File GitHub issues: drafted from a session's decisions, or broken
//    out of a PRD or ADR already on the default branch with to-tickets.
// 3. Complete issues: a Batch, by default in one pull request.
// 4. Status update: one now, and hourly while the Agents work.
//
// Each sends what the Owner would type in the Manager chat, so the chat
// answers as ever and keeps the conversation; the chat opens on it.

/** Where a Floor's PRDs and ADRs are, as the cards say and list them. */
export const prdDirectory = "docs/product-requirements-document";
export const adrDirectory = "docs/architectural-decision-record";

/** How many ended sessions the issues card offers. */
const recentSessions = 3;

/** "complete issues 1 to 10 in one PR", from what the Owner typed. */
export function completeIssuesText(issues: string, onePullRequest: boolean) {
  const said = issues
    .trim()
    .replace(/^(?:complete\s+)?(?:issues?\s+)?/i, "")
    .trim();
  return `complete issues ${said}${onePullRequest ? " in one PR" : ""}`;
}

/** The skill command that starts writing a PRD of `topic`. */
export function writePrdText(kind: "feature" | "effort", topic: string) {
  const name = kind === "feature" ? grillWithDocsSkillName : wayfinderSkillName;
  return `/${name} ${topic.trim()}`.trim();
}

/** The issue numbers a session's drafts were filed as, lowest first. */
function filedIssues(session: {
  issues: { drafts: { filed: { number: number } | null }[] } | null;
}): number[] {
  return (session.issues?.drafts ?? [])
    .flatMap(({ filed }) => (filed === null ? [] : [filed.number]))
    .sort((a, b) => a - b);
}

/** "12 to 15", or "12, 14 and 15" when they are not a run. */
export function issueRange(numbers: readonly number[]): string {
  if (numbers.length === 0) {
    return "";
  }
  const first = numbers[0] ?? 0;
  const last = numbers.at(-1) ?? 0;
  if (numbers.length > 1 && last - first === numbers.length - 1) {
    return `${String(first)} to ${String(last)}`;
  }
  return numbers.length === 1
    ? String(first)
    : `${numbers.slice(0, -1).join(", ")} and ${String(last)}`;
}

function Card({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border bg-card/60 p-3"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-0.5 rounded-md bg-accent p-1.5 text-accent-foreground [&_svg]:size-4"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="font-medium">
            {title}
          </h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** A document's file name without its folder: the PRD and ADR folders go without saying. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The PRDs and ADRs on the Floor's default branch, for to-tickets. */
function usePlanDocuments(floorId: string) {
  const files = (directory: string) => ({
    queryKey: ["floors", floorId, "manager-chat-files", `${directory}/`],
    queryFn: async () =>
      (
        await getJson(
          `/api/floors/${encodeURIComponent(floorId)}/manager-chat/files?query=${encodeURIComponent(`${directory}/`)}`,
          managerChatFileListSchema,
        )
      ).files.filter(
        (path) => path.startsWith(`${directory}/`) && path.endsWith(".md"),
      ),
    staleTime: 30_000,
  });
  const prds = useQuery(files(prdDirectory));
  const adrs = useQuery(files(adrDirectory));
  return {
    documents: [...(prds.data ?? []), ...(adrs.data ?? [])],
    loading: prds.isPending || adrs.isPending,
  };
}

/** One ended session in the issues card: draft its issues, or read them. */
function SessionIssues({
  floorId,
  summary,
  sending,
  onSend,
  onRead,
  onFiled,
}: {
  floorId: string;
  summary: GrillingSessionSummary;
  sending: boolean;
  onSend: (text: string) => void;
  onRead: () => void;
  /** Told the issues filed for it, to offer them to complete. */
  onFiled: (numbers: readonly number[]) => void;
}) {
  const { data } = useQuery(grillingSessionQuery(floorId, summary.id));
  const session = data?.session;
  const filed = session === undefined ? [] : filedIssues(session);
  const drafted = session?.issues !== null && session?.issues !== undefined;
  const filedKey = filed.join(",");
  const told = useRef("");
  useEffect(() => {
    if (filedKey !== "" && told.current !== filedKey) {
      told.current = filedKey;
      onFiled(filedKey.split(",").map(Number));
    }
  }, [filedKey, onFiled]);
  const topic = summary.topic === "" ? "No topic" : summary.topic;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate" title={topic}>
        Session {summary.id}: {topic}
        <span className="block text-xs text-muted-foreground">
          {filed.length > 0
            ? `Filed as issues ${issueRange(filed)}`
            : drafted
              ? "Issues drafted, waiting for you"
              : `${String(summary.decisionCount)} decisions settled`}
        </span>
      </span>
      {filed.length > 0 || drafted ? (
        <Button type="button" size="sm" variant="outline" onClick={onRead}>
          {filed.length > 0 ? "Read" : "Review and file"}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={sending || session === undefined}
          onClick={() => {
            onSend(draftGrillingIssuesText(summary.id));
          }}
        >
          Draft issues
        </Button>
      )}
    </li>
  );
}

/**
 * The Meeting Room's panel: the day's work, each as a card. `manager` is
 * the Floor's Manager, whose chat each card's message opens; `session`
 * the running Grilling Session's object, if one runs.
 */
export function MeetingRoomPanel({
  floorId,
  manager,
  session,
  className,
}: {
  floorId: string;
  manager: InspectableObject;
  session: InspectableObject | undefined;
  className?: string;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const close = useMeetingRoomCall((state) => state.closePanel);
  const { send, sending, problem, ready } = useChatSender(floorId);
  const { data } = useQuery(grillingSessionsQuery(floorId));
  const sessions = data?.sessions ?? [];
  const paused = sessions.find(({ status }) => status === "paused");
  const ended = sessions
    .filter(({ status }) => status === "ended")
    .slice(0, recentSessions);
  const { documents, loading } = usePlanDocuments(floorId);

  const [prdKind, setPrdKind] = useState<"feature" | "effort">("feature");
  const [topic, setTopic] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  // What the Owner typed; until they type, the issues a session filed.
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [filed, setFiled] = useState<readonly number[]>([]);
  const issues = typed ?? issueRange(filed);
  const [onePullRequest, setOnePullRequest] = useState(true);
  // A Grilling Session asked for: its chat opens once it runs.
  const opening = useRef(false);
  // The same, for what the button says while it starts.
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (opening.current && session !== undefined) {
      opening.current = false;
      close();
      openInspectable(session);
    }
  }, [session, close]);

  /** Sends `text` to the Manager and opens its chat on the answer. */
  const ask = (text: string, { startsSession = false } = {}) => {
    if (startsSession) {
      opening.current = true;
      setStarting(true);
    }
    void send(text).then((sent) => {
      setStarting(false);
      if (!sent) {
        opening.current = false;
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: grillingQueryKey(floorId),
      });
      if (!startsSession) {
        close();
        openAgentChat(manager);
      }
    });
  };

  const field = (name: string) => `${id}-${name}`;
  return (
    <MovablePanel
      layoutKey="meeting-room"
      role="region"
      title="Meeting Room"
      description="Everyone is at the table. Pick what to do; the Manager's chat opens on it."
      onClose={close}
      closeLabel="Close the Meeting Room"
      widthClass="w-[min(28rem,calc(100vw-2rem))]"
      className={cn("pointer-events-auto max-h-full", className)}
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}

        <Card
          icon={<FileText />}
          title="Write a PRD"
          description={
            <>
              The Manager asks you questions, each with its recommended answer,
              then writes the PRD in <code>{prdDirectory}</code> and any ADRs in{" "}
              <code>{adrDirectory}</code>, in one pull request.
            </>
          }
        >
          {session !== undefined ? (
            <Button
              type="button"
              className="w-full"
              onClick={() => {
                close();
                openInspectable(session);
              }}
            >
              <Play aria-hidden />
              Carry on with the running session
            </Button>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                ask(writePrdText(prdKind, topic), { startsSession: true });
              }}
            >
              <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <legend className="sr-only">How big is it?</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={field("prd-kind")}
                    className="size-4"
                    checked={prdKind === "feature"}
                    onChange={() => {
                      setPrdKind("feature");
                    }}
                  />
                  One feature{" "}
                  <span className="text-muted-foreground">
                    (grill-with-docs)
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={field("prd-kind")}
                    className="size-4"
                    checked={prdKind === "effort"}
                    onChange={() => {
                      setPrdKind("effort");
                    }}
                  />
                  A large effort{" "}
                  <span className="text-muted-foreground">(wayfinder)</span>
                </label>
              </fieldset>
              <label htmlFor={field("topic")} className="text-sm font-medium">
                What is it?
              </label>
              <textarea
                id={field("topic")}
                rows={2}
                value={topic}
                onChange={(event) => {
                  setTopic(event.target.value);
                }}
                className="w-full rounded-lg border border-input bg-card px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  pending={starting}
                  disabled={!ready || topic.trim() === ""}
                >
                  <FileText aria-hidden />
                  {starting ? "Starting…" : "Start grilling"}
                </Button>
                {paused !== undefined && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!ready}
                    onClick={() => {
                      ask(`resume session ${String(paused.id)}`, {
                        startsSession: true,
                      });
                    }}
                  >
                    Resume session {paused.id}
                  </Button>
                )}
              </div>
            </form>
          )}
        </Card>

        <Card
          icon={<ListChecks />}
          title="File GitHub issues"
          description="Draft them from a session's decisions, or break a PRD or ADR already on the default branch into tracer-bullet issues (to-tickets). You review every draft before it is filed."
        >
          {ended.length > 0 && (
            <ul aria-label="Ended Grilling Sessions" className="space-y-2">
              {ended.map((summary) => (
                <SessionIssues
                  key={summary.id}
                  floorId={floorId}
                  summary={summary}
                  sending={sending}
                  onSend={(text) => {
                    ask(text);
                  }}
                  onRead={() => {
                    close();
                    openAgentChat(manager);
                  }}
                  onFiled={setFiled}
                />
              ))}
            </ul>
          )}
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              ask(`/${toTicketsSkillName} ${chosen.join(" ")}`, {
                startsSession: true,
              });
            }}
          >
            {/* A fieldset is as wide as its content unless told otherwise, so
                min-w-0 lets a long file name truncate rather than overflow. */}
            <fieldset className="min-w-0 space-y-1 text-sm">
              <legend className="font-medium">From a PRD or ADR</legend>
              {loading ? (
                <p className="text-xs text-muted-foreground">
                  Reading the repository…
                </p>
              ) : documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  None on the default branch yet: write a PRD first.
                </p>
              ) : (
                <ul className="max-h-36 space-y-1 overflow-y-auto">
                  {documents.map((path) => (
                    <li key={path}>
                      <label
                        className="flex min-w-0 items-center gap-2"
                        title={path}
                      >
                        <input
                          type="checkbox"
                          className="size-4 shrink-0"
                          checked={chosen.includes(path)}
                          onChange={(event) => {
                            setChosen((before) =>
                              event.target.checked
                                ? [...before, path]
                                : before.filter((each) => each !== path),
                            );
                          }}
                        />
                        <span className="min-w-0 truncate font-mono text-xs">
                          {fileName(path)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <Button
              type="submit"
              variant="outline"
              disabled={
                !ready ||
                sending ||
                chosen.length === 0 ||
                session !== undefined
              }
            >
              <ListChecks aria-hidden />
              Break into issues
            </Button>
          </form>
        </Card>

        <Card
          icon={<Rocket />}
          title="Complete issues"
          description="The Floor's Agents work them as a Batch: code, review and QA for each, then merged as the Merge Policy allows."
        >
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              ask(completeIssuesText(issues, onePullRequest));
            }}
          >
            <label htmlFor={field("issues")} className="text-sm font-medium">
              Issues
            </label>
            <Input
              id={field("issues")}
              value={issues}
              placeholder="1 to 10"
              aria-describedby={field("issues-help")}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
            <p
              id={field("issues-help")}
              className="text-xs text-muted-foreground"
            >
              A range or a list: 1 to 10, or 3, 5 and 8.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={onePullRequest}
                onChange={(event) => {
                  setOnePullRequest(event.target.checked);
                }}
              />
              In one pull request
            </label>
            <Button
              type="submit"
              disabled={!ready || sending || issues.trim() === ""}
            >
              <Rocket aria-hidden />
              Start work
            </Button>
          </form>
        </Card>

        <Card
          icon={<Megaphone />}
          title="Status update"
          description="What each Agent did and does next, a turn each at the table. Kept in the Manager's chat too."
        >
          <div className="flex flex-wrap items-center gap-3">
            <StatusUpdateButton floorId={floorId} />
            <HourlyStatusUpdatesSwitch floorId={floorId} />
          </div>
        </Card>

        <Card
          icon={<OctagonPause />}
          title="Stop everything"
          description="Every Agent on the Floor stops at once: their work waits in the queue until you let them continue where they were."
        >
          <StopEverything floorId={floorId} />
        </Card>

        <Card
          icon={<MessageSquare />}
          title="Something else"
          description="Ask the Manager anything, or run any of the Floor's Skills with /name."
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              close();
              openAgentChat(manager);
            }}
          >
            <MessageSquare aria-hidden />
            Chat with the Manager
          </Button>
        </Card>
      </div>
    </MovablePanel>
  );
}
