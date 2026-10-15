import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  developmentTemplateId,
  floorTemplateRolesFolder,
  type RoleDefinition,
} from "@ai-office/shared";

import {
  FloorTemplateError,
  floorTemplateFromFiles,
  type LoadedFloorTemplate,
} from "./files.ts";

export { FloorTemplateError, type LoadedFloorTemplate } from "./files.ts";

// The built-in Floor Templates (PRD FR-99, FR-100), loaded from their
// files under `templates/` when AI Office starts. Every file there belongs
// to a template and is checked as every template is (`files.ts`). A Role
// two templates both bring is the same Role, so its files must agree. Any
// problem stops the load with the path of the file at fault.

/** The built-in templates' folder, `templates/` in the repository. */
export const builtInTemplatesDir = fileURLToPath(
  new URL("../../../../templates", import.meta.url),
);

/** Every file under `dir`, relative to it, with `/`, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}

const sameRole = (a: RoleDefinition, b: RoleDefinition): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Loads and checks one template: the folder `dir`, whose name is its id. */
export async function loadFloorTemplate(
  dir: string,
  id: string,
): Promise<LoadedFloorTemplate> {
  const files = await Promise.all(
    (await filesUnder(dir)).map(async (path) => ({
      path,
      content: await readFile(join(dir, path), "utf8"),
    })),
  );
  return floorTemplateFromFiles(id, files, (file) =>
    file === "" ? dir : join(dir, file),
  );
}

/**
 * Loads every template in `root` (the built-in ones by default), each in
 * its own folder: Development first, then by name. Throws a
 * `FloorTemplateError` naming the file at fault.
 */
export async function loadFloorTemplates(
  root: string = builtInTemplatesDir,
): Promise<LoadedFloorTemplate[]> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const templates: LoadedFloorTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new FloorTemplateError(join(root, entry.name), [
        "Not part of a Floor Template: each template is a folder of its own.",
      ]);
    }
    templates.push(await loadFloorTemplate(join(root, entry.name), entry.name));
  }

  // A Role two templates both bring is one Role in the library.
  const seen = new Map<string, { template: string; role: RoleDefinition }>();
  for (const template of templates) {
    for (const { role } of template.roles) {
      const file = join(
        root,
        template.id,
        floorTemplateRolesFolder,
        `${role.id}.md`,
      );
      const earlier = seen.get(role.id);
      if (earlier !== undefined && !sameRole(earlier.role, role)) {
        throw new FloorTemplateError(file, [
          `The ${earlier.template} template brings "${role.id}" too, differently: a Role is the same in every template that brings it.`,
        ]);
      }
      const namesake = [...seen.values()].find(
        (other) =>
          other.role.id !== role.id &&
          other.role.name.toLowerCase() === role.name.toLowerCase(),
      );
      if (namesake !== undefined) {
        throw new FloorTemplateError(file, [
          `The ${namesake.template} template's "${namesake.role.id}" is called "${namesake.role.name}" too.`,
        ]);
      }
      seen.set(role.id, { template: template.id, role });
    }
  }

  return templates.sort(
    (a, b) =>
      Number(b.id === developmentTemplateId) -
        Number(a.id === developmentTemplateId) || a.name.localeCompare(b.name),
  );
}
