// A Model's effective context window: the Context window the Owner set on
// an AI Account of its AI Provider, which overrides the model catalogue's,
// or the catalogue's where its AI Provider reports one (such as vLLM's
// `max_model_len`); unknown otherwise. What a prompt may carry is sized
// from it: the reviewer's diff, and the memory and Skills Agents are
// given. Tokens become characters conservatively, at 3.5 to a token.

/** A Model's effective context window, in tokens; null when unknown. */
export type ContextWindowOf = (
  aiProvider: string,
  model: string,
) => Promise<number | null>;

/** Characters to a token, counted conservatively. */
export const charactersPerToken = 3.5;

/** The characters `tokens` hold at most, counted conservatively. */
export const charactersIn = (tokens: number): number =>
  Math.max(0, Math.floor(tokens * charactersPerToken));
