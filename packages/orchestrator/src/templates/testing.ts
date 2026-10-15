import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { builtInTemplatesDir } from "./load.ts";

// Floor Templates for tests: a folder of templates to load, and a template
// that uses every part of the format.

/** A folder for templates, removed with `remove`. */
export interface TemplateFolder {
  readonly root: string;
  /** Writes each of `files` (paths relative to `root`). */
  write(files: Readonly<Record<string, string>>): Promise<void>;
  remove(): Promise<void>;
}

/**
 * A new folder of templates: a copy of the built-in ones unless `empty`,
 * or of only the built-in templates `only` names.
 */
export async function templateFolder(
  options: { readonly empty?: boolean; readonly only?: readonly string[] } = {},
): Promise<TemplateFolder> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-templates-"));
  if (options.only !== undefined) {
    for (const id of options.only) {
      await cp(join(builtInTemplatesDir, id), join(root, id), {
        recursive: true,
      });
    }
  } else if (options.empty !== true) {
    await cp(builtInTemplatesDir, root, { recursive: true });
  }
  return {
    root,
    async write(files) {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

/** The built-in templates Corner shop can be loaded beside. */
export const cornerShopNeighbours: readonly string[] = ["development", "blank"];

/**
 * The files of "Corner shop" (`corner-shop/…`): a merchandiser (two
 * Agents, with a Skill of the template's), a brand reviewer (its required
 * reviewer) and a copywriter it brings into the library without an Agent;
 * its own settings, a label, planning guidance and a first issue. Its
 * Roles share their ids with the Online store template's but differ, so it
 * loads beside `cornerShopNeighbours` only.
 */
export const cornerShopFiles: Readonly<Record<string, string>> = {
  "corner-shop/template.yaml": `name: Corner shop
description: A small online shop's catalogue, copy and theme.
icon: shopping-bag
theme: stockroom
roles:
  - role: merchandiser
    count: 2
  - role: brand-reviewer
    count: 1
  - role: copywriter
    count: 0
settings:
  setupCommand: pnpm install
  testCommand: pnpm theme-check
  mergePolicy: auto_merge
  roundCap: 2
  requiredReviewers: [brand-reviewer]
manager:
  planningGuidance: Plan catalogue changes before the copy that describes them.
  firstIssue:
    title: Check every product has a price
    body: List the products without a price, and add one to each.
labels:
  - name: product
    color: c2e0c6
    description: A product's data
`,
  "corner-shop/roles/merchandiser.md": `---
name: merchandiser
stage: work
description: Arranges the catalogue's collections, prices and product data.
skills: [price-check]
deskDressing: printouts
aiProvider: Claude
model: claude-sonnet-5-5
---

- Keep every price in pence.
`,
  "corner-shop/roles/brand-reviewer.md": `---
name: brand reviewer
stage: review
description: Reviews a change against the shop's brand.
skills: []
deskDressing: books
aiProvider: null
model: null
---

Review the change against the brand: its voice, its colours and its promises.
`,
  "corner-shop/roles/copywriter.md": `---
name: copywriter
stage: work
description: Writes the product copy.
skills: []
deskDressing: books
aiProvider: Claude
model: null
---

- Write in British English.
`,
  "corner-shop/skills/price-check/SKILL.md": `---
name: price-check
description: Checks that every product has a price in pence.
---

# Price check

Read each product's data and list those without a price.
`,
};
