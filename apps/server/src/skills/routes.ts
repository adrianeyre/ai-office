import {
  FloorError,
  SkillError,
  type FloorSkills,
  type SkillLibrary,
  type SkillRecord,
} from "@ai-office/orchestrator";
import {
  addSkillRequestSchema,
  floorSkillToggleSchema,
  importSkillRequestSchema,
  repositorySkillReviewSchema,
  reviewSkillRequestSchema,
  skillErrorCodes,
  skillUpdateSchema,
  type ApiError,
  type FloorSkillDetail,
  type FloorSkillList,
  type RepositorySkillDetail,
  type Skill,
  type SkillErrorCode,
  type SkillSummary,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// The office Skill library API (PRD FR-71, FR-72, FR-76), a thin adapter
// over the orchestrator's Skill library: list Skills, read one in full,
// add one by upload or from the editor, import one from a Git repository,
// edit it, review it, turn it on or off, and remove it. Every route needs
// a signed-in session.

const statusFor: Record<SkillErrorCode, number> = {
  [skillErrorCodes.skillNotFound]: 404,
  [skillErrorCodes.skillNameTaken]: 409,
  [skillErrorCodes.skillNotReviewed]: 409,
  [skillErrorCodes.skillChanged]: 409,
  [skillErrorCodes.importFailed]: 502,
  [skillErrorCodes.noSkillInRepository]: 422,
  [skillErrorCodes.skillPathRequired]: 422,
  [skillErrorCodes.invalidSkill]: 422,
  [skillErrorCodes.notSandboxRole]: 422,
};

/** A Skill's whole folder may be up to 4 MB of text, escaped as JSON. */
const skillBodyLimit = 16 * 1024 * 1024;

const skillFields = (skill: SkillRecord) => ({
  id: skill.id,
  name: skill.name,
  description: skill.description,
  source: skill.source,
  origin: skill.origin,
  digest: skill.digest,
  enabled: skill.enabled,
  reviewedAt: skill.reviewedAt?.toISOString() ?? null,
  createdAt: skill.createdAt.toISOString(),
  updatedAt: skill.updatedAt.toISOString(),
});

/** A Skill as `GET /api/skills` lists it: its files' paths and sizes. */
export const skillSummaryBody = (skill: SkillRecord): SkillSummary => ({
  ...skillFields(skill),
  files: skill.files.map(({ path, content }) => ({
    path,
    bytes: Buffer.byteLength(content),
  })),
});

/** A Skill with its full contents, for the Owner to read. */
export const skillBody = (skill: SkillRecord): Skill => ({
  ...skillFields(skill),
  files: skill.files.map(({ path, content }) => ({ path, content })),
});

/** Answers a `SkillError` with its status; anything else is rethrown. */
const sendSkillError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof SkillError)) {
    throw error;
  }
  const body: ApiError = {
    error: error.code,
    message: error.message,
    ...(error.problems === undefined ? {} : { problems: [...error.problems] }),
  };
  return reply.code(statusFor[error.code]).send(body);
};

interface SkillParams {
  readonly skillId: string;
}

export function registerSkillRoutes(
  app: FastifyInstance,
  options: { readonly skills: SkillLibrary },
): void {
  const { skills } = options;

  app.get("/api/skills", { config: { access: "owner" } }, async () => ({
    skills: (await skills.list()).map(skillSummaryBody),
  }));

  app.get<{ Params: SkillParams }>(
    "/api/skills/:skillId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return skillBody(await skills.get(request.params.skillId));
      } catch (error) {
        return sendSkillError(reply, error);
      }
    },
  );

  app.post(
    "/api/skills",
    { config: { access: "owner" }, bodyLimit: skillBodyLimit },
    async (request, reply) => {
      const parsed = addSkillRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const skill = await skills.add(parsed.data);
        request.log.info(
          { skillId: skill.id, source: skill.source },
          "A Skill was added.",
        );
        return await reply.code(201).send(skillBody(skill));
      } catch (error) {
        return sendSkillError(reply, error);
      }
    },
  );

  app.post(
    "/api/skills/import",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = importSkillRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const skill = await skills.importFromGit(parsed.data);
        request.log.info(
          { skillId: skill.id, source: skill.source },
          "A Skill was imported from Git.",
        );
        return await reply.code(201).send(skillBody(skill));
      } catch (error) {
        return sendSkillError(reply, error);
      }
    },
  );

  app.patch<{ Params: SkillParams }>(
    "/api/skills/:skillId",
    { config: { access: "owner" }, bodyLimit: skillBodyLimit },
    async (request, reply) => {
      const parsed = skillUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const skill = await skills.update(request.params.skillId, parsed.data);
        request.log.info({ skillId: skill.id }, "A Skill was changed.");
        return skillBody(skill);
      } catch (error) {
        return sendSkillError(reply, error);
      }
    },
  );

  app.post<{ Params: SkillParams }>(
    "/api/skills/:skillId/review",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = reviewSkillRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const skill = await skills.review(
          request.params.skillId,
          parsed.data.digest,
        );
        request.log.info(
          { skillId: skill.id },
          "A Skill was reviewed and enabled.",
        );
        return skillBody(skill);
      } catch (error) {
        return sendSkillError(reply, error);
      }
    },
  );

  app.delete<{ Params: SkillParams }>(
    "/api/skills/:skillId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await skills.remove(request.params.skillId);
        request.log.info(
          { skillId: request.params.skillId },
          "A Skill was removed.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendSkillError(reply, error);
      }
    },
  );
}

interface FloorSkillParams {
  readonly floorId: string;
}

interface FloorSkillToggleParams extends FloorSkillParams {
  readonly skillName: string;
  readonly role: string;
}

// A Floor's Skills (PRD FR-72, FR-75): the office library's enabled Skills
// and the Floor repository's own (which override office Skills of the same
// name there), each turned on or off per Role in the Floor admin. A
// repository Skill is used only once the Owner has read its files and
// reviewed exactly those (FR-76, P1-10).
export function registerFloorSkillRoutes(
  app: FastifyInstance,
  options: { readonly floorSkills: FloorSkills },
): void {
  const { floorSkills } = options;

  app.get<{ Params: FloorSkillParams }>(
    "/api/floors/:floorId/skills",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const list: FloorSkillList = await floorSkills.list(
          request.params.floorId,
        );
        if (list.repositoryError !== null) {
          request.log.warn(
            { floorId: request.params.floorId },
            list.repositoryError,
          );
        }
        return list;
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  // One in full, for the Available Skills list's modal (FR-73).
  app.get<{ Params: FloorSkillParams & { readonly skillName: string } }>(
    "/api/floors/:floorId/skills/:skillName",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const skill = await floorSkills.get(
          request.params.floorId,
          request.params.skillName,
        );
        const detail: FloorSkillDetail = {
          name: skill.name,
          description: skill.description,
          source: skill.source,
          folder: skill.folder,
          overridesOffice: skill.overridesOffice,
          files: skill.files.map(({ path, content }) => ({ path, content })),
        };
        return detail;
      } catch (error) {
        return error instanceof FloorError
          ? sendFloorError(reply, error)
          : sendSkillError(reply, error);
      }
    },
  );

  // A repository Skill in full, by its folder, reviewed or not: what the
  // Owner reads to review it (P1-10).
  app.get<{
    Params: FloorSkillParams;
    Querystring: { readonly folder?: string };
  }>(
    "/api/floors/:floorId/repository-skills",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const skill: RepositorySkillDetail = await floorSkills.repositorySkill(
          request.params.floorId,
          request.query.folder ?? "",
        );
        return skill;
      } catch (error) {
        return error instanceof FloorError
          ? sendFloorError(reply, error)
          : sendSkillError(reply, error);
      }
    },
  );

  // The Owner's review of the files they read: from now on the Skill is
  // used on the Floor while its files are exactly those (P1-10).
  app.post<{ Params: FloorSkillParams }>(
    "/api/floors/:floorId/repository-skills/review",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = repositorySkillReviewSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const skill: RepositorySkillDetail =
          await floorSkills.reviewRepositorySkill(
            request.params.floorId,
            parsed.data.folder,
            parsed.data.digest,
          );
        return skill;
      } catch (error) {
        return error instanceof FloorError
          ? sendFloorError(reply, error)
          : sendSkillError(reply, error);
      }
    },
  );

  app.put<{ Params: FloorSkillToggleParams }>(
    "/api/floors/:floorId/skills/:skillName/roles/:role",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = floorSkillToggleSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId, skillName, role } = request.params;
      try {
        await floorSkills.setEnabled(
          floorId,
          skillName,
          role,
          parsed.data.enabled,
        );
        return { name: skillName, role, enabled: parsed.data.enabled };
      } catch (error) {
        return error instanceof FloorError
          ? sendFloorError(reply, error)
          : sendSkillError(reply, error);
      }
    },
  );
}
