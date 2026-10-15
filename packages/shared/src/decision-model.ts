import { z } from "zod";

import { modelNameSchema } from "./pricing.ts";

// The Decision Model (PRD FR-17, FR-89): Jev, TypeSafe's fast decision
// model, which the Owner may turn on in the office admin. It writes no
// text: it answers typed questions about what it is given (a yes-or-no
// probability, one of a set of options, or a place on a scale), in well
// under a second, at a fraction of a chat model's price. When it is on, the
// Managers and AI Office's safety checks ask it for their quick
// judgements: whether an issue is clear enough to work, whether a Review
// Loop is stalled or repeating, and whether an Agent's tool call is safe.
// When it is off, as it is until the Owner turns it on, those judgements
// are the Manager's Model's or AI Office's own rules, as before. It is
// reached through the AI Gateway (ADR 0001) at Jev's own API
// (`/v1/systemone`), which OpenRouter serves: its Model is named as
// OpenRouter names it. It is never an Agent's AI Provider or Model. The
// server and the web app share these.

/** The Decision Model's Model until the Owner chooses another. */
export const defaultDecisionModel = "typesafe/jev-1.13";

/**
 * Whether `model` names Jev, as OpenRouter does: a release
 * (`typesafe/jev-1.13`), or the alias for the newest (`~typesafe/jev-latest`);
 * not `typesafe/jev-router`, a chat model that routes to other Models.
 */
export const isDecisionModel = (model: string): boolean =>
  /^~?typesafe\/jev-(?!router$)[a-z0-9][\w.-]*$/i.test(model.trim());

/** `GET` and `PUT /api/office/decision-model`. */
export const decisionModelSettingsSchema = z.strictObject({
  /** Whether the Managers and safety checks ask it. */
  enabled: z.boolean({ error: "Say whether the Decision Model is on." }),
  /** Jev, as OpenRouter names it. */
  model: z
    .string({ error: "Name Jev's Model." })
    .trim()
    .refine(isDecisionModel, {
      error:
        "The Decision Model is Jev: name it as OpenRouter does, such as typesafe/jev-1.13 or ~typesafe/jev-latest.",
    }),
  /**
   * Whether it writes Fresh Start and Manager chat compaction summaries
   * (FR-89), while it is on; otherwise each Agent's own Model does.
   */
  summaries: z.boolean({
    error: "Say whether the Decision Model writes summaries.",
  }),
});
export type DecisionModelSettings = z.infer<typeof decisionModelSettingsSchema>;

/** Until the Owner chooses: off, and not writing summaries. */
export const defaultDecisionModelSettings: DecisionModelSettings = {
  enabled: false,
  model: defaultDecisionModel,
  summaries: false,
};

/** Why Jev is refused as an Agent's Model, or an AI Provider's default. */
export const notAnAgentModel =
  "Jev is the Decision Model only: it is never an Agent's Model.";

/**
 * A Model an Agent may use, as its own or its AI Provider's default: any
 * but Jev, which is never an Agent's (FR-17).
 */
export const agentModelSchema = modelNameSchema.refine(
  (model) => !isDecisionModel(model),
  { error: notAnAgentModel },
);
