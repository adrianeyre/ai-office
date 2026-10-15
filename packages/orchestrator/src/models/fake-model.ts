import type { ModelClient, ModelReply, ModelRequest } from "./client.ts";

// A fake model for tests: each Agent's answers are scripted in order, and
// every request is recorded as it was made. Streamed, an answer comes a
// word at a time.

export interface FakeModel extends ModelClient {
  /** Every request, as it was when it was made. */
  readonly requests: ModelRequest[];
  /** Queues an Agent's next answers: a text, or an error to throw. */
  answer(agentId: string, ...answers: (string | Error)[]): void;
  /** The requests one Agent made. */
  requestsOf(agentId: string): ModelRequest[];
}

export function createFakeModel(
  options: {
    /** The answer to any request no script is left for; none if absent. */
    readonly otherwise?: string;
  } = {},
): FakeModel {
  const requests: ModelRequest[] = [];
  const scripts = new Map<string, (string | Error)[]>();
  return {
    requests,
    answer(agentId, ...answers) {
      scripts.set(agentId, [...(scripts.get(agentId) ?? []), ...answers]);
    },
    requestsOf: (agentId) =>
      requests.filter((request) => request.agentId === agentId),
    complete(request): Promise<ModelReply> {
      requests.push({
        ...request,
        messages: request.messages.map((message) => ({ ...message })),
      });
      const next = scripts.get(request.agentId)?.shift() ?? options.otherwise;
      if (next === undefined) {
        return Promise.reject(
          new Error(`The fake model has no answer for ${request.agentId}.`),
        );
      }
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve({ text: next, stopReason: "end_turn" });
    },
    async stream(request, { onText }) {
      const reply = await this.complete(request);
      for (const word of reply.text.match(/\S+\s*|\s+/g) ?? []) {
        onText(word);
      }
      return reply;
    },
  };
}
