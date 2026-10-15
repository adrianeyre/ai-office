import {
  decisionAnswers,
  type DecisionAnswer,
  type DecisionModelClient,
  type DecisionModelRequest,
} from "./client.ts";

// A fake Decision Model for tests: each Agent's answers are scripted in
// order, checked against the questions as Jev's would be, and every
// request is recorded as it was made.

export interface FakeDecisionModel extends DecisionModelClient {
  /** Every request, in the order they were made. */
  readonly requests: DecisionModelRequest[];
  /** Queues an Agent's next answers: each question's, or an error to throw. */
  answer(
    agentId: string,
    ...answers: (Readonly<Record<string, DecisionAnswer>> | Error)[]
  ): void;
}

export function createFakeDecisionModel(): FakeDecisionModel {
  const requests: DecisionModelRequest[] = [];
  const scripts = new Map<
    string,
    (Readonly<Record<string, DecisionAnswer>> | Error)[]
  >();
  return {
    requests,
    answer(agentId, ...answers) {
      scripts.set(agentId, [...(scripts.get(agentId) ?? []), ...answers]);
    },
    decide(request) {
      requests.push(structuredClone(request));
      const next = scripts.get(request.agentId)?.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `The fake Decision Model has no answer for ${request.agentId}.`,
          ),
        );
      }
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      // Checked as Jev's answers are: a mismatch rejects.
      return Promise.resolve().then(() =>
        decisionAnswers(request, { answers: next }),
      );
    },
  };
}

/** A yes-or-no answer: the probability its statement is true. */
export const noul = (probability: number): DecisionAnswer => ({
  type: "noul",
  noul: probability,
});

/** A choice answer, sure as given. */
export const choice = (option: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: option,
  confidence,
});
