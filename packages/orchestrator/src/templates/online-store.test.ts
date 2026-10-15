import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type EventOfType,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  defaultIntakeSettings,
  initialDefaultModels,
  managerInstructionsOf,
  type FloorTemplate,
  type ReviewVerdict,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createBatches } from "../batches/batches.ts";
import { createCoderFlow } from "../coder/coder.ts";
import { createFloors } from "../floors/floors.ts";
import { createTriage } from "../manager/triage.ts";
import { createMergeFlow, type MergeFlow } from "../merge/merge.ts";
import { createFakeModel } from "../models/fake-model.ts";
import { createNotices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createQaFlow } from "../qa/qa.ts";
import { createReviewFlow } from "../review/reviewer.ts";
import { issueBranch } from "../sandbox/branch.ts";
import {
  createFakeSandbox,
  result,
  say,
  type FakeAgentContext,
} from "../sandbox/fake-sandbox.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { createSandboxRunner } from "../sandbox/runner.ts";
import type { SkillMount } from "../sandbox/skills.ts";
import { createFloorSkills } from "../skills/floor.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createWorkQueue,
  executeByStage,
  type WorkQueue,
} from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createWorkTurns } from "../work/turns.ts";
import { loadFloorTemplates } from "./load.ts";

// §5 scenario 11, "Open an online store Floor", end to end on a Floor
// added from the built-in Online store Floor Template (PRD FR-100), with
// a fake model for the Manager and the brand reviewer, the fake GitHub
// over a local bare repository, and each sandbox Agent a script in a fake
// sandbox, wired as the server wires them:
//
// 1. The Owner adds a Floor for `shop-theme` from Online store. It starts
//    with a Manager, a merchandiser, a copywriter, a storefront developer,
//    a brand reviewer and a store QA Agent, the template's check commands
//    and its stockroom look.
// 2. The Owner files "add the autumn range". The Manager's Plan gives it
//    to the merchandiser and then the copywriter, on one branch.
// 3. The brand reviewer approves, store QA runs the store's checks (links,
//    prices and images among them, as npm scripts in the repository), and
//    the pull request awaits the Owner's approval.
//
// It runs in memory and in Postgres 18.

const exec = promisify(execFile);
const shop = "adrianeyre/shop-theme";
const floorId = "shop-theme";
const gatewayKey = "aio_gk_theonlinestoresagentskeyfortheirsandboxes0";
const at = new Date("2026-10-10T09:00:00.000Z");

const autumnRange = {
  title: "Add the autumn range",
  body: [
    "Add the two autumn coats to the catalogue, at £120 each in S, M and L, with their photos, and write each one's description.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Two products in the Autumn collection, each with a price, S, M and L, and a photo with alt text",
    "- [ ] Each has a description in the brand's voice, linking to its product",
  ].join("\n"),
  labels: ["ai-office"],
};
const branch = issueBranch(1, autumnRange.title);
const productsFile = "products/autumn.json";
const copyFile = "copy/autumn.md";

/**
 * The store's checks, as its first set-up issue would leave them: one
 * script per check, run by `npm run check:<name>` with no dependencies, so
 * the template's setup command (`npm install`) needs no network.
 */
const checkScript = `import { existsSync, readdirSync, readFileSync } from "node:fs";

const check = process.argv[2];
const products = readdirSync("products")
  .filter((file) => file.endsWith(".json"))
  .flatMap((file) =>
    JSON.parse(readFileSync(\`products/\${file}\`, "utf8")).map((product) => ({
      ...product,
      file: \`products/\${file}\`,
    })),
  );
const problems = [];
if (check === "theme" && !existsSync("layout/theme.liquid")) {
  problems.push("layout/theme.liquid is missing");
}
if (check === "prices") {
  for (const product of products) {
    for (const variant of product.variants) {
      if (!(variant.price > 0)) {
        problems.push(\`\${product.file}: \${variant.sku} has no price\`);
      }
    }
  }
}
if (check === "images") {
  for (const product of products) {
    for (const image of product.images) {
      if (!existsSync(image.src)) problems.push(\`\${product.file}: \${image.src} is missing\`);
      if (!image.alt) problems.push(\`\${product.file}: \${image.src} has no alt text\`);
    }
  }
}
if (check === "links") {
  const handles = new Set(products.map(({ handle }) => handle));
  const pages = existsSync("copy") ? readdirSync("copy") : [];
  for (const page of pages) {
    const text = readFileSync(\`copy/\${page}\`, "utf8");
    for (const [, handle] of text.matchAll(/\\/products\\/([a-z0-9-]+)/g)) {
      if (!handles.has(handle)) problems.push(\`copy/\${page}: /products/\${handle} goes nowhere\`);
    }
  }
}
if (check === "accessibility") {
  for (const [tag] of readFileSync("layout/theme.liquid", "utf8").matchAll(/<img[^>]*>/g)) {
    if (!tag.includes("alt=")) problems.push(\`layout/theme.liquid: \${tag} has no alt text\`);
  }
}
for (const problem of problems) console.log(problem);
console.log(\`check:\${check}: \${problems.length === 0 ? "ok" : "failed"}\`);
process.exit(problems.length === 0 ? 0 : 1);
`;

/** The `shop-theme` repository as the Owner has it before the Floor. */
const seedFiles: Readonly<Record<string, string>> = {
  "README.md": "# Shop theme\n",
  ".gitignore": "node_modules/\n",
  "package.json": `${JSON.stringify(
    {
      name: "shop-theme",
      private: true,
      scripts: Object.fromEntries(
        ["theme", "links", "prices", "images", "accessibility"].map((check) => [
          `check:${check}`,
          `node scripts/check.mjs ${check}`,
        ]),
      ),
    },
    null,
    2,
  )}\n`,
  "package-lock.json": `${JSON.stringify(
    {
      name: "shop-theme",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "shop-theme" } },
    },
    null,
    2,
  )}\n`,
  "scripts/check.mjs": checkScript,
  "layout/theme.liquid":
    '<img src="{{ \'logo.png\' | asset_url }}" alt="The shop">\n{{ content_for_layout }}\n',
  "products/core.json": `${JSON.stringify([
    {
      handle: "wool-scarf",
      title: "Wool scarf",
      collections: ["Core"],
      variants: [{ sku: "SCARF-1", option: "One size", price: 35 }],
      images: [{ src: "assets/wool-scarf.jpg", alt: "A grey wool scarf" }],
    },
  ])}\n`,
  "assets/wool-scarf.jpg": "a scarf\n",
};

/** The autumn coats, as the merchandiser adds them. */
const coats = [1, 2].map((coat) => ({
  handle: `autumn-coat-${String(coat)}`,
  title: `Autumn coat ${String(coat)}`,
  collections: ["Autumn"],
  variants: ["S", "M", "L"].map((size) => ({
    sku: `COAT-${String(coat)}-${size}`,
    option: size,
    price: 120,
  })),
  images: [
    {
      src: `assets/autumn-coat-${String(coat)}.jpg`,
      alt: `Autumn coat ${String(coat)}, in rust wool, buttoned`,
    },
  ],
}));

/** Their descriptions, as the copywriter writes them, each linking to its coat. */
const copy = coats
  .map(
    ({ handle, title }) =>
      `## ${title}\n\nFor cold mornings. [Shop the ${title.toLowerCase()}](/products/${handle}).\n`,
  )
  .join("\n");

const ofType = <Type extends OfficeEvent["type"]>(
  events: readonly OfficeEvent[],
  type: Type,
): EventOfType<Type>[] =>
  events.filter((event): event is EventOfType<Type> => event.type === type);

/** A Handoff, at the end of a work Agent's last message. */
const handoff = (changed: string, check: string): object =>
  say(
    [
      "Done.",
      "<handoff>",
      `Changed: ${changed}`,
      `Check: ${check}`,
      "Risks: none.",
      "</handoff>",
    ].join("\n"),
  );

/** The Skills mounted into a sandbox, by name, as its Agent finds them. */
const mountedSkills = async (
  mounts: readonly SkillMount[],
): Promise<string[]> => {
  const names: string[] = [];
  for (const { hostPath } of mounts) {
    for (const entry of await readdir(hostPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skill = await readFile(
          join(hostPath, entry.name, "SKILL.md"),
          "utf8",
        );
        if (skill.includes(`name: ${entry.name}`)) {
          names.push(entry.name);
        }
      }
    }
  }
  return names.sort();
};

/** One sandbox run: its Agent's Role, its prompt and its Skills. */
interface Run {
  readonly role: string;
  readonly prompt: string;
  readonly skills: readonly string[];
  /** For store QA: what the check command printed, and its exit code. */
  readonly checks?: { readonly output: string; readonly exitCode: number };
}

async function scenario(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
  run: (setup: {
    readonly template: FloorTemplate;
    readonly team: (role: string) => AgentRecord;
    readonly runs: readonly Run[];
    readonly sandboxCommands: () => string[];
    readonly addFloor: () => Promise<void>;
    readonly handOver: () => Promise<{ batchId: number; answer: string }>;
    readonly queue: WorkQueue;
    readonly remote: string;
    readonly events: () => Promise<OfficeEvent[]>;
    readonly stores: OfficeStores;
    readonly model: ReturnType<typeof createFakeModel>;
    readonly notices: ReturnType<typeof createNotices>;
    readonly github: ReturnType<typeof gitBackedGitHub>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-online-store-"));
  const remote = join(root, "shop-theme.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  for (const [path, content] of Object.entries(seedFiles)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: the shop's theme");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const fake = createFakeGitHub();
  fake.installRepository(shop);
  const github = gitBackedGitHub(fake, remote);
  const templates = await loadFloorTemplates();
  const template = templates.find(({ id }) => id === "online-store");
  if (template === undefined) {
    throw new Error("Online store is a built-in Floor Template.");
  }
  // The brand reviewer's suggested AI Provider is ChatGPT.
  const defaultModels = () =>
    Promise.resolve({ ...initialDefaultModels, ChatGPT: "gpt-5.5" });
  const floors = createFloors({
    store: stores.floors,
    github,
    events: bus,
    agents: stores.agents,
    defaultModels,
    roles: stores.roles,
    skills: stores.skills,
    templates,
    now: () => at,
  });

  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events: bus,
  });
  const pipeline = createPipeline({ github, events: bus });
  const notices = createNotices({ store: stores.notices, events: bus });
  const model = createFakeModel();
  const turns = createWorkTurns({ store: stores.workTurns });
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    defaultModels,
    notices,
    events: bus,
    store: stores.triage,
    roles: stores.roles,
  });
  const floorSkills = createFloorSkills({
    floors: stores.floors,
    library: stores.skills,
    toggles: stores.floorSkills,
    reviews: stores.repositorySkillReviews,
    roles: stores.roles,
    events: bus,
  });

  const runs: Run[] = [];
  let mounts: readonly SkillMount[] = [];
  const working = async (
    context: FakeAgentContext,
    role: string,
    files: Readonly<Record<string, string>>,
    subject: string,
    check: string,
  ): Promise<void> => {
    runs.push({
      role,
      prompt: context.prompt,
      skills: await mountedSkills(mounts),
    });
    for (const [path, content] of Object.entries(files)) {
      await context.sh(
        `mkdir -p "$(dirname ${path})" && printf '%s' '${content.replaceAll("'", "'\\''")}' > ${path}`,
      );
    }
    await context.sh(`git add -A && git commit --quiet -m "${subject}"`);
    context.print(handoff(`${subject}.`, check));
    context.print(result({ input: 900, output: 150 }));
  };
  const sandbox = await createFakeSandbox(async (context) => {
    const { prompt } = context;
    if (prompt.includes("a merchandiser Agent in AI Office")) {
      await working(
        context,
        "merchandiser",
        {
          [productsFile]: `${JSON.stringify(coats, null, 2)}\n`,
          "assets/autumn-coat-1.jpg": "coat one\n",
          "assets/autumn-coat-2.jpg": "coat two\n",
        },
        "feat: the autumn coats' product data",
        `${productsFile}: two coats at 120 in S, M and L, with photos.`,
      );
      return;
    }
    if (prompt.includes("a copywriter Agent in AI Office")) {
      await working(
        context,
        "copywriter",
        { [copyFile]: copy },
        "feat: the autumn coats' descriptions",
        `${copyFile}: each coat's description links to it.`,
      );
      return;
    }
    if (prompt.includes("a store QA Agent in AI Office")) {
      // Store QA runs the Floor's check command, as its prompt says.
      const command = template.settings.testCommand;
      const checks = await context.sh(`${command} 2>&1`);
      runs.push({
        role: "store-qa",
        prompt,
        skills: await mountedSkills(mounts),
        checks: { output: checks.stdout, exitCode: checks.exitCode },
      });
      context.print(
        say(
          [
            "Checked.",
            "<qa-report>",
            `Result: ${checks.exitCode === 0 ? "pass" : "fail"}`,
            "Summary: The store's checks pass: theme, links, prices, images and accessibility.",
            "Steps: none",
            "</qa-report>",
          ].join("\n"),
        ),
      );
      context.print(result({ input: 800, output: 100 }));
      return;
    }
    throw new Error(`No Agent here works this: ${prompt.slice(0, 120)}`);
  });
  const runner = createSandboxRunner({
    github,
    events: bus,
    sandbox: (environment, _tool, given) => {
      mounts = given;
      return sandbox.provider(environment);
    },
    gateway: () =>
      Promise.resolve({ url: "http://gateway:4000", key: gatewayKey }),
    // As the server wires it: the Floor's Skills on for the Agent's Role.
    skills: async (task, clone) =>
      (await floorSkills.forSandbox(task.floor.id, task.agent.role, clone))
        .skills,
    workDir: join(root, "work"),
    cloneUrl: () => remote,
  });
  const holder: { queue?: WorkQueue } = {};
  const next = {
    enqueue: (work: Parameters<WorkQueue["enqueue"]>[0]) =>
      holder.queue?.enqueue(work) ?? Promise.resolve(),
  };
  // The Merge Policy waits for CI on its own clock, which passes at once.
  let clock = Date.now();
  const mergeFlow: MergeFlow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github,
    notices,
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    ownerLogin: async () => (await office.intakeSettings()).ownerLogin,
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  const sandboxFlow = {
    floors: stores.floors,
    agents: stores.agents,
    github,
    pipeline,
    notices,
    events: bus,
    runner,
    gitIdentity: (floor: string) => office.floorGitIdentity(floor),
    defaultModels,
    scratchDir: root,
    pushUrl: () => remote,
    queue: next,
    reviews: stores.reviews,
    roles: stores.roles,
  };
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    issuePriority: (floor, issue) => triage.priority(floor, issue),
    // As the server wires it: the Role whose turn it is, else triage's.
    issueRole: async (floor, issue) =>
      (await turns.role(floor, issue)) ?? triage.role(floor, issue),
    execute: executeByStage({
      "needs-work": createCoderFlow({ ...sandboxFlow, turns }),
      "needs-review": createReviewFlow({
        floors: stores.floors,
        agents: stores.agents,
        github,
        pipeline,
        notices,
        events: bus,
        models: model,
        defaultModels,
        reviews: stores.reviews,
        queue: next,
        roles: stores.roles,
        turns,
      }),
      "needs-qa": createQaFlow(sandboxFlow),
      "ready-to-merge": mergeFlow.execute,
    }),
  });
  holder.queue = queue;
  const batches = createBatches({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    defaultModels,
    store: stores.batches,
    work: workStore,
    pipeline,
    queue,
    events: bus,
    notices,
    triage,
    turns,
    settings: () => Promise.resolve(defaultIntakeSettings),
  });
  await queue.start();

  /** The Floor's Agents, by Role: one each. */
  const members = new Map<string, AgentRecord>();
  try {
    await run({
      template,
      team: (role) => {
        const found = members.get(role);
        if (found === undefined) {
          throw new Error(`The Floor has no ${role}.`);
        }
        return found;
      },
      runs,
      sandboxCommands: () =>
        sandbox.sandboxes.flatMap(({ commands }) => commands),
      async addFloor() {
        await floors.add(shop, "online-store");
        for (const agent of await stores.agents.list(floorId)) {
          members.set(agent.role, agent);
        }
      },
      async handOver() {
        const issue = fake.createIssue(shop, autumnRange).number;
        const manager = members.get("manager");
        model.answer(
          manager?.id ?? "",
          JSON.stringify({
            summary: "The autumn range: its product data, then its copy.",
            issues: [
              {
                issue,
                dependsOn: [],
                files: [productsFile, copyFile],
                agent: null,
                roles: ["merchandiser", "copywriter"],
                note: "The coats first, then their words, on one branch.",
              },
            ],
          }),
          JSON.stringify({
            clear: true,
            priority: "normal",
            reason: "It lists acceptance criteria.",
            questions: [],
          }),
        );
        const answer = await batches.command(floorId, [issue]);
        const [batch] = await stores.batches.open(floorId);
        if (batch === undefined) {
          throw new Error("The Batch is made.");
        }
        await batches.approve(floorId, batch.id, 1);
        return { batchId: batch.id, answer };
      },
      queue,
      remote,
      events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
      stores,
      model,
      notices,
      github,
    });
  } finally {
    await queue.stop();
    await batches.stop();
    mergeFlow.stop();
    triage.stop();
    await rm(root, { recursive: true, force: true });
  }
}

const approve = JSON.stringify({
  verdict: "approve",
  summary:
    "On brand: the coats' copy is in the brand's voice, and the prices match.",
  comments: [],
} satisfies ReviewVerdict);

const scenario11 = (
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<void> =>
  scenario(stores, workStore, bus, async (setup) => {
    const { template } = setup;

    // 1. The Owner adds the Floor from Online store.
    await setup.addFloor();
    const floor = await setup.stores.floors.get(floorId);
    expect(floor?.template).toEqual({
      id: "online-store",
      name: "Online store",
    });
    const team = await setup.stores.agents.list(floorId);
    expect(team.map(({ role, stage }) => [role, stage])).toEqual([
      ["manager", null],
      ["merchandiser", "work"],
      ["copywriter", "work"],
      ["storefront-developer", "work"],
      ["brand-reviewer", "review"],
      ["store-qa", "qa"],
    ]);
    // With the template's check commands, and its brand reviewer required.
    expect(floor).toMatchObject({
      setupCommand: "if [ -f package.json ]; then npm install; fi",
      testCommand:
        "npm run check:theme && npm run check:links && npm run check:prices && npm run check:images && npm run check:accessibility",
      mergePolicy: "send_to_me",
      roundCap: 3,
      requiredReviewerAgentIds: [setup.team("brand-reviewer").id],
    });
    // The brand reviewer on ChatGPT, as its Role suggests; the rest on Claude.
    expect(
      team.map(({ role, aiProvider }) => [role, aiProvider]),
    ).toContainEqual(["brand-reviewer", "ChatGPT"]);
    expect(setup.team("manager").extraInstructions).toBe(
      managerInstructionsOf(template.manager),
    );
    // The stockroom look: the theme its 3D Office dresses the Floor in.
    expect(template.theme).toBe("stockroom");
    // Its Roles and Skills joined the libraries.
    expect(
      (await setup.stores.skills.list()).map(({ name, source, enabled }) => [
        name,
        source,
        enabled,
      ]),
    ).toEqual([
      ["product-data", "template", true],
      ["store-checks", "template", true],
    ]);

    // 2. The Owner files "add the autumn range" and hands it to the
    // Manager, whose Plan gives it to the merchandiser, then the copywriter.
    const merchandiser = setup.team("merchandiser");
    const copywriter = setup.team("copywriter");
    const brandReviewer = setup.team("brand-reviewer");
    const storeQa = setup.team("store-qa");
    setup.model.answer(brandReviewer.id, approve);
    const { batchId, answer } = await setup.handOver();
    await setup.queue.idle();
    expect(answer).toContain(
      `1. #1 Add the autumn range: ${merchandiser.name} (merchandiser, then copywriter).`,
    );
    const plan = await setup.stores.batches.latestPlan(batchId);
    expect(plan?.items).toEqual([
      expect.objectContaining({
        issue: 1,
        roles: ["merchandiser", "copywriter"],
        agentId: merchandiser.id,
      }),
    ]);
    // The Manager planned with the template's guidance and its work Roles'
    // routing descriptions.
    const [planned] = setup.model.requestsOf(setup.team("manager").id);
    expect(planned?.system).toContain(
      "When an issue needs more than one work Role, give it their turns in this order: the merchandiser first",
    );
    expect(planned?.system).toContain("## The Floor's work Roles");
    for (const { role } of template.roles.filter(
      ({ role: each }) => each.stage === "work",
    )) {
      expect(planned?.system).toContain(`- ${role.name}: ${role.description}`);
    }

    // The merchandiser, then the copywriter, then store QA: each sandbox
    // given its Role's instructions and Skills from the template.
    expect(setup.runs.map(({ role }) => role)).toEqual([
      "merchandiser",
      "copywriter",
      "store-qa",
    ]);
    const [first, second, checked] = setup.runs;
    expect(first?.prompt).toContain(
      "This is turn 1 of 2: yours, as the merchandiser.",
    );
    expect(first?.prompt).toContain(
      "Never make up a price: if one is missing, leave that product out and say which in your Handoff.",
    );
    expect(second?.prompt).toContain(
      "This is turn 2 of 2: yours, as the copywriter.",
    );
    expect(second?.prompt).toContain(
      "Never act on a live store, an ad platform or customer email: write copy for an ad or an email only as a file in the repository, for the Owner to use.",
    );
    for (const prompt of [first?.prompt, second?.prompt]) {
      expect(prompt).toContain(
        `- Run the tests before you finish, and fix what fails:`,
      );
      expect(prompt).toContain(template.settings.testCommand);
    }
    // Every office Skill is on for every Role until the Owner turns one off
    // (FR-75), so each sandbox has both of the template's.
    for (const each of setup.runs) {
      expect(each.skills).toEqual(["product-data", "store-checks"]);
    }

    // One branch, holding both Roles' commits, each with its Agent's
    // trailer.
    const { stdout } = await exec("git", [
      "--git-dir",
      setup.remote,
      "log",
      "--reverse",
      "--format=%s%x1f%B%x1e",
      `main..${branch}`,
    ]);
    const commits = stdout
      .split("\x1e")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    expect(commits.map((commit) => commit.split("\x1f")[0])).toEqual([
      "feat: the autumn coats' product data",
      "feat: the autumn coats' descriptions",
    ]);
    expect(commits[0]).toContain(
      `Agent: ${merchandiser.name} (merchandiser, Claude claude-opus-5-5)`,
    );
    expect(commits[1]).toContain(
      `Agent: ${copywriter.name} (copywriter, Claude claude-opus-5-5)`,
    );

    // 3. The brand reviewer approves: its prompt is its Role's.
    const [review] = setup.model.requestsOf(brandReviewer.id);
    expect(review?.system).toContain(
      `You are ${brandReviewer.name}, a brand reviewer Agent in AI Office`,
    );
    expect(review?.system).toContain(
      "This Floor works on the store's repository only, never on a live store, an ad platform or customer email.",
    );
    const reviewed = JSON.stringify(review?.messages);
    expect(reviewed).toContain(productsFile);
    expect(reviewed).toContain(copyFile);

    // Store QA ran the setup command, then the store's checks on the pull
    // request's branch: links, prices and images among them, all passing.
    expect(checked?.prompt).toContain(
      `You are ${storeQa.name}, a store QA Agent in AI Office, checking pull request #2`,
    );
    expect(checked?.prompt).toContain(
      "3. Check the links, prices and images the change touches yourself:",
    );
    expect(setup.sandboxCommands()).toContain(template.settings.setupCommand);
    expect(checked?.checks?.exitCode).toBe(0);
    for (const check of [
      "theme",
      "links",
      "prices",
      "images",
      "accessibility",
    ]) {
      expect(checked?.checks?.output).toContain(`check:${check}: ok`);
    }

    // The pull request awaits the Owner's approval: send to me.
    const events = await setup.events();
    expect(
      ofType(events, "qa.reported").map(({ agentId, result: found }) => [
        agentId,
        found,
      ]),
    ).toEqual([[storeQa.id, "pass"]]);
    expect(ofType(events, "review.posted")).toEqual([
      expect.objectContaining({ agentId: brandReviewer.id }),
    ]);
    const [pullRequest] = await setup.github
      .repository(shop)
      .listPullRequests({ head: branch });
    expect(pullRequest?.number).toBe(2);
    expect(pullRequest?.merged).toBe(false);
    expect(
      (await setup.notices.open({ floorId })).map(({ title }) => title),
    ).toContain("PR #2 awaiting your approval");
    expect(ofType(events, "pull_request.merged")).toEqual([]);
  });

describe("§5 scenario 11 on an Online store Floor, in memory", () => {
  it('adds the Floor from Online store; "add the autumn range" goes to the merchandiser then the copywriter, the brand reviewer approves, store QA runs the checks, and it awaits the Owner', async () => {
    const stores = memoryStores();
    await scenario11(
      stores,
      memoryWorkQueueStore(stores.floors),
      createEventBus({ store: memoryEventStore() }),
    );
  });
});

describe("§5 scenario 11 on an Online store Floor, in Postgres 18", () => {
  postgresTest(
    'adds the Floor from Online store; "add the autumn range" goes to the merchandiser then the copywriter, the brand reviewer approves, store QA runs the checks, and it awaits the Owner',
    async ({ database }) => {
      await scenario11(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
    },
  );
});
