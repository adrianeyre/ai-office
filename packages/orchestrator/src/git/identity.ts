import { roleName, type GitIdentity, type Role } from "@ai-office/shared";

// Who agent commits are by, and how they name their Agent (PRD FR-68,
// FR-69; ADR 0002). The author and committer are the Owner, never the
// Agent: AI Office sets them in the sandbox's environment, and every
// commit message ends with an `Agent:` trailer naming the Agent, its Role
// and its AI Provider and Model, so agent commits stay distinguishable.
// It is the only line naming who made the commit: any `Agent:` or
// `*-by:` line the Agent wrote is dropped (W1-5).

/** The identity a Floor's commits are by: its own, or else the office's. */
export function gitIdentityFor(
  office: GitIdentity,
  floor: { readonly gitIdentity: GitIdentity | null },
): GitIdentity {
  return floor.gitIdentity ?? office;
}

/** The environment that makes Git author and commit as `identity`. */
export function gitEnvironment(identity: GitIdentity): {
  readonly GIT_AUTHOR_NAME: string;
  readonly GIT_AUTHOR_EMAIL: string;
  readonly GIT_COMMITTER_NAME: string;
  readonly GIT_COMMITTER_EMAIL: string;
} {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/** What the trailer says about an Agent. */
export interface TrailerAgent {
  readonly name: string;
  readonly role: Role;
  /** Such as `Claude`. */
  readonly aiProvider: string;
  /** The Model it uses, such as `claude-opus-5-5`. */
  readonly model: string;
}

/** A trailer's value is one line. */
const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** `Agent: Ada (coder, Claude claude-opus-5-5)`. */
export function agentTrailer(agent: TrailerAgent): string {
  return `Agent: ${oneLine(agent.name)} (${roleName(agent.role)}, ${oneLine(agent.aiProvider)} ${oneLine(agent.model)})`;
}

/** A paragraph Git reads as trailers: every line `Token: value`. */
const isTrailerBlock = (paragraph: string): boolean =>
  paragraph.split("\n").every((line) => /^[A-Za-z0-9-]+: \S/.test(line));

/**
 * A line that names who made a commit, as only AI Office may in one
 * authored as the Owner: an `Agent:` trailer, or a person's, such as
 * `Co-authored-by:` or `Signed-off-by:` (W1-5).
 */
const namesWhoMadeIt = /^[ \t]*(?:agent|[a-z0-9-]*-by)[ \t]*:/i;

/**
 * `message` without the lines that name who made the commit (`Agent:`,
 * `Co-authored-by:`, `Signed-off-by:` and the like) and their folded
 * continuation lines: an Agent may write them, but in a commit authored
 * as the Owner only AI Office names the Agent, and nobody else (W1-5).
 */
export function withoutWhoMadeIt(message: string): string {
  // The subject line is never a trailer.
  const [subject = "", ...lines] = message.split("\n");
  const kept = [subject];
  let dropping = false;
  for (const line of lines) {
    if (namesWhoMadeIt.test(line)) {
      dropping = true;
    } else if (!(dropping && /^[ \t]+\S/.test(line))) {
      dropping = false;
      kept.push(line);
    }
  }
  const left = kept.join("\n");
  return left === message ? message : left.replaceAll(/\n{3,}/g, "\n\n");
}

/**
 * `message` with the Agent's trailer at its end, and no other line naming
 * who made it (`withoutWhoMadeIt`): in the message's own trailer block if
 * it ends with one (beside `Refs:`), or in a new block after a blank line.
 */
export function withAgentTrailer(message: string, agent: TrailerAgent): string {
  const trailer = agentTrailer(agent);
  const body = withoutWhoMadeIt(message).trimEnd();
  const paragraphs = body.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  // The subject line alone is never a trailer block.
  const joinsTrailers = paragraphs.length > 1 && isTrailerBlock(last);
  return `${body}${joinsTrailers ? "\n" : "\n\n"}${trailer}\n`;
}
