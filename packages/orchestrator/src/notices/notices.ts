import { randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  createRedactor,
  newNoticeSchema,
  noticeErrorCodes,
  type NewNotice,
  type NoticeErrorCode,
  type Redactor,
} from "@ai-office/shared";

import type { NoticeClosing, NoticeRecord, NoticeStore } from "./store.ts";

// Notices (PRD §6.9, FR-48): raised by the parts of AI Office that need
// the Owner, listed on the Notice Board, and kept there until the Owner
// dismisses one or takes one of its actions. Each action is done by a
// handler its source registers. Raising, dismissing and acting are each an
// event, so the board updates live.

/** Why a Notice operation was refused; `code` is one of `noticeErrorCodes`. */
export class NoticeError extends Error {
  readonly code: NoticeErrorCode;

  constructor(code: NoticeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NoticeError";
    this.code = code;
  }
}

/**
 * Thrown by an action's handler when the Notice no longer stands for what
 * is there, such as a pull request whose branch has moved on since it was
 * raised: nothing was done, and the Notice is taken off the Notice Board
 * rather than kept.
 */
export class NoticeOutdatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeOutdatedError";
  }
}

/**
 * Does a Notice's action, such as merging its pull request. It throws a
 * `NoticeOutdatedError` when the Notice is out of date.
 */
export type NoticeActionHandler = (notice: NoticeRecord) => Promise<void>;

export interface Notices {
  /**
   * Puts a Notice on the Notice Board. Each action it offers must have a
   * handler registered; an info Notice offers none.
   */
  raise(notice: NewNotice): Promise<NoticeRecord>;
  /** The open Notices, newest first: every Floor's, or one Floor's. */
  open(filter?: {
    readonly floorId?: string | undefined;
  }): Promise<NoticeRecord[]>;
  get(id: string): Promise<NoticeRecord>;
  /** Takes an open Notice off the Notice Board without acting on it. */
  dismiss(id: string): Promise<NoticeRecord>;
  /**
   * Takes one of an open Notice's actions, by its handler. The Notice
   * leaves the board only when the handler succeeds, or finds it out of
   * date (`NoticeOutdatedError`), when it is dismissed.
   */
  act(id: string, action: string): Promise<NoticeRecord>;
  /** Registers the handler for an action; returns a function to remove it. */
  registerAction(action: string, handler: NoticeActionHandler): () => void;
}

export interface NoticesOptions {
  readonly store: NoticeStore;
  readonly events: EventBus;
  /**
   * Removes credentials from titles, links and positions before they are
   * stored.
   */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createNotices(options: NoticesOptions): Notices {
  const { store, events } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `notice-${randomUUID()}`);
  const handlers = new Map<string, NoticeActionHandler>();
  /** Notices whose action is being taken right now. */
  const acting = new Set<string>();

  const get = async (id: string): Promise<NoticeRecord> => {
    const notice = await store.get(id);
    if (notice === undefined) {
      throw new NoticeError(
        noticeErrorCodes.noticeNotFound,
        `There is no Notice "${id}".`,
      );
    }
    return notice;
  };

  const closedError = (notice: NoticeRecord): NoticeError =>
    new NoticeError(
      noticeErrorCodes.noticeClosed,
      notice.actedAt === null
        ? "That Notice was already dismissed."
        : "That Notice was already acted on.",
    );

  /** The Notice, if it is open and no action on it is being taken. */
  const openNotice = async (id: string): Promise<NoticeRecord> => {
    const notice = await get(id);
    if (notice.dismissedAt !== null || notice.actedAt !== null) {
      throw closedError(notice);
    }
    if (acting.has(id)) {
      throw new NoticeError(
        noticeErrorCodes.actionInProgress,
        "An action on that Notice is being taken.",
      );
    }
    return notice;
  };

  /** Closes `notice`, or explains why it could not be. */
  const close = async (
    notice: NoticeRecord,
    closing: NoticeClosing,
  ): Promise<NoticeRecord> => {
    const closed = await store.close(notice.id, closing);
    if (closed === undefined) {
      throw closedError(await get(notice.id));
    }
    return closed;
  };

  return {
    async raise(input) {
      const parsed = newNoticeSchema.parse(input);
      if (parsed.kind === "info" && parsed.actions.length > 0) {
        throw new TypeError("An info Notice offers no actions.");
      }
      const unregistered = parsed.actions.filter(({ id }) => !handlers.has(id));
      if (unregistered.length > 0) {
        throw new NoticeError(
          noticeErrorCodes.actionNotRegistered,
          `No handler is registered for ${unregistered.map(({ id }) => id).join(", ")}.`,
        );
      }
      const link = <Link extends { url: string }>(value: Link | undefined) =>
        value === undefined
          ? null
          : { ...value, url: redactor.redactText(value.url) };
      const notice: NoticeRecord = {
        id: newId(),
        kind: parsed.kind,
        title: redactor.redactText(parsed.title),
        floorId: parsed.floorId ?? null,
        agentId: parsed.agentId ?? null,
        issue: link(parsed.issue),
        pullRequest: link(parsed.pullRequest),
        ciRunUrl:
          parsed.ciRunUrl === undefined
            ? null
            : redactor.redactText(parsed.ciRunUrl),
        links: parsed.links.map((value) => ({
          label: redactor.redactText(value.label),
          url: redactor.redactText(value.url),
        })),
        positions: parsed.positions.map(({ label, text, url }) => ({
          label: redactor.redactText(label),
          text: redactor.redactText(text),
          ...(url === undefined ? {} : { url: redactor.redactText(url) }),
        })),
        actions: parsed.actions,
        createdAt: now(),
        dismissedAt: null,
        actedAt: null,
        actedOn: null,
      };
      await store.add(notice);
      const issue = notice.issue?.number ?? notice.pullRequest?.number;
      await events.publish({
        type: "notice.raised",
        version: 1,
        noticeId: notice.id,
        kind: notice.kind,
        title: notice.title,
        ...(notice.floorId === null ? {} : { floorId: notice.floorId }),
        ...(notice.agentId === null ? {} : { agentId: notice.agentId }),
        ...(issue === undefined ? {} : { issue }),
      });
      return notice;
    },

    open: (filter) => store.open(filter),

    get,

    async dismiss(id) {
      const notice = await openNotice(id);
      const dismissed = await close(notice, { dismissedAt: now() });
      await events.publish({
        type: "notice.dismissed",
        version: 1,
        noticeId: id,
        ...(notice.floorId === null ? {} : { floorId: notice.floorId }),
      });
      return dismissed;
    },

    async act(id, action) {
      const notice = await openNotice(id);
      if (!notice.actions.some((offered) => offered.id === action)) {
        throw new NoticeError(
          noticeErrorCodes.actionNotOffered,
          `That Notice does not offer "${action}".`,
        );
      }
      const handler = handlers.get(action);
      if (handler === undefined) {
        throw new NoticeError(
          noticeErrorCodes.actionNotRegistered,
          `No handler is registered for ${action}.`,
        );
      }
      acting.add(id);
      try {
        try {
          await handler(notice);
        } catch (error) {
          if (error instanceof NoticeOutdatedError) {
            await close(notice, { dismissedAt: now() });
            await events.publish({
              type: "notice.dismissed",
              version: 1,
              noticeId: id,
              ...(notice.floorId === null ? {} : { floorId: notice.floorId }),
            });
            throw new NoticeError(
              noticeErrorCodes.actionFailed,
              redactor.redactText(
                `The action was not taken, and the Notice is closed: ${error.message}`,
              ),
              { cause: error },
            );
          }
          throw new NoticeError(
            noticeErrorCodes.actionFailed,
            redactor.redactText(
              `The action failed, so the Notice stays: ${messageOf(error)}`,
            ),
            { cause: error },
          );
        }
        const acted = await close(notice, { actedAt: now(), actedOn: action });
        await events.publish({
          type: "notice.acted_on",
          version: 1,
          noticeId: id,
          ...(notice.floorId === null ? {} : { floorId: notice.floorId }),
          action,
        });
        return acted;
      } finally {
        acting.delete(id);
      }
    },

    registerAction(action, handler) {
      if (handlers.has(action)) {
        throw new Error(`A handler for ${action} is already registered.`);
      }
      handlers.set(action, handler);
      return () => {
        if (handlers.get(action) === handler) {
          handlers.delete(action);
        }
      };
    },
  };
}
