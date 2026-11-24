import {
  GuidelineProposalError,
  GuidelineVersionError,
  type GuidelineProposals,
  type GuidelinesAdmin,
} from "@ai-office/orchestrator";
import {
  guidelineErrorCodes,
  guidelineVersionRequestSchema,
  type ApiError,
  type FloorGuidelineList,
  type GuidelineProposalList,
  type OpenedGuidelineProposal,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// A Floor's Guidelines in its admin (Guidelines, Specs and Hooks PRD,
// FR-103, FR-111; ADR 0014), a thin adapter over the orchestrator's
// Guidelines admin: list them as they are on the default branch now, and
// approve or dismiss the version the Owner saw, named by its content hash.
// A version that is no longer the one waiting is a 409.
//
// The Guidelines Agents propose (FR-110, FR-111) wait in the same card:
// list them, open one as a pull request the GitHub App opens for the Owner
// to merge, or reject one. One that is gone is a 404; one settled already,
// or already on the default branch, a 409. Every route needs a signed-in
// session.

interface GuidelineParams {
  readonly floorId: string;
  readonly name: string;
}

/** Answers a `GuidelineVersionError` or `FloorError`; anything else is rethrown. */
const sendGuidelineError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof GuidelineVersionError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError =
    error.code === "not_found"
      ? { error: guidelineErrorCodes.guidelineNotFound, message: error.message }
      : { error: guidelineErrorCodes.guidelineChanged, message: error.message };
  return reply.code(error.code === "not_found" ? 404 : 409).send(body);
};

/** Answers a `GuidelineProposalError` or `FloorError`; anything else is rethrown. */
const sendProposalError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof GuidelineProposalError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError = {
    error: {
      not_found: guidelineErrorCodes.proposalNotFound,
      settled: guidelineErrorCodes.proposalSettled,
      unchanged: guidelineErrorCodes.proposalUnchanged,
    }[error.code],
    message: error.message,
  };
  return reply.code(error.code === "not_found" ? 404 : 409).send(body);
};

interface ProposalParams {
  readonly floorId: string;
  readonly id: string;
}

/** A proposal's id from the path; undefined unless a positive integer. */
const proposalIdOf = (id: string): number | undefined =>
  /^[1-9]\d{0,15}$/.test(id) ? Number(id) : undefined;

export function registerGuidelineRoutes(
  app: FastifyInstance,
  options: {
    readonly guidelines: GuidelinesAdmin;
    readonly proposals: GuidelineProposals;
  },
): void {
  const { guidelines, proposals } = options;

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/guideline-proposals",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const list: GuidelineProposalList = await proposals.list(
          request.params.floorId,
        );
        return list;
      } catch (error) {
        return sendProposalError(reply, error);
      }
    },
  );

  app.post<{ Params: ProposalParams }>(
    "/api/floors/:floorId/guideline-proposals/:id/open",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = proposalIdOf(request.params.id);
      if (id === undefined) {
        return sendProposalError(
          reply,
          new GuidelineProposalError("not_found", "There is no such proposal."),
        );
      }
      try {
        const opened: OpenedGuidelineProposal = await proposals.open(
          request.params.floorId,
          id,
        );
        return opened;
      } catch (error) {
        return sendProposalError(reply, error);
      }
    },
  );

  app.post<{ Params: ProposalParams }>(
    "/api/floors/:floorId/guideline-proposals/:id/reject",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = proposalIdOf(request.params.id);
      if (id === undefined) {
        return sendProposalError(
          reply,
          new GuidelineProposalError("not_found", "There is no such proposal."),
        );
      }
      try {
        const list: GuidelineProposalList = await proposals.reject(
          request.params.floorId,
          id,
        );
        return list;
      } catch (error) {
        return sendProposalError(reply, error);
      }
    },
  );

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/guidelines",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const list: FloorGuidelineList = await guidelines.list(
          request.params.floorId,
        );
        return list;
      } catch (error) {
        return sendGuidelineError(reply, error);
      }
    },
  );

  for (const action of ["approve", "dismiss"] as const) {
    app.post<{ Params: GuidelineParams }>(
      `/api/floors/:floorId/guidelines/:name/${action}`,
      { config: { access: "owner" } },
      async (request, reply) => {
        const parsed = guidelineVersionRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return sendInvalidRequest(reply, parsed.error);
        }
        const { floorId, name } = request.params;
        try {
          const list: FloorGuidelineList = await guidelines[action](
            floorId,
            name,
            parsed.data.contentHash,
          );
          return list;
        } catch (error) {
          return sendGuidelineError(reply, error);
        }
      },
    );
  }
}
