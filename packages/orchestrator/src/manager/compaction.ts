import type { ChatMessageRecord } from "./store.ts";

// Compacting the Manager chat (PRD FR-87, FR-88, FR-89): the Manager's own
// Model summarises the conversation so far for itself, and the summary
// takes the place of the messages it replaced. In a Grilling Session the
// session's settled decisions, open questions and glossary terms are kept
// apart, as stored data, and put back into every prompt word for word,
// so the summary covers only the back-and-forth.

/** The most of the conversation one summary is written from. */
export const maxCompactedCharacters = 200_000;

/** The most tokens a summary may use. */
export const maxSummaryTokens = 2048;

export interface CompactionPromptInput {
  readonly manager: { readonly name: string };
  readonly floor: { readonly name: string };
  /** The summary the conversation already started with, if any. */
  readonly previous?: string;
  /** The messages to replace, oldest first. */
  readonly messages: readonly ChatMessageRecord[];
  /** What the Owner asked to keep (`/compact <what to keep>`). */
  readonly focus?: string;
  /** A Grilling Session runs: its stored data is kept apart. */
  readonly grilling?: boolean;
}

/** Who wrote a message, as the transcript names them. */
const speaker = (message: ChatMessageRecord, manager: string): string =>
  message.kind === "owner" ? "Owner" : manager;

/** The summariser's prompt: its instructions, and the transcript to summarise. */
export function compactionPrompt(input: CompactionPromptInput): {
  readonly system: string;
  readonly user: string;
} {
  const { manager, floor } = input;
  const lines = input.messages
    .filter(({ kind }) => kind !== "clear" && kind !== "summary")
    .map((message) => `${speaker(message, manager.name)}: ${message.text}`);
  // The oldest messages go first when the transcript is too long.
  let transcript = lines.join("\n\n");
  while (transcript.length > maxCompactedCharacters && lines.length > 1) {
    lines.shift();
    transcript = lines.join("\n\n");
  }
  const system = [
    `You are ${manager.name}, the Manager of the Floor "${floor.name}" in AI Office. Your chat with the Owner is being compacted: the messages below will be replaced by the summary you write now, and you will carry on from it.`,
    "",
    "Write the summary for yourself, in plain text. Keep what you need to carry on: what the Owner asked for and decided, what you said you would do, open questions, and anything the Owner told you about the Floor. Leave out greetings and anything settled and no longer needed. Name issues by number.",
    ...(input.grilling === true
      ? [
          "",
          "A Grilling Session is running. Its settled decisions, open questions and glossary terms are kept apart and given back to you word for word, so do not restate them: summarise only the back-and-forth, such as what the Owner explained, asked or worried about.",
        ]
      : []),
    ...(input.focus === undefined
      ? []
      : ["", `The Owner asked you to keep this in particular: ${input.focus}`]),
    "",
    "Never put a credential, a token or a secret in the summary.",
  ].join("\n");
  const user = [
    ...(input.previous === undefined
      ? []
      : [
          "The conversation already started from this summary of what came before:",
          "",
          input.previous.trim(),
          "",
        ]),
    "The conversation to summarise:",
    "",
    transcript,
    "",
    "Now write the summary.",
  ].join("\n");
  return { system, user };
}
