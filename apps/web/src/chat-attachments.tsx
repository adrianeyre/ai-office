import {
  chatAttachmentMediaTypes,
  chatAttachmentSchema,
  isChatImage,
  maxChatAttachmentBytes,
  maxChatAttachmentNameLength,
  maxChatAttachments,
  type ChatAttachment,
  type ChatAttachmentMediaType,
} from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { FileText, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils.ts";

import { postJson, readApiError } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Files and images in the Manager chat (PRD FR-24, ADR 0004), as Claude
// Code takes them: attached with a button, pasted or dropped on the box.
// Each is checked here against the shared limits (its type, its size, how
// many a message may carry), then uploaded at once, so the Owner sees it
// ready, or why not, before sending; a message then names them by id. A
// sent message shows its images as thumbnails and its text files as chips,
// each opening its content.

/** Where an attachment's content is served. */
export const attachmentUrl = (floorId: string, id: string): string =>
  `/api/floors/${encodeURIComponent(floorId)}/manager-chat/attachments/${encodeURIComponent(id)}`;

/** Types browsers often leave empty or name otherwise, by extension. */
const typesByExtension: Readonly<Record<string, ChatAttachmentMediaType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  ndjson: "application/x-ndjson",
  jsonl: "application/x-ndjson",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/** The attachment type of `file`, if the chat takes it. */
export function mediaTypeOf(file: {
  readonly name: string;
  readonly type: string;
}): ChatAttachmentMediaType | undefined {
  const given = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = chatAttachmentMediaTypes.find((type) => type === given);
  if (known !== undefined) {
    return known;
  }
  const extension = /\.([^./]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : typesByExtension[extension];
}

const mebibytes = (bytes: number): string =>
  `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MiB`;

/** A size as people read it: 512 bytes, 12 KiB, 1.5 MiB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))} KiB`;
  }
  return mebibytes(bytes);
}

/** Why `file` cannot be attached, if it cannot. */
export function attachmentProblem(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): string | undefined {
  const mediaType = mediaTypeOf(file);
  if (mediaType === undefined) {
    return `${file.name} cannot be attached: attach an image (PNG, JPEG, GIF or WebP) or a text file (such as a log, Markdown, CSV, JSON, XML or YAML).`;
  }
  const limit = maxChatAttachmentBytes(mediaType);
  if (file.size > limit) {
    return `${file.name} is too large: ${isChatImage(mediaType) ? "an image" : "a text file"} is at most ${mebibytes(limit)}.`;
  }
  if (file.name.length > maxChatAttachmentNameLength) {
    return `${file.name.slice(0, 40)}… has too long a name: at most ${String(maxChatAttachmentNameLength)} characters.`;
  }
  return undefined;
}

/** `file`'s content in base64. */
function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("The file could not be read."));
    };
    reader.readAsDataURL(file);
  });
}

/** One file attached to the message being written. */
export interface DraftAttachment {
  readonly key: number;
  readonly name: string;
  readonly mediaType: ChatAttachmentMediaType;
  readonly size: number;
  /** Uploading, uploaded (with its id), or refused by the server. */
  readonly status: "uploading" | "ready" | "failed";
  readonly attachment?: ChatAttachment;
  readonly problem?: string;
}

/**
 * The files attached to the message being written: `add` checks and
 * uploads them; `ids` names those uploaded, for sending.
 */
export function useChatAttachments(floorId: string) {
  const { data: session } = useQuery(sessionQuery);
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const nextKey = useRef(1);
  // How many are attached, as `add` sees it: it may run again before a render.
  const count = useRef(0);

  const update = (key: number, change: Partial<DraftAttachment>): void => {
    setDrafts((now) =>
      now.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)),
    );
  };

  const upload = async (key: number, file: File, mediaType: string) => {
    try {
      const response = await postJson(
        `/api/floors/${encodeURIComponent(floorId)}/manager-chat/attachments`,
        { name: file.name, mediaType, content: await base64Of(file) },
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        update(key, {
          status: "failed",
          problem:
            error.problems?.join(" ") ??
            error.message ??
            "It was not uploaded.",
        });
        return;
      }
      const attachment = chatAttachmentSchema.parse(await response.json());
      update(key, { status: "ready", attachment });
    } catch {
      update(key, {
        status: "failed",
        problem: "AI Office could not be reached. Remove it and try again.",
      });
    }
  };

  const add = (files: readonly File[]): void => {
    const found: string[] = [];
    const added: DraftAttachment[] = [];
    for (const file of files) {
      const problem = attachmentProblem(file);
      const mediaType = mediaTypeOf(file);
      if (problem !== undefined || mediaType === undefined) {
        found.push(problem ?? `${file.name} cannot be attached.`);
        continue;
      }
      if (count.current + added.length >= maxChatAttachments) {
        found.push(
          `${file.name} was not attached: a message carries at most ${String(maxChatAttachments)} files.`,
        );
        continue;
      }
      const key = nextKey.current;
      nextKey.current += 1;
      added.push({
        key,
        name: file.name,
        mediaType,
        size: file.size,
        status: "uploading",
      });
      void upload(key, file, mediaType);
    }
    count.current += added.length;
    setProblems(found);
    if (added.length > 0) {
      setDrafts((now) => [...now, ...added]);
    }
  };

  const remove = (key: number): void => {
    count.current = Math.max(0, count.current - 1);
    setDrafts((now) => now.filter((draft) => draft.key !== key));
  };

  const clear = (): void => {
    count.current = 0;
    setDrafts([]);
    setProblems([]);
  };

  return {
    drafts,
    problems,
    add,
    remove,
    clear,
    /** The uploaded attachments' ids, for sending. */
    ids: drafts.flatMap(({ attachment }) =>
      attachment === undefined ? [] : [attachment.id],
    ),
    uploading: drafts.some(({ status }) => status === "uploading"),
    /** Whether any failed: they are removed before sending. */
    failed: drafts.some(({ status }) => status === "failed"),
  };
}

/** The files attached to the message being written, each to remove. */
export function DraftAttachments({
  drafts,
  onRemove,
}: {
  drafts: readonly DraftAttachment[];
  onRemove: (key: number) => void;
}) {
  if (drafts.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-2">
      {drafts.map((draft) => (
        <li
          key={draft.key}
          aria-busy={draft.status === "uploading"}
          className={cn(
            "flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
            draft.status === "failed" && "border-destructive/50",
          )}
        >
          {draft.status === "uploading" ? (
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <FileText aria-hidden className="size-3.5" />
          )}
          <span className="max-w-48 truncate" title={draft.name}>
            {draft.name}
          </span>
          <span className="text-muted-foreground">
            {draft.status === "uploading"
              ? "Uploading…"
              : draft.status === "failed"
                ? "Not uploaded"
                : formatSize(draft.size)}
          </span>
          {draft.problem !== undefined && (
            <span className="text-destructive">{draft.problem}</span>
          )}
          <button
            type="button"
            aria-label={`Remove ${draft.name}`}
            className="rounded p-0.5 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={() => {
              onRemove(draft.key);
            }}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A sent message's files: images as thumbnails, text files as chips. */
export function MessageAttachments({
  floorId,
  attachments,
  align = "start",
}: {
  floorId: string;
  attachments: readonly ChatAttachment[];
  align?: "start" | "end";
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Attachments"
      className={cn("flex flex-wrap gap-2", align === "end" && "justify-end")}
    >
      {attachments.map((attachment) => {
        const url = attachmentUrl(floorId, attachment.id);
        return (
          <li key={attachment.id}>
            {isChatImage(attachment.mediaType) ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title={`${attachment.name}, ${formatSize(attachment.size)}`}
                className="block overflow-hidden rounded-md border"
              >
                <img
                  src={url}
                  alt={attachment.name}
                  loading="lazy"
                  className="h-20 w-auto max-w-40 object-cover"
                />
              </a>
            ) : (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent"
              >
                <FileText aria-hidden className="size-3.5" />
                <span className="max-w-48 truncate">{attachment.name}</span>
                <span className="text-muted-foreground">
                  {formatSize(attachment.size)}
                </span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
