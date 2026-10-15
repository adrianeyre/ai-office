import {
  NoticeError,
  type NoticeRecord,
  type Notices,
} from "@ai-office/orchestrator";
import {
  actOnNoticeRequestSchema,
  noticeErrorCodes,
  noticeListQuerySchema,
  type ApiError,
  type Notice,
  type NoticeErrorCode,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Notice Board's API (PRD §6.9, FR-48, FR-50), a thin adapter over the
// orchestrator's Notices: the open Notices, all Floors' or one Floor's, and
// dismissing one or taking one of its actions. Raising them is up to the
// parts of AI Office that need the Owner.

const statusFor: Record<NoticeErrorCode, number> = {
  [noticeErrorCodes.noticeNotFound]: 404,
  [noticeErrorCodes.noticeClosed]: 409,
  [noticeErrorCodes.actionNotOffered]: 422,
  [noticeErrorCodes.actionNotRegistered]: 422,
  [noticeErrorCodes.actionFailed]: 502,
  [noticeErrorCodes.actionInProgress]: 409,
};

/** A Notice as the API sends it. */
export const noticeBody = (notice: NoticeRecord): Notice => ({
  ...notice,
  links: notice.links.map((link) => ({ ...link })),
  positions: notice.positions.map((position) => ({ ...position })),
  actions: [...notice.actions],
  createdAt: notice.createdAt.toISOString(),
  dismissedAt: notice.dismissedAt?.toISOString() ?? null,
  actedAt: notice.actedAt?.toISOString() ?? null,
});

const sendNoticeError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof NoticeError)) {
    throw error;
  }
  if (error.code === noticeErrorCodes.actionFailed) {
    reply.log.warn({ err: error }, "A Notice's action failed.");
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface NoticeParams {
  readonly noticeId: string;
}

export function registerNoticeRoutes(
  app: FastifyInstance,
  options: { readonly notices: Notices },
): void {
  const { notices } = options;

  app.get(
    "/api/notices",
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = noticeListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      return { notices: (await notices.open(query.data)).map(noticeBody) };
    },
  );

  app.post<{ Params: NoticeParams }>(
    "/api/notices/:noticeId/dismiss",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const notice = await notices.dismiss(request.params.noticeId);
        request.log.info({ noticeId: notice.id }, "A Notice was dismissed.");
        return noticeBody(notice);
      } catch (error) {
        return sendNoticeError(reply, error);
      }
    },
  );

  app.post<{ Params: NoticeParams }>(
    "/api/notices/:noticeId/act",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = actOnNoticeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const notice = await notices.act(
          request.params.noticeId,
          parsed.data.action,
        );
        request.log.info(
          { noticeId: notice.id, action: parsed.data.action },
          "A Notice was acted on.",
        );
        return noticeBody(notice);
      } catch (error) {
        return sendNoticeError(reply, error);
      }
    },
  );
}
