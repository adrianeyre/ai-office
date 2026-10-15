import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  builtInRole,
  floorTemplateManifestFileName,
  floorTemplateRolesFolder,
  floorTemplateSkillsFolder,
  type FloorTemplate,
  type Stage,
} from "@ai-office/shared";

// The lint for a Floor Template's words (PRD FR-100): what its Agents and
// its Manager are told, and what the Owner reads in the picker. The schema
// says a template is well formed; the lint says it is well written for
// AI Office:
//
// - it uses `GLOSSARY.md`'s terms, capitalised, and none of the words the
//   glossary lists under _Avoid_;
// - every Role, and the Manager, is told plainly that the Floor works on
//   its repository only, never on the live systems its kind of work has,
//   such as a live store, an ad platform or customer email (PRD §4);
// - each Role's instructions fit where its Stage's prompt puts them;
// - its suggested first issue sets up every check its check command runs;
// - none of its commands, or the commands its Skills and first issue show
//   in shell code blocks, applies, deploys or publishes anything;
// - every Skill it ships is one of its Roles' Skills, and a Skill two
//   templates ship is the same in both;
// - a Role with a built-in Role's id is that Role, as the library starts
//   with it. Its words are the library's own, from before templates, so
//   they are not linted.
//
// Code (fenced blocks and `inline code`) is not prose, so it is not linted.

/** `GLOSSARY.md`, at the top of the repository. */
export const glossaryFile = fileURLToPath(
  new URL("../../../../GLOSSARY.md", import.meta.url),
);

/** The glossary's terms, and the words it says to avoid for them. */
export interface Glossary {
  readonly terms: readonly string[];
  readonly avoid: readonly string[];
}

/** Reads `GLOSSARY.md`: each `**Term**:` and its `_Avoid_:` list. */
export function parseGlossary(text: string): Glossary {
  const terms = [...text.matchAll(/^\*\*(.+?)\*\*:\s*$/gm)].map(
    ([, term]) => term ?? "",
  );
  const avoid = [...text.matchAll(/^_Avoid_:\s*(.+)$/gm)].flatMap(([, words]) =>
    (words ?? "").split(",").map((word) => word.trim()),
  );
  return { terms, avoid: avoid.filter((word) => word !== "") };
}

/** Reads the repository's `GLOSSARY.md`. */
export const readGlossary = async (
  file: string = glossaryFile,
): Promise<Glossary> => parseGlossary(await readFile(file, "utf8"));

/**
 * Words the glossary avoids for one of its terms that a template's
 * instructions need in another sense: an Agent runs a check; a Floor has a
 * setup and a check command; QA ends with its report, as its Stage's
 * prompt names it; and a title's length is counted in characters.
 */
const everydayWords = new Set(["run", "command", "report", "character"]);

/**
 * Glossary terms whose lowercase form is an everyday word too (to notice
 * something, to plan, a batch of products, a product's model, an office),
 * so they are not held to their capitals.
 */
const everydaySenses = new Set([
  "Notice",
  "Plan",
  "Batch",
  "Model",
  "Office",
  "Connection",
  "Digest",
]);

/**
 * Words the glossary avoids that a template's domain has a name with, in
 * any case, with a space or a hyphen: a design system's design tokens are
 * its colours, spacing and font sizes, never a credential.
 */
const everydayPhrases = ["design token"];

/** The live systems a Floor is told it never acts on (PRD §4). */
interface LiveSystems {
  /** Each one, as its Roles' instructions name it. */
  readonly named: readonly RegExp[];
  /** All of them, as the lint's problems say them. */
  readonly says: string;
}

const storeSystems: LiveSystems = {
  named: [/\blive stores?\b/i, /\bad platforms?\b/i, /\bcustomer email\b/i],
  says: "a live store, an ad platform or customer email",
};

/** What each built-in template's Floor never acts on, by its id. */
export const liveSystemsOf: Readonly<Record<string, LiveSystems>> = {
  "online-store": storeSystems,
  "website-and-marketing": storeSystems,
  "content-and-blog": storeSystems,
  documentation: {
    named: [/\blive docs site\b/i, /\bproduction (?:API|service)s?\b/i],
    says: "the live docs site or a production API",
  },
  "design-system": {
    named: [/\bpackage registr(?:y|ies)\b/i, /\blive sites?\b/i],
    says: "a package registry or a live site",
  },
  "data-and-analytics": {
    named: [/\bproduction warehouse\b/i, /\blive dashboards?\b/i],
    says: "the production warehouse or a live dashboard",
  },
  infrastructure: {
    named: [/\blive infrastructure\b/i, /\bcloud accounts?\b/i],
    says: "live infrastructure or a cloud account",
  },
  "mobile-app": {
    named: [/\bapp stores?\b/i, /\bbeta-testing services?\b/i],
    says: "the app stores or a beta-testing service",
  },
};

/**
 * A command's words that apply, deploy or publish: what a Floor's
 * commands never do, since they only check the repository. `-auto-approve`
 * is how a plan is applied without asking.
 */
const actingWords =
  /(?:^|[\s"'])(?:apply|destroy|deploy|publish|release|upload|push|submit|-auto-approve)(?=$|[\s"'])/i;

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Prose only: without fenced code blocks and inline code. */
const prose = (text: string): string =>
  text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");

/** One piece of a template's words, and the file it is in. */
interface Text {
  readonly file: string;
  readonly text: string;
}

/** Whether `role` is the built-in Role of its id, exactly. */
const isBuiltIn = (role: FloorTemplate["roles"][number]["role"]): boolean =>
  JSON.stringify(builtInRole(role.id)) === JSON.stringify(role);

/** The template's Roles that are not built-in Roles, whose words it wrote. */
const ownRoles = (template: FloorTemplate) =>
  template.roles.filter(({ role }) => !isBuiltIn(role));

/** Every piece of a template's words, each with its file. */
function textsOf(template: FloorTemplate): Text[] {
  const manifest = `${template.id}/${floorTemplateManifestFileName}`;
  const { firstIssue } = template.manager;
  return [
    { file: manifest, text: template.description },
    { file: manifest, text: template.manager.planningGuidance },
    ...(firstIssue === null
      ? []
      : [
          { file: manifest, text: firstIssue.title },
          { file: manifest, text: firstIssue.body },
        ]),
    ...ownRoles(template).flatMap(({ role }) => {
      const file = `${template.id}/${floorTemplateRolesFolder}/${role.id}.md`;
      return [
        { file, text: role.name },
        { file, text: role.description },
        { file, text: role.instructions },
      ];
    }),
    ...template.skills.flatMap((skill) =>
      skill.files.map(({ path, content }) => ({
        file: `${template.id}/${floorTemplateSkillsFolder}/${skill.name}/${path}`,
        text: content,
      })),
    ),
  ];
}

/** Problems with the words: avoided words, and terms not capitalised. */
function wordingProblems(texts: readonly Text[], glossary: Glossary): string[] {
  // Longest first, so "AI Provider" is taken out before "AI" is looked for.
  const terms = [...glossary.terms, "AI Office"].sort(
    (a, b) => b.length - a.length,
  );
  const avoided = glossary.avoid.filter(
    (word) => !everydayWords.has(word.toLowerCase()),
  );
  const lowercase = glossary.terms.filter((term) => !everydaySenses.has(term));
  const problems: string[] = [];
  for (const { file, text } of texts) {
    const words = prose(text);
    // The glossary's own terms, as written, are never avoided words, nor
    // are the everyday phrases, in any case.
    const withoutTerms = [
      ...terms.map((term) => new RegExp(`\\b${escape(term)}s?\\b`, "g")),
      ...everydayPhrases.map(
        (phrase) =>
          new RegExp(`\\b${escape(phrase).replaceAll(" ", "[ -]")}s?\\b`, "gi"),
      ),
    ].reduce((rest, term) => rest.replace(term, " "), words);
    for (const word of avoided) {
      const found = new RegExp(`\\b${escape(word)}(?:s|es)?\\b`, "i").exec(
        withoutTerms,
      );
      if (found !== null) {
        problems.push(
          `${file}: "${found[0]}" is a word GLOSSARY.md says to avoid.`,
        );
      }
    }
    for (const term of lowercase) {
      const found = new RegExp(`\\b${escape(term.toLowerCase())}s?\\b`).exec(
        words,
      );
      if (found !== null) {
        problems.push(
          `${file}: "${found[0]}" is GLOSSARY.md's "${term}", so it is written with its capitals.`,
        );
      }
    }
  }
  return [...new Set(problems)];
}

/** Whether `text` says plainly that the Floor works on its repository only. */
const saysRepositoryOnly = (text: string, systems: LiveSystems): boolean =>
  /\brepository\b/i.test(text) &&
  systems.named.every((system) => system.test(text));

const repositoryOnly = (systems: LiveSystems): string =>
  `never says plainly that the Floor works on its repository only, never on ${systems.says}.`;

/** How each Stage's prompt lists a Role's instructions. */
function stageShapeProblems(
  file: string,
  stage: Stage,
  text: string,
): string[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (stage === "work") {
    return lines.every((line) => line.startsWith("- "))
      ? []
      : [
          `${file}: a work Role's instructions are "- " list items, which its prompt puts under "How to work".`,
        ];
  }
  if (stage === "qa" || stage === "docs") {
    // Their prompts' lists start with 1 (run the tests, or read the diff).
    const numbered = lines.every((line, index) =>
      line.startsWith(`${String(index + 2)}. `),
    );
    return numbered
      ? []
      : [
          `${file}: a ${stage === "qa" ? "QA" : "docs"} Role's instructions are a numbered list from 2, which its prompt continues.`,
        ];
  }
  return lines.some((line) => /^(?:- |\d+\. )/.test(line))
    ? [
        `${file}: a review Role's instructions are paragraphs, which its prompt puts before the pull request.`,
      ]
    : [];
}

/** The npm scripts a check command runs, in order. */
export const checkScripts = (command: string): string[] =>
  [...command.matchAll(/\bnpm run ([\w:.-]+)/g)].map(
    ([, script]) => script ?? "",
  );

/** A command's steps, one after another: what `&&`, `||` and `;` join. */
export const commandSteps = (command: string): string[] =>
  command
    .split(/&&|\|\||;/)
    .map((step) => step.trim())
    .filter((step) => step !== "");

/**
 * The checks a check command runs, in order, as its first issue names
 * them: an npm script by its name (`check:links`), and a tool's own
 * command as it is written (`dbt test --target ci`).
 */
export const checkSteps = (command: string): string[] =>
  commandSteps(command).map(
    (step) => /^npm run ([\w:.-]+)$/.exec(step)?.[1] ?? step,
  );

/** Each line of every shell code block in `text`: the commands it shows. */
const shellLines = (text: string): string[] =>
  [
    ...text.matchAll(
      /^(```|~~~)(?:sh|bash|shell|console)[ \t]*\n([\s\S]*?)^\1[^\n]*$/gm,
    ),
  ].flatMap(([, , code]) =>
    (code ?? "").split("\n").map((line) => line.replace(/^\$ /, "")),
  );

/** Problems with commands that would apply, deploy or publish something. */
function actingProblems(template: FloorTemplate): string[] {
  const manifest = `${template.id}/${floorTemplateManifestFileName}`;
  const { setupCommand, testCommand } = template.settings;
  const shown = [
    ...[template.manager.firstIssue?.body ?? ""].map((text) => ({
      file: manifest,
      text,
    })),
    ...template.skills.flatMap((skill) =>
      skill.files.map(({ path, content }) => ({
        file: `${template.id}/${floorTemplateSkillsFolder}/${skill.name}/${path}`,
        text: content,
      })),
    ),
  ];
  const commands = [
    ...commandSteps(setupCommand).map((step) => ({
      where: `${manifest}: settings.setupCommand's`,
      step,
    })),
    ...commandSteps(testCommand).map((step) => ({
      where: `${manifest}: settings.testCommand's`,
      step,
    })),
    ...shown.flatMap(({ file, text }) =>
      shellLines(text).flatMap((line) =>
        commandSteps(line).map((step) => ({ where: `${file}: the`, step })),
      ),
    ),
  ];
  return [
    ...new Set(
      commands
        .filter(({ step }) => actingWords.test(step))
        .map(
          ({ where, step }) =>
            `${where} "${step}" would apply, deploy or publish something: a Floor's commands only check its repository.`,
        ),
    ),
  ];
}

/** What is wrong with one template's words; empty when nothing is. */
export function lintFloorTemplate(
  template: FloorTemplate,
  glossary: Glossary,
): string[] {
  const manifest = `${template.id}/${floorTemplateManifestFileName}`;
  const problems = wordingProblems(textsOf(template), glossary);

  const systems = liveSystemsOf[template.id];
  if (systems === undefined) {
    problems.push(
      `${manifest}: the lint does not know what live systems this template's Floor never acts on: add them to liveSystemsOf in lint.ts.`,
    );
  } else if (!saysRepositoryOnly(template.manager.planningGuidance, systems)) {
    problems.push(
      `${manifest}: the Manager's planning guidance ${repositoryOnly(systems)}`,
    );
  }
  for (const { role } of template.roles) {
    const file = `${template.id}/${floorTemplateRolesFolder}/${role.id}.md`;
    const builtIn = builtInRole(role.id);
    if (builtIn !== undefined) {
      if (!isBuiltIn(role)) {
        problems.push(
          `${file}: "${role.id}" is a built-in Role's id, so the file is that Role as the Role library starts with it.`,
        );
      }
      continue;
    }
    if (
      systems !== undefined &&
      !saysRepositoryOnly(role.instructions, systems)
    ) {
      problems.push(`${file}: its instructions ${repositoryOnly(systems)}`);
    }
    problems.push(...stageShapeProblems(file, role.stage, role.instructions));
  }

  const checks = checkSteps(template.settings.testCommand);
  if (checks.length === 0) {
    problems.push(
      `${manifest}: settings.testCommand runs the Floor's checks, each as an npm script or a tool's own command.`,
    );
  }
  const body = template.manager.firstIssue?.body ?? "";
  const unset = checks.filter((check) => !body.includes(`\`${check}\``));
  if (unset.length > 0) {
    problems.push(
      `${manifest}: the first issue sets up every check the Floor runs, and says nothing of ${unset.map((check) => `\`${check}\``).join(", ")}.`,
    );
  }
  problems.push(...actingProblems(template));

  for (const skill of template.skills) {
    if (!template.roles.some(({ role }) => role.skills.includes(skill.name))) {
      problems.push(
        `${template.id}/${floorTemplateSkillsFolder}/${skill.name}: none of the template's Roles has this Skill.`,
      );
    }
  }
  return problems;
}

/** What is wrong across templates: a Skill two ship differently. */
export function lintFloorTemplates(
  templates: readonly FloorTemplate[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, { template: string; files: string }>();
  for (const template of templates) {
    for (const skill of template.skills) {
      const files = JSON.stringify(skill.files);
      const earlier = seen.get(skill.name);
      if (earlier !== undefined && earlier.files !== files) {
        problems.push(
          `${template.id}/${floorTemplateSkillsFolder}/${skill.name}: the ${earlier.template} template ships "${skill.name}" too, differently: a Skill is the same in every template that ships it.`,
        );
      }
      seen.set(skill.name, { template: template.id, files });
    }
  }
  return problems;
}
