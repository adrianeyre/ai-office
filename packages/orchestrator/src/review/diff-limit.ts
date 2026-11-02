import { modelOf } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { ContextWindowOf } from "../context/window.ts";
import { diffLimitOf, type DiffLimit } from "./prompt.ts";

/**
 * The most of a diff every one of `reviewers` can be shown: the least of
 * their Models' limits (`diffLimitOf`), from each one's effective context
 * window. The review Stage and the Merge Policy both ask it, so they never
 * disagree on whether a pull request can be shown in full (P1-11).
 */
export async function reviewersDiffLimit(
  reviewers: readonly Pick<AgentRecord, "aiProvider" | "modelOverride">[],
  defaults: DefaultModels | undefined,
  contextWindow: ContextWindowOf | undefined,
): Promise<DiffLimit> {
  let limit = diffLimitOf(null);
  if (contextWindow === undefined) {
    return limit;
  }
  for (const agent of reviewers) {
    const model = modelOf(agent, defaults);
    if (model === undefined) {
      continue;
    }
    const own = diffLimitOf(await contextWindow(agent.aiProvider, model));
    if (own.characters < limit.characters) {
      limit = own;
    }
  }
  return limit;
}
