import { aiOfficeHeaders } from "@ai-office/shared";

import { ModelCallError, type OpenCallWork } from "../models/client.ts";

// The Decision Model's calls (PRD FR-17): Jev's typed questions, asked
// through the AI Gateway (ADR 0001) at Jev's own API (`/v1/systemone`)
// with the Gateway Key of the Agent that asks, so each is attributed to it
// and its issue (FR-42) and counted against its Token Caps (FR-33). Jev
// writes no text: it is given a `state` (what to judge) and named
// questions, and answers each with a probability that a statement is true
// (`noul`) or the option it picks from a set (`choice`), all at once.

/** A question for Jev: a yes or no, or one option of several. */
export type DecisionQuestion =
  | {
      readonly type: "noul";
      /** The statement whose probability is asked. */
      readonly instructions: string;
      /** What makes it true, and false. */
      readonly criteria: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      /** Each option, by name, with what it means. */
      readonly criteria: Readonly<Record<string, string>>;
    };

/** Jev's answer to one question. */
export type DecisionAnswer =
  | {
      readonly type: "noul";
      /** The probability, from 0 to 1, that the statement is true. */
      readonly noul: number;
    }
  | {
      readonly type: "choice";
      /** The option it picked: one of the question's. */
      readonly choice: string;
      /** How sure it is, from 0 to 1. */
      readonly confidence: number;
    };

export interface DecisionModelRequest {
  /** The Agent that asks: its Gateway Key is used. */
  readonly agentId: string;
  /** Jev, as the Gateway is asked for it. */
  readonly model: string;
  /** What is judged. Never holds a credential. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /** What the call is for, as the Gateway records it (FR-42). */
  readonly issue?: number;
  readonly pullRequest?: number;
}

/** Asks Jev. */
export interface DecisionModelClient {
  /**
   * Jev's answer to each question, by name: each checked to be of its
   * question's type, a choice one of its options; anything else throws.
   */
  decide(
    request: DecisionModelRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>>;
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 1;

/** One of Jev's answers, if it is one of the two kinds asked. */
const answerOf = (value: unknown): DecisionAnswer | undefined => {
  const answer = (value ?? {}) as Record<string, unknown>;
  if (answer["type"] === "noul" && isProbability(answer["noul"])) {
    return { type: "noul", noul: answer["noul"] };
  }
  if (
    answer["type"] === "choice" &&
    typeof answer["choice"] === "string" &&
    isProbability(answer["confidence"])
  ) {
    return {
      type: "choice",
      choice: answer["choice"],
      confidence: answer["confidence"],
    };
  }
  return undefined;
};

/** Jev's answer to the questions in `request`, from its response body. */
export function decisionAnswers(
  request: Pick<DecisionModelRequest, "questions">,
  body: unknown,
): Record<string, DecisionAnswer> {
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (typeof answers !== "object" || answers === null) {
    throw new ModelCallError(
      200,
      "The Decision Model's answer had no answers.",
    );
  }
  const checked: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = answerOf((answers as Record<string, unknown>)[name]);
    if (answer?.type !== question.type) {
      throw new ModelCallError(
        200,
        `The Decision Model gave no ${question.type} answer to "${name}".`,
      );
    }
    if (
      answer.type === "choice" &&
      !Object.hasOwn(question.criteria, answer.choice)
    ) {
      throw new ModelCallError(
        200,
        `The Decision Model chose no option of "${name}".`,
      );
    }
    checked[name] = answer;
  }
  return checked;
}

export interface GatewayDecisionModelClientOptions {
  /** The AI Gateway's address, such as `http://127.0.0.1:3047`. */
  readonly url: string;
  /** The Agent's own Gateway Key (a credential: never logged). */
  readonly key: (agentId: string) => Promise<string | undefined>;
  /** Opens each call's work; without it, a call counts against no issue. */
  readonly work?: OpenCallWork;
  readonly fetch?: typeof fetch;
}

/** The Gateway's error message, from an OpenAI-format error. */
const errorMessage = (body: unknown): string | undefined => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : undefined;
};

export function gatewayDecisionModelClient(
  options: GatewayDecisionModelClientOptions,
): DecisionModelClient {
  const call = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/v1/systemone`;
  return {
    async decide(request, signal) {
      const key = await options.key(request.agentId);
      if (key === undefined) {
        throw new ModelCallError(
          0,
          `The Agent ${request.agentId} has no Gateway Key.`,
        );
      }
      const work = options.work?.(request.agentId, {
        ...(request.issue === undefined ? {} : { issue: request.issue }),
        ...(request.pullRequest === undefined
          ? {}
          : { pullRequest: request.pullRequest }),
      });
      let response: Response;
      try {
        response = await call(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            ...(work === undefined
              ? {}
              : { [aiOfficeHeaders.work]: work.token }),
            ...(request.issue === undefined
              ? {}
              : { [aiOfficeHeaders.issue]: String(request.issue) }),
            ...(request.pullRequest === undefined
              ? {}
              : {
                  [aiOfficeHeaders.pullRequest]: String(request.pullRequest),
                }),
          },
          body: JSON.stringify({
            model: request.model,
            state: request.state,
            questions: request.questions,
          }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }
        throw new ModelCallError(
          0,
          `The AI Gateway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        // The Gateway has read it once it answers.
        work?.close();
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new ModelCallError(
          response.status,
          `The AI Gateway answered ${String(response.status)}: ${errorMessage(body) ?? response.statusText}`,
        );
      }
      return decisionAnswers(request, body);
    },
  };
}
