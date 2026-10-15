import { z } from "zod";

// Notices (PRD §6.9, FR-48): what the Owner should see or act on, on the
// Notice Board until they dismiss it or take its action. The server, the
// orchestrator and the web app share these.

/** An action Notice wants the Owner to do something; an info one does not. */
export const noticeKinds = ["action", "info"] as const;
export type NoticeKind = (typeof noticeKinds)[number];

/** Links are shown to the Owner, so only web addresses are taken. */
const webUrl = z.url({
  protocol: /^https?$/,
  error: "A link is an http or https address.",
});
const number = z.number().int().positive();

/**
 * A one-click action a Notice offers, such as "Approve and merge". `id`
 * names the handler that does it, which must be registered before a Notice
 * can offer it.
 */
export const noticeActionSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, {
      error: "An action's id is lower case, such as raise_cap.",
    })
    .max(64),
  label: z.string().trim().min(1).max(60),
  /**
   * For an action the Owner takes on a page of AI Office, such as signing
   * in to an AI Account again: that page's path. The Notice Board links to
   * it, and its handler then only checks the action was taken.
   */
  href: z
    .string()
    .regex(/^\/(?!\/)\S*$/, {
      error: "An action's page is a path in AI Office.",
    })
    .max(500)
    .optional(),
  /**
   * The commit it acts on, when it acts on one: the head "Approve and
   * merge" merges, which is what the Owner was asked about (W1-6). The
   * action does nothing to any other.
   */
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, { error: "A commit is 40 hex digits." })
    .optional(),
});
export type NoticeAction = z.infer<typeof noticeActionSchema>;

/** A further link a Notice carries, such as one round of a Review Loop. */
export const noticeLinkSchema = z.strictObject({
  label: z.string().trim().min(1).max(60),
  url: webUrl,
});
export type NoticeLink = z.infer<typeof noticeLinkSchema>;

/**
 * One side of a conflict between Roles (FR-30), such as QA failing what
 * every reviewer approved: shown beside the other side, so the Owner can
 * weigh them.
 */
export const noticePositionSchema = z.strictObject({
  /** Whose position it is and what they did, such as "QA: failed". */
  label: z.string().trim().min(1).max(80),
  /** What they said, in their own words. */
  text: z.string().trim().min(1).max(1500),
  /** Where they said it, such as a review on the pull request. */
  url: webUrl.optional(),
});
export type NoticePosition = z.infer<typeof noticePositionSchema>;

/** What raising a Notice takes (in the orchestrator). */
export const newNoticeSchema = z.strictObject({
  kind: z.enum(noticeKinds),
  title: z
    .string()
    .trim()
    .min(1, { error: "Give the Notice a title." })
    .max(200, { error: "Use at most 200 characters for a Notice's title." }),
  /** The Floor it is about; absent for the whole Office. */
  floorId: z.string().min(1).optional(),
  /** The Agent it is about: its desk is linked. */
  agentId: z.string().min(1).optional(),
  issue: z.strictObject({ number, url: webUrl }).optional(),
  pullRequest: z.strictObject({ number, url: webUrl }).optional(),
  ciRunUrl: webUrl.optional(),
  /** Further links, in order: each round of a Review Loop that hit its cap. */
  links: z.array(noticeLinkSchema).max(10).default([]),
  /** The two sides of a conflict between Roles, in the order they arose. */
  positions: z.array(noticePositionSchema).max(2).default([]),
  /** Its one-click actions; an info Notice has none. */
  actions: z.array(noticeActionSchema).max(4).default([]),
});
export type NewNotice = z.input<typeof newNoticeSchema>;

/** A Notice, as the API sends it. */
export const noticeSchema = z.object({
  id: z.string(),
  kind: z.enum(noticeKinds),
  title: z.string(),
  floorId: z.string().nullable(),
  agentId: z.string().nullable(),
  issue: z.object({ number, url: z.string() }).nullable(),
  pullRequest: z.object({ number, url: z.string() }).nullable(),
  ciRunUrl: z.string().nullable(),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  /** The sides of a conflict between Roles, shown side by side. */
  positions: z.array(
    z.object({
      label: z.string(),
      text: z.string(),
      url: z.string().optional(),
    }),
  ),
  actions: z.array(noticeActionSchema),
  createdAt: z.iso.datetime({ offset: true }),
  /** When the Owner dismissed it; null otherwise. */
  dismissedAt: z.iso.datetime({ offset: true }).nullable(),
  /** When its action was taken; null otherwise. */
  actedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Which action was taken; null until one is. */
  actedOn: z.string().nullable(),
});
export type Notice = z.infer<typeof noticeSchema>;

/** The body of `GET /api/notices`: the open Notices, newest first. */
export const noticeListSchema = z.object({ notices: z.array(noticeSchema) });

/** The query of `GET /api/notices`. */
export const noticeListQuerySchema = z.strictObject({
  floorId: z.string().min(1).optional(),
});

/** The body of `POST /api/notices/:noticeId/act`. */
export const actOnNoticeRequestSchema = z.strictObject({
  action: noticeActionSchema.shape.id,
});
export type ActOnNoticeRequest = z.infer<typeof actOnNoticeRequestSchema>;

/** Codes in the `error` field of the Notice API's errors. */
export const noticeErrorCodes = {
  noticeNotFound: "notice_not_found",
  /** It was already dismissed or acted on. */
  noticeClosed: "notice_closed",
  /** The Notice does not offer that action. */
  actionNotOffered: "action_not_offered",
  /** No handler is registered for the action. */
  actionNotRegistered: "action_not_registered",
  /** The action's handler failed; the Notice stays open. */
  actionFailed: "action_failed",
  /** The action is already being taken. */
  actionInProgress: "action_in_progress",
} as const;
export type NoticeErrorCode =
  (typeof noticeErrorCodes)[keyof typeof noticeErrorCodes];
