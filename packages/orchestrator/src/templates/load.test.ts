import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  builtInRole,
  defaultFloorSettings,
  defaultTeamRoles,
  managerInstructionsOf,
  managerRole,
} from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  builtInTemplatesDir,
  FloorTemplateError,
  loadFloorTemplates,
} from "./load.ts";
import {
  cornerShopFiles,
  cornerShopNeighbours,
  templateFolder,
  type TemplateFolder,
} from "./testing.ts";

// The built-in Floor Templates (PRD FR-99, FR-100), loaded from their files
// under `templates/`: every file there passes the schema, Development is
// the team and settings every Floor had before templates, and Blank is a
// Manager only. A broken file fails the load with its path.

/** Every file under `dir`, relative to it, with `/`. */
async function everyFile(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    )
    .sort();
}

describe("the built-in Floor Templates", () => {
  it("every file under templates/ passes the schema, as part of its template", async () => {
    const templates = await loadFloorTemplates();
    // Development first, then by name.
    expect(templates.map(({ id }) => id)).toEqual([
      "development",
      "blank",
      "content-and-blog",
      "data-and-analytics",
      "design-system",
      "documentation",
      "infrastructure",
      "mobile-app",
      "online-store",
      "website-and-marketing",
    ]);
    const loaded = templates
      .flatMap(({ id, files }) => files.map((file) => `${id}/${file}`))
      .sort();
    const files = await everyFile(builtInTemplatesDir);
    expect(files.length).toBeGreaterThan(0);
    expect(loaded).toEqual(files);
  });

  it("Development is the team and settings every Floor had before templates", async () => {
    const [development] = await loadFloorTemplates();
    expect(development).toMatchObject({
      id: "development",
      name: "Development",
      icon: "code",
      theme: "office",
      labels: [],
      skills: [],
    });
    // The Manager, then a coder, a reviewer and a QA Agent (FR-10), each
    // in the built-in Role exactly as the library has always had it.
    expect([
      managerRole,
      ...(development?.roles ?? []).flatMap(({ role, count }) =>
        Array<string>(count).fill(role.id),
      ),
    ]).toEqual(defaultTeamRoles);
    for (const { role } of development?.roles ?? []) {
      expect(role).toEqual(builtInRole(role.id));
    }
    expect(development?.settings).toEqual({
      setupCommand: defaultFloorSettings.setupCommand,
      testCommand: defaultFloorSettings.testCommand,
      mergePolicy: defaultFloorSettings.mergePolicy,
      roundCap: defaultFloorSettings.roundCap,
      requiredReviewers: ["reviewer"],
    });
    // Its Manager has no instructions of its own, as before.
    expect(
      managerInstructionsOf(
        development?.manager ?? { planningGuidance: "x", firstIssue: null },
      ),
    ).toBe("");
  });

  it("Blank is a Manager only, with the default settings", async () => {
    const blank = (await loadFloorTemplates()).find(({ id }) => id === "blank");
    expect(blank).toMatchObject({
      name: "Blank",
      roles: [],
      labels: [],
      skills: [],
      settings: {
        setupCommand: "",
        testCommand: "",
        mergePolicy: "send_to_me",
        roundCap: 3,
        requiredReviewers: [],
      },
    });
    expect(blank?.manager.planningGuidance).toMatch(/no Agents but you/);
  });

  // FR-100's other templates: each with its starting Roles on their
  // Stages, its setup and check commands, its required reviewers, its
  // Skills and the Manager's guidance and first issue. `checks` are the
  // check command's steps, one after another: an npm script by its name,
  // or a tool's own command.
  const npmInstall = "if [ -f package.json ]; then npm install; fi";
  const builtIn = [
    {
      id: "online-store",
      name: "Online store",
      icon: "shopping-bag",
      theme: "stockroom",
      team: [
        ["merchandiser", "merchandiser", "work", "Claude", ["product-data"]],
        ["copywriter", "copywriter", "work", "Claude", []],
        [
          "storefront-developer",
          "storefront developer",
          "work",
          "Claude",
          ["store-checks"],
        ],
        ["brand-reviewer", "brand reviewer", "review", "ChatGPT", []],
        [
          "store-qa",
          "store QA",
          "qa",
          "Claude",
          ["product-data", "store-checks"],
        ],
      ],
      checks: [
        "check:theme",
        "check:links",
        "check:prices",
        "check:images",
        "check:accessibility",
      ],
      requiredReviewers: ["brand-reviewer"],
      skills: ["product-data", "store-checks"],
      firstIssue: "Set up the store's checks",
      setupCommand: npmInstall,
    },
    {
      id: "website-and-marketing",
      name: "Website & marketing",
      icon: "megaphone",
      theme: "studio",
      team: [
        ["web-developer", "web developer", "work", "Claude", ["site-checks"]],
        ["copywriter", "copywriter", "work", "Claude", []],
        ["seo-specialist", "SEO specialist", "work", "Claude", ["seo-basics"]],
        ["conversion-reviewer", "conversion reviewer", "review", "ChatGPT", []],
      ],
      checks: ["build", "check:links", "check:lighthouse"],
      requiredReviewers: ["conversion-reviewer"],
      skills: ["seo-basics", "site-checks"],
      firstIssue: "Set up the site's checks",
      setupCommand: npmInstall,
    },
    {
      id: "content-and-blog",
      name: "Content & blog",
      icon: "pen-line",
      theme: "editorial",
      team: [
        ["writer", "writer", "work", "Claude", ["content-checks"]],
        ["seo-specialist", "SEO specialist", "work", "Claude", ["seo-basics"]],
        ["editor", "editor", "review", "ChatGPT", []],
        [
          "fact-checker",
          "fact-checker",
          "qa",
          "Claude",
          ["fact-checking", "content-checks"],
        ],
      ],
      checks: ["check:markdown", "check:links", "check:spelling"],
      requiredReviewers: ["editor"],
      skills: ["content-checks", "fact-checking", "seo-basics"],
      firstIssue: "Set up the blog's checks",
      setupCommand: npmInstall,
    },
    {
      id: "documentation",
      name: "Documentation",
      icon: "book-open",
      theme: "library",
      team: [
        [
          "technical-writer",
          "technical writer",
          "work",
          "Claude",
          ["docs-checks", "runnable-examples"],
        ],
        ["docs-reviewer", "docs reviewer", "review", "ChatGPT", []],
        [
          "example-checker",
          "example checker",
          "qa",
          "Claude",
          ["docs-checks", "runnable-examples"],
        ],
      ],
      checks: ["docs:build", "check:links", "check:examples"],
      requiredReviewers: ["docs-reviewer"],
      skills: ["docs-checks", "runnable-examples"],
      firstIssue: "Set up the docs' checks",
      setupCommand: npmInstall,
    },
    {
      id: "design-system",
      name: "Design system",
      icon: "palette",
      theme: "atelier",
      team: [
        ["designer", "designer", "work", "Claude", []],
        [
          "front-end-developer",
          "front-end developer",
          "work",
          "Claude",
          ["component-checks", "design-tokens"],
        ],
        [
          "accessibility-reviewer",
          "accessibility reviewer",
          "review",
          "ChatGPT",
          [],
        ],
        ["visual-qa", "visual QA", "qa", "Claude", ["component-checks"]],
      ],
      checks: ["test:components", "test:visual", "check:contrast"],
      requiredReviewers: ["accessibility-reviewer"],
      skills: ["component-checks", "design-tokens"],
      firstIssue: "Set up the design system's checks",
      setupCommand: npmInstall,
    },
    {
      id: "data-and-analytics",
      name: "Data & analytics",
      icon: "chart-column",
      theme: "observatory",
      team: [
        [
          "analytics-engineer",
          "analytics engineer",
          "work",
          "Claude",
          ["dbt-checks"],
        ],
        ["data-reviewer", "data reviewer", "review", "ChatGPT", []],
        ["data-quality-qa", "data-quality QA", "qa", "Claude", ["dbt-checks"]],
      ],
      // `dbt test` and the SQL lint, on the sample data's `ci` target.
      checks: [
        "dbt deps",
        "dbt seed --target ci",
        "dbt run --target ci",
        "dbt test --target ci",
        "sqlfluff lint models",
      ],
      requiredReviewers: ["data-reviewer"],
      skills: ["dbt-checks"],
      firstIssue: "Set up the data checks on sample data",
      setupCommand:
        "if [ -f requirements.txt ]; then pip install -r requirements.txt; fi",
    },
    {
      id: "infrastructure",
      name: "Infrastructure",
      icon: "server",
      theme: "data-centre",
      team: [
        [
          "platform-engineer",
          "platform engineer",
          "work",
          "Claude",
          ["terraform-checks"],
        ],
        ["security-reviewer", "security reviewer", "review", "ChatGPT", []],
        ["plan-qa", "plan QA", "qa", "Claude", ["terraform-checks"]],
      ],
      // A plan from no state, and the policy checks; never an apply
      // (infrastructure.test.ts).
      checks: [
        "terraform fmt -check -recursive",
        "terraform init -input=false -backend=false",
        "terraform validate",
        "terraform plan -input=false -lock=false -refresh=false",
        "checkov --directory . --quiet",
      ],
      requiredReviewers: ["security-reviewer"],
      skills: ["terraform-checks"],
      firstIssue: "Set up the infrastructure's checks",
      setupCommand: "",
    },
    {
      id: "mobile-app",
      name: "Mobile app",
      icon: "smartphone",
      theme: "device-lab",
      team: [
        [
          "mobile-developer",
          "mobile developer",
          "work",
          "Claude",
          ["mobile-checks"],
        ],
        ["reviewer", "reviewer", "review", "Claude", []],
        ["device-test-qa", "device-test QA", "qa", "Claude", ["mobile-checks"]],
      ],
      checks: ["test:unit", "test:simulator"],
      requiredReviewers: ["reviewer"],
      skills: ["mobile-checks"],
      firstIssue: "Set up the app's checks",
      setupCommand: npmInstall,
    },
  ] as const;

  for (const expected of builtIn) {
    it(`${expected.name} starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue`, async () => {
      const template = (await loadFloorTemplates()).find(
        ({ id }) => id === expected.id,
      );
      expect(template).toMatchObject({
        name: expected.name,
        icon: expected.icon,
        theme: expected.theme,
        labels: [],
      });
      // The Manager, then one Agent in each Role, in the manifest's order.
      expect(
        template?.roles.map(({ role, count }) => [
          role.id,
          role.name,
          role.stage,
          role.aiProvider,
          role.skills,
          count,
        ]),
      ).toEqual(expected.team.map((member) => [...member, 1]));
      // Each check is an npm script or a tool's own command, run one
      // after another.
      expect(template?.settings).toEqual({
        setupCommand: expected.setupCommand,
        testCommand: expected.checks
          .map((check) => (check.includes(" ") ? check : `npm run ${check}`))
          .join(" && "),
        mergePolicy: "send_to_me",
        roundCap: 3,
        requiredReviewers: expected.requiredReviewers,
      });
      expect(template?.skills.map(({ name }) => name)).toEqual(expected.skills);
      // The suggested first issue sets up every check the Floor runs.
      expect(template?.manager.firstIssue?.title).toBe(expected.firstIssue);
      for (const check of expected.checks) {
        expect(template?.manager.firstIssue?.body).toContain(`\`${check}\``);
      }
      expect(template?.manager.planningGuidance).toContain(
        `This Floor started from the ${expected.name} Floor Template.`,
      );
    });
  }

  it("a Role two of them bring is the same Role, with the same Skills", async () => {
    const templates = await loadFloorTemplates();
    const of = (id: string) => templates.find((template) => template.id === id);
    const role = (template: string, id: string) =>
      of(template)?.roles.find(({ role: each }) => each.id === id)?.role;
    expect(role("online-store", "copywriter")).toBeDefined();
    expect(role("website-and-marketing", "copywriter")).toEqual(
      role("online-store", "copywriter"),
    );
    expect(role("content-and-blog", "seo-specialist")).toBeDefined();
    expect(role("content-and-blog", "seo-specialist")).toEqual(
      role("website-and-marketing", "seo-specialist"),
    );
    const skill = (template: string, name: string) =>
      of(template)?.skills.find((each) => each.name === name);
    expect(skill("content-and-blog", "seo-basics")).toBeDefined();
    expect(skill("content-and-blog", "seo-basics")).toEqual(
      skill("website-and-marketing", "seo-basics"),
    );
  });

  it("a Role with a built-in Role's id is that Role, as the library starts with it", async () => {
    // The library has the built-in Roles from the start, and a template's
    // Role is added only where the library has none of its id, so a file
    // that differed would never reach an Agent. Design system's designer
    // and Mobile app's reviewer are the library's own.
    const brought = (await loadFloorTemplates()).flatMap((template) =>
      template.roles
        .filter(({ role }) => builtInRole(role.id) !== undefined)
        .map(({ role }) => ({ template: template.id, role })),
    );
    expect(
      brought.map(({ template, role }) => `${template}/${role.id}`),
    ).toEqual([
      "development/coder",
      "development/reviewer",
      "development/qa",
      "design-system/designer",
      "mobile-app/reviewer",
    ]);
    for (const { role } of brought) {
      expect(role).toEqual(builtInRole(role.id));
    }
  });
});

describe("loading templates from their files", () => {
  let folder: TemplateFolder;
  beforeEach(async () => {
    folder = await templateFolder();
  });
  afterEach(() => folder.remove());

  /** The load's failure, which must be a `FloorTemplateError`. */
  const failure = async (): Promise<FloorTemplateError> => {
    const error = await loadFloorTemplates(folder.root).then(
      () => undefined,
      (failed: unknown) => failed,
    );
    expect(error).toBeInstanceOf(FloorTemplateError);
    return error as FloorTemplateError;
  };

  it("reads every part of the format: Roles, counts, settings, the Manager's guidance, labels and Skills", async () => {
    // Beside Development and Blank only: its Roles differ from Online
    // store's.
    await folder.remove();
    folder = await templateFolder({ only: cornerShopNeighbours });
    await folder.write(cornerShopFiles);
    const templates = await loadFloorTemplates(folder.root);
    // Development first, then by name.
    expect(templates.map(({ id }) => id)).toEqual([
      "development",
      "blank",
      "corner-shop",
    ]);
    const shop = templates[2];
    expect(shop).toMatchObject({
      id: "corner-shop",
      name: "Corner shop",
      icon: "shopping-bag",
      theme: "stockroom",
      settings: {
        setupCommand: "pnpm install",
        testCommand: "pnpm theme-check",
        mergePolicy: "auto_merge",
        roundCap: 2,
        requiredReviewers: ["brand-reviewer"],
      },
      labels: [
        { name: "product", color: "c2e0c6", description: "A product's data" },
      ],
    });
    expect(
      shop?.roles.map(({ role, count }) => [role.id, role.stage, count]),
    ).toEqual([
      ["merchandiser", "work", 2],
      ["brand-reviewer", "review", 1],
      ["copywriter", "work", 0],
    ]);
    expect(shop?.roles[0]?.role).toEqual({
      id: "merchandiser",
      name: "merchandiser",
      stage: "work",
      description:
        "Arranges the catalogue's collections, prices and product data.",
      instructions: "- Keep every price in pence.",
      skills: ["price-check"],
      deskDressing: "printouts",
      aiProvider: "Claude",
      model: "claude-sonnet-5-5",
    });
    expect(
      shop?.skills.map(({ name, description }) => [name, description]),
    ).toEqual([
      ["price-check", "Checks that every product has a price in pence."],
    ]);
    expect(
      managerInstructionsOf(
        shop?.manager ?? { planningGuidance: "", firstIssue: null },
      ),
    ).toBe(
      [
        "Plan catalogue changes before the copy that describes them.",
        "",
        'When the Owner asks where to start, suggest they file this set-up issue first, titled "Check every product has a price":',
        "",
        "List the products without a price, and add one to each.",
      ].join("\n"),
    );
  });

  it("fails a broken manifest with its path", async () => {
    await folder.write({
      "blank/template.yaml": `name: Blank
description: Only a Manager.
icon: square
theme: office
roles: []
settings:
  setupCommand: ""
  testCommand: ""
  mergePolicy: merge_whenever
  roundCap: 0
  requiredReviewers: []
manager:
  planningGuidance: ""
  firstIssue: null
labels: []
`,
    });
    const error = await failure();
    expect(error.path).toBe(join(folder.root, "blank", "template.yaml"));
    expect(error.message.startsWith(`${error.path}: `)).toBe(true);
    expect(error.problems).toEqual([
      "settings.mergePolicy: The Merge Policy is send_to_me or auto_merge.",
      "settings.roundCap: The Round Cap is at least 1.",
    ]);
  });

  it("fails a manifest that is not YAML, or misses a field, with its path", async () => {
    await folder.write({ "blank/template.yaml": "name: [Blank\n" });
    const notYaml = await failure();
    expect(notYaml.path).toBe(join(folder.root, "blank", "template.yaml"));
    expect(notYaml.problems[0]).toMatch(/^template\.yaml is not valid YAML/);

    await folder.write({ "blank/template.yaml": "name: Blank\n" });
    const missing = await failure();
    expect(missing.path).toBe(join(folder.root, "blank", "template.yaml"));
    expect(missing.problems).toContain(
      "description: Describe the template in one line.",
    );
    expect(
      missing.problems.some((problem) => problem.startsWith("settings: ")),
    ).toBe(true);
  });

  it("fails a template with no manifest, and a file that is no part of one", async () => {
    await folder.write({ "notes/README.md": "# Notes\n" });
    const noManifest = await failure();
    expect(noManifest.path).toBe(join(folder.root, "notes"));
    expect(noManifest.problems).toEqual([
      "A Floor Template has a template.yaml.",
    ]);
    await folder.remove();

    folder = await templateFolder();
    await folder.write({ "development/notes.txt": "Remember the QA Agent.\n" });
    const stray = await failure();
    expect(stray.path).toBe(join(folder.root, "development", "notes.txt"));
    expect(stray.problems[0]).toMatch(/^Not part of a Floor Template/);
    await folder.remove();

    folder = await templateFolder();
    await folder.write({ "README.md": "# Templates\n" });
    expect((await failure()).path).toBe(join(folder.root, "README.md"));
  });

  it("fails a broken Role's file with its path", async () => {
    await folder.write({
      "development/roles/coder.md": `---
name: coder
stage: build
description: Changes the code.
skills: []
deskDressing: monitor
aiProvider: Claude
model: null
---

- Make the change.
`,
    });
    const badStage = await failure();
    expect(badStage.path).toBe(
      join(folder.root, "development", "roles", "coder.md"),
    );
    expect(badStage.problems).toEqual([
      "stage: Choose a Stage: work, review, QA or docs.",
    ]);

    await folder.write({
      "development/roles/coder.md": "- Make the change.\n",
    });
    expect((await failure()).problems).toEqual([
      "A Role's file starts with YAML frontmatter between two --- lines.",
    ]);
  });

  it("fails a template whose Roles and manifest disagree", async () => {
    await folder.write({
      "corner-shop/template.yaml":
        cornerShopFiles["corner-shop/template.yaml"] ?? "",
      "corner-shop/roles/merchandiser.md":
        cornerShopFiles["corner-shop/roles/merchandiser.md"] ?? "",
      "corner-shop/roles/brand-reviewer.md":
        cornerShopFiles["corner-shop/roles/brand-reviewer.md"] ?? "",
      "corner-shop/skills/price-check/SKILL.md":
        cornerShopFiles["corner-shop/skills/price-check/SKILL.md"] ?? "",
    });
    // The manifest lists a copywriter, with no file.
    const unfiled = await failure();
    expect(unfiled.path).toBe(
      join(folder.root, "corner-shop", "template.yaml"),
    );
    expect(unfiled.problems).toEqual([
      "Each Role it lists has a file: there is no roles/copywriter.md.",
    ]);

    await folder.write({
      ...cornerShopFiles,
      "corner-shop/roles/stocktaker.md": (
        cornerShopFiles["corner-shop/roles/copywriter.md"] ?? ""
      ).replace("name: copywriter", "name: stocktaker"),
    });
    const unlisted = await failure();
    expect(unlisted.path).toBe(
      join(folder.root, "corner-shop", "roles", "stocktaker.md"),
    );
    expect(unlisted.problems).toEqual([
      '"stocktaker" is not one of the Roles template.yaml lists.',
    ]);
  });

  it("fails a required reviewer outside the review Stage, and a Role's Skill the template lacks", async () => {
    await folder.write({
      ...cornerShopFiles,
      "corner-shop/template.yaml": (
        cornerShopFiles["corner-shop/template.yaml"] ?? ""
      ).replace(
        "requiredReviewers: [brand-reviewer]",
        "requiredReviewers: [merchandiser]",
      ),
    });
    const notReviewer = await failure();
    expect(notReviewer.path).toBe(
      join(folder.root, "corner-shop", "template.yaml"),
    );
    expect(notReviewer.problems).toEqual([
      'settings.requiredReviewers: "merchandiser" is not a Role in the review Stage.',
    ]);

    await folder.write({
      ...cornerShopFiles,
      "corner-shop/skills/price-check/SKILL.md": "# No frontmatter\n",
    });
    const badSkill = await failure();
    expect(badSkill.path).toBe(
      join(folder.root, "corner-shop", "skills", "price-check", "SKILL.md"),
    );
    expect(badSkill.problems).toEqual([
      "SKILL.md starts with YAML frontmatter between two --- lines.",
    ]);
    await folder.remove();

    folder = await templateFolder();
    const withoutSkill = Object.fromEntries(
      Object.entries(cornerShopFiles).filter(
        ([path]) => !path.startsWith("corner-shop/skills/"),
      ),
    );
    await folder.write(withoutSkill);
    const noSkill = await failure();
    expect(noSkill.path).toBe(
      join(folder.root, "corner-shop", "roles", "merchandiser.md"),
    );
    expect(noSkill.problems).toEqual([
      'Its Skills are in the template\'s skills folder, which has no "price-check".',
    ]);
  });

  it("fails a Role two templates bring differently", async () => {
    await folder.write({
      ...cornerShopFiles,
      "corner-shop/roles/copywriter.md": (
        cornerShopFiles["corner-shop/roles/copywriter.md"] ?? ""
      ).replace("name: copywriter", "name: coder"),
    });
    // Its name is Development's coder's, under another id. Templates are
    // read in their folders' order, so Development's is the second.
    const namesake = await failure();
    expect(namesake.path).toBe(
      join(folder.root, "development", "roles", "coder.md"),
    );
    expect(namesake.problems).toEqual([
      'The corner-shop template\'s "copywriter" is called "coder" too.',
    ]);

    await folder.write({
      ...cornerShopFiles,
      "corner-shop/template.yaml": (
        cornerShopFiles["corner-shop/template.yaml"] ?? ""
      ).replace("role: copywriter", "role: qa"),
      "corner-shop/roles/qa.md": (
        cornerShopFiles["corner-shop/roles/copywriter.md"] ?? ""
      ).replace("name: copywriter", "name: QA"),
    });
    await rm(join(folder.root, "corner-shop", "roles", "copywriter.md"));
    const differently = await failure();
    expect(differently.path).toBe(
      join(folder.root, "development", "roles", "qa.md"),
    );
    expect(differently.problems).toEqual([
      'The corner-shop template brings "qa" too, differently: a Role is the same in every template that brings it.',
    ]);
  });
});
