import type { FloorTemplate } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  checkScripts,
  checkSteps,
  lintFloorTemplate,
  lintFloorTemplates,
  parseGlossary,
  readGlossary,
} from "./lint.ts";
import { loadFloorTemplates } from "./load.ts";

// The lint for the built-in Floor Templates' words (PRD FR-100): they use
// GLOSSARY.md's terms and none of the words it avoids, say plainly that
// the Floor works on its repository only, fit each Stage's prompt, set up
// every check they run, never apply, deploy or publish, keep the built-in
// Roles as they are, and ship each Skill once. Each rule is shown to
// catch what it is for.

/**
 * The templates the lint holds to all of its rules. Development's Roles
 * are the built-in ones from before templates, character for character
 * (its QA tries a change "as a user would"), and Blank has no Roles or
 * checks, so neither is linted.
 */
const linted = [
  "online-store",
  "website-and-marketing",
  "content-and-blog",
  "documentation",
  "design-system",
  "data-and-analytics",
  "infrastructure",
  "mobile-app",
];

const builtIn = async (id: string): Promise<FloorTemplate> => {
  const template = (await loadFloorTemplates()).find((each) => each.id === id);
  if (template === undefined) {
    throw new Error(`There is no built-in "${id}" template.`);
  }
  return template;
};

/** `template` with its Role `id` changed by `change`. */
const withRole = (
  template: FloorTemplate,
  id: string,
  change: (role: FloorTemplate["roles"][number]["role"]) => object,
): FloorTemplate => ({
  ...template,
  roles: template.roles.map((entry) =>
    entry.role.id === id
      ? { ...entry, role: { ...entry.role, ...change(entry.role) } }
      : entry,
  ),
});

describe("the glossary", () => {
  it("is read from GLOSSARY.md: its terms, and the words it avoids", async () => {
    const glossary = await readGlossary();
    expect(glossary.terms).toEqual(
      expect.arrayContaining([
        "Owner",
        "Floor",
        "Floor Template",
        "Role",
        "Stage",
        "Notice",
        "Handoff",
        "Token Cap",
      ]),
    );
    expect(glossary.avoid).toEqual(
      expect.arrayContaining(["User", "admin", "project", "Floor type", "run"]),
    );
  });
});

describe("the built-in Floor Templates' words", () => {
  for (const id of linted) {
    it(`${id} passes the lint`, async () => {
      expect(
        lintFloorTemplate(await builtIn(id), await readGlossary()),
      ).toEqual([]);
    });
  }

  it("every Skill two templates ship is the same in both", async () => {
    expect(lintFloorTemplates(await loadFloorTemplates())).toEqual([]);
  });

  it("each check command's scripts are found", async () => {
    expect(
      checkScripts((await builtIn("online-store")).settings.testCommand),
    ).toEqual([
      "check:theme",
      "check:links",
      "check:prices",
      "check:images",
      "check:accessibility",
    ]);
  });

  it("each check command's steps are found: npm scripts by name, a tool's own command as written", async () => {
    expect(
      checkSteps((await builtIn("documentation")).settings.testCommand),
    ).toEqual(["docs:build", "check:links", "check:examples"]);
    expect(
      checkSteps((await builtIn("data-and-analytics")).settings.testCommand),
    ).toEqual([
      "dbt deps",
      "dbt seed --target ci",
      "dbt run --target ci",
      "dbt test --target ci",
      "sqlfluff lint models",
    ]);
  });
});

describe("the lint catches", () => {
  const glossary = parseGlossary(
    [
      "**Owner**:",
      "The one person.",
      "_Avoid_: User, admin",
      "",
      "**Floor Template**:",
      "A starting set-up.",
      "_Avoid_: Floor type, preset",
      "",
      "**Batch**:",
      "Issues handed over at once.",
      "_Avoid_: Sprint, run",
      "",
      "**Handoff**:",
      "Passing work on.",
      "_Avoid_: Transfer",
    ].join("\n"),
  );

  it("a word the glossary avoids, in any case or plural, but not in code", async () => {
    const shop = await builtIn("online-store");
    const problems = lintFloorTemplate(
      withRole(shop, "merchandiser", ({ instructions }) => ({
        instructions: `${instructions}\n- Ask the Users before a change, and never use \`preset\` names.`,
      })),
      glossary,
    );
    expect(problems).toEqual([
      'online-store/roles/merchandiser.md: "Users" is a word GLOSSARY.md says to avoid.',
    ]);
  });

  it("a glossary term without its capitals", async () => {
    const shop = await builtIn("online-store");
    expect(
      lintFloorTemplate(
        {
          ...shop,
          description:
            "A store team for the owner, with each change's handoff.",
        },
        glossary,
      ),
    ).toEqual([
      'online-store/template.yaml: "owner" is GLOSSARY.md\'s "Owner", so it is written with its capitals.',
      'online-store/template.yaml: "handoff" is GLOSSARY.md\'s "Handoff", so it is written with its capitals.',
    ]);
  });

  it("a Role, or the Manager, not told that the Floor works on its repository only", async () => {
    const blog = await builtIn("content-and-blog");
    const problems = lintFloorTemplate(
      withRole(
        {
          ...blog,
          manager: {
            ...blog.manager,
            planningGuidance: "Plan posts in a series one after another.",
          },
        },
        "editor",
        ({ instructions }) => ({
          instructions: instructions.replaceAll(
            "ad platform",
            "partner's site",
          ),
        }),
      ),
      glossary,
    );
    expect(problems).toEqual([
      "content-and-blog/template.yaml: the Manager's planning guidance never says plainly that the Floor works on its repository only, never on a live store, an ad platform or customer email.",
      "content-and-blog/roles/editor.md: its instructions never says plainly that the Floor works on its repository only, never on a live store, an ad platform or customer email.",
    ]);
  });

  it("instructions that do not fit their Stage's prompt", async () => {
    const shop = await builtIn("online-store");
    const problems = lintFloorTemplate(
      withRole(
        withRole(
          withRole(shop, "copywriter", ({ instructions }) => ({
            instructions: `Write well.\n${instructions}`,
          })),
          "store-qa",
          ({ instructions }) => ({
            instructions: instructions.replace(/^2\. /, "1. "),
          }),
        ),
        "brand-reviewer",
        ({ instructions }) => ({
          instructions: `${instructions}\n- Check the colours.`,
        }),
      ),
      glossary,
    );
    expect(problems).toEqual([
      'online-store/roles/copywriter.md: a work Role\'s instructions are "- " list items, which its prompt puts under "How to work".',
      "online-store/roles/brand-reviewer.md: a review Role's instructions are paragraphs, which its prompt puts before the pull request.",
      "online-store/roles/store-qa.md: a QA Role's instructions are a numbered list from 2, which its prompt continues.",
    ]);
  });

  it("a check the first issue does not set up, or no checks at all", async () => {
    const site = await builtIn("website-and-marketing");
    expect(
      lintFloorTemplate(
        {
          ...site,
          settings: {
            ...site.settings,
            testCommand: `${site.settings.testCommand} && npm run check:spelling`,
          },
        },
        glossary,
      ),
    ).toEqual([
      "website-and-marketing/template.yaml: the first issue sets up every check the Floor runs, and says nothing of `check:spelling`.",
    ]);
    expect(
      lintFloorTemplate(
        { ...site, settings: { ...site.settings, testCommand: "" } },
        glossary,
      ),
    ).toEqual([
      "website-and-marketing/template.yaml: settings.testCommand runs the Floor's checks, each as an npm script or a tool's own command.",
    ]);
    // A tool's own command is named by the first issue as it is written.
    const data = await builtIn("data-and-analytics");
    expect(
      lintFloorTemplate(
        {
          ...data,
          settings: {
            ...data.settings,
            testCommand: `${data.settings.testCommand} && dbt source freshness --target ci`,
          },
        },
        glossary,
      ),
    ).toEqual([
      "data-and-analytics/template.yaml: the first issue sets up every check the Floor runs, and says nothing of `dbt source freshness --target ci`.",
    ]);
  });

  it("each template's own live systems, and a template whose live systems it does not know", async () => {
    const infrastructure = await builtIn("infrastructure");
    const mobile = await builtIn("mobile-app");
    expect(
      lintFloorTemplate(
        withRole(infrastructure, "plan-qa", ({ instructions }) => ({
          instructions: instructions.replace(
            "live infrastructure or a cloud account",
            "anything outside it",
          ),
        })),
        glossary,
      ),
    ).toEqual([
      "infrastructure/roles/plan-qa.md: its instructions never says plainly that the Floor works on its repository only, never on live infrastructure or a cloud account.",
    ]);
    expect(
      lintFloorTemplate(
        {
          ...mobile,
          manager: {
            ...mobile.manager,
            planningGuidance: mobile.manager.planningGuidance.replaceAll(
              "the app stores",
              "a shop",
            ),
          },
        },
        glossary,
      ),
    ).toEqual([
      "mobile-app/template.yaml: the Manager's planning guidance never says plainly that the Floor works on its repository only, never on the app stores or a beta-testing service.",
    ]);
    // A store's words are not an infrastructure Floor's.
    const shop = await builtIn("online-store");
    expect(
      lintFloorTemplate({ ...shop, id: "infrastructure" }, glossary),
    ).toEqual(
      expect.arrayContaining([
        "infrastructure/template.yaml: the Manager's planning guidance never says plainly that the Floor works on its repository only, never on live infrastructure or a cloud account.",
        "infrastructure/roles/merchandiser.md: its instructions never says plainly that the Floor works on its repository only, never on live infrastructure or a cloud account.",
      ]),
    );
    expect(
      lintFloorTemplate({ ...shop, id: "garden-centre" }, glossary),
    ).toEqual([
      "garden-centre/template.yaml: the lint does not know what live systems this template's Floor never acts on: add them to liveSystemsOf in lint.ts.",
    ]);
  });

  it("a command, or a command a Skill shows, that would apply, deploy or publish", async () => {
    const infrastructure = await builtIn("infrastructure");
    const design = await builtIn("design-system");
    expect(
      lintFloorTemplate(
        {
          ...infrastructure,
          settings: {
            ...infrastructure.settings,
            setupCommand: "terraform init -input=false",
            testCommand: `${infrastructure.settings.testCommand} && terraform apply -auto-approve`,
          },
        },
        glossary,
      ),
    ).toEqual([
      "infrastructure/template.yaml: the first issue sets up every check the Floor runs, and says nothing of `terraform apply -auto-approve`.",
      "infrastructure/template.yaml: settings.testCommand's \"terraform apply -auto-approve\" would apply, deploy or publish something: a Floor's commands only check its repository.",
    ]);
    // A Skill's shell block is a command; its JSON is not.
    expect(
      lintFloorTemplate(
        {
          ...design,
          skills: design.skills.map((skill) =>
            skill.name === "component-checks"
              ? {
                  ...skill,
                  files: skill.files.map((file) => ({
                    ...file,
                    content: `${file.content}\n\`\`\`sh\n$ npm run build; npm publish --access public\n\`\`\`\n\n\`\`\`json\n{ "upload": true }\n\`\`\`\n`,
                  })),
                }
              : skill,
          ),
        },
        glossary,
      ),
    ).toEqual([
      'design-system/skills/component-checks/SKILL.md: the "npm publish --access public" would apply, deploy or publish something: a Floor\'s commands only check its repository.',
    ]);
  });

  it("a built-in Role's id with other words; the built-in Roles' own words are not linted", async () => {
    const mobile = await builtIn("mobile-app");
    const design = await builtIn("design-system");
    // The built-in designer says "type" (fonts), and is told nothing of a
    // package registry, yet Design system passes: its words are the
    // library's own.
    expect(
      design.roles.find(({ role }) => role.id === "designer")?.role
        .instructions,
    ).toContain("type");
    expect(lintFloorTemplate(design, await readGlossary())).toEqual([]);
    expect(
      lintFloorTemplate(
        withRole(mobile, "reviewer", ({ instructions }) => ({
          instructions: `${instructions} Check it on both platforms.`,
        })),
        glossary,
      ),
    ).toEqual([
      'mobile-app/roles/reviewer.md: "reviewer" is a built-in Role\'s id, so the file is that Role as the Role library starts with it.',
    ]);
  });

  it("a Skill none of the template's Roles has, and a Skill two templates ship differently", async () => {
    const blog = await builtIn("content-and-blog");
    const site = await builtIn("website-and-marketing");
    expect(
      lintFloorTemplate(
        withRole(blog, "fact-checker", () => ({ skills: ["content-checks"] })),
        glossary,
      ),
    ).toEqual([
      "content-and-blog/skills/fact-checking: none of the template's Roles has this Skill.",
    ]);
    const changed = {
      ...blog,
      skills: blog.skills.map((skill) =>
        skill.name === "seo-basics"
          ? {
              ...skill,
              files: skill.files.map((file) => ({
                ...file,
                content: `${file.content}\nOne more line.\n`,
              })),
            }
          : skill,
      ),
    };
    expect(lintFloorTemplates([site, changed])).toEqual([
      'content-and-blog/skills/seo-basics: the website-and-marketing template ships "seo-basics" too, differently: a Skill is the same in every template that ships it.',
    ]);
  });
});
