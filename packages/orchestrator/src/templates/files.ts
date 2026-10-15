import { createHash } from "node:crypto";

import {
  describeSkill,
  floorTemplateManifestFileName,
  floorTemplateRolesFolder,
  floorTemplateSkillsFolder,
  parseFloorTemplateManifest,
  parseRoleDocument,
  skillFileName,
  skillFileSchema,
  skillProblems,
  templateIdSchema,
  type FloorTemplate,
  type FloorTemplateFile,
  type FloorTemplateManifest,
  type FloorTemplateSkill,
  type RoleDefinition,
  type SkillFile,
} from "@ai-office/shared";
import { stringify as stringifyYaml } from "yaml";

// A Floor Template as the files of its folder (PRD FR-99, FR-101), and
// back. The built-in templates are folders under `templates/`; an
// exported template is the same files in one document, and a template
// imported from Git is the same folder in its repository. So every
// template, wherever it comes from, is checked here, the same way:
// its manifest against the schema, each Role's file, each Skill's folder,
// and the template as a whole (its Roles are the ones its manifest lists,
// its required reviewers are in the review Stage, its Roles' Skills are
// beside them).

/** A file that is not a valid part of a template. */
export class FloorTemplateError extends Error {
  /** The file (or folder) at fault. */
  readonly path: string;
  /** What is wrong with it, one line each. */
  readonly problems: readonly string[];

  constructor(path: string, problems: readonly string[]) {
    super(`${path}: ${problems.join(" ")}`);
    this.name = "FloorTemplateError";
    this.path = path;
    this.problems = problems;
  }
}

/** A template, and the files it was read from. */
export interface LoadedFloorTemplate extends FloorTemplate {
  /** Every file in its folder, relative to it, with `/`, sorted. */
  readonly files: readonly string[];
}

/**
 * Reads the template `id` from the files of its folder (paths relative to
 * it, with `/`), checking every one. Throws a `FloorTemplateError` naming
 * the file at fault as `at` gives it ("" for the folder itself).
 */
export function floorTemplateFromFiles(
  id: string,
  folder: readonly FloorTemplateFile[],
  at: (file: string) => string = (file) => file,
): LoadedFloorTemplate {
  const fail = (file: string, problems: readonly string[]): never => {
    throw new FloorTemplateError(at(file), problems);
  };

  const parsedId = templateIdSchema.safeParse(id);
  if (!parsedId.success) {
    fail(
      "",
      parsedId.error.issues.map(
        ({ message }) => `The folder's name: ${message}`,
      ),
    );
  }
  const contents = new Map(folder.map(({ path, content }) => [path, content]));
  const files = [...contents.keys()].sort();
  const manifestText = contents.get(floorTemplateManifestFileName);
  if (manifestText === undefined) {
    return fail("", [
      `A Floor Template has a ${floorTemplateManifestFileName}.`,
    ]);
  }

  const roleFiles: string[] = [];
  const skillFolders = new Map<string, string[]>();
  for (const file of files) {
    const segments = file.split("/");
    if (file === floorTemplateManifestFileName) {
      continue;
    }
    if (
      segments[0] === floorTemplateRolesFolder &&
      segments.length === 2 &&
      file.endsWith(".md")
    ) {
      roleFiles.push(file);
      continue;
    }
    const skillFolder = segments[1];
    if (
      segments[0] === floorTemplateSkillsFolder &&
      segments.length >= 3 &&
      skillFolder !== undefined &&
      skillFolder !== ""
    ) {
      skillFolders.set(skillFolder, [
        ...(skillFolders.get(skillFolder) ?? []),
        segments.slice(2).join("/"),
      ]);
      continue;
    }
    fail(file, [
      `Not part of a Floor Template: a template holds ${floorTemplateManifestFileName}, ${floorTemplateRolesFolder}/<role>.md and ${floorTemplateSkillsFolder}/<skill>/${skillFileName}.`,
    ]);
  }

  const manifest = parseFloorTemplateManifest(manifestText);
  if (!manifest.ok) {
    return fail(floorTemplateManifestFileName, manifest.problems);
  }
  const { roles: listed, settings } = manifest.manifest;

  const skills: FloorTemplateSkill[] = [];
  for (const [name, paths] of [...skillFolders].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const skillFiles: SkillFile[] = [];
    for (const path of paths) {
      const file = skillFileSchema.safeParse({
        path,
        content: contents.get(`${floorTemplateSkillsFolder}/${name}/${path}`),
      });
      if (!file.success) {
        fail(
          `${floorTemplateSkillsFolder}/${name}/${path}`,
          file.error.issues.map(({ message }) => message),
        );
      } else {
        skillFiles.push(file.data);
      }
    }
    const problems = skillProblems(skillFiles, { folder: name });
    if (problems.length > 0) {
      fail(`${floorTemplateSkillsFolder}/${name}/${skillFileName}`, problems);
    }
    const { description } = describeSkill(skillFiles);
    skills.push({ name, description, files: skillFiles });
  }

  const roles = new Map<string, RoleDefinition>();
  for (const file of roleFiles) {
    const roleId = file.slice(
      floorTemplateRolesFolder.length + 1,
      -".md".length,
    );
    const parsed = parseRoleDocument(roleId, contents.get(file) ?? "");
    if (!parsed.ok) {
      return fail(file, parsed.problems);
    }
    const { role } = parsed;
    if (!listed.some((entry) => entry.role === role.id)) {
      fail(file, [
        `"${role.id}" is not one of the Roles ${floorTemplateManifestFileName} lists.`,
      ]);
    }
    const twin = [...roles.values()].find(
      ({ name }) => name.toLowerCase() === role.name.toLowerCase(),
    );
    if (twin !== undefined) {
      fail(file, [`"${twin.id}" is called "${twin.name}" too.`]);
    }
    const missing = role.skills.filter(
      (skill) => !skills.some(({ name }) => name === skill),
    );
    if (missing.length > 0) {
      fail(file, [
        `Its Skills are in the template's ${floorTemplateSkillsFolder} folder, which has no ${missing.map((skill) => `"${skill}"`).join(", ")}.`,
      ]);
    }
    roles.set(role.id, role);
  }
  const unfiled = listed.filter(({ role }) => !roles.has(role));
  if (unfiled.length > 0) {
    fail(floorTemplateManifestFileName, [
      `Each Role it lists has a file: there is no ${unfiled.map(({ role }) => `${floorTemplateRolesFolder}/${role}.md`).join(", ")}.`,
    ]);
  }
  const notReviewers = settings.requiredReviewers.filter(
    (role) => roles.get(role)?.stage !== "review",
  );
  if (notReviewers.length > 0) {
    fail(floorTemplateManifestFileName, [
      `settings.requiredReviewers: ${notReviewers.map((role) => `"${role}"`).join(", ")} ${notReviewers.length === 1 ? "is not a Role" : "are not Roles"} in the review Stage.`,
    ]);
  }

  return {
    id,
    name: manifest.manifest.name,
    description: manifest.manifest.description,
    icon: manifest.manifest.icon,
    theme: manifest.manifest.theme,
    // Each one has its file: checked above.
    roles: listed.flatMap(({ role, count }) => {
      const definition = roles.get(role);
      return definition === undefined ? [] : [{ role: definition, count }];
    }),
    settings,
    manager: manifest.manifest.manager,
    labels: manifest.manifest.labels,
    skills,
    files,
  };
}

/** A Role's file: its fields as YAML frontmatter, then its instructions. */
export function roleDocument(role: RoleDefinition): string {
  const frontmatter = stringifyYaml(
    {
      name: role.name,
      stage: role.stage,
      description: role.description,
      skills: [...role.skills],
      deskDressing: role.deskDressing,
      aiProvider: role.aiProvider,
      model: role.model,
    },
    { lineWidth: 0 },
  );
  return `---\n${frontmatter}---\n\n${role.instructions}\n`;
}

/** A template's `template.yaml`: everything it holds but its Roles and Skills. */
export function manifestDocument(template: FloorTemplate): string {
  const manifest: FloorTemplateManifest = {
    name: template.name,
    description: template.description,
    icon: template.icon,
    theme: template.theme,
    roles: template.roles.map(({ role, count }) => ({ role: role.id, count })),
    settings: {
      ...template.settings,
      requiredReviewers: [...template.settings.requiredReviewers],
    },
    manager: {
      planningGuidance: template.manager.planningGuidance,
      firstIssue:
        template.manager.firstIssue === null
          ? null
          : { ...template.manager.firstIssue },
    },
    labels: template.labels.map((label) => ({ ...label })),
  };
  return stringifyYaml(manifest, { lineWidth: 0 });
}

/**
 * A template as the files of its folder: `template.yaml`, then each
 * Role's file, then each Skill's folder, every path relative to the
 * folder. `floorTemplateFromFiles` reads them back as the same template.
 */
export function floorTemplateFiles(
  template: FloorTemplate,
): FloorTemplateFile[] {
  return [
    {
      path: floorTemplateManifestFileName,
      content: manifestDocument(template),
    },
    ...template.roles.map(({ role }) => ({
      path: `${floorTemplateRolesFolder}/${role.id}.md`,
      content: roleDocument(role),
    })),
    ...[...template.skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap(({ name, files }) =>
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map(({ path, content }) => ({
            path: `${floorTemplateSkillsFolder}/${name}/${path}`,
            content,
          })),
      ),
  ];
}

/** The SHA-256 of a template's files (by path), in hex: what a review names. */
export const floorTemplateDigest = (
  files: readonly FloorTemplateFile[],
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map(({ path, content }) => [path, content]),
      ),
    )
    .digest("hex");
