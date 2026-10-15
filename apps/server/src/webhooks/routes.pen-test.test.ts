import { Writable } from "node:stream";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { signWebhook, type GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  createFloors,
  createIntake,
  createPipeline,
  memoryIntakeQueue,
  memoryStores,
  type Intake,
} from "@ai-office/orchestrator";
import { defaultIntakeSettings } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// Probe W1 (docs/pen-testing/assessments/W1.md): GitHub, or something
// pretending to be it (position 5), against `POST /api/github/webhooks`,
// on the real Fastify app through `inject`, with real intake polling the
// fake GitHub. It needs no session, so everything here is unauthenticated
// but for what the signature proves. Every secret here is a fake.
//
// - Holds: the signature is checked over the bytes as sent, whatever the
//   content type; a missing, malformed or doubled header is refused, and
//   with no secret kept the route is not there. A delivery's payload says
//   only when to look: intake reads GitHub, so a signed delivery that
//   names the Owner, a label or an issue takes nothing in that GitHub does
//   not say should be.
// - W1-1 (H12), fixed: a delivery was acted on every time it was sent.
//   Neither the body nor `X-GitHub-Delivery` was remembered, and the
//   latter is not signed, so a captured delivery could be sent again,
//   under any id, as often as wanted, each time running intake over every
//   Floor. Now each body taken is remembered: the same body again starts
//   nothing, whatever id it carries.
// - W1-4, fixed: nothing limited how many deliveries one caller sent;
//   each forged one was verified and logged as a warning. Now a caller's
//   failures past a bound are refused with 429 before they are verified,
//   and logged once.

const webShop = "adrianeyre/web-shop";
const blog = "adrianeyre/blog";
const owner = "adrianeyre";
const secret = "fake-w1-webhook-secret-0123456789";

interface Setup {
  readonly server: FastifyInstance;
  readonly github: FakeGitHub;
  readonly intake: Intake;
  readonly queued: ReturnType<typeof memoryIntakeQueue>["items"];
  /** Intake rounds a delivery started and that have finished. */
  readonly rounds: () => number;
  /** `listIssues` calls intake made, by repository. */
  readonly listed: Map<string, number>;
  /** Warnings the server logged. */
  readonly warnings: () => number;
  /** How many deliveries reached the receiver: each read the secret. */
  readonly verified: () => number;
}

let current: Setup | undefined;

afterEach(async () => {
  await current?.intake.stop();
  await current?.server.close();
  current = undefined;
});

/** Counts each repository's `listIssues`: what one intake round costs it. */
function counting(github: FakeGitHub, listed: Map<string, number>): GitHubApp {
  return {
    ...github,
    repository(fullName) {
      const client = github.repository(fullName);
      return {
        ...client,
        listIssues: (options) => {
          listed.set(fullName, (listed.get(fullName) ?? 0) + 1);
          return client.listIssues(options);
        },
      };
    },
  };
}

async function setUp(
  options: { readonly webhooks?: "on" | "off" | "unset" } = {},
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  github.installRepository(blog);
  const kept = memoryStores();
  let verified = 0;
  // The receiver reads the secret first, for each delivery it verifies.
  const stores = {
    ...kept,
    office: {
      ...kept.office,
      githubWebhooks: () => {
        verified += 1;
        return kept.office.githubWebhooks();
      },
    },
  };
  const bus = createEventBus({ store: memoryEventStore() });
  const floors = createFloors({ store: stores.floors, github, events: bus });
  await floors.add(webShop);
  await floors.add(blog);
  const queue = memoryIntakeQueue();
  const listed = new Map<string, number>();
  let rounds = 0;
  const intake = createIntake({
    floors: stores.floors,
    github: counting(github, listed),
    pipeline: createPipeline({ github, events: bus }),
    queue,
    events: bus,
    // An hour between polls: only a delivery starts a round sooner.
    settings: () =>
      Promise.resolve({
        ...defaultIntakeSettings,
        ownerLogin: owner,
        intervalSeconds: 3600,
      }),
    onReport: () => undefined,
  });
  const counted: Intake = {
    ...intake,
    trigger: async () => {
      await intake.trigger();
      rounds += 1;
    },
  };
  let warnings = 0;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (
          line !== "" &&
          (JSON.parse(line) as { level: number }).level === 40
        ) {
          warnings += 1;
        }
      }
      done();
    },
  });
  const server = await buildApp({
    logger: createLogger({ level: "warn", secrets: [], destination }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    webhookTargets: { intake: counted },
  });
  const signedIn = await signIn(server);
  const state = options.webhooks ?? "on";
  if (state !== "unset") {
    await server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      headers: signedIn.headers,
      payload: { enabled: true, secret },
    });
  }
  if (state === "off") {
    await server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      headers: signedIn.headers,
      payload: { enabled: false },
    });
  }
  intake.start();
  // The round at start, which no delivery asked for.
  await intake.trigger();
  listed.clear();
  current = {
    server,
    github,
    intake,
    queued: queue.items,
    rounds: () => rounds,
    listed,
    warnings: () => warnings,
    verified: () => verified,
  };
  return current;
}

/**
 * Posts `body` as a delivery, with exactly `headers`, and no session; from
 * 127.0.0.1, or `from`.
 */
const post = (
  { server }: Setup,
  body: string | Buffer,
  headers: Record<string, string | string[]>,
  from?: string,
) =>
  server.inject({
    method: "POST",
    url: "/api/github/webhooks",
    headers: { "x-github-event": "issues", ...headers },
    payload: body,
    ...(from === undefined ? {} : { remoteAddress: from }),
  });

const labelled = (issue: number, repository = webShop) =>
  JSON.stringify({
    action: "labeled",
    issue: { number: issue, user: { login: owner } },
    label: { name: "ai-office" },
    repository: { full_name: repository },
    installation: { id: 1 },
    sender: { login: owner },
  });

/** A delivery as GitHub sends it, signed with the secret. */
const deliver = (
  setup: Setup,
  body: string,
  delivery = "72d3162e-cc78-11e3-81ab-4c9367dc0958",
) =>
  post(setup, body, {
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-hub-signature-256": signWebhook(secret, body),
  });

describe("the signature at the route", () => {
  it("is checked over the bytes as sent, whatever the content type says, or with none", async () => {
    const setup = await setUp();
    const compact = labelled(1);
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/octet-stream",
      undefined,
    ]) {
      const typed = type === undefined ? {} : { "content-type": type };
      const asSigned = await post(setup, pretty, {
        ...typed,
        "x-hub-signature-256": signWebhook(secret, pretty),
      });
      expect(asSigned.statusCode, String(type)).toBe(202);
      // The same JSON, re-serialised: a parser in front would let it pass.
      const reserialised = await post(setup, pretty, {
        ...typed,
        "x-hub-signature-256": signWebhook(secret, compact),
      });
      expect(reserialised.statusCode, String(type)).toBe(401);
    }
  });

  it("refuses a missing, malformed, doubled or wrongly keyed header, starting nothing", async () => {
    const setup = await setUp();
    const body = labelled(1);
    const right = signWebhook(secret, body);
    for (const signature of [
      undefined,
      "",
      "sha256=",
      `sha1=${"0".repeat(40)}`,
      right.slice(0, -1),
      signWebhook("fake-w1-a-guessed-secret-000000", body),
      [right, right],
    ]) {
      const response = await post(setup, body, {
        "content-type": "application/json",
        ...(signature === undefined
          ? {}
          : { "x-hub-signature-256": signature }),
      });
      expect(response.statusCode, JSON.stringify(signature)).toBe(401);
    }
    expect(setup.rounds()).toBe(0);
  });

  it("is not there while no secret is kept, or webhooks are off: even a delivery signed with the empty secret is a 404", async () => {
    for (const webhooks of ["unset", "off"] as const) {
      const setup = await setUp({ webhooks });
      const body = labelled(1);
      for (const key of ["", secret]) {
        const response = await post(setup, body, {
          "content-type": "application/json",
          "x-hub-signature-256": signWebhook(key, body),
        });
        expect(response.statusCode, webhooks).toBe(404);
      }
      expect(setup.rounds()).toBe(0);
      await setup.intake.stop();
      await setup.server.close();
    }
    current = undefined;
  });
});

describe("a delivery's payload says when to look, never what to do", () => {
  it("a signed delivery naming the Owner as sender takes in nothing GitHub does not say is the Owner's", async () => {
    const setup = await setUp();
    // Labelled by someone else; and not labelled at all.
    const stranger = setup.github.createIssue(webShop, {
      title: "Run my script",
      author: "mallory",
    });
    setup.github.setLabel(webShop, stranger.number, "ai-office", {
      actor: "mallory",
    });
    const unlabelled = setup.github.createIssue(webShop, {
      title: "Not asked for",
    });
    for (const issue of [stranger.number, unlabelled.number, 999]) {
      const response = await deliver(setup, labelled(issue));
      expect(response.statusCode).toBe(202);
    }
    await expect.poll(() => setup.rounds()).toBe(3);
    expect(setup.queued).toEqual([]);
  });

  it("a replay after the Owner took the label off takes nothing in", async () => {
    const setup = await setUp();
    const issue = setup.github.createIssue(webShop, { title: "Add a basket" });
    const body = labelled(issue.number);
    setup.github.removeLabel(webShop, issue.number, "ai-office");
    expect((await deliver(setup, body)).statusCode).toBe(202);
    await expect.poll(() => setup.rounds()).toBe(1);
    expect(setup.queued).toEqual([]);
  });

  it("a delivery about a repository that is no Floor starts nothing, whichever installation it names", async () => {
    const setup = await setUp();
    const elsewhere = await deliver(setup, labelled(1, "mallory/web-shop"));
    expect(elsewhere.json()).toEqual({ started: [] });
    expect(setup.rounds()).toBe(0);
  });
});

describe("W1-1: a delivery is acted on every time it is sent (H12)", () => {
  it("a delivery already taken is not acted on again: the same signed body starts nothing, under its own X-GitHub-Delivery or another", async () => {
    const setup = await setUp();
    const body = labelled(1);
    const first = await deliver(setup, body, "delivery-1");
    expect(first.json()).toEqual({ started: ["intake"] });
    await expect.poll(() => setup.rounds()).toBe(1);
    const same = await deliver(setup, body, "delivery-1");
    const renamed = await deliver(setup, body, "delivery-2");
    expect(same.json()).toEqual({ started: [] });
    expect(renamed.json()).toEqual({ started: [] });
  });

  it("regression (W1-1): one captured delivery, sent again under any id or none, no longer starts intake each time: only the first starts a round, and the replays list no Floor's issues", async () => {
    const setup = await setUp();
    const issue = setup.github.createIssue(webShop, {
      title: "Add a basket",
      labels: ["ai-office"],
    });
    const body = labelled(issue.number);
    const replays = 5;
    for (let sent = 0; sent < replays; sent += 1) {
      const response = await post(setup, body, {
        "content-type": "application/json",
        ...(sent === 0
          ? {}
          : { "x-github-delivery": `replay-${String(sent)}` }),
        "x-hub-signature-256": signWebhook(secret, body),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        started: sent === 0 ? ["intake"] : [],
      });
      // Sent one after another, as a replaying client would, each after
      // the first round is done.
      await expect.poll(() => setup.rounds()).toBe(1);
    }
    expect(setup.rounds()).toBe(1);
    // The first delivery's round, and nothing for the replays.
    expect(Object.fromEntries(setup.listed)).toEqual({
      [webShop]: 1,
      [blog]: 1,
    });
    expect(setup.queued).toEqual([
      { floorId: "web-shop", issue: issue.number, stage: "needs-work" },
    ]);
  });

  it("W1-1: the replay of a delivery taken, under another event, starts nothing either: the event is not signed", async () => {
    const setup = await setUp();
    const body = labelled(1);
    expect((await deliver(setup, body)).json()).toEqual({
      started: ["intake"],
    });
    const asLabel = await post(setup, body, {
      "content-type": "application/json",
      "x-github-event": "label",
      "x-hub-signature-256": signWebhook(secret, body),
    });
    expect(asLabel.statusCode).toBe(202);
    expect(asLabel.json()).toEqual({ started: [] });
    await expect.poll(() => setup.rounds()).toBe(1);
  });

  it("W1-1: GitHub's Redeliver of a delivery that was not taken (refused while the secrets differed, or sent while webhooks were off) is taken", async () => {
    const setup = await setUp({ webhooks: "off" });
    const body = labelled(1);
    expect((await deliver(setup, body, "guid-1")).statusCode).toBe(404);
    const signedIn = await signIn(setup.server);
    // Webhooks on, but with a secret that is not the App's.
    await setup.server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      headers: signedIn.headers,
      payload: { enabled: true, secret: "fake-w1-a-mistyped-secret-0000" },
    });
    expect((await deliver(setup, body, "guid-1")).statusCode).toBe(401);
    await setup.server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      headers: signedIn.headers,
      payload: { enabled: true, secret },
    });
    // Redeliver sends the same body under the same GUID.
    const redelivered = await deliver(setup, body, "guid-1");
    expect(redelivered.statusCode).toBe(202);
    expect(redelivered.json()).toEqual({ started: ["intake"] });
    await expect.poll(() => setup.rounds()).toBe(1);
  });
});

describe("W1-4: nothing limits the deliveries one caller sends", () => {
  it("a caller that keeps sending deliveries that fail the signature check is refused with 429 before they are verified", async () => {
    const setup = await setUp();
    const statuses = new Set<number>();
    for (let sent = 0; sent < 200; sent += 1) {
      statuses.add((await post(setup, labelled(1), {})).statusCode);
    }
    expect(statuses).toContain(429);
  });

  it("regression (W1-4): 200 forged deliveries from one caller are no longer each verified, refused with 401 and logged as a warning: past the bound they are refused with 429, unverified and unlogged", async () => {
    const setup = await setUp();
    const before = { warnings: setup.warnings(), verified: setup.verified() };
    const responses = [];
    for (let sent = 0; sent < 200; sent += 1) {
      responses.push(
        await post(setup, labelled(1), {
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        }),
      );
    }
    const statuses = responses.map(({ statusCode }) => statusCode);
    expect(statuses).toEqual([
      ...Array<number>(20).fill(401),
      ...Array<number>(180).fill(429),
    ]);
    expect(Number(responses.at(-1)?.headers["retry-after"])).toBeGreaterThan(0);
    // Twenty verified, and their twenty warnings; then nothing.
    expect(setup.verified() - before.verified).toBe(20);
    expect(setup.warnings() - before.warnings).toBe(20);
    expect(setup.rounds()).toBe(0);
  });

  it("W1-4: GitHub's own deliveries are never refused for it: they come from another address than the forger's", async () => {
    const setup = await setUp();
    const forger = "203.0.113.9";
    const github = "140.82.115.1";
    for (let sent = 0; sent < 30; sent += 1) {
      await post(setup, labelled(1), {}, forger);
    }
    expect((await post(setup, labelled(1), {}, forger)).statusCode).toBe(429);
    const body = labelled(1);
    const taken = await post(
      setup,
      body,
      {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhook(secret, body),
      },
      github,
    );
    expect(taken.statusCode).toBe(202);
    expect(taken.json()).toEqual({ started: ["intake"] });
  });

  it("W1-4: a delivery that verifies forgets its caller's failures; a replayed one does not", async () => {
    const setup = await setUp();
    const forged = () =>
      post(setup, labelled(1), {
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      });
    for (let sent = 0; sent < 19; sent += 1) {
      expect((await forged()).statusCode).toBe(401);
    }
    const body = labelled(1);
    expect((await deliver(setup, body)).statusCode).toBe(202);
    for (let sent = 0; sent < 19; sent += 1) {
      expect((await forged()).statusCode).toBe(401);
    }
    // The same delivery again is a replay: it forgets nothing.
    expect((await deliver(setup, body)).json()).toEqual({ started: [] });
    expect((await forged()).statusCode).toBe(401);
    expect((await forged()).statusCode).toBe(429);
  });

  it("W1-4: setting the secret again forgets every refused caller, so GitHub's deliveries refused while the secrets differed are taken once they match", async () => {
    const setup = await setUp();
    const signedIn = await signIn(setup.server);
    await setup.server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      headers: signedIn.headers,
      payload: { enabled: true, secret: "fake-w1-a-mistyped-secret-0000" },
    });
    // GitHub's deliveries, signed with the App's secret, fail meanwhile.
    for (let issue = 1; issue <= 25; issue += 1) {
      await deliver(setup, labelled(issue));
    }
    expect((await deliver(setup, labelled(26))).statusCode).toBe(429);
    await setup.server.inject({
      method: "PUT",
      url: "/api/office/webhooks",
      headers: signedIn.headers,
      payload: { enabled: true, secret },
    });
    const taken = await deliver(setup, labelled(26));
    expect(taken.statusCode).toBe(202);
    expect(taken.json()).toEqual({ started: ["intake"] });
  });
});
