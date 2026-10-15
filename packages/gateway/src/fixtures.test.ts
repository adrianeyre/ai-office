import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { directoryFixtureRecorder, readFixture } from "./fixtures.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  accountKey,
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";

const stream =
  'event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n\n';

let directory: string;
let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gateway-fixtures-"));
});

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  await rm(directory, { recursive: true, force: true });
});

const recorded = async () => {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map((name) => readFixture(join(directory, name))));
};

describe("recorder mode", () => {
  it("saves each request/response pair as a fixture, without the account's key", async () => {
    upstream = await startFakeUpstream((request, response) => {
      if (request.body.includes('"stream":true')) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "request-id": "req_streamed",
          // Must not end up in a fixture either.
          "set-cookie": "upstream-session=xyz",
        });
        response.end(stream);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 4 }));
      }
    });
    gateway = await startGateway({
      upstream,
      fixtureRecorder: directoryFixtureRecorder(directory, {
        secrets: [accountKey],
      }),
    });

    const streamedBody = JSON.stringify({
      model: "claude-haiku-5-5",
      stream: true,
      // A prompt that happens to hold the key is redacted too.
      messages: [{ role: "user", content: `My key is ${accountKey}` }],
    });
    await (
      await fetch(`${gateway.url}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": gatewayKey,
        },
        body: streamedBody,
      })
    ).text();
    await vi.waitFor(async () => {
      expect(await readdir(directory)).toHaveLength(1);
    });
    await (
      await fetch(`${gateway.url}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${gatewayKey}`,
        },
        body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
      })
    ).text();
    await vi.waitFor(async () => {
      expect(await readdir(directory)).toHaveLength(2);
    });

    const files = (await readdir(directory)).sort();
    expect(files[0]).toMatch(/-0001-messages-200\.json$/);
    expect(files[1]).toMatch(/-0002-count-tokens-200\.json$/);
    const [streamed, counted] = await recorded();
    expect(streamed).toEqual({
      request: {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: expect.objectContaining({
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        }) as unknown,
        body: streamedBody.replace(accountKey, "[REDACTED]"),
      },
      response: {
        status: 200,
        headers: expect.objectContaining({
          "content-type": "text/event-stream",
          "request-id": "req_streamed",
        }) as unknown,
        body: stream,
      },
    });
    expect(streamed?.request.headers).not.toHaveProperty("x-api-key");
    expect(streamed?.response.headers).not.toHaveProperty("set-cookie");
    expect(counted?.response.body).toBe('{"input_tokens":4}');

    const raw = await Promise.all(
      files.map((name) => readFile(join(directory, name), "utf8")),
    );
    for (const text of raw) {
      expect(text).not.toContain(accountKey);
      expect(text).not.toContain("the-callers-key");
      expect(text).not.toContain("upstream-session");
    }
  });

  it("writes fixtures that replay through the Gateway unchanged", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(stream);
    });
    gateway = await startGateway({
      upstream,
      fixtureRecorder: directoryFixtureRecorder(directory, { secrets: [] }),
    });
    const body = JSON.stringify({ model: "claude-haiku-5-5", stream: true });
    await (
      await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": gatewayKey,
        },
        body,
      })
    ).text();
    await vi.waitFor(async () => {
      expect(await readdir(directory)).toHaveLength(1);
    });
    const [fixture] = await recorded();
    if (fixture === undefined) {
      throw new Error("expected a fixture");
    }
    await gateway.close();
    await upstream.close();

    // Replay it, the way the contract tests do.
    upstream = await startFakeUpstream(replay(fixture));
    const requestLog = memoryRequestLog();
    gateway = await startGateway({ upstream, requestLog });
    const response = await fetch(`${gateway.url}${fixture.request.path}`, {
      method: fixture.request.method,
      headers: { ...fixture.request.headers, "x-api-key": gatewayKey },
      body: fixture.request.body,
    });
    expect(await response.text()).toBe(stream);
    expect(upstream.received[0]?.body).toBe(body);
    await vi.waitFor(() => {
      expect(requestLog.records).toHaveLength(1);
    });
    expect(requestLog.records[0]).toMatchObject({
      inputTokens: 11,
      outputTokens: 6,
    });
  });

  it("names a cloud platform's exchange after its endpoint too", async () => {
    const recorder = directoryFixtureRecorder(directory, { secrets: [] });
    const exchange = (path: string) => ({
      request: { method: "POST", path, headers: {}, body: "{}" },
      response: { status: 200, headers: {}, body: "{}" },
    });
    const models =
      "/v1/projects/p/locations/global/publishers/anthropic/models";
    await recorder.save(exchange(`${models}/count-tokens:rawPredict`));
    await recorder.save(exchange(`${models}/claude-opus-5-5:rawPredict`));
    await recorder.save(exchange("/anthropic/v1/messages"));
    const files = (await readdir(directory)).sort();
    expect(files[0]).toMatch(/-0001-count-tokens-200\.json$/);
    expect(files[1]).toMatch(/-0002-messages-200\.json$/);
    expect(files[2]).toMatch(/-0003-messages-200\.json$/);
  });

  it("records nothing when it is off", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    gateway = await startGateway({ upstream });
    await (
      await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: "{}" })
    ).text();
    expect(await readdir(directory)).toEqual([]);
  });
});
