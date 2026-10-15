import {
  directChatFrameSchema,
  directChatSchema,
  directChatSendResponseSchema,
  maxDirectChatMessageLength,
  type DirectChat,
  type DirectChatFrame,
  type DirectChatMessage,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { getJson, postJson, readApiError } from "./api.ts";
import {
  eventSources,
  type EventSourceLike,
  type EventStreamStatus,
} from "./event-stream.ts";
import {
  PendingReply,
  WaitingNote,
  WaitingSweep,
} from "./chat-pending-reply.tsx";
import { ChatStatusLine } from "./chat-status-line.tsx";
import { sessionQuery } from "./session.ts";

// Direct chats: the Owner's one-to-one chat with any of a Floor's Agents,
// which clicking its Avatar in the Office offers, and with the AI itself in
// the Terminal. The conversation is read when the chat opens; then its
// messages, and the Model's replies as it writes them, stream in over
// server-sent events, as the Manager chat's do. `/clear` starts the
// conversation afresh. The Terminal chooses which AI Provider's default
// Model to ask.

/** Where a chat is: an Agent's, or the Terminal's. */
export type DirectChatPlace =
  | {
      readonly kind: "agent";
      readonly floorId: string;
      readonly agentId: string;
    }
  | { readonly kind: "terminal" };

const urlOf = (place: DirectChatPlace): string =>
  place.kind === "terminal"
    ? "/api/terminal"
    : `/api/floors/${encodeURIComponent(place.floorId)}/agents/${encodeURIComponent(place.agentId)}/chat`;

/** A chat so far. */
export const directChatQuery = (place: DirectChatPlace) =>
  queryOptions({
    queryKey:
      place.kind === "terminal"
        ? ["terminal"]
        : ["floors", place.floorId, "agents", place.agentId, "chat"],
    queryFn: () => getJson(urlOf(place), directChatSchema),
    // New messages come by the stream.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

const answered = (chat: DirectChat, replyTo: number): boolean =>
  chat.messages.some((message) => message.replyTo === replyTo);

/** `chat` with `message` in id order, once; its reply is no longer pending. */
export function withDirectMessage(
  chat: DirectChat,
  message: DirectChatMessage,
): DirectChat {
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
export function withDirectFrame(
  chat: DirectChat,
  frame: DirectChatFrame,
): DirectChat {
  if (frame.type === "message") {
    return withDirectMessage(chat, frame.message);
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

/** The longest wait between reconnection attempts. */
const maxBackoffMs = 30_000;

/**
 * Keeps the chat's stream open while `enabled`, applying each frame to its
 * query. When the browser gives up on it, it reconnects itself with
 * growing waits, resuming after the last message it has.
 */
function useDirectChatStream(
  place: DirectChatPlace,
  enabled: boolean,
): EventStreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventStreamStatus>("connecting");
  const url = urlOf(place);
  const key = JSON.stringify(directChatQuery(place).queryKey);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const queryKey = JSON.parse(key) as string[];
    let source: EventSourceLike | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const open = (): void => {
      const last =
        queryClient.getQueryData<DirectChat>(queryKey)?.messages.at(-1)?.id ??
        0;
      const current = eventSources.open(
        `${url}/stream?lastEventId=${String(last)}`,
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
        const frame = directChatFrameSchema.safeParse(data);
        if (frame.success) {
          queryClient.setQueryData<DirectChat>(queryKey, (chat) =>
            chat === undefined ? chat : withDirectFrame(chat, frame.data),
          );
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
  }, [url, key, enabled, queryClient]);
  return status;
}

const capitalised = (name: string): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

function Message({
  message,
  name,
  terminal,
}: {
  message: DirectChatMessage;
  name: string;
  terminal: boolean;
}) {
  const muted = terminal ? "text-zinc-400" : "text-muted-foreground";
  if (message.kind === "clear") {
    return (
      <div
        role="separator"
        aria-label="Conversation cleared"
        className={cn("flex items-center gap-3 text-xs", muted)}
      >
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="max-w-[80%] text-center">{message.text}</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (message.kind === "owner") {
    return (
      <div className="ml-auto max-w-[85%] space-y-1 text-right">
        <p className={cn("text-xs", muted)}>You</p>
        <p className="inline-block rounded-lg bg-primary px-3 py-2 text-left whitespace-pre-wrap text-primary-foreground">
          {message.text}
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-[85%] space-y-1">
      <p className={cn("flex items-center gap-2 text-xs", muted)}>
        {capitalised(name)}
        {message.model !== null && (
          <span className="font-mono">{message.model}</span>
        )}
      </p>
      <p
        className={cn(
          "inline-block rounded-lg px-3 py-2 break-words whitespace-pre-wrap",
          message.kind === "error"
            ? "border border-destructive/40 text-destructive"
            : terminal
              ? "bg-zinc-800"
              : "bg-muted",
        )}
      >
        {message.text}
      </p>
    </div>
  );
}

/**
 * A direct chat: the conversation, the reply being written, and a box to
 * write in; the Terminal's also chooses the Model to ask. `terminal` gives
 * it the Terminal's look: monospaced, on a dark screen.
 */
export function DirectChatPanel({
  place,
  className,
  terminal = false,
  compact = false,
}: {
  place: DirectChatPlace;
  className?: string;
  terminal?: boolean;
  /** In a narrow panel, such as the 3D Office's: its status line smaller. */
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const query = directChatQuery(place);
  const chat = useQuery(query);
  const { data: session } = useQuery(sessionQuery);
  const status = useDirectChatStream(place, chat.isSuccess);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string>();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const inputId = useId();
  const modelId = useId();
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);

  const messages = chat.data?.messages ?? [];
  const pending = chat.data?.pending ?? [];
  const name = chat.data?.name ?? "the Agent";
  const models = chat.data?.models ?? [];
  const chosen = model ?? chat.data?.model ?? "";
  const answering = pending.length > 0;
  const content = `${String(messages.length)}:${pending.map((reply) => reply.text).join("")}`;

  // Follows the conversation as it grows.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [content]);

  const send = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    const message = text.trim();
    if (message === "" || sending) {
      return;
    }
    if (answering) {
      // Said rather than ignored: the reply before it is still being written.
      setProblem(
        `${capitalised(name)} is still answering your last message: send this once it has.`,
      );
      return;
    }
    setSending(true);
    setProblem(undefined);
    try {
      const response = await postJson(
        `${urlOf(place)}/messages`,
        {
          text: message,
          ...(place.kind === "terminal" && chosen !== ""
            ? { model: chosen }
            : {}),
        },
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblem(
          error.message ?? error.problems?.join(" ") ?? "It was not sent.",
        );
        return;
      }
      const sent = directChatSendResponseSchema.parse(await response.json());
      queryClient.setQueryData<DirectChat>(query.queryKey, (current) => {
        if (current === undefined) {
          return current;
        }
        let next = withDirectMessage(current, sent.message);
        if (sent.reply !== null) {
          next = withDirectMessage(next, sent.reply);
        } else if (
          sent.message.kind === "owner" &&
          !answered(next, sent.message.id) &&
          !next.pending.some(({ replyTo }) => replyTo === sent.message.id)
        ) {
          // The Model's reply is on its way.
          next = {
            ...next,
            pending: [...next.pending, { replyTo: sent.message.id, text: "" }],
          };
        }
        return next;
      });
      setText("");
    } catch {
      setProblem("AI Office could not be reached. Try again.");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {chat.data !== undefined && (
        <ChatStatusLine
          caller={place}
          aiProvider={
            models.find((offered) => offered.model === chosen)?.aiProvider ??
            chat.data.aiProvider
          }
          label={
            place.kind === "terminal"
              ? "The Terminal's usage"
              : `${capitalised(name)}'s usage`
          }
          contextUsage={chat.data.usage ?? undefined}
          latestAccountId={chat.data.usage?.aiAccountId}
          onRequest={() => {
            // Its Context Usage and serving account, from the new request.
            void queryClient.invalidateQueries({ queryKey: query.queryKey });
          }}
          compact={compact}
        >
          {chosen !== "" && (
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-muted-foreground">Model</p>
              <p className={cn("font-mono", compact ? "text-xs" : "text-sm")}>
                {chosen}
              </p>
            </div>
          )}
        </ChatStatusLine>
      )}
      <div
        ref={scroller}
        role="log"
        aria-label={`Chat with ${name}`}
        tabIndex={0}
        className={cn(
          "min-h-48 flex-1 overflow-y-auto rounded-xl border p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          terminal && "bg-zinc-950 font-mono text-sm text-zinc-100",
        )}
      >
        {chat.isError && (
          <p role="alert" className="text-sm text-destructive">
            The chat could not be loaded.
          </p>
        )}
        {chat.isSuccess && messages.length === 0 && !answering && (
          <p
            className={cn(
              "text-sm",
              terminal ? "text-zinc-400" : "text-muted-foreground",
            )}
          >
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
              <Message message={message} name={name} terminal={terminal} />
            </li>
          ))}
          {pending.map((reply) => (
            <li
              key={`pending-${String(reply.replyTo)}`}
              data-kind="pending"
              aria-busy="true"
              className="flex flex-col"
            >
              <PendingReply
                name={capitalised(name)}
                text={reply.text}
                terminal={terminal}
              />
            </li>
          ))}
        </ol>
      </div>
      <form
        aria-label={`Write to ${name}`}
        className="space-y-2"
        onSubmit={(event) => {
          void send(event);
        }}
      >
        {place.kind === "terminal" && (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={modelId}>Model</Label>
            <select
              id={modelId}
              className={cn(selectClass, "w-auto")}
              value={chosen}
              disabled={models.length === 0}
              onChange={(event) => {
                setModel(event.target.value);
              }}
            >
              {models.length === 0 && <option value="">No Models yet</option>}
              {models.map((each) => (
                <option key={each.aiProvider} value={each.model}>
                  {each.aiProvider}: {each.model}
                </option>
              ))}
            </select>
          </div>
        )}
        <Label htmlFor={inputId}>Message {name}</Label>
        <div className="flex items-end gap-2">
          <div className="relative w-full">
            <WaitingSweep active={answering} />
            <textarea
              id={inputId}
              rows={2}
              value={text}
              maxLength={maxDirectChatMessageLength}
              aria-describedby={hintId}
              {...(answering && {
                placeholder: `Waiting for ${name}'s reply…`,
              })}
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
              className={cn(
                "block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                terminal && "font-mono",
              )}
            />
          </div>
          <Button
            type="submit"
            disabled={
              sending ||
              answering ||
              text.trim() === "" ||
              session === undefined ||
              !chat.isSuccess
            }
          >
            <Send aria-hidden />
            Send
          </Button>
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          <code>/clear</code> starts the conversation afresh. Enter sends;
          Shift+Enter starts a new line.
        </p>
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <WaitingNote answering={answering} live={status === "open"}>
          {answering
            ? `${capitalised(name)} is answering…`
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
