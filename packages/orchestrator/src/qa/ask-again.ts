import type { ModelClient } from "../models/client.ts";

// A sandbox Agent's report asked for again (QA's `<qa-report>`, a
// designer's `<design-review>`): when its run ends without a valid block,
// it is asked once more, as a reviewer whose answer is not a verdict is
// (`review/reviewer.ts`). The sandbox has gone, so it is one model call
// through the AI Gateway with the Agent's own Gateway Key, quoting its
// last message and asking for the block alone, in the form its prompt
// gave. Like any of its calls, it is attributed to the Agent and its
// issue (FR-42) and counts against its Token Caps (FR-33). An answer that
// is still not valid is the caller's to block the Agent on.

/** The most of the Agent's last message quoted: its end, where reports go. */
const maxQuoted = 20_000;
/** The most tokens the answer may use. */
const maxAnswerTokens = 4096;

export interface AskAgainInput<Report> {
  readonly models: ModelClient;
  readonly agent: { readonly id: string; readonly name: string };
  readonly model: string;
  readonly issue: number;
  readonly pullRequest: number;
  /** The block's tag, such as `qa-report`. */
  readonly tag: string;
  /** The block's form, a line each, as the Agent's prompt gives it. */
  readonly form: readonly string[];
  /** The Agent's last message, which has no valid block. */
  readonly lastText: string | null;
  /** The report in an answer; undefined when it has no valid block. */
  readonly parse: (text: string) => Report | undefined;
  readonly signal?: AbortSignal;
}

/** What the Agent is asked: its last message, and the block's form. */
export function askAgainMessage(
  tag: string,
  form: readonly string[],
  lastText: string | null,
): string {
  const text = (lastText ?? "").trim();
  const quoted =
    text.length <= maxQuoted ? text : `…${text.slice(-(maxQuoted - 1))}`;
  return [
    `Your run has ended, but your last message, quoted below, has no valid \`<${tag}>\` block.`,
    "",
    "<last-message>",
    quoted === "" ? "(No message.)" : quoted,
    "</last-message>",
    "",
    `Answer again with only the \`<${tag}>\` block, from what you found, in this form:`,
    "",
    ...form.map((line) => `    ${line}`),
  ].join("\n");
}

/** The Agent's report, asked for once more; undefined when still not valid. */
export async function askAgain<Report>(
  input: AskAgainInput<Report>,
): Promise<Report | undefined> {
  const { agent, tag } = input;
  const reply = await input.models.complete(
    {
      agentId: agent.id,
      model: input.model,
      system: `You are ${agent.name}, an Agent in AI Office. Your sandbox run has ended. Answer with only the \`<${tag}>\` block asked for, in its form.`,
      messages: [
        {
          role: "user",
          content: askAgainMessage(tag, input.form, input.lastText),
        },
      ],
      maxTokens: maxAnswerTokens,
      issue: input.issue,
      pullRequest: input.pullRequest,
    },
    input.signal,
  );
  return input.parse(reply.text);
}
