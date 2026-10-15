import { notices, type Database } from "@ai-office/db";
import {
  noticeActionSchema,
  noticeLinkSchema,
  noticePositionSchema,
  type NoticeAction,
  type NoticeKind,
  type NoticeLink,
  type NoticePosition,
} from "@ai-office/shared";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";

// Where Notices live (PRD FR-48): the `notices` table, or memory for tests.

/** A Notice as the orchestrator holds it. */
export interface NoticeRecord {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly floorId: string | null;
  readonly agentId: string | null;
  readonly issue: { readonly number: number; readonly url: string } | null;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
  } | null;
  readonly ciRunUrl: string | null;
  /** Further links, in order. */
  readonly links: readonly NoticeLink[];
  /** The sides of a conflict between Roles, in the order they arose. */
  readonly positions: readonly NoticePosition[];
  readonly actions: readonly NoticeAction[];
  readonly createdAt: Date;
  readonly dismissedAt: Date | null;
  readonly actedAt: Date | null;
  /** The id of the action taken; null until one is. */
  readonly actedOn: string | null;
}

/** How a Notice left the Notice Board. */
export type NoticeClosing =
  | { readonly dismissedAt: Date }
  | { readonly actedAt: Date; readonly actedOn: string };

export interface NoticeStore {
  add(notice: NoticeRecord): Promise<void>;
  get(id: string): Promise<NoticeRecord | undefined>;
  /** The Notices not yet dismissed or acted on, newest first. */
  open(filter?: {
    readonly floorId?: string | undefined;
  }): Promise<NoticeRecord[]>;
  /**
   * Closes an open Notice; undefined if there is none by that id, or it
   * is already closed.
   */
  close(id: string, closing: NoticeClosing): Promise<NoticeRecord | undefined>;
  /**
   * Deletes the Notices that were dismissed or acted on before `before`
   * (retention, PRD §7). An open Notice stays, however old, until the
   * Owner closes it (FR-48). Resolves with how many went.
   */
  deleteClosedBefore(before: Date): Promise<number>;
}

const isOpen = (notice: NoticeRecord): boolean =>
  notice.dismissedAt === null && notice.actedAt === null;

/** When a Notice left the Notice Board; null while it is on it. */
const closedAt = (notice: NoticeRecord): Date | null =>
  notice.dismissedAt ?? notice.actedAt;

const newestFirst = (a: NoticeRecord, b: NoticeRecord): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

const closingColumns = (closing: NoticeClosing) =>
  "dismissedAt" in closing
    ? { dismissedAt: closing.dismissedAt }
    : { actedAt: closing.actedAt, actedOn: closing.actedOn };

/** Keeps Notices in memory: for tests. */
export function memoryNoticeStore(): NoticeStore & {
  readonly notices: Map<string, NoticeRecord>;
} {
  const all = new Map<string, NoticeRecord>();
  const copy = (notice: NoticeRecord): NoticeRecord => structuredClone(notice);
  return {
    notices: all,
    add(notice) {
      if (all.has(notice.id)) {
        return Promise.reject(new Error(`Notice ${notice.id} exists.`));
      }
      all.set(notice.id, copy(notice));
      return Promise.resolve();
    },
    get(id) {
      const notice = all.get(id);
      return Promise.resolve(notice === undefined ? undefined : copy(notice));
    },
    open({ floorId } = {}) {
      return Promise.resolve(
        [...all.values()]
          .filter(
            (notice) =>
              isOpen(notice) &&
              (floorId === undefined || notice.floorId === floorId),
          )
          .sort(newestFirst)
          .map(copy),
      );
    },
    close(id, closing) {
      const notice = all.get(id);
      if (notice === undefined || !isOpen(notice)) {
        return Promise.resolve(undefined);
      }
      const closed = { ...notice, ...closingColumns(closing) };
      all.set(id, closed);
      return Promise.resolve(copy(closed));
    },
    deleteClosedBefore(before) {
      let deleted = 0;
      for (const notice of [...all.values()]) {
        const closed = closedAt(notice);
        if (closed !== null && closed < before) {
          all.delete(notice.id);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
  };
}

type NoticeRow = typeof notices.$inferSelect;

const toRecord = (row: NoticeRow): NoticeRecord => ({
  id: row.id,
  kind: row.kind === "action" ? "action" : "info",
  title: row.title,
  floorId: row.floorId,
  agentId: row.agentId,
  issue:
    row.issue === null || row.issueUrl === null
      ? null
      : { number: row.issue, url: row.issueUrl },
  pullRequest:
    row.pullRequest === null || row.pullRequestUrl === null
      ? null
      : { number: row.pullRequest, url: row.pullRequestUrl },
  ciRunUrl: row.ciRunUrl,
  links: noticeLinkSchema.array().parse(row.links),
  positions: noticePositionSchema.array().parse(row.positions),
  actions: noticeActionSchema.array().parse(row.actions),
  createdAt: row.createdAt,
  dismissedAt: row.dismissedAt,
  actedAt: row.actedAt,
  actedOn: row.actedOn,
});

const openCondition = and(isNull(notices.dismissedAt), isNull(notices.actedAt));

/** Keeps Notices in the `notices` table. */
export function databaseNoticeStore(db: Database): NoticeStore {
  return {
    async add(notice) {
      await db.insert(notices).values({
        id: notice.id,
        kind: notice.kind,
        title: notice.title,
        floorId: notice.floorId,
        agentId: notice.agentId,
        issue: notice.issue?.number ?? null,
        issueUrl: notice.issue?.url ?? null,
        pullRequest: notice.pullRequest?.number ?? null,
        pullRequestUrl: notice.pullRequest?.url ?? null,
        ciRunUrl: notice.ciRunUrl,
        links: notice.links,
        positions: notice.positions,
        actions: notice.actions,
        createdAt: notice.createdAt,
        dismissedAt: notice.dismissedAt,
        actedAt: notice.actedAt,
        actedOn: notice.actedOn,
      });
    },

    async get(id) {
      const [row] = await db.select().from(notices).where(eq(notices.id, id));
      return row === undefined ? undefined : toRecord(row);
    },

    async open({ floorId } = {}) {
      const rows = await db
        .select()
        .from(notices)
        .where(
          floorId === undefined
            ? openCondition
            : and(openCondition, eq(notices.floorId, floorId)),
        )
        .orderBy(desc(notices.createdAt), desc(notices.id));
      return rows.map(toRecord);
    },

    async close(id, closing) {
      const [row] = await db
        .update(notices)
        .set(closingColumns(closing))
        .where(and(eq(notices.id, id), openCondition))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },

    async deleteClosedBefore(before) {
      const deleted = await db
        .delete(notices)
        .where(
          or(lt(notices.dismissedAt, before), lt(notices.actedAt, before)),
        );
      return deleted.rowCount ?? 0;
    },
  };
}
