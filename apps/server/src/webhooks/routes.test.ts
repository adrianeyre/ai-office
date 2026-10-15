import { createEventBus, memoryEventStore } from "@ai-office/events";
import { signWebhook } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createFloors,
  createIntake,
  createPipeline,
  memoryIntakeQueue,
  memoryStores,
  type Intake,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  defaultIntakeSettings,
  webhookSettingsSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The GitHub App's webhooks through the API (PRD FR-8): the Owner turns
// them on with the secret in the office admin; GitHub's deliveries need no
// session, but one whose signature does not match is refused, and a
// labelled issue's delivery has intake take the issue in at once.

const webShop = "adrianeyre/web-shop";
const secret = "the-app-webhook-secret-0123456789";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly github: ReturnType<typeof createFakeGitHub>;
  readonly intake: Intake;
  readonly queued: ReturnType<typeof memoryIntakeQueue>["items"];
  /** Rounds intake has finished, the first at start. */
  readonly rounds: () => number;
}

let current: Setup | undefined;

afterEach(async () => {
  await current?.intake.stop();
  await current?.server.close();
  current = undefined;
});

async function setUp(): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  const stores = memoryStores();
  const bus = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events: bus }).add(
    webShop,
  );
  const queue = memoryIntakeQueue();
  let rounds = 0;
  const intake = createIntake({
    floors: stores.floors,
    github,
    pipeline: createPipeline({ github, events: bus }),
    queue,
    events: bus,
    // An hour between polls: only a webhook takes an issue in sooner.
    settings: () =>
      Promise.resolve({ ...defaultIntakeSettings, intervalSeconds: 3600 }),
    onReport: () => undefined,
  });
  const counted: Intake = {
    ...intake,
    trigger: async () => {
      await intake.trigger();
      rounds += 1;
    },
  };
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    webhookTargets: { intake: counted },
  });
  current = {
    server,
    owner: await signIn(server),
    github,
    intake,
    queued: queue.items,
    rounds: () => rounds,
  };
  return current;
}

const settings = (
  { server, owner }: Setup,
  method: "GET" | "PUT",
  payload?: object,
) =>
  server.inject({
    method,
    url: "/api/office/webhooks",
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

/**
 * A delivery as GitHub sends it, with no session; signed with `key`, or
 * not at all with null.
 */
const deliver = (
  { server }: Setup,
  event: string,
  payload: object,
  key: string | null = secret,
) => {
  const body = JSON.stringify(payload);
  return server.inject({
    method: "POST",
    url: "/api/github/webhooks",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      ...(key === null
        ? {}
        : { "x-hub-signature-256": signWebhook(key, body) }),
    },
    payload: body,
  });
};

const labelled = (issue: number) => ({
  action: "labeled",
  issue: { number: issue },
  label: { name: "ai-office" },
  repository: { full_name: webShop },
  sender: { login: "adrianeyre" },
});

describe("GitHub webhook settings", () => {
  it("are off until the Owner turns them on with a secret, which is never sent back", async () => {
    const setup = await setUp();
    const before = await settings(setup, "GET");
    expect(webhookSettingsSchema.parse(before.json())).toEqual({
      enabled: false,
      secretSet: false,
    });

    const noSecret = await settings(setup, "PUT", { enabled: true });
    expect(noSecret.statusCode).toBe(400);
    expect(apiErrorSchema.parse(noSecret.json()).error).toBe(
      "webhook_secret_required",
    );
    const short = await settings(setup, "PUT", {
      enabled: true,
      secret: "too-short",
    });
    expect(short.statusCode).toBe(400);

    const on = await settings(setup, "PUT", { enabled: true, secret });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ enabled: true, secretSet: true });
    const after = await settings(setup, "GET");
    expect(after.json()).toEqual({ enabled: true, secretSet: true });
    expect(after.body).not.toContain(secret);
  });

  it("need a session", async () => {
    const setup = await setUp();
    const response = await setup.server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      payload: { enabled: true, secret },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GitHub webhook deliveries", () => {
  it("are a 404 while webhooks are off", async () => {
    const setup = await setUp();
    const response = await deliver(setup, "issues", labelled(1));
    expect(response.statusCode).toBe(404);
  });

  it("refuse a delivery with no signature, or a wrong one, starting nothing", async () => {
    const setup = await setUp();
    await settings(setup, "PUT", { enabled: true, secret });
    setup.intake.start();
    const issue = setup.github.createIssue(webShop, {
      title: "Add a basket",
      labels: ["ai-office"],
    });

    for (const key of [null, "a-forged-secret-of-some-length"]) {
      const response = await deliver(
        setup,
        "issues",
        labelled(issue.number),
        key,
      );
      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error).toBe("unauthorized");
    }
    // A body changed after it was signed.
    const signed = JSON.stringify(labelled(issue.number));
    const tampered = await setup.server.inject({
      method: "POST",
      url: "/api/github/webhooks",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signWebhook(secret, signed),
      },
      payload: JSON.stringify({ ...labelled(issue.number), action: "opened" }),
    });
    expect(tampered.statusCode).toBe(401);
    expect(setup.rounds()).toBe(0);
  });

  it("take a labelled issue in at once, without waiting for the next poll", async () => {
    const setup = await setUp();
    await settings(setup, "PUT", { enabled: true, secret });
    setup.intake.start();
    // The poll at start found nothing to take in.
    await setup.intake.trigger();
    expect(setup.queued).toEqual([]);

    const issue = setup.github.createIssue(webShop, { title: "Add a basket" });
    setup.github.setLabel(webShop, issue.number, "ai-office");
    const response = await deliver(setup, "issues", labelled(issue.number));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ started: ["intake"] });

    await expect.poll(() => setup.rounds()).toBe(1);
    expect(setup.queued).toEqual([
      { floorId: "web-shop", issue: issue.number, stage: "needs-work" },
    ]);
    expect(
      (await setup.github.repository(webShop).getIssue(issue.number)).labels,
    ).toEqual(["ai-office", "needs-work"]);
  });

  it("take GitHub's ping, and ignore deliveries about other repositories", async () => {
    const setup = await setUp();
    await settings(setup, "PUT", { enabled: true, secret });
    const ping = await deliver(setup, "ping", {
      zen: "Design for failure.",
      hook_id: 1,
    });
    expect(ping.statusCode).toBe(202);
    expect(ping.json()).toEqual({ started: [] });
    const elsewhere = await deliver(setup, "issues", {
      ...labelled(1),
      repository: { full_name: "someone/else" },
    });
    expect(elsewhere.statusCode).toBe(202);
    expect(elsewhere.json()).toEqual({ started: [] });
    expect(setup.rounds()).toBe(0);
  });
});
