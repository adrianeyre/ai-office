import type {
  RequestDetail,
  RequestHistory,
  StoredRequest,
} from "@ai-office/gateway";
import {
  gatewayRequestFilterSchema,
  gatewayRequestQuerySchema,
  type ApiError,
  type GatewayLogLine,
  type GatewayRequestDetail,
  type GatewayRequestSummary,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { sendInvalidRequest } from "../auth/responses.ts";
import type { LogHub } from "./log-hub.ts";
import { openSse } from "./sse.ts";

// Request history and the live streams (PRD FR-44), a thin adapter over
// the Gateway's request history and log:
// - `GET /api/gateway/requests`: searchable, filterable, newest first, a
//   page at a time;
// - `GET /api/gateway/requests/:id`: one request, with redacted headers
//   and, while body storage was on, its bodies;
// - `GET /api/gateway/requests/stream`: each new request as it is
//   recorded, over server-sent events, resuming after `Last-Event-ID`;
// - `GET /api/gateway/logs/stream`: the Gateway's log lines, the recent
//   ones first.
// Every route needs a signed-in session.

/** A request as the list and the live stream send it. */
export const requestSummaryBody = (
  request: StoredRequest,
): GatewayRequestSummary => ({
  id: request.id,
  startedAt: request.startedAt.toISOString(),
  endpoint: request.endpoint,
  model: request.model,
  streamed: request.streamed,
  status: request.status,
  latencyMs: request.latencyMs,
  timeToFirstByteMs: request.timeToFirstByteMs,
  inputTokens: request.inputTokens,
  outputTokens: request.outputTokens,
  cacheReadInputTokens: request.cacheReadInputTokens,
  cacheCreationInputTokens: request.cacheCreationInputTokens,
  estimatedCostUsd: request.estimatedCostUsd,
  account: request.account,
  aiAccountId: request.accountId,
  agentId: request.agentId,
  floorId: request.floorId,
  ownerTool: request.ownerTool,
  issue: request.issue,
  pullRequest: request.pullRequest,
  upstreamRequestId: request.upstreamRequestId,
  keepAlive: request.keepAlive ?? false,
});

const requestDetailBody = (request: RequestDetail): GatewayRequestDetail => ({
  ...requestSummaryBody(request),
  requestHeaders:
    request.requestHeaders === null ? null : { ...request.requestHeaders },
  responseHeaders:
    request.responseHeaders === null ? null : { ...request.responseHeaders },
  bodies: request.bodies,
});

const streamQuerySchema = gatewayRequestFilterSchema.extend({
  lastEventId: z.coerce.number().int().min(0).optional(),
});
const lastEventIdSchema = z.coerce.number().int().min(0);
const idSchema = z.coerce.number().int().positive();

export interface GatewayRequestRoutesOptions {
  readonly history: RequestHistory;
  readonly logs: LogHub;
  /** How often a stream sends a heartbeat (and re-checks the session). */
  readonly heartbeatMs: number;
  readonly signedIn: (request: FastifyRequest) => Promise<boolean>;
}

/** The id a stream resumes after: `Last-Event-ID`, or `?lastEventId=`. */
function resumeAfter(
  request: FastifyRequest,
  fromQuery: number | undefined,
): z.ZodSafeParseResult<number | undefined> {
  const header = request.headers["last-event-id"];
  return header === undefined
    ? { success: true, data: fromQuery }
    : lastEventIdSchema.safeParse(header);
}

export function registerGatewayRequestRoutes(
  app: FastifyInstance,
  options: GatewayRequestRoutesOptions,
): void {
  const { history, logs } = options;
  const open = new Set<() => void>();
  app.addHook("preClose", (done) => {
    for (const end of [...open]) {
      end();
    }
    done();
  });

  app.get(
    "/api/gateway/requests",
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = gatewayRequestQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const { from, to, ...rest } = query.data;
      const page = await history.list({
        ...rest,
        from: from === undefined ? undefined : new Date(from),
        to: to === undefined ? undefined : new Date(to),
      });
      return {
        requests: page.requests.map(requestSummaryBody),
        nextBefore: page.nextBefore,
      };
    },
  );

  app.get(
    "/api/gateway/requests/stream",
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = streamQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const after = resumeAfter(request, query.data.lastEventId);
      if (!after.success) {
        return sendInvalidRequest(reply, after.error);
      }
      // The filters alone, without `lastEventId`.
      const filter = gatewayRequestFilterSchema.parse(query.data);

      let unsubscribe = (): void => undefined;
      const stream = openSse(request, reply, {
        heartbeatMs: options.heartbeatMs,
        signedIn: options.signedIn,
        open,
        onEnd: () => {
          unsubscribe();
        },
      });
      // Subscribe first and hold what arrives while catching up, so
      // nothing is lost or sent twice.
      let lastSent = after.data ?? 0;
      let live = false;
      const held: StoredRequest[] = [];
      const send = (stored: StoredRequest) => {
        if (stored.id > lastSent) {
          lastSent = stored.id;
          stream.send(stored.id, requestSummaryBody(stored));
        }
      };
      unsubscribe = history.subscribe((stored) => {
        if (live) {
          send(stored);
        } else {
          held.push(stored);
        }
      }, filter);
      try {
        if (after.data !== undefined) {
          for (const stored of await history.after(lastSent, filter)) {
            send(stored);
          }
        }
        for (const stored of held) {
          send(stored);
        }
        held.length = 0;
        live = true;
      } catch (error) {
        request.log.error(
          { err: error },
          "The live request stream failed to catch up.",
        );
        stream.end();
      }
    },
  );

  app.get<{ Params: { readonly requestId: string } }>(
    "/api/gateway/requests/:requestId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = idSchema.safeParse(request.params.requestId);
      const found = id.success ? await history.get(id.data) : undefined;
      if (found === undefined) {
        const body: ApiError = {
          error: "gateway_request_not_found",
          message: "There is no such Gateway request.",
        };
        return reply.code(404).send(body);
      }
      return requestDetailBody(found);
    },
  );

  app.get(
    "/api/gateway/logs/stream",
    { config: { access: "owner" } },
    (request, reply) => {
      const query = z
        .object({ lastEventId: lastEventIdSchema.optional() })
        .safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const after = resumeAfter(request, query.data.lastEventId);
      if (!after.success) {
        return sendInvalidRequest(reply, after.error);
      }
      let unsubscribe = (): void => undefined;
      const stream = openSse(request, reply, {
        heartbeatMs: options.heartbeatMs,
        signedIn: options.signedIn,
        open,
        onEnd: () => {
          unsubscribe();
        },
      });
      let lastSent = after.data ?? 0;
      const send = (line: GatewayLogLine) => {
        if (line.id > lastSent) {
          lastSent = line.id;
          stream.send(line.id, line);
        }
      };
      // The recent lines, then each new one; nothing comes between the two.
      for (const line of logs.recent(lastSent)) {
        send(line);
      }
      unsubscribe = logs.subscribe(send);
      return reply;
    },
  );
}
