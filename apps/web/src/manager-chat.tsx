import {
  chatAttachmentMediaTypes,
  managerChatFrameSchema,
  managerChatSchema,
  managerChatSendResponseSchema,
  managerCommandExamples,
  maxManagerChatMessageLength,
  type ManagerChat,
  type ManagerChatFrame,
  type ManagerChatMessage,
  type ManagerChatToolUse,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Paperclip, Send } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { cn } from "@/lib/utils.ts";

import { AgentLink } from "./agent-link.tsx";
import { getJson, postJson, readApiError } from "./api.ts";
import { AvailableSkillList, withSkillCommand } from "./available-skills.tsx";
import {
  DraftAttachments,
  MessageAttachments,
  useChatAttachments,
} from "./chat-attachments.tsx";
import {
  PendingReply,
  WaitingNote,
  WaitingSweep,
} from "./chat-pending-reply.tsx";
import { ChatTaskList, managerChatTasksQuery } from "./chat-task-list.tsx";
import { ToolUses } from "./chat-tool-use.tsx";
import { useContextUsage } from "./context-usage.tsx";
import {
  eventSources,
  type EventSourceLike,
  type EventStreamStatus,
} from "./event-stream.ts";
import { useFileMentions } from "./file-mention-autocomplete.tsx";
import { floorQuery } from "./floors.ts";
import {
  GrillingBar,
  GrillingRound,
  GrillingSessionList,
  grillingQueryKey,
} from "./grilling.tsx";
import { ManagerModelPicker } from "./manager-model-picker.tsx";
import { ManagerStatusLine } from "./manager-status-line.tsx";
import { sessionQuery } from "./session.ts";
import { useSkillAutocomplete } from "./skill-autocomplete.tsx";

// The Manager chat (PRD FR-24): the Owner talks with a Floor's Manager.
// The conversation is kept per Floor and read when the chat opens; then
// its messages, and the Manager's replies as its Model writes them, stream
// in over server-sent events (§8). Commands are answered by AI Office
// itself, at once, with what it understood; `/skill-name` runs one of the
// Floor's Skills (FR-74), autocompleted from them. `/grilling` starts a
// Grilling Session (FR-77), whose rounds are shown as question cards
// (`grilling.tsx`). `/clear` and `/compact` clear the conversation the
// Manager's Model is given or replace it with a summary (FR-87), shown as
// dividers, and the header shows the Manager's status line: its Context
// Usage, its tokens against its Token Caps and its subscription's plan
// usage (`manager-status-line.tsx`). This 2D page
// holds the panel; the Manager's glass office in the 3D office will open
// the same one.
//
// The chat is a read-only agent session, as Claude Code is (FR-24, ADR
// 0004): each reply shows the tools it used, collapsed; the Owner may
// attach files and images, mention the repository's files with `@`, and
// send while the Manager is still writing, which interrupts it; a live
// task list shows the work each request spun off, each task opening its
// Agent's or Contractor's live view; and the header chooses the Manager's
// Model and effort.

/** What the file picker offers: the types an attachment may be. */
const chatAttachmentAccept = [
  ...chatAttachmentMediaTypes,
  ".md",
  ".log",
  ".yaml",
  ".yml",
  ".ndjson",
].join(",");

const chatUrl = (floorId: string) =>
  `/api/floors/${encodeURIComponent(floorId)}/manager-chat`;

/** A Floor's chat so far (`GET /api/floors/:floorId/manager-chat`). */
export const managerChatQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "manager-chat"],
    queryFn: () => getJson(chatUrl(floorId), managerChatSchema),
    // New messages come by the stream.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

/** Whether the Manager has answered the Owner's message `replyTo`. */
const answered = (chat: ManagerChat, replyTo: number): boolean =>
  chat.messages.some((message) => message.replyTo === replyTo);

/** `chat` with `message` in id order, once; its reply is no longer pending. */
export function withMessage(
  chat: ManagerChat,
  message: ManagerChatMessage,
): ManagerChat {
  const pending = chat.pending.filter(
    ({ replyTo }) => replyTo !== message.replyTo,
  );
  if (chat.messages.some(({ id }) => id === message.id)) {
    return { ...chat, pending };
  }
  return {
    ...chat,
    messages: [...chat.messages, message].sort((a, b) => a.id - b.id),
    pending,
  };
}

/** `chat` with one frame of the stream applied. */
export function withFrame(
  chat: ManagerChat,
  frame: ManagerChatFrame,
): ManagerChat {
  if (frame.type === "message") {
    return withMessage(chat, frame.message);
  }
  // A tool frame is kept beside the chat (`withToolFrame`).
  if (frame.type !== "pending" && frame.type !== "delta") {
    return chat;
  }
  if (answered(chat, frame.replyTo)) {
    return chat;
  }
  const others = chat.pending.filter(
    ({ replyTo }) => replyTo !== frame.replyTo,
  );
  const sofar =
    chat.pending.find(({ replyTo }) => replyTo === frame.replyTo)?.text ?? "";
  return {
    ...chat,
    pending: [
      ...others,
      {
        replyTo: frame.replyTo,
        text: frame.type === "pending" ? frame.text : sofar + frame.text,
      },
    ],
  };
}

/** The tools each reply being written has used so far, by the message it answers. */
export type LiveTools = Readonly<Record<number, readonly ManagerChatToolUse[]>>;

/**
 * `tools` with one frame of the stream applied: a `tool` frame adds to its
 * reply's, and the reply kept (a `message` frame) ends them.
 */
export function withToolFrame(
  tools: LiveTools,
  frame: ManagerChatFrame,
): LiveTools {
  if (frame.type === "tool") {
    return {
      ...tools,
      [frame.replyTo]: [...(tools[frame.replyTo] ?? []), frame.tool],
    };
  }
  const replyTo = frame.type === "message" ? frame.message.replyTo : null;
  if (replyTo === null || !(replyTo in tools)) {
    return tools;
  }
  return Object.fromEntries(
    Object.entries(tools).filter(([key]) => key !== String(replyTo)),
  );
}

/** The longest wait between reconnection attempts. */
const maxBackoffMs = 30_000;

/**
 * Keeps the Floor's chat stream open while `enabled`, applying each frame
 * to the chat's query. When the browser gives up on it, it reconnects
 * itself with growing waits, resuming after the last message it has.
 */
function useManagerChatStream(
  floorId: string,
  enabled: boolean,
): { status: EventStreamStatus; liveTools: LiveTools } {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventStreamStatus>("connecting");
  const [liveTools, setLiveTools] = useState<LiveTools>({});
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const { queryKey } = managerChatQuery(floorId);
    let source: EventSourceLike | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const open = (): void => {
      const last =
        queryClient.getQueryData<ManagerChat>(queryKey)?.messages.at(-1)?.id ??
        0;
      const current = eventSources.open(
        `${chatUrl(floorId)}/stream?lastEventId=${String(last)}`,
      );
      source = current;
      current.onopen = () => {
        failures = 0;
        setStatus("open");
      };
      current.onmessage = (message) => {
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        // The task list changed (FR-24, ADR 0004): fetched again. A new
        // message may mean so too, below.
        const refetchTasks = () => {
          void queryClient.invalidateQueries({
            queryKey: managerChatTasksQuery(floorId).queryKey,
          });
        };
        if (
          typeof data === "object" &&
          data !== null &&
          (data as { type?: unknown }).type === "tasks"
        ) {
          refetchTasks();
          return;
        }
        const frame = managerChatFrameSchema.safeParse(data);
        if (frame.success) {
          setLiveTools((tools) => withToolFrame(tools, frame.data));
          if (frame.data.type === "message") {
            refetchTasks();
          }
          queryClient.setQueryData<ManagerChat>(queryKey, (chat) =>
            chat === undefined ? chat : withFrame(chat, frame.data),
          );
          // A Grilling Session's message: its state has changed.
          if (
            frame.data.type === "message" &&
            frame.data.message.grilling !== null
          ) {
            void queryClient.invalidateQueries({
              queryKey: grillingQueryKey(floorId),
            });
          }
        }
      };
      current.onerror = () => {
        setStatus("reconnecting");
        // EventSource.CLOSED: the browser will not reconnect by itself.
        if (current.readyState !== 2) {
          return;
        }
        current.close();
        void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
        failures += 1;
        retry = setTimeout(
          open,
          Math.min(maxBackoffMs, 1000 * 2 ** (failures - 1)),
        );
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [floorId, enabled, queryClient]);
  return { status, liveTools };
}

/**
 * What can be typed in the box: shown under it, or, compact, folded under
 * a summary so a narrow panel keeps its room for the conversation.
 */
function HintText({
  id,
  compact,
  children,
}: {
  id: string;
  compact: boolean;
  children: ReactNode;
}) {
  if (!compact) {
    return (
      <p id={id} className="text-xs text-muted-foreground">
        {children}
      </p>
    );
  }
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">What you can type</summary>
      <p id={id} className="mt-1 break-words">
        {children}
      </p>
    </details>
  );
}

/** A round's message, without the questions its cards show. */
export const roundPreamble = (text: string): string =>
  text.split(/(?:^|\n)Round \d+: \d+ questions?\./)[0]?.trim() ?? "";

function Message({
  floorId,
  message,
  managerName,
  round,
}: {
  floorId: string;
  message: ManagerChatMessage;
  managerName: string;
  /** A round's question cards, shown in place of its questions' text. */
  round?: ReactNode;
}) {
  const skill =
    message.skill === null ? null : (
      <Badge tone="violet" className="font-mono">
        Skill /{message.skill.name}
      </Badge>
    );
  if (message.kind === "clear") {
    return (
      <div
        role="separator"
        aria-label="Conversation cleared"
        className="flex items-center gap-3 text-xs text-muted-foreground"
      >
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="max-w-[80%] text-center">{message.text}</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (message.kind === "summary") {
    const { compaction } = message;
    return (
      <div className="space-y-1 rounded-lg border border-dashed p-3 text-sm">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone="neutral">Compacted</Badge>
          {compaction?.trigger === "auto"
            ? `Automatically, at ${compaction.contextUsage === null ? "its threshold" : `${String(Math.floor(compaction.contextUsage * 100))}% Context Usage`}`
            : "With /compact"}
          {compaction !== null &&
            `: ${String(compaction.messages)} earlier ${compaction.messages === 1 ? "message" : "messages"} replaced by ${managerName}'s summary.`}
        </p>
        <details>
          <summary className="cursor-pointer text-xs">
            The summary {managerName} carries on from
          </summary>
          <p className="mt-1 whitespace-pre-wrap">{message.text}</p>
        </details>
      </div>
    );
  }
  if (message.kind === "owner") {
    return (
      <div className="ml-auto max-w-[80%] space-y-1 text-right">
        <p className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {skill}
          You
        </p>
        {message.text !== "" && (
          <p className="inline-block rounded-lg bg-primary px-3 py-2 text-left whitespace-pre-wrap text-primary-foreground">
            {message.text}
          </p>
        )}
        <MessageAttachments
          floorId={floorId}
          attachments={message.attachments}
          align="end"
        />
      </div>
    );
  }
  return (
    <div className="max-w-[80%] space-y-1">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {managerName}
        {message.kind === "command" && <Badge tone="info">Command</Badge>}
        {message.kind === "hint" && (
          <Badge tone="warning">Not understood</Badge>
        )}
        {message.kind === "report" && (
          <Badge tone="success">Status report</Badge>
        )}
        {/* A chat request's Plan, and the Manager reporting back on it
            (FR-24, ADR 0004). */}
        {message.kind === "plan" && <Badge tone="indigo">Plan</Badge>}
        {message.kind === "progress" && <Badge tone="neutral">Progress</Badge>}
        {message.grilling !== null && (
          <Badge tone="success">
            {message.grilling.round === null
              ? "Grilling Session"
              : `Round ${String(message.grilling.round)}`}
          </Badge>
        )}
        {skill}
      </p>
      {(round === undefined || roundPreamble(message.text) !== "") && (
        <p
          className={cn(
            "inline-block rounded-lg px-3 py-2 whitespace-pre-wrap",
            message.kind === "error"
              ? "border border-destructive/40 text-destructive"
              : message.kind === "progress"
                ? "border text-sm text-muted-foreground"
                : "bg-muted",
          )}
        >
          {round === undefined ? message.text : roundPreamble(message.text)}
        </p>
      )}
      <ToolUses tools={message.tools} />
      {round}
    </div>
  );
}

/**
 * Sends the Owner's messages to a Floor's Manager, with the ids of any
 * files attached, putting each in the chat's query with its answer, or a
 * pending reply while the Model writes it. Sent while the Manager is still
 * writing, a message interrupts it (FR-24, ADR 0004): the server ends that
 * reply, and the new one is awaited in its place. While the Manager is
 * carrying out a request, the server refuses it, saying so. `send`
 * answers whether it was sent; `problem` says why not.
 */
export function useChatSender(floorId: string) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const send = async (
    message: string,
    attachments: readonly string[] = [],
  ): Promise<boolean> => {
    if ((message === "" && attachments.length === 0) || sending) {
      return false;
    }
    setSending(true);
    setProblem(undefined);
    try {
      const response = await postJson(
        `${chatUrl(floorId)}/messages`,
        { text: message, attachments },
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblem(
          error.message ?? error.problems?.join(" ") ?? "It was not sent.",
        );
        return false;
      }
      const sent = managerChatSendResponseSchema.parse(await response.json());
      queryClient.setQueryData<ManagerChat>(
        managerChatQuery(floorId).queryKey,
        (current) => {
          if (current === undefined) {
            return current;
          }
          let next = withMessage(current, sent.message);
          if (sent.reply !== null) {
            next = withMessage(next, sent.reply);
          } else if (
            !answered(next, sent.message.id) &&
            !next.pending.some(({ replyTo }) => replyTo === sent.message.id)
          ) {
            // The Model's reply is on its way, in place of any it was still
            // writing: sending interrupted that one.
            next = {
              ...next,
              pending: [
                ...next.pending.filter(
                  ({ replyTo }) => replyTo > sent.message.id,
                ),
                { replyTo: sent.message.id, text: "" },
              ],
            };
          }
          return next;
        },
      );
      if (sent.message.grilling !== null || sent.reply?.grilling != null) {
        void queryClient.invalidateQueries({
          queryKey: grillingQueryKey(floorId),
        });
      }
      return true;
    } catch {
      setProblem("AI Office could not be reached. Try again.");
      return false;
    } finally {
      setSending(false);
    }
  };
  return { send, sending, problem, ready: session !== undefined };
}

/**
 * The chat itself: the conversation, the reply being written, and a box to
 * write in. The 3D office's glass office reuses it.
 */
/**
 * The Manager's status line, compact, over its chat in a narrow panel (the
 * 3D Office's, a Grilling Session's included).
 */
function CompactManagerStatus({
  floorId,
  manager,
}: {
  floorId: string;
  manager: { readonly id: string; readonly aiProvider: string };
}) {
  const { usageOf } = useContextUsage(floorId);
  return (
    <ManagerStatusLine
      floorId={floorId}
      manager={manager}
      contextUsage={usageOf(manager.id)}
      compact
    />
  );
}

export function ManagerChatPanel({
  floorId,
  className,
  insert,
  compact = false,
}: {
  floorId: string;
  className?: string;
  /**
   * For a narrow panel, such as an Agent's card in the Office: what can be
   * typed folds away under a summary, and the conversation gives up room
   * first, so the box always fits.
   */
  compact?: boolean;
  /**
   * A Skill to put in the box as `/name ` (FR-73): each new `seq` puts it
   * there, in place of a Skill's command already written, and moves focus
   * to the box.
   */
  insert?: { readonly skill: string; readonly seq: number } | undefined;
}) {
  const chat = useQuery(managerChatQuery(floorId));
  const { data: session } = useQuery(sessionQuery);
  const { status, liveTools } = useManagerChatStream(floorId, chat.isSuccess);
  const sender = useChatSender(floorId);
  const { sending, problem } = sender;
  const attached = useChatAttachments(floorId);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const inserted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (insert === undefined || inserted.current === insert.seq) {
      return;
    }
    inserted.current = insert.seq;
    const next = withSkillCommand(input.current?.value ?? "", insert.skill);
    setText(next);
    const box = input.current;
    // Once React has put the text in, and once the Skill's modal that asked
    // has closed and handed focus back to what opened it.
    setTimeout(() => {
      box?.focus();
      box?.setSelectionRange(next.length, next.length);
    }, 0);
  }, [insert]);

  const messages = chat.data?.messages ?? [];
  const pending = chat.data?.pending ?? [];
  const name = chat.data?.manager.name ?? "The Manager";
  const answering = pending.length > 0;
  const content = `${String(messages.length)}:${pending.map((reply) => reply.text).join("")}:${String(Object.values(liveTools).flat().length)}`;

  // Follows the conversation as it grows.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [content]);

  const canSend =
    !sending &&
    !attached.uploading &&
    !attached.failed &&
    (text.trim() !== "" || attached.ids.length > 0) &&
    session !== undefined &&
    chat.isSuccess;

  // Sending while the Manager is writing interrupts it (FR-24, ADR 0004).
  const send = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (!canSend) {
      return;
    }
    if (await sender.send(text.trim(), attached.ids)) {
      setText("");
      setCaret(0);
      attached.clear();
    }
  };

  const autocomplete = useSkillAutocomplete({
    floorId,
    text,
    onChoose: setText,
  });
  const mentions = useFileMentions({
    floorId,
    text,
    caret,
    onChoose: (next, at) => {
      setText(next);
      setCaret(at);
      const box = input.current;
      // Once React has put the text in.
      setTimeout(() => {
        box?.setSelectionRange(at, at);
      }, 0);
    },
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(event) || autocomplete.onKeyDown(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) {
      event.preventDefault();
      attached.add(files);
    }
  };

  // The latest message asking each round: its cards take the answers.
  const latestOfRound = new Map<string, number>();
  for (const message of messages) {
    if (message.grilling?.round != null) {
      latestOfRound.set(
        `${String(message.grilling.sessionId)}:${String(message.grilling.round)}`,
        message.id,
      );
    }
  }
  const sendFromCards = async (message: string) =>
    !answering && (await sender.send(message));

  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        // Whatever still does not fit scrolls, rather than spilling out.
        compact && "min-w-0 overflow-y-auto",
        className,
      )}
    >
      {compact && chat.data !== undefined && (
        <CompactManagerStatus floorId={floorId} manager={chat.data.manager} />
      )}
      <GrillingBar
        floorId={floorId}
        disabled={sending || answering || !sender.ready}
        onSend={sendFromCards}
      />
      <ChatTaskList floorId={floorId} defaultOpen={!compact} />
      <div
        ref={scroller}
        role="log"
        aria-label="Manager chat"
        tabIndex={0}
        className={cn(
          "flex-1 overflow-y-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          compact ? "min-h-24 p-3" : "min-h-48 p-4",
        )}
      >
        {chat.isError && (
          <p role="alert" className="text-sm text-destructive">
            The chat could not be loaded.
          </p>
        )}
        {chat.isSuccess && messages.length === 0 && !answering && (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Write to {name} below.
          </p>
        )}
        <ol className="space-y-4">
          {messages.map((message) => (
            <li
              key={message.id}
              data-kind={message.kind}
              className="flex flex-col"
            >
              <Message
                floorId={floorId}
                message={message}
                managerName={name}
                round={
                  message.grilling?.round == null ? undefined : (
                    <GrillingRound
                      floorId={floorId}
                      sessionId={message.grilling.sessionId}
                      round={message.grilling.round}
                      interactive={
                        latestOfRound.get(
                          `${String(message.grilling.sessionId)}:${String(message.grilling.round)}`,
                        ) === message.id
                      }
                      disabled={sending || answering || !sender.ready}
                      onSend={sendFromCards}
                    />
                  )
                }
              />
            </li>
          ))}
          {pending.map((reply) => (
            <li
              key={`pending-${String(reply.replyTo)}`}
              data-kind="pending"
              aria-busy="true"
              className="flex flex-col"
            >
              <PendingReply name={name} text={reply.text}>
                <ToolUses tools={liveTools[reply.replyTo] ?? []} live />
              </PendingReply>
            </li>
          ))}
        </ol>
      </div>
      <form
        aria-label={`Write to ${name}`}
        className={cn(
          "space-y-2 rounded-md",
          dragging && "outline-2 outline-offset-4 outline-ring outline-dashed",
        )}
        onSubmit={(event) => {
          void send(event);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        <Label htmlFor={inputId}>Message {name}</Label>
        {compact ? (
          // Shorter, so the box stays in the panel.
          <div className="[&_[role=listbox]]:max-h-32">
            {autocomplete.list}
            {mentions.list}
          </div>
        ) : (
          <>
            {autocomplete.list}
            {mentions.list}
          </>
        )}
        <DraftAttachments drafts={attached.drafts} onRemove={attached.remove} />
        <div className="flex items-end gap-2">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Files to attach"
            accept={chatAttachmentAccept}
            onChange={(event) => {
              attached.add([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Attach files"
            title="Attach files or images (or paste or drop them on the box)"
            disabled={session === undefined || !chat.isSuccess}
            onClick={() => {
              picker.current?.click();
            }}
          >
            <Paperclip aria-hidden />
          </Button>
          <div className="relative w-full">
            <WaitingSweep active={answering} />
            <textarea
              ref={input}
              id={inputId}
              rows={2}
              value={text}
              maxLength={maxManagerChatMessageLength}
              aria-describedby={hintId}
              {...(answering && {
                placeholder: `${name} is thinking… Sending now interrupts ${name}.`,
              })}
              {...autocomplete.inputProps}
              {...mentions.inputProps}
              onChange={(event) => {
                setText(event.target.value);
                setCaret(event.target.selectionStart);
              }}
              onSelect={(event) => {
                setCaret(event.currentTarget.selectionStart);
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length > 0) {
                  event.preventDefault();
                  attached.add(files);
                }
              }}
              onKeyDown={onKeyDown}
              className="block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <Button type="submit" disabled={!canSend}>
            <Send aria-hidden />
            {answering ? "Interrupt and send" : "Send"}
          </Button>
        </div>
        <HintText id={hintId} compact={compact}>
          AI Office reads these commands itself:{" "}
          {managerCommandExamples.map((example, index) => (
            <span key={example}>
              {index === 0 ? "" : ", "}
              <code>{example}</code>
            </span>
          ))}
          . <code>/skill-name</code> runs one of the Floor&apos;s Skills; type{" "}
          <code>/</code> to choose one. <code>/grilling</code> starts a Grilling
          Session. <code>/clear</code> clears the conversation and{" "}
          <code>/compact</code> replaces it with a summary; decisions, Plans and
          Batches are kept. Anything else goes to {name}&apos;s Model, which may
          choose a Skill itself. Type <code>@</code> to mention one of the
          repository&apos;s files; attach images or text files with the clip, or
          paste or drop them. Enter sends; Shift+Enter starts a new line.
          Sending while {name} is writing interrupts {name}.
        </HintText>
        {attached.problems.length > 0 && (
          <ul role="alert" className="space-y-0.5 text-sm text-destructive">
            {attached.problems.map((each) => (
              <li key={each}>{each}</li>
            ))}
          </ul>
        )}
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <WaitingNote answering={answering} live={status === "open"}>
          {answering
            ? `${name} is answering…`
            : status === "open"
              ? "Live"
              : status === "reconnecting"
                ? "Reconnecting…"
                : "Connecting…"}
        </WaitingNote>
      </form>
    </div>
  );
}

/**
 * The Manager chat's page: who the Manager is, then the chat, with the
 * Floor's Available Skills beside it (FR-73). `skill`, from the address,
 * is put in the box as the page opens, as running a Skill from Admin or
 * the Manager's bookshelf asks; `onSkillTaken` then clears it.
 */
export function ManagerChatPage({
  floorId,
  skill,
  onSkillTaken,
}: {
  floorId: string;
  skill?: string | undefined;
  onSkillTaken?: () => void;
}) {
  const { data: chat, isError } = useQuery(managerChatQuery(floorId));
  const { data: floor } = useQuery(floorQuery(floorId));
  const { usageOf } = useContextUsage(floorId);
  const [insert, setInsert] = useState<
    { skill: string; seq: number } | undefined
  >();
  // The address's Skill, put in the box once each time it names one.
  const [named, setNamed] = useState<string | undefined>();
  if (skill !== named) {
    setNamed(skill);
    if (skill !== undefined) {
      setInsert({ skill, seq: (insert?.seq ?? 0) + 1 });
    }
  }
  useEffect(() => {
    if (skill !== undefined) {
      onSkillTaken?.();
    }
  }, [skill, onSkillTaken]);
  const skillsId = useId();
  const sessionsId = useId();
  const sessions = useChatSender(floorId);
  return (
    <section className="flex h-full flex-col gap-4">
      <PageHeader
        title={
          <>
            {chat === undefined ? (
              "Manager chat"
            ) : (
              <>
                Chat with{" "}
                <AgentLink floorId={floorId} agentId={chat.manager.id}>
                  {() => chat.manager.name}
                </AgentLink>
              </>
            )}
          </>
        }
        eyebrow={
          <Link to="/floor-settings/$floorId" params={{ floorId }}>
            {floor?.name ?? floorId}
          </Link>
        }
      >
        {chat !== undefined && (
          <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            The Manager of {floor?.name ?? floorId} · {chat.manager.aiProvider}{" "}
            {chat.manager.model}
          </p>
        )}
        {chat !== undefined && (
          <ManagerStatusLine
            floorId={floorId}
            manager={chat.manager}
            contextUsage={usageOf(chat.manager.id)}
          >
            {floor?.archivedAt == null && (
              <ManagerModelPicker
                floorId={floorId}
                managerId={chat.manager.id}
                chatQueryKey={managerChatQuery(floorId).queryKey}
              />
            )}
          </ManagerStatusLine>
        )}
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            There is no such Floor, or it has no Manager.
          </p>
        )}
        {floor?.archivedAt != null && (
          <p role="note" className="rounded-md border p-3 text-sm">
            This Floor is archived: its chat can be read, but not added to.
          </p>
        )}
      </PageHeader>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ManagerChatPanel
          floorId={floorId}
          className="h-[70vh]"
          insert={insert}
        />
        <aside
          aria-labelledby={skillsId}
          className="space-y-2 lg:max-h-[70vh] lg:overflow-y-auto"
        >
          <h2 id={skillsId} className="font-semibold">
            Available Skills
          </h2>
          <p className="text-xs text-muted-foreground">
            Open one to read it; run it to put its command in the box.
          </p>
          <AvailableSkillList
            floorId={floorId}
            onRun={(name) => {
              setInsert((current) => ({
                skill: name,
                seq: (current?.seq ?? 0) + 1,
              }));
            }}
          />
          <h2 id={sessionsId} className="pt-4 font-semibold">
            Grilling Sessions
          </h2>
          <GrillingSessionList
            floorId={floorId}
            disabled={
              sessions.sending ||
              !sessions.ready ||
              (chat?.pending.length ?? 0) > 0
            }
            onSend={sessions.send}
          />
          {sessions.problem !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {sessions.problem}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
