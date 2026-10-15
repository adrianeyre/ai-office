import { z } from "zod";

// The Manager chat as Claude Code is (PRD FR-24, ADR 0004): a continuing,
// read-only agent session on a read-only clone of the Floor's repository,
// whose tool use the transcript shows collapsed; messages may carry files
// and images, and `@path` mentions of the repository's files; and a live
// task list of the work each chat request spun off. The server, the web
// app and the orchestrator share these.

/**
 * One tool the Manager's session used while it answered, as the transcript
 * shows it, collapsed: its name (`Read`, `Grep`, `Glob`, `WebSearch`,
 * `WebFetch`, `Bash` for git) and what it was used on, in a line.
 */
export const managerChatToolUseSchema = z.object({
  name: z.string().min(1).max(100),
  /** Such as `src/checkout/total.ts`, or `"order total" in src/`. */
  summary: z.string().max(500),
});
export type ManagerChatToolUse = z.infer<typeof managerChatToolUseSchema>;

/** The most tools one reply lists. */
export const maxChatToolUses = 200;

/** Image types an attachment may be, which a Model can see as images. */
export const chatImageMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Text types an attachment may be, given to the Model as text. */
export const chatTextMediaTypes = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "text/xml",
  "application/yaml",
  "text/yaml",
] as const;

export const chatAttachmentMediaTypes = [
  ...chatImageMediaTypes,
  ...chatTextMediaTypes,
] as const;
export type ChatAttachmentMediaType = (typeof chatAttachmentMediaTypes)[number];

/** Whether an attachment of `mediaType` is an image. */
export const isChatImage = (mediaType: string): boolean =>
  (chatImageMediaTypes as readonly string[]).includes(mediaType);

/** The most attachments one message may carry. */
export const maxChatAttachments = 5;
/** The largest image attachment: 5 MiB. */
export const maxChatImageBytes = 5 * 1024 * 1024;
/** The largest text attachment, such as a log: 1 MiB. */
export const maxChatTextBytes = 1024 * 1024;
/** The longest attachment name. */
export const maxChatAttachmentNameLength = 200;

/** The largest attachment of `mediaType`. */
export const maxChatAttachmentBytes = (mediaType: string): number =>
  isChatImage(mediaType) ? maxChatImageBytes : maxChatTextBytes;

/** A file or image attached to a message, as the chat lists it. */
export const chatAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(maxChatAttachmentNameLength),
  mediaType: z.enum(chatAttachmentMediaTypes),
  /** Its size in bytes. */
  size: z.number().int().nonnegative(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

/**
 * The body of `POST /api/floors/:floorId/manager-chat/attachments`: one
 * file, its content in base64. It is kept until a message sends it, and
 * answered with its id; one never sent is deleted within a day.
 */
export const chatAttachmentUploadSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: "Name the file." })
      .max(maxChatAttachmentNameLength, {
        error: `A file's name is at most ${String(maxChatAttachmentNameLength)} characters.`,
      }),
    mediaType: z.enum(chatAttachmentMediaTypes, {
      error:
        "Attach an image (PNG, JPEG, GIF or WebP) or a text file (such as a log, Markdown, CSV, JSON, XML or YAML).",
    }),
    /** Its content, in base64. */
    content: z.base64({ error: "The file's content is base64." }),
  })
  .superRefine(({ mediaType, content }, context) => {
    const bytes = Math.floor((content.length * 3) / 4);
    const limit = maxChatAttachmentBytes(mediaType);
    if (bytes > limit + 2) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: `${isChatImage(mediaType) ? "An image" : "A text file"} is at most ${String(limit / (1024 * 1024))} MiB.`,
      });
    }
  });
export type ChatAttachmentUpload = z.infer<typeof chatAttachmentUploadSchema>;

/** Where a task the Manager spun off stands, as the chat's task list shows it. */
export const managerChatTaskStates = [
  "queued",
  "running",
  "in_review",
  "done",
  "blocked",
] as const;
export type ManagerChatTaskState = (typeof managerChatTaskStates)[number];

export const managerChatTaskStateLabels: Record<ManagerChatTaskState, string> =
  {
    queued: "Queued",
    running: "Running",
    in_review: "In review",
    done: "Done",
    blocked: "Blocked",
  };

/**
 * One piece of work a chat request spun off: an issue of its Batch, a
 * Contractor, or a research run. Each opens its Agent's live view.
 */
export const managerChatTaskSchema = z.object({
  /** Stable across updates: `issue:12`, `contractor:<agentId>`, `research:<id>`. */
  id: z.string().min(1),
  kind: z.enum(["issue", "contractor", "research"]),
  title: z.string(),
  state: z.enum(managerChatTaskStates),
  /** The Owner's chat message it was spun off for. */
  messageId: z.number().int().positive(),
  batchId: z.number().int().positive().nullable(),
  issue: z.number().int().positive().nullable(),
  /** Its issue's page on GitHub, if it is one. */
  url: z.string().nullable(),
  /** The Agent or Contractor working it, whose live view it opens. */
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
});
export type ManagerChatTask = z.infer<typeof managerChatTaskSchema>;

/** `GET /api/floors/:floorId/manager-chat/tasks`, newest request first. */
export const managerChatTaskListSchema = z.object({
  tasks: z.array(managerChatTaskSchema),
});
export type ManagerChatTaskList = z.infer<typeof managerChatTaskListSchema>;

/** The most files `@` mentions offer at once. */
export const maxMentionSuggestions = 20;
/** The most files one message may mention. */
export const maxMentionedFiles = 10;
/** The most of one mentioned file the Manager is given. */
export const maxMentionedFileBytes = 200 * 1024;

/**
 * `GET /api/floors/:floorId/manager-chat/files?query=`: the repository's
 * files whose path matches, for `@` mentions.
 */
export const managerChatFilesQuerySchema = z.strictObject({
  query: z.string().max(300).default(""),
});
export const managerChatFileListSchema = z.object({
  files: z.array(z.string()),
});
export type ManagerChatFileList = z.infer<typeof managerChatFileListSchema>;

/**
 * The repository paths a message mentions with `@`: `@src/a.ts`, each at
 * most once, in order, `maxMentionedFiles` at most. An `@` must start a
 * word, and a path ends at whitespace or closing punctuation.
 */
export function mentionedFiles(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(
    /(?:^|[\s(])@((?:[\w.-]+\/)*[\w.-]+)(?=$|[\s),;:!?])/g,
  )) {
    const path = match[1]?.replace(/[.]+$/, "");
    if (path !== undefined && path !== "" && !found.includes(path)) {
      found.push(path);
    }
  }
  return found.slice(0, maxMentionedFiles);
}
