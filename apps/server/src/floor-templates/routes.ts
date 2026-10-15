import {
  FloorTemplateLibraryError,
  type FloorTemplateEntry,
  type FloorTemplateLibrary,
  type RoleRecord,
} from "@ai-office/orchestrator";
import {
  developmentTemplateId,
  duplicateFloorTemplateRequestSchema,
  floorTemplateErrorCodes,
  importFloorTemplateFromGitRequestSchema,
  importFloorTemplateRequestSchema,
  managerRole,
  reviewFloorTemplateRequestSchema,
  saveFloorTemplateRequestSchema,
  updateFloorTemplateRequestSchema,
  type ApiError,
  type FloorTemplate,
  type FloorTemplateDetail,
  type FloorTemplateErrorCode,
  type FloorTemplateList,
  type FloorTemplateSummary,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Floor Template API (PRD FR-97, FR-101), a thin adapter over the
// orchestrator's template library: the picker's list, a template's full
// contents, duplicating one, saving a Floor's set-up as one, editing and
// deleting the Owner's own (a built-in one is read-only), exporting one
// to a file, importing one from a file or a Git repository, and reviewing
// an imported one, which enables it. Every route needs a signed-in session.

const statusFor: Record<FloorTemplateErrorCode, number> = {
  [floorTemplateErrorCodes.templateNotFound]: 404,
  [floorTemplateErrorCodes.templateBuiltIn]: 409,
  [floorTemplateErrorCodes.templateNameTaken]: 409,
  [floorTemplateErrorCodes.invalidTemplate]: 422,
  [floorTemplateErrorCodes.templateChanged]: 409,
  [floorTemplateErrorCodes.roleNotFound]: 422,
  [floorTemplateErrorCodes.floorNotFound]: 404,
  [floorTemplateErrorCodes.importFailed]: 502,
  [floorTemplateErrorCodes.noTemplateInRepository]: 422,
  [floorTemplateErrorCodes.templatePathRequired]: 422,
};

/** A template's files may be up to 8 MB of text, escaped as JSON. */
const templateBodyLimit = 32 * 1024 * 1024;

type LibraryRoles = readonly Pick<RoleRecord, "id" | "name" | "stage">[];

/**
 * A template as the picker shows it: its starting team is the Manager,
 * then each Role it starts Agents in, named as the library has it (the
 * template's own name until it is added).
 */
export const templateSummary = (
  template: FloorTemplate,
  library: LibraryRoles,
  flags: { readonly builtIn: boolean; readonly enabled: boolean } = {
    builtIn: true,
    enabled: true,
  },
): FloorTemplateSummary => ({
  id: template.id,
  name: template.name,
  description: template.description,
  icon: template.icon,
  theme: template.theme,
  team: [
    { role: managerRole, name: "Manager", stage: null, count: 1 },
    ...template.roles
      .filter(({ count }) => count > 0)
      .map(({ role, count }) => {
        const inLibrary = library.find(({ id }) => id === role.id) ?? role;
        return {
          role: role.id,
          name: inLibrary.name,
          stage: inLibrary.stage,
          count,
        };
      }),
  ],
  builtIn: flags.builtIn,
  enabled: flags.enabled,
});

/** A template with its full contents, as the API sends it. */
const templateDetail = (
  entry: FloorTemplateEntry,
  library: LibraryRoles,
  clashes: readonly string[],
): FloorTemplateDetail => {
  const { template } = entry;
  return {
    ...templateSummary(template, library, entry),
    source: entry.source,
    origin: entry.origin,
    reviewedAt: entry.reviewedAt?.toISOString() ?? null,
    digest: entry.digest,
    roles: template.roles.map(({ role, count }) => ({
      role: { ...role, skills: [...role.skills] },
      count,
    })),
    settings: {
      ...template.settings,
      requiredReviewers: [...template.settings.requiredReviewers],
    },
    manager: { ...template.manager },
    labels: template.labels.map((label) => ({ ...label })),
    skills: template.skills.map(({ name, description, files }) => ({
      name,
      description,
      files: files.map(({ path, content }) => ({ path, content })),
    })),
    clashes: [...clashes],
    createdAt: entry.createdAt?.toISOString() ?? null,
    updatedAt: entry.updatedAt?.toISOString() ?? null,
  };
};

/** Answers a `FloorTemplateLibraryError` with its status; anything else is rethrown. */
const sendTemplateError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof FloorTemplateLibraryError)) {
    throw error;
  }
  if (error.code === floorTemplateErrorCodes.importFailed) {
    reply.log.warn({ err: error }, "A Floor Template was not imported.");
  }
  const body: ApiError = {
    error: error.code,
    message: error.message,
    ...(error.problems === undefined ? {} : { problems: [...error.problems] }),
  };
  return reply.code(statusFor[error.code]).send(body);
};

interface TemplateParams {
  readonly templateId: string;
}

export function registerFloorTemplateRoutes(
  app: FastifyInstance,
  options: {
    readonly templates: FloorTemplateLibrary;
    /** The office Role library, which names the templates' Roles. */
    readonly roles: () => Promise<LibraryRoles>;
  },
): void {
  const { templates } = options;

  /** A template's full contents, with its clashes as they are now. */
  const detail = async (
    entry: FloorTemplateEntry,
  ): Promise<FloorTemplateDetail> =>
    templateDetail(
      entry,
      await options.roles(),
      await templates.clashes(entry.template),
    );

  app.get(
    "/api/floor-templates",
    { config: { access: "owner" } },
    async (): Promise<FloorTemplateList> => {
      const library = await options.roles();
      return {
        templates: (await templates.list()).map((entry) =>
          templateSummary(entry.template, library, entry),
        ),
        defaultTemplate: developmentTemplateId,
      };
    },
  );

  app.get<{ Params: TemplateParams }>(
    "/api/floor-templates/:templateId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return await detail(await templates.get(request.params.templateId));
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.post(
    "/api/floor-templates",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = saveFloorTemplateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const saved = await templates.saveFloor(parsed.data);
        request.log.info(
          { templateId: saved.template.id, floorId: parsed.data.floorId },
          "A Floor's set-up was saved as a Floor Template.",
        );
        return await reply.code(201).send(await detail(saved));
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.post<{ Params: TemplateParams }>(
    "/api/floor-templates/:templateId/duplicate",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = duplicateFloorTemplateRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const copy = await templates.duplicate(
          request.params.templateId,
          parsed.data.name,
        );
        request.log.info(
          { templateId: copy.template.id, from: request.params.templateId },
          "A Floor Template was duplicated.",
        );
        return await reply.code(201).send(await detail(copy));
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.patch<{ Params: TemplateParams }>(
    "/api/floor-templates/:templateId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = updateFloorTemplateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        return await detail(
          await templates.update(request.params.templateId, parsed.data),
        );
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.delete<{ Params: TemplateParams }>(
    "/api/floor-templates/:templateId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await templates.remove(request.params.templateId);
        request.log.info(
          { templateId: request.params.templateId },
          "A Floor Template was deleted.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.get<{ Params: TemplateParams }>(
    "/api/floor-templates/:templateId/export",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const bundle = await templates.exportBundle(request.params.templateId);
        request.log.info(
          { templateId: bundle.id },
          "A Floor Template was exported.",
        );
        return await reply
          .header(
            "content-disposition",
            `attachment; filename="${bundle.id}.floor-template.json"`,
          )
          .header("cache-control", "no-store")
          .send(bundle);
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.post(
    "/api/floor-templates/import",
    { config: { access: "owner" }, bodyLimit: templateBodyLimit },
    async (request, reply) => {
      const parsed = importFloorTemplateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const imported = await templates.importBundle(
          parsed.data.bundle,
          parsed.data.name,
        );
        request.log.info(
          { templateId: imported.template.id },
          "A Floor Template was imported from a file; it waits for review.",
        );
        return await reply.code(201).send(await detail(imported));
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.post(
    "/api/floor-templates/import/git",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = importFloorTemplateFromGitRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const imported = await templates.importFromGit(parsed.data);
        request.log.info(
          { templateId: imported.template.id, url: parsed.data.url },
          "A Floor Template was imported from Git; it waits for review.",
        );
        return await reply.code(201).send(await detail(imported));
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );

  app.post<{ Params: TemplateParams }>(
    "/api/floor-templates/:templateId/review",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = reviewFloorTemplateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const reviewed = await templates.review(
          request.params.templateId,
          parsed.data.digest,
        );
        request.log.info(
          { templateId: reviewed.template.id },
          "A Floor Template was reviewed and enabled.",
        );
        return await detail(reviewed);
      } catch (error) {
        return sendTemplateError(reply, error);
      }
    },
  );
}
