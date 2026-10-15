import {
  AgentError,
  modelOf,
  type AgentRecord,
  type Agents,
  type DefaultModels,
  type RoleRecord,
} from "@ai-office/orchestrator";
import {
  addAgentRequestSchema,
  agentErrorCodes,
  teamSizeRequestSchema,
  updateAgentRequestSchema,
  type Agent,
  type AgentErrorCode,
  type ApiError,
  type TeamChange,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// The Agent API (PRD §6.3): a Floor's Agents, the Agent editor's changes
// to each one's config (FR-11, FR-12), which its next task uses, and its
// team (FR-10): adding an Agent, removing one, and each Role's team size,
// within the Floor's "most Agents". A Contractor (ADR 0004) is listed with
// what it is there for and its one-off Role, if it has one, and the Owner
// may keep it on the team.

const statusFor: Record<AgentErrorCode, number> = {
  [agentErrorCodes.managerExists]: 409,
  [agentErrorCodes.managerNotRemovable]: 409,
  [agentErrorCodes.nameTaken]: 409,
  [agentErrorCodes.modelRequired]: 400,
  [agentErrorCodes.agentNotFound]: 404,
  [agentErrorCodes.modelNotInCatalogue]: 400,
  [agentErrorCodes.effortNotSupported]: 400,
  [agentErrorCodes.roleNotFound]: 404,
  [agentErrorCodes.mostAgentsReached]: 409,
  [agentErrorCodes.notAContractor]: 409,
};

/** A Floor's one-off Roles, which its Contractors' bodies name. */
type OneOffRoles = readonly Pick<RoleRecord, "id" | "name" | "description">[];

/** An Agent as the API sends it, with its AI Provider's default Model. */
export const agentBody = (
  agent: AgentRecord,
  defaults?: DefaultModels,
  oneOffs: OneOffRoles = [],
): Agent => {
  const { contractor } = agent;
  const oneOff = oneOffs.find(({ id }) => id === agent.role);
  return {
    ...agent,
    model: modelOf(agent, defaults) ?? "",
    createdAt: agent.createdAt.toISOString(),
    leavingAt: agent.leavingAt?.toISOString() ?? null,
    contractor:
      contractor === null
        ? null
        : {
            kind: contractor.kind,
            batchId: contractor.batchId,
            oneOffRole: !contractor.oneOffRole
              ? null
              : {
                  name: oneOff?.name ?? agent.role,
                  description: oneOff?.description ?? "",
                },
          },
  };
};

/** Answers an `AgentError` or a `FloorError`; anything else is rethrown. */
const sendAgentError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof AgentError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface AgentParams {
  readonly floorId: string;
  readonly agentId: string;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  options: {
    readonly agents: Agents;
    /** Each AI Provider's default Model (FR-15). */
    readonly defaultModels?: () => Promise<DefaultModels>;
    /** A Floor's one-off Roles (ADR 0004); none without it. */
    readonly oneOffRoles?: (floorId: string) => Promise<OneOffRoles>;
  },
): void {
  /** The Floor's Agents' bodies, as the API sends them. */
  const bodiesOn = async (floorId: string) => {
    const defaults = await options.defaultModels?.();
    const oneOffs = (await options.oneOffRoles?.(floorId)) ?? [];
    return (agent: AgentRecord) => agentBody(agent, defaults, oneOffs);
  };

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/agents",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const agents = await options.agents.list(request.params.floorId);
        const body = await bodiesOn(request.params.floorId);
        return { agents: agents.map(body) };
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.post<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/agents",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = addAgentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId } = request.params;
      try {
        const agent = await options.agents.addToTeam(
          floorId,
          parsed.data.role,
          parsed.data.name,
        );
        request.log.info(
          { floorId, agentId: agent.id, role: agent.role },
          "An Agent was added.",
        );
        return await reply
          .code(201)
          .send(agentBody(agent, await options.defaultModels?.()));
      } catch (error) {
        return sendAgentError(reply, error);
      }
    },
  );

  app.delete<{ Params: AgentParams }>(
    "/api/floors/:floorId/agents/:agentId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, agentId } = request.params;
      try {
        const { agent, removed } = await options.agents.remove(
          floorId,
          agentId,
        );
        request.log.info(
          { floorId, agentId, removed },
          removed
            ? "An Agent was removed."
            : "An Agent is leaving once its task ends.",
        );
        const body = (await bodiesOn(floorId))(agent);
        const change: TeamChange = {
          added: [],
          removed: removed ? [body] : [],
          leaving: removed ? [] : [body],
        };
        return change;
      } catch (error) {
        return sendAgentError(reply, error);
      }
    },
  );

  app.put<{ Params: { readonly floorId: string; readonly role: string } }>(
    "/api/floors/:floorId/team/:role",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, role } = request.params;
      // A Role the office Role library has not is refused as not found.
      const parsed = teamSizeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const change = await options.agents.setTeamSize(
          floorId,
          role,
          parsed.data.count,
        );
        request.log.info(
          {
            floorId,
            role,
            count: parsed.data.count,
            added: change.added.length,
            removed: change.removed.length,
            leaving: change.leaving.length,
          },
          "A Role's team size was set.",
        );
        const defaults = await options.defaultModels?.();
        const body: TeamChange = {
          added: change.added.map((agent) => agentBody(agent, defaults)),
          removed: change.removed.map((agent) => agentBody(agent, defaults)),
          leaving: change.leaving.map((agent) => agentBody(agent, defaults)),
        };
        return body;
      } catch (error) {
        return sendAgentError(reply, error);
      }
    },
  );

  app.patch<{ Params: AgentParams }>(
    "/api/floors/:floorId/agents/:agentId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = updateAgentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId, agentId } = request.params;
      try {
        const agent = await options.agents.update(
          floorId,
          agentId,
          parsed.data,
        );
        // Which settings, never their values: extra instructions are the
        // Owner's own words.
        request.log.info(
          { floorId, agentId, settings: Object.keys(parsed.data) },
          "An Agent's config was changed.",
        );
        return (await bodiesOn(floorId))(agent);
      } catch (error) {
        return sendAgentError(reply, error);
      }
    },
  );

  // "Keep on the team" (ADR 0004): the Contractor is an ordinary Agent from
  // now on, and never leaves on its own.
  app.post<{ Params: AgentParams }>(
    "/api/floors/:floorId/agents/:agentId/keep",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, agentId } = request.params;
      try {
        const agent = await options.agents.keep(floorId, agentId);
        request.log.info({ floorId, agentId }, "A Contractor was kept.");
        return (await bodiesOn(floorId))(agent);
      } catch (error) {
        return sendAgentError(reply, error);
      }
    },
  );
}
