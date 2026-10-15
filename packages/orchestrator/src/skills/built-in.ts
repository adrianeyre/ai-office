import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  grillingSkillName,
  isGrillingSkillName,
  mattPocockSkillNames,
  parseSkillDocument,
  skillFileName,
  skillFilesInOrder,
  skillProblems,
  type GrillingSkillName,
  type SkillFile,
} from "@ai-office/shared";

import { grillingSkill, grillingSkillInstructions } from "../grilling/skill.ts";

// AI Office's built-in Skills (PRD FR-77, FR-83b), on every Floor: its own
// `/grilling`, and those adapted from Matt Pocock's skills (MIT), each a
// real Agent Skills folder under `built-in/` with its `SKILL.md` and
// supporting files, read when AI Office starts and checked as every Skill
// is. Any problem stops the load with the folder at fault.
//
// Two kinds:
// - **Session-starting** (`grillingSkillNames`): `/grill-with-docs`,
//   `/wayfinder`, `/to-tickets` and `/to-spec` start a Grilling Session,
//   as `/grilling` does, and their instructions are loaded beside
//   `/grilling`'s while it runs. No office or repository Skill of their
//   name overrides them, and the Manager is never offered them to choose.
// - **Instructions**: `/pr`, `/domain-modeling` and the rest load their
//   instructions into the Manager chat as any `/name` does, with their
//   supporting files, which the Manager cannot otherwise read. An office or
//   repository Skill of their name takes their place, so a Floor's own
//   version wins.
//
// None is mounted into a sandbox: the Floor admin's per-Role switches are
// for the office library's and the repository's Skills, and an Owner who
// wants one of these in sandboxes adds it to the office library.

/** A built-in Skill as a Floor's Skills list it. */
export interface BuiltInSkill {
  readonly name: string;
  readonly description: string;
  readonly files: readonly SkillFile[];
}

/** The folder of the built-in Skills adapted from Matt Pocock's. */
export const builtInSkillsDir = fileURLToPath(
  new URL("built-in", import.meta.url),
);

/** Every file under `dir`, relative to it, with `/`, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}

/** Loads and checks the built-in Skill in `dir/name`. */
export function loadBuiltInSkill(dir: string, name: string): BuiltInSkill {
  const folder = join(dir, name);
  const files = filesUnder(folder).map((path) => ({
    path,
    content: readFileSync(join(folder, path), "utf8"),
  }));
  const problems = skillProblems(files, { folder: name });
  if (problems.length > 0) {
    throw new Error(
      `The built-in Skill in ${folder} is not a valid Skill: ${problems.join(" ")}`,
    );
  }
  const parsed = parseSkillDocument(
    files.find(({ path }) => path === skillFileName)?.content ?? "",
  );
  if (!parsed.ok) {
    throw new Error(
      `The built-in Skill in ${folder} is not a valid Skill: ${parsed.problems.join(" ")}`,
    );
  }
  return {
    name,
    description: parsed.document.description,
    files: skillFilesInOrder(files),
  };
}

/** AI Office's own Skills, on every Floor, by name. */
export const builtInSkills: readonly BuiltInSkill[] = [
  grillingSkill,
  ...mattPocockSkillNames.map((name) =>
    loadBuiltInSkill(builtInSkillsDir, name),
  ),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * Whether the built-in Skill `name` keeps its place whatever the Floor's
 * other Skills: those that start a Grilling Session do.
 */
export const builtInOverridesAll = (name: string): boolean =>
  isGrillingSkillName(name);

/** A built-in Skill's `SKILL.md` instructions, below its frontmatter. */
const instructionsOf = (skill: BuiltInSkill): string => {
  const text =
    skill.files.find(({ path }) => path === skillFileName)?.content ?? "";
  const parsed = parseSkillDocument(text);
  return parsed.ok ? parsed.document.instructions : text;
};

/**
 * A Skill's instructions with its supporting files after them, each
 * under its path: what the Manager is given of a built-in Skill, as it
 * cannot read their folders.
 */
export function withSupportingFiles(
  instructions: string,
  files: readonly SkillFile[],
): string {
  const supporting = skillFilesInOrder(files).filter(
    ({ path }) => path !== skillFileName,
  );
  return [
    instructions.trimEnd(),
    ...supporting.map(
      ({ path, content }) =>
        `---\n\nThe supporting file ${path}, which these instructions refer to:\n\n${content.trimEnd()}`,
    ),
  ].join("\n\n");
}

/**
 * The instructions loaded while a Grilling Session started by `skill`
 * runs, beside `/grilling`'s; none for `/grilling` itself.
 */
export function grillingSkillInstructionsOf(
  skill: GrillingSkillName,
): string | undefined {
  if (skill === grillingSkillName) {
    return undefined;
  }
  const found = builtInSkills.find(({ name }) => name === skill);
  return found === undefined ? undefined : instructionsOf(found);
}

/** The instructions `/name` runs for the session-starting Skill `skill`. */
export const sessionSkillInstructions = (skill: GrillingSkillName): string =>
  grillingSkillInstructionsOf(skill) ?? grillingSkillInstructions;
