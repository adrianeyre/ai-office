import { randomUUID } from "node:crypto";

import {
  deleteUnsentChatAttachmentsBefore,
  managerChatAttachments,
  type Database,
} from "@ai-office/db";
import {
  chatAttachmentMediaTypes,
  isChatImage,
  maxChatAttachmentBytes,
  type ChatAttachment,
  type ChatAttachmentMediaType,
  type ChatAttachmentUpload,
} from "@ai-office/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

// The files and images the Owner attaches to Manager chat messages (PRD
// FR-24, ADR 0004), as Claude Code takes a screenshot or a log: each is
// uploaded first, unsent, and kept with the message that sends it, going
// with it. One never sent is deleted within a day by the retention job
// (`deleteUnsentBefore`). Kept in `manager_chat_attachments`, or memory for
// tests. Their content is the Owner's, untrusted: it is checked to be what
// it says it is before it is kept, and served back only as itself.

/** An attachment as it is kept. */
export interface StoredChatAttachment extends ChatAttachment {
  readonly floorId: string;
  /** The Owner's message that sent it; null until one does. */
  readonly messageId: number | null;
  readonly createdAt: Date;
}

/** An attachment with its content. */
export interface ChatAttachmentWithContent extends StoredChatAttachment {
  readonly content: Buffer;
}

/** A file to keep: checked by `readChatAttachment`. */
export interface NewChatAttachment {
  readonly floorId: string;
  readonly name: string;
  readonly mediaType: ChatAttachmentMediaType;
  readonly content: Buffer;
  readonly createdAt: Date;
}

/**
 * A message named attachments that another message sent first, or that
 * went meanwhile: nothing is kept.
 */
export class ChatAttachmentsTakenError extends Error {
  constructor() {
    super("An attachment named was sent already, or is gone.");
    this.name = "ChatAttachmentsTakenError";
  }
}

export interface ChatAttachmentStore {
  /** Keeps a new, unsent attachment, giving it an id no one can guess. */
  add(attachment: NewChatAttachment): Promise<ChatAttachment>;
  /** One of the Floor's attachments, sent or not, with its content. */
  get(
    floorId: string,
    id: string,
  ): Promise<ChatAttachmentWithContent | undefined>;
  /** Those of `ids` that are the Floor's and unsent, in the order named. */
  unsent(floorId: string, ids: readonly string[]): Promise<ChatAttachment[]>;
  /** What a message sent, oldest first, with each one's content. */
  ofMessage(
    floorId: string,
    messageId: number,
  ): Promise<ChatAttachmentWithContent[]>;
  /** Deletes the unsent ones uploaded before `before`; how many went. */
  deleteUnsentBefore(before: Date): Promise<number>;
}

/** How long an unsent attachment is kept: a day. */
export const unsentChatAttachmentMs = 24 * 60 * 60 * 1000;

const listed = (attachment: StoredChatAttachment): ChatAttachment => ({
  id: attachment.id,
  name: attachment.name,
  mediaType: attachment.mediaType,
  size: attachment.size,
});

/** Whether `content` starts as an image of `mediaType` does. */
function looksLike(mediaType: string, content: Buffer): boolean {
  const starts = (bytes: readonly number[], at = 0) =>
    bytes.every((byte, index) => content[at + index] === byte);
  switch (mediaType) {
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/gif":
      return starts([0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return (
        starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)
      );
    default:
      return false;
  }
}

/**
 * Reads an upload's content (base64), checked against its type: its real
 * size within the limit (5 MiB for an image, 1 MiB for text), an image
 * that is the image it says, text that is UTF-8 text. Answers the bytes,
 * or why they are refused, in a sentence for the Owner.
 */
export function readChatAttachment(
  upload: Pick<ChatAttachmentUpload, "mediaType" | "content">,
):
  | { readonly ok: true; readonly content: Buffer }
  | { readonly ok: false; readonly problem: string } {
  const content = Buffer.from(upload.content, "base64");
  const limit = maxChatAttachmentBytes(upload.mediaType);
  const image = isChatImage(upload.mediaType);
  if (content.length > limit) {
    return {
      ok: false,
      problem: `${image ? "An image" : "A text file"} is at most ${String(limit / (1024 * 1024))} MiB.`,
    };
  }
  if (content.length === 0) {
    return { ok: false, problem: "The file is empty." };
  }
  if (image) {
    return looksLike(upload.mediaType, content)
      ? { ok: true, content }
      : {
          ok: false,
          problem: `The file is not the ${upload.mediaType.slice("image/".length).toUpperCase()} image it says it is.`,
        };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (text.includes("\u0000")) {
      throw new Error("A text file holds no NUL characters.");
    }
  } catch {
    return {
      ok: false,
      problem: "A text file is UTF-8 text: this one is not.",
    };
  }
  return { ok: true, content };
}

/** Keeps attachments in memory: for tests. */
export function memoryChatAttachmentStore(): ChatAttachmentStore & {
  readonly attachments: ChatAttachmentWithContent[];
  /**
   * Binds the Floor's unsent `ids` to `messageId`, all or none: false if
   * any is not there to bind. The memory chat store calls it as it keeps
   * the message.
   */
  bind(floorId: string, ids: readonly string[], messageId: number): boolean;
} {
  const attachments: ChatAttachmentWithContent[] = [];
  const unsentOf = (floorId: string, id: string) =>
    attachments.find(
      (attachment) =>
        attachment.id === id &&
        attachment.floorId === floorId &&
        attachment.messageId === null,
    );
  return {
    attachments,
    add(attachment) {
      const kept: ChatAttachmentWithContent = {
        id: randomUUID(),
        floorId: attachment.floorId,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.content.length,
        content: Buffer.from(attachment.content),
        messageId: null,
        createdAt: attachment.createdAt,
      };
      attachments.push(kept);
      return Promise.resolve(listed(kept));
    },
    get: (floorId, id) =>
      Promise.resolve(
        attachments.find(
          (attachment) =>
            attachment.id === id && attachment.floorId === floorId,
        ),
      ),
    unsent: (floorId, ids) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const found = unsentOf(floorId, id);
          return found === undefined ? [] : [listed(found)];
        }),
      ),
    ofMessage: (floorId, messageId) =>
      Promise.resolve(
        attachments.filter(
          (attachment) =>
            attachment.floorId === floorId &&
            attachment.messageId === messageId,
        ),
      ),
    deleteUnsentBefore(before) {
      const going = attachments.filter(
        ({ messageId, createdAt }) =>
          messageId === null && createdAt.getTime() < before.getTime(),
      );
      for (const attachment of going) {
        attachments.splice(attachments.indexOf(attachment), 1);
      }
      return Promise.resolve(going.length);
    },
    bind(floorId, ids, messageId) {
      const found = ids.map((id) => unsentOf(floorId, id));
      if (
        new Set(ids).size !== ids.length ||
        found.some((attachment) => attachment === undefined)
      ) {
        return false;
      }
      for (const attachment of found) {
        if (attachment !== undefined) {
          attachments[attachments.indexOf(attachment)] = {
            ...attachment,
            messageId,
          };
        }
      }
      return true;
    },
  };
}

type Row = typeof managerChatAttachments.$inferSelect;

const mediaTypeOf = (mediaType: string): ChatAttachmentMediaType => {
  const known = chatAttachmentMediaTypes.find((each) => each === mediaType);
  if (known === undefined) {
    throw new Error(`A chat attachment has an unknown type, ${mediaType}.`);
  }
  return known;
};

const storedOf = (row: Omit<Row, "content">): StoredChatAttachment => ({
  id: row.id,
  floorId: row.floorId,
  name: row.name,
  mediaType: mediaTypeOf(row.mediaType),
  size: row.size,
  messageId: row.messageId,
  createdAt: row.createdAt,
});

/** Everything but the content, which is read only when it is needed. */
const listing = {
  id: managerChatAttachments.id,
  floorId: managerChatAttachments.floorId,
  messageId: managerChatAttachments.messageId,
  name: managerChatAttachments.name,
  mediaType: managerChatAttachments.mediaType,
  size: managerChatAttachments.size,
  createdAt: managerChatAttachments.createdAt,
};

/**
 * The attachments each of `messageIds` sent, oldest first: what the
 * database chat store lists with its messages.
 */
export async function attachmentsOfMessages(
  db: Pick<Database, "select">,
  messageIds: readonly number[],
): Promise<Map<number, ChatAttachment[]>> {
  const found = new Map<number, ChatAttachment[]>();
  if (messageIds.length === 0) {
    return found;
  }
  const rows = await db
    .select(listing)
    .from(managerChatAttachments)
    .where(inArray(managerChatAttachments.messageId, [...messageIds]))
    .orderBy(
      asc(managerChatAttachments.createdAt),
      asc(managerChatAttachments.id),
    );
  for (const row of rows) {
    if (row.messageId !== null) {
      found.set(row.messageId, [
        ...(found.get(row.messageId) ?? []),
        listed(storedOf(row)),
      ]);
    }
  }
  return found;
}

/**
 * Binds the Floor's unsent `ids` to `messageId`, in the transaction that
 * keeps the message: all of them, or `ChatAttachmentsTakenError`, which
 * rolls the message back too.
 */
export async function bindChatAttachments(
  tx: Pick<Database, "update">,
  floorId: string,
  ids: readonly string[],
  messageId: number,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const bound = await tx
    .update(managerChatAttachments)
    .set({ messageId })
    .where(
      and(
        inArray(managerChatAttachments.id, [...ids]),
        eq(managerChatAttachments.floorId, floorId),
        isNull(managerChatAttachments.messageId),
      ),
    )
    .returning({ id: managerChatAttachments.id });
  // A repeated id binds once, so is refused like a missing one.
  if (bound.length !== ids.length) {
    throw new ChatAttachmentsTakenError();
  }
}

/** Keeps attachments in `manager_chat_attachments`. */
export function databaseChatAttachmentStore(db: Database): ChatAttachmentStore {
  return {
    async add(attachment) {
      const [row] = await db
        .insert(managerChatAttachments)
        .values({
          id: randomUUID(),
          floorId: attachment.floorId,
          messageId: null,
          name: attachment.name,
          mediaType: attachment.mediaType,
          size: attachment.content.length,
          content: attachment.content,
          createdAt: attachment.createdAt,
        })
        .returning(listing);
      if (row === undefined) {
        throw new Error("The attachment was not stored.");
      }
      return listed(storedOf(row));
    },

    async get(floorId, id) {
      const [row] = await db
        .select()
        .from(managerChatAttachments)
        .where(
          and(
            eq(managerChatAttachments.id, id),
            eq(managerChatAttachments.floorId, floorId),
          ),
        );
      return row === undefined
        ? undefined
        : { ...storedOf(row), content: row.content };
    },

    async unsent(floorId, ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db
        .select(listing)
        .from(managerChatAttachments)
        .where(
          and(
            inArray(managerChatAttachments.id, [...ids]),
            eq(managerChatAttachments.floorId, floorId),
            isNull(managerChatAttachments.messageId),
          ),
        );
      return ids.flatMap((id) => {
        const row = rows.find((candidate) => candidate.id === id);
        return row === undefined ? [] : [listed(storedOf(row))];
      });
    },

    async ofMessage(floorId, messageId) {
      const rows = await db
        .select()
        .from(managerChatAttachments)
        .where(
          and(
            eq(managerChatAttachments.floorId, floorId),
            eq(managerChatAttachments.messageId, messageId),
          ),
        )
        .orderBy(
          asc(managerChatAttachments.createdAt),
          asc(managerChatAttachments.id),
        );
      return rows.map((row) => ({ ...storedOf(row), content: row.content }));
    },

    deleteUnsentBefore: (before) =>
      deleteUnsentChatAttachmentsBefore(db, before),
  };
}
