import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ModelCallError } from "../models/client.ts";
import { gatewayDecisionModelClient } from "./client.ts";

// The Decision Model's calls (PRD FR-17, FR-42; ADR 0001): Jev's typed
// questions to the AI Gateway's `/v1/systemone`, with the asking Agent's
// own Gateway Key, attributed to its issue and pull request, against a
// stand-in Gateway answering as OpenRouter's Jev does.

const key = "aio_gk_managerskeyforthegateway0000000000000";

interface Received {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function gateway(
  status: number,
  answer: unknown,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(answer));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  close = () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/`, received };
}

const request = {
  agentId: "margo",
  model: "typesafe/jev-1.13",
  state: { issue: "#4 Add a basket", body: "Shoppers can buy things." },
  questions: {
    clear: {
      type: "noul",
      instructions: "The issue is clear enough to work.",
      criteria: { true: "It is.", false: "It is not." },
    },
    priority: {
      type: "choice",
      instructions: "How soon to work it.",
      criteria: { high: "Soon.", normal: "Whenever.", low: "Later." },
    },
  },
  issue: 4,
  pullRequest: 14,
} as const;

/** OpenRouter's answer to `request`, as its Jev tutorial shows one. */
const answered = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    clear: { type: "noul", noul: 0.94 },
    priority: {
      type: "choice",
      choice: "normal",
      confidence: 0.71,
      probabilities: { high: 0.12, normal: 0.81, low: 0.07 },
    },
  },
  usage: { input_tokens: 412, output_tokens: 38, cost: 0.0000173 },
};

describe("gatewayDecisionModelClient", () => {
  it("asks the Gateway's /v1/systemone with the Agent's Gateway Key, attributed to its issue and pull request", async () => {
    const stand = await gateway(200, answered);
    const asked: string[] = [];
    const client = gatewayDecisionModelClient({
      url: stand.url,
      key: (agentId) => {
        asked.push(agentId);
        return Promise.resolve(key);
      },
    });
    expect(await client.decide(request)).toEqual({
      clear: { type: "noul", noul: 0.94 },
      priority: { type: "choice", choice: "normal", confidence: 0.71 },
    });
    expect(asked).toEqual(["margo"]);
    const [received] = stand.received;
    expect(received?.url).toBe("/v1/systemone");
    expect(received?.headers.authorization).toBe(`Bearer ${key}`);
    expect(received?.headers["x-ai-office-issue"]).toBe("4");
    expect(received?.headers["x-ai-office-pull-request"]).toBe("14");
    expect(received?.body).toEqual({
      model: "typesafe/jev-1.13",
      state: request.state,
      questions: request.questions,
    });
  });

  it("G1-1: sends the token of the work it opened for the question, and closes it once the Gateway answers", async () => {
    const stand = await gateway(200, answered);
    const opened: { agentId: string; work: unknown; closed: boolean }[] = [];
    const client = gatewayDecisionModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
      work: (agentId, work) => {
        const entry = { agentId, work, closed: false };
        opened.push(entry);
        return {
          token: "work-1",
          close: () => {
            entry.closed = true;
          },
        };
      },
    });
    await client.decide(request);
    expect(opened).toEqual([
      { agentId: "margo", work: { issue: 4, pullRequest: 14 }, closed: true },
    ]);
    expect(stand.received[0]?.headers["x-ai-office-work"]).toBe("work-1");
  });

  it("refuses an answer that is not of the question's type, or not one of its options", async () => {
    for (const answers of [
      { ...answered.answers, clear: { type: "choice", choice: "yes" } },
      {
        ...answered.answers,
        priority: { type: "choice", choice: "urgent", confidence: 0.9 },
      },
      { clear: answered.answers.clear },
      { ...answered.answers, clear: { type: "noul", noul: 1.5 } },
    ]) {
      const stand = await gateway(200, { ...answered, answers });
      const client = gatewayDecisionModelClient({
        url: stand.url,
        key: () => Promise.resolve(key),
      });
      await expect(client.decide(request)).rejects.toBeInstanceOf(
        ModelCallError,
      );
      await close?.();
      close = undefined;
    }
  });

  it("throws the Gateway's refusal with its status", async () => {
    const stand = await gateway(403, {
      error: {
        type: "permission_error",
        message: "The daily Token Cap is reached.",
      },
    });
    const client = gatewayDecisionModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    const error = await client
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      status: 403,
      message: "The AI Gateway answered 403: The daily Token Cap is reached.",
    });
  });

  it("asks nothing for an Agent without a Gateway Key", async () => {
    const stand = await gateway(200, answered);
    const client = gatewayDecisionModelClient({
      url: stand.url,
      key: () => Promise.resolve(undefined),
    });
    await expect(client.decide(request)).rejects.toThrow(
      "The Agent margo has no Gateway Key.",
    );
    expect(stand.received).toEqual([]);
  });
});
