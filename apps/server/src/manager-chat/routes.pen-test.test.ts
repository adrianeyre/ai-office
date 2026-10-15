import { createFakeGitHub } from "@ai-office/github/testing";
import { memoryStores } from "@ai-office/orchestrator";
import { chatAttachmentSchema } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// P2 (issue #205), H18. The Manager chat takes files and images and serves
// them back (`GET …/attachments/:id`). These probes drive the real Fastify
// app and confirm the serving side holds against stored XSS and cross-Floor
// access:
//
// - An allowed text type (XML, plain) carrying HTML/script is served as a
//   download, never as a page: `Content-Disposition: attachment`, `nosniff`,
//   a `default-src 'none'; … sandbox` CSP and `same-origin` CORP.
// - An attachment of one Floor cannot be fetched through another Floor's
//   URL, even by the Owner.
//
// It also pins a documentation gap (FR-24 "each checked to be what it
// says"): a text attachment's bytes are checked only to be UTF-8, not to be
// the declared type, which is safe only because of the serving headers.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/P2.md.

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
}

async function setUp(): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const server = await buildApp({
    logger: createLogger({
      level: "warn",
      secrets: [],
      destination: { write: () => undefined },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    stores: memoryStores(),
    github,
    models: {
      complete: () => Promise.reject(new Error("no model")),
      stream: () => Promise.reject(new Error("no model")),
    },
  });
  servers.push(server);
  const owner = await signIn(server);
  for (const repository of ["adrianeyre/web-shop", "adrianeyre/blog"]) {
    const added = await server.inject({
      method: "POST",
      url: "/api/floors",
      headers: owner.headers,
      payload: { repository },
    });
    if (added.statusCode !== 409) {
      expect(added.statusCode).toBe(201);
    }
  }
  return { server, owner };
}

const upload = (
  { server, owner }: Setup,
  floorId: string,
  payload: Record<string, unknown>,
) =>
  server.inject({
    method: "POST",
    url: `/api/floors/${floorId}/manager-chat/attachments`,
    headers: owner.headers,
    payload,
  });

describe("P2: attachment serving holds against stored XSS", () => {
  it("serves an XML attachment holding script markup as an inert download", async () => {
    const setup = await setUp();
    const html = "<html><script>alert(document.cookie)</script></html>";
    const put = await upload(setup, "web-shop", {
      name: "report.xml",
      mediaType: "application/xml",
      content: Buffer.from(html).toString("base64"),
    });
    expect(put.statusCode).toBe(201);
    const stored = chatAttachmentSchema.parse(put.json());
    const served = await setup.server.inject({
      url: `/api/floors/web-shop/manager-chat/attachments/${stored.id}`,
      headers: setup.owner.headers,
    });
    expect(served.statusCode).toBe(200);
    // A download, never rendered as a page; a browser will not execute it.
    expect(served.headers["content-disposition"]).toContain("attachment;");
    expect(served.headers["content-type"]).toBe(
      "application/xml; charset=utf-8",
    );
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-security-policy"]).toContain("sandbox");
    expect(served.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("pins the FR-24 gap: a text attachment's bytes are not checked to be its declared type", async () => {
    const setup = await setUp();
    // Declared application/json, but the bytes are HTML. Accepted: only
    // UTF-8-ness is checked for text. Safe only because of the headers above.
    const put = await upload(setup, "web-shop", {
      name: "data.json",
      mediaType: "application/json",
      content: Buffer.from("<not-json>").toString("base64"),
    });
    expect(put.statusCode).toBe(201);
  });
});

describe("P2: attachments are isolated to their Floor", () => {
  it("cannot be fetched through another Floor's URL", async () => {
    const setup = await setUp();
    const put = await upload(setup, "web-shop", {
      name: "secret.txt",
      mediaType: "text/plain",
      content: Buffer.from("floor A only").toString("base64"),
    });
    expect(put.statusCode).toBe(201);
    const stored = chatAttachmentSchema.parse(put.json());
    // The same id, asked for through the other Floor the Owner also owns.
    const crossFloor = await setup.server.inject({
      url: `/api/floors/blog/manager-chat/attachments/${stored.id}`,
      headers: setup.owner.headers,
    });
    expect(crossFloor.statusCode).toBe(404);
    // Its own Floor still serves it.
    const sameFloor = await setup.server.inject({
      url: `/api/floors/web-shop/manager-chat/attachments/${stored.id}`,
      headers: setup.owner.headers,
    });
    expect(sameFloor.statusCode).toBe(200);
  });
});
