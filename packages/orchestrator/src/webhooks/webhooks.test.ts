import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { signWebhook } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { defaultIntakeSettings } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import {
  createIntake,
  memoryIntakeQueue,
  type Intake,
  type QueuedWork,
} from "../intake/intake.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createGitHubWebhooks,
  webhookActions,
  WebhookSettingsError,
  type GitHubWebhooks,
  type WebhookTargets,
} from "./webhooks.ts";

// The GitHub App's webhooks (PRD FR-8): off until the Owner turns them on
// with the App's secret; a delivery whose signature does not match it is
// refused; a signed one about a Floor starts what it concerns at once.

const webShop = "adrianeyre/web-shop";
const secret = "the-app-webhook-secret-0123456789";
const encryptor = encryptorFromKey(Buffer.alloc(32, 9));

/** A delivery of `event`, signed with `key`. */
const delivery = (event: string, payload: unknown, key = secret) => {
  const body = Buffer.from(JSON.stringify(payload));
  return { event, body, signature: signWebhook(key, body) };
};

const labelled = (issue: number, repository = webShop) => ({
  action: "labeled",
  issue: { number: issue },
  label: { name: "ai-office" },
  repository: { full_name: repository },
});

interface Started {
  readonly intake: number;
  readonly labels: string[];
  readonly batches: number;
  readonly ci: string[];
}

function recordingTargets(): WebhookTargets & { started: Started } {
  const started = {
    intake: 0,
    labels: [] as string[],
    batches: 0,
    ci: [] as string[],
  };
  return {
    started,
    intake: {
      trigger() {
        started.intake += 1;
        return Promise.resolve();
      },
      recheckLabels(floorId) {
        started.labels.push(floorId);
      },
    },
    batches: {
      trigger() {
        started.batches += 1;
        return Promise.resolve();
      },
    },
    merge: {
      ciChanged(floorId) {
        started.ci.push(floorId);
      },
    },
  };
}

interface Setup {
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly bus: EventBus;
  readonly webhooks: GitHubWebhooks;
  readonly targets: ReturnType<typeof recordingTargets>;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  github.installRepository("adrianeyre/blog");
  await createFloors({ store: stores.floors, github, events: bus }).add(
    webShop,
  );
  const targets = recordingTargets();
  return {
    github,
    stores,
    bus,
    targets,
    webhooks: createGitHubWebhooks({
      store: stores.office,
      floors: stores.floors,
      encryptor,
      events: bus,
      targets,
    }),
  };
}

const configChanges = async (bus: EventBus) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type === "config.changed");

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "are off, with no secret, until turned on; the secret is sealed and never read back",
    async ({ webhooks, stores, bus }) => {
      expect(await webhooks.settings()).toEqual({
        enabled: false,
        secretSet: false,
      });
      await expect(
        webhooks.setSettings({ enabled: true }),
      ).rejects.toBeInstanceOf(WebhookSettingsError);

      expect(await webhooks.setSettings({ enabled: true, secret })).toEqual({
        enabled: true,
        secretSet: true,
      });
      const kept = await stores.office.githubWebhooks();
      expect(kept.sealedSecret).toMatch(/^aio1:/);
      expect(kept.sealedSecret).not.toContain(secret);

      // Off and on again keeps the secret.
      await webhooks.setSettings({ enabled: false });
      expect(await webhooks.setSettings({ enabled: true })).toEqual({
        enabled: true,
        secretSet: true,
      });
      const changes = await configChanges(bus);
      expect(changes.map((event) => event.keys)).toEqual([
        ["webhooks.enabled", "webhooks.secret"],
        ["webhooks.enabled"],
        ["webhooks.enabled"],
      ]);
      expect(JSON.stringify(changes)).not.toContain(secret);
    },
  ],
  [
    "look at nothing while off",
    async ({ webhooks, targets }) => {
      expect(await webhooks.receive(delivery("issues", labelled(1)))).toEqual({
        status: "off",
      });
      // A secret kept, but webhooks off.
      await webhooks.setSettings({ enabled: false, secret });
      expect(await webhooks.receive(delivery("issues", labelled(1)))).toEqual({
        status: "off",
      });
      expect(targets.started.intake).toBe(0);
    },
  ],
  [
    "refuse a delivery whose signature is missing, wrong or for another body",
    async ({ webhooks, targets }) => {
      await webhooks.setSettings({ enabled: true, secret });
      const right = delivery("issues", labelled(1));
      for (const refused of [
        { ...right, signature: undefined },
        { ...right, signature: "" },
        { ...right, signature: "sha256=0000" },
        delivery("issues", labelled(1), "another-secret-of-some-length"),
        { ...right, body: Buffer.from(JSON.stringify(labelled(2))) },
      ]) {
        expect(await webhooks.receive(refused)).toEqual({ status: "refused" });
      }
      expect(targets.started.intake).toBe(0);

      // A new secret: deliveries signed with the old one are refused.
      await webhooks.setSettings({
        enabled: true,
        secret: "a-brand-new-webhook-secret-987",
      });
      expect(await webhooks.receive(right)).toEqual({ status: "refused" });
    },
  ],
  [
    "start intake at once for a labelled issue on a Floor",
    async ({ webhooks, targets }) => {
      await webhooks.setSettings({ enabled: true, secret });
      expect(await webhooks.receive(delivery("issues", labelled(1)))).toEqual({
        status: "accepted",
        floorId: "web-shop",
        started: ["intake"],
      });
      expect(targets.started.intake).toBe(1);
    },
  ],
  [
    "start nothing for a repository that is not a Floor, nor for a body that is not JSON",
    async ({ webhooks, targets }) => {
      await webhooks.setSettings({ enabled: true, secret });
      expect(
        await webhooks.receive(
          delivery("issues", labelled(1, "adrianeyre/blog")),
        ),
      ).toEqual({ status: "accepted", started: [] });
      const body = Buffer.from("not json");
      expect(
        await webhooks.receive({
          event: "issues",
          body,
          signature: signWebhook(secret, body),
        }),
      ).toEqual({ status: "malformed" });
      expect(targets.started.intake).toBe(0);
    },
  ],
  [
    "start the Batches' check for a closed pull request, and the wait for CI for a check run",
    async ({ webhooks, targets }) => {
      await webhooks.setSettings({ enabled: true, secret });
      const repository = { full_name: "ADRIANEYRE/Web-Shop" };
      await webhooks.receive(
        delivery("pull_request", { action: "closed", repository }),
      );
      await webhooks.receive(
        delivery("check_run", { action: "completed", repository }),
      );
      await webhooks.receive(
        delivery("label", {
          action: "deleted",
          label: { name: "needs-review" },
          repository,
        }),
      );
      expect(targets.started).toEqual({
        intake: 1,
        labels: ["web-shop"],
        batches: 1,
        ci: ["web-shop"],
      });
    },
  ],
  [
    "say the Floor's repository changed for a push, a pull request, a check run or a check suite, and for nothing else",
    async ({ webhooks, bus }) => {
      await webhooks.setSettings({ enabled: true, secret });
      const repository = { full_name: webShop };
      for (const [event, action] of [
        ["push", undefined],
        ["pull_request", "synchronize"],
        ["check_run", "completed"],
        ["check_suite", "requested"],
        ["issues", "labeled"],
        ["status", undefined],
      ] as const) {
        await webhooks.receive(
          delivery(event, {
            ...(action === undefined ? {} : { action }),
            ref: "refs/heads/ai-office/4-add-a-basket",
            repository,
          }),
        );
      }
      // Not for a repository that is no Floor.
      await webhooks.receive(
        delivery("push", { repository: { full_name: "adrianeyre/blog" } }),
      );
      expect(
        (await bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter((event) => event.type === "repository.changed"),
      ).toEqual(
        ["push", "pull_request", "check_run", "check_suite"].map((change) => ({
          type: "repository.changed",
          version: 1,
          floorId: "web-shop",
          change,
        })),
      );
    },
  ],
];

describe("a delivery taken once (W1-1)", () => {
  const replayed = async (remember?: number) => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const setup = await setUp(stores, bus);
    const webhooks =
      remember === undefined
        ? setup.webhooks
        : createGitHubWebhooks({
            store: stores.office,
            floors: stores.floors,
            encryptor,
            events: bus,
            targets: setup.targets,
            remember,
          });
    await webhooks.setSettings({ enabled: true, secret });
    return { ...setup, webhooks };
  };

  it("starts nothing again for a body taken before, whatever it starts: intake, the labels, the Batches' check or the wait for CI", async () => {
    const { webhooks, targets } = await replayed();
    const repository = { full_name: webShop };
    const deliveries = [
      delivery("issues", labelled(1)),
      delivery("label", {
        action: "deleted",
        label: { name: "needs-review" },
        repository,
      }),
      delivery("pull_request", { action: "closed", repository }),
      delivery("check_run", { action: "completed", repository }),
    ];
    for (const sent of deliveries) {
      expect(await webhooks.receive(sent)).toMatchObject({
        status: "accepted",
      });
    }
    const once = structuredClone(targets.started);
    expect(once).toEqual({
      intake: 2,
      labels: ["web-shop"],
      batches: 1,
      ci: ["web-shop"],
    });
    for (const sent of deliveries) {
      expect(await webhooks.receive(sent)).toEqual({ status: "repeated" });
    }
    expect(targets.started).toEqual(once);
  });

  it("takes the same body sent twice at once only once", async () => {
    const { webhooks, targets } = await replayed();
    const sent = delivery("issues", labelled(1));
    const outcomes = await Promise.all([
      webhooks.receive(sent),
      webhooks.receive(sent),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([
      "accepted",
      "repeated",
    ]);
    expect(targets.started.intake).toBe(1);
  });

  it("remembers only bodies taken, so one refused or sent while off is taken when it comes again", async () => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const { webhooks, targets } = await setUp(stores, bus);
    const sent = delivery("issues", labelled(1));
    expect(await webhooks.receive(sent)).toEqual({ status: "off" });
    await webhooks.setSettings({
      enabled: true,
      secret: "not-the-apps-webhook-secret-1",
    });
    expect(await webhooks.receive(sent)).toEqual({ status: "refused" });
    await webhooks.setSettings({ enabled: true, secret });
    expect(await webhooks.receive(sent)).toMatchObject({
      status: "accepted",
      started: ["intake"],
    });
    expect(targets.started.intake).toBe(1);
  });

  it("forgets the oldest body taken once it remembers as many as it may", async () => {
    const { webhooks, targets } = await replayed(2);
    const first = delivery("issues", labelled(1));
    const second = delivery("issues", labelled(2));
    const third = delivery("issues", labelled(3));
    for (const sent of [first, second, third]) {
      await webhooks.receive(sent);
    }
    expect(await webhooks.receive(third)).toEqual({ status: "repeated" });
    expect(await webhooks.receive(second)).toEqual({ status: "repeated" });
    expect(await webhooks.receive(first)).toMatchObject({
      status: "accepted",
    });
    expect(targets.started.intake).toBe(4);
  });
});

describe("GitHub webhooks, settings kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () =>
      run(
        await setUp(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
        ),
      ),
    );
  }
});

describe("GitHub webhooks, settings kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) =>
      run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }
});

describe("what each delivery starts", () => {
  it.each([
    ["issues", "opened", ["intake"]],
    ["issues", "reopened", ["intake"]],
    ["issues", "labeled", ["intake"]],
    ["issues", "edited", ["intake"]],
    ["issues", "transferred", ["intake"]],
    ["issues", "closed", ["batches"]],
    ["issues", "unlabeled", []],
    ["issues", "assigned", []],
    ["pull_request", "opened", ["ci"]],
    ["pull_request", "synchronize", ["ci"]],
    ["pull_request", "closed", ["batches"]],
    ["check_run", "completed", ["ci"]],
    ["check_suite", "completed", ["ci"]],
    // The App has no Commit statuses permission; the gate reads check runs.
    ["status", undefined, []],
    ["ping", undefined, []],
    ["push", undefined, []],
  ])("%s %s starts %j", (event, action, started) => {
    expect(
      webhookActions(event, action === undefined ? {} : { action }),
    ).toEqual(started);
  });

  it("checks the pipeline labels again only when one of them is deleted or renamed", () => {
    expect(
      webhookActions("label", { action: "deleted", label: "needs-work" }),
    ).toEqual(["labels", "intake"]);
    // A work Role's label is AI Office's too.
    expect(
      webhookActions("label", { action: "deleted", label: "role:copywriter" }),
    ).toEqual(["labels", "intake"]);
    expect(
      webhookActions("label", { action: "edited", label: "AI-Office" }),
    ).toEqual(["labels", "intake"]);
    expect(
      webhookActions("label", { action: "created", label: "needs-work" }),
    ).toEqual([]);
    expect(
      webhookActions("label", { action: "deleted", label: "bug" }),
    ).toEqual([]);
  });
});

describe("a labelled-issue webhook, with intake running", () => {
  let intake: Intake | undefined;

  afterEach(async () => {
    await intake?.stop();
    intake = undefined;
  });

  it("picks the issue up at once, without waiting for the next poll", async () => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const { github } = await setUp(stores, bus);
    const queue = memoryIntakeQueue();
    const queued: QueuedWork[] = queue.items;
    let polls = 0;
    intake = createIntake({
      floors: stores.floors,
      github,
      pipeline: createPipeline({ github, events: bus }),
      queue,
      events: bus,
      // An hour between polls: only the webhook can be what picks it up.
      settings: () => {
        polls += 1;
        return Promise.resolve({
          ...defaultIntakeSettings,
          intervalSeconds: 3600,
        });
      },
    });
    const webhooks = createGitHubWebhooks({
      store: stores.office,
      floors: stores.floors,
      encryptor,
      events: bus,
      targets: { intake },
    });
    await webhooks.setSettings({ enabled: true, secret });

    intake.start();
    // The first round, at start, finds nothing.
    await expect.poll(() => polls).toBeGreaterThanOrEqual(2);
    expect(queued).toEqual([]);

    // The Owner labels an issue ai-office on GitHub, which tells AI Office.
    const issue = github.createIssue(webShop, { title: "Add a basket" });
    github.setLabel(webShop, issue.number, "ai-office");
    expect(
      await webhooks.receive(delivery("issues", labelled(issue.number))),
    ).toMatchObject({ status: "accepted", started: ["intake"] });

    await expect
      .poll(() => queued)
      .toEqual([
        { floorId: "web-shop", issue: issue.number, stage: "needs-work" },
      ]);
    expect(
      (await github.repository(webShop).getIssue(issue.number)).labels,
    ).toContain("needs-work");
  });

  it("is refused, and picks nothing up, when its signature is wrong", async () => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const { github } = await setUp(stores, bus);
    const queue = memoryIntakeQueue();
    let triggered = 0;
    const webhooks = createGitHubWebhooks({
      store: stores.office,
      floors: stores.floors,
      encryptor,
      events: bus,
      targets: {
        intake: {
          trigger: () => {
            triggered += 1;
            return Promise.resolve();
          },
          recheckLabels: () => undefined,
        },
      },
    });
    await webhooks.setSettings({ enabled: true, secret });
    const issue = github.createIssue(webShop, {
      title: "Add a basket",
      labels: ["ai-office"],
    });

    const forged = delivery(
      "issues",
      labelled(issue.number),
      "not-the-app-webhook-secret-at-all",
    );
    expect(await webhooks.receive(forged)).toEqual({ status: "refused" });
    expect(triggered).toBe(0);
    expect(queue.items).toEqual([]);
  });
});
