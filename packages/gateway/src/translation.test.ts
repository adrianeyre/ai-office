// Contract tests for the OpenAI endpoints and format translation (PRD
// FR-34, §9): every fixture in `fixtures/translation/` is replayed through
// the Gateway against a fake AI Provider that gives the fixture's response.
// The request must reach the AI Provider as the fixture says (translated,
// or unchanged), the caller must get the fixture's answer (whole or
// streamed), and the request must be recorded with its usage.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiFormat } from "./gateway.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  accountKey,
  gatewayKey,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { readSse } from "./translate/sse.ts";

interface TranslationFixture {
  readonly description: string;
  /** The API the AI Account speaks. */
  readonly account: ApiFormat;
  readonly request: {
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body: unknown;
  };
  readonly upstream: {
    /** What the AI Provider must receive. */
    readonly request: { readonly path: string; readonly body: unknown };
    /** What it answers, as the exact text that crossed the wire. */
    readonly response: {
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
    };
  };
  /** What the caller must get: a JSON body, events, or the AI Provider's own bytes. */
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body?: unknown;
    readonly events?: { event: string | null; data: unknown }[];
    readonly raw?: true;
  };
  /** How the request must be recorded. */
  readonly record: Record<string, unknown>;
}

const folder = fileURLToPath(
  new URL("../fixtures/translation/", import.meta.url),
);
const names = (await readdir(folder))
  .filter((name) => name.endsWith(".json"))
  .sort();
const read = async (name: string) =>
  JSON.parse(await readFile(`${folder}${name}`, "utf8")) as TranslationFixture;

const now = new Date("2026-10-09T12:00:00.000Z");

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
});

/** Answers with the fixture's response, `chunkSize` bytes at a time. */
const answer =
  (fixture: TranslationFixture, chunkSize: number) =>
  async (
    _request: unknown,
    response: import("node:http").ServerResponse,
  ): Promise<void> => {
    const { status, headers, body } = fixture.upstream.response;
    response.writeHead(status, headers);
    const bytes = Buffer.from(body, "utf8");
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      response.write(bytes.subarray(offset, offset + chunkSize));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  };

describe("the translation fixtures", () => {
  it("cover each direction, with tool calls and streaming", async () => {
    const fixtures = await Promise.all(names.map(read));
    const kinds = new Set(
      fixtures.map(
        (fixture) =>
          `${fixture.request.path} -> ${fixture.upstream.request.path}${
            fixture.response.events === undefined ? "" : " (streamed)"
          }`,
      ),
    );
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining([
        "/v1/chat/completions -> /v1/messages",
        "/v1/chat/completions -> /v1/messages (streamed)",
        "/v1/responses -> /v1/messages",
        "/v1/responses -> /v1/messages (streamed)",
        "/v1/responses/compact -> /v1/messages",
        "/v1/messages -> /v1/chat/completions",
        "/v1/messages -> /v1/chat/completions (streamed)",
        "/v1/chat/completions -> /v1/chat/completions",
        "/v1/responses -> /v1/responses",
      ]),
    );
    const sent = JSON.stringify(fixtures.map(({ upstream }) => upstream));
    expect(sent).toContain('"type":"tool_use"');
    expect(sent).toContain("tool_calls");
  });

  describe.each(names)("%s", (name) => {
    it.each([1, 7, 1_000_000])(
      "is translated both ways and recorded (%i-byte chunks)",
      async (chunkSize) => {
        const fixture = await read(name);
        upstream = await startFakeUpstream(answer(fixture, chunkSize));
        const requestLog = memoryRequestLog();
        gateway = await startGateway({
          upstream,
          requestLog,
          apiFormat: fixture.account,
          now: () => now,
        });
        const sentBody = JSON.stringify(fixture.request.body);

        const response = await fetch(`${gateway.url}${fixture.request.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${gatewayKey}`,
            ...fixture.request.headers,
          },
          body: sentBody,
        });
        const text = await response.text();

        // What reached the AI Provider.
        expect(upstream.received).toHaveLength(1);
        const [received] = upstream.received;
        expect(received?.url).toBe(fixture.upstream.request.path);
        expect(JSON.parse(received?.body ?? "null")).toEqual(
          fixture.upstream.request.body,
        );
        if (fixture.request.path === fixture.upstream.request.path) {
          // Passed through: the very bytes the caller sent.
          expect(received?.body).toBe(sentBody);
        }
        if (fixture.account === "anthropic") {
          expect(received?.headers["x-api-key"]).toBe(accountKey);
          expect(received?.headers["anthropic-version"]).toBe("2023-06-01");
          expect(received?.headers.authorization).toBeUndefined();
        } else {
          expect(received?.headers.authorization).toBe(`Bearer ${accountKey}`);
          expect(received?.headers["x-api-key"]).toBeUndefined();
        }
        expect(JSON.stringify(received)).not.toContain(gatewayKey);

        // What the caller got.
        expect(response.status).toBe(fixture.response.status);
        for (const [header, value] of Object.entries(
          fixture.response.headers,
        )) {
          expect(response.headers.get(header), header).toBe(value);
        }
        if (fixture.response.raw === true) {
          expect(text).toBe(fixture.upstream.response.body);
        } else if (fixture.response.events !== undefined) {
          expect(
            readSse(text).map(({ event, data }) => ({
              event: event ?? null,
              data: data === "[DONE]" ? data : (JSON.parse(data) as unknown),
            })),
          ).toEqual(fixture.response.events);
        } else {
          expect(JSON.parse(text)).toEqual(fixture.response.body);
        }

        // How it was recorded.
        await vi.waitFor(() => {
          expect(requestLog.records).toHaveLength(1);
        });
        expect(requestLog.records[0]).toMatchObject({
          ...fixture.record,
          account: "test-account",
          ownerTool: "test-tool",
        });
      },
    );
  });
});
