// PRD §7: the AI Gateway adds less than 10 ms median overhead per request,
// excluding upstream time. Each round times the same request sent straight
// to a local fake AI Provider and through the Gateway in front of it; the
// difference between the medians is what the Gateway adds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFixture } from "./fixtures.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";

const rounds = 300;
const warmUp = 50;
const budgetMs = 10;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

let upstream: FakeUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  const fixtures = new URL("../fixtures/anthropic/", import.meta.url);
  const message = await readFixture(
    new URL("messages.json", fixtures).pathname,
  );
  const streamed = await readFixture(
    new URL("messages-streaming.json", fixtures).pathname,
  );
  upstream = await startFakeUpstream((request, response) =>
    replay(
      request.body.includes('"stream":true') ? streamed : message,
      1_000_000,
    )(request, response),
  );
  gateway = await startGateway({ upstream });
});

afterAll(async () => {
  await gateway.close();
  await upstream.close();
});

describe("the Gateway's added latency", () => {
  it.each([
    ["a non-streamed message", false],
    ["a streamed message", true],
  ])(
    `has a median under ${String(budgetMs)} ms for %s`,
    async (name, stream) => {
      const body = JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 1024,
        stream,
        messages: [{ role: "user", content: "x".repeat(20_000) }],
      });
      const time = async (base: string): Promise<number> => {
        const start = performance.now();
        const response = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": gatewayKey,
          },
          body,
        });
        await response.arrayBuffer();
        return performance.now() - start;
      };

      const direct: number[] = [];
      const through: number[] = [];
      for (let round = 0; round < warmUp + rounds; round += 1) {
        // Interleaved, so both sides see the same machine conditions.
        const directMs = await time(upstream.url);
        const throughMs = await time(gateway.url);
        if (round >= warmUp) {
          direct.push(directMs);
          through.push(throughMs);
        }
      }

      const added = median(through) - median(direct);
      console.info(
        `${name}: direct median ${median(direct).toFixed(2)} ms, through the Gateway ${median(through).toFixed(2)} ms, added ${added.toFixed(2)} ms over ${String(rounds)} rounds`,
      );
      expect(added).toBeLessThan(budgetMs);
    },
  );
});
