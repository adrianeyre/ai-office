import { randomBytes } from "node:crypto";

// What an Agent's model calls count against (FR-32, FR-42; pen-testing
// G1-1): the issue and pull request AI Office gave its work, never ones a
// call names. A sandbox's code can send any header, or none, so the
// Gateway never reads an Agent's issue from what it sends. Instead:
// - a sandbox's work is held for its Agent while the sandbox runs
//   (`hold`): every call its Agent's key makes counts against it, whatever
//   the call names;
// - a call AI Office makes itself for an Agent (a review, a Manager's
//   judgement, a Fresh Start's summary) opens its work (`open`) and sends
//   the token it is given as `x-ai-office-work`. The token is good for
//   that Agent alone, and only until the call is done.
// Any other call counts against no issue: its Agent's own cap, its
// Floor's or the office's.

/** The issue and pull request a call counts against; null for none. */
export interface CallWork {
  readonly issue: number | null;
  readonly pullRequest: number | null;
}

/** Work AI Office gives an Agent: its issue, and its pull request if any. */
export interface GivenWork {
  readonly issue?: number | undefined;
  readonly pullRequest?: number | undefined;
}

/** Work opened for AI Office's own call, until it is closed. */
export interface OpenWork {
  /** What the call sends as `x-ai-office-work`. */
  readonly token: string;
  /** Ends the token: from now on it names nothing. */
  close(): void;
}

export interface AgentWork {
  /**
   * Holds a sandbox's work for its Agent until the function it returns is
   * called: every call by the Agent's key counts against it, except one
   * that brings its own open work's token.
   */
  hold(agentId: string, work: GivenWork): () => void;
  /** Opens work for one of AI Office's own calls for the Agent. */
  open(agentId: string, work: GivenWork): OpenWork;
  /** What a call by the Agent counts against, given the token it sent. */
  of(agentId: string, token: string | undefined): CallWork;
}

/** A call that counts against no issue. */
export const noWork: CallWork = { issue: null, pullRequest: null };

const callWork = (work: GivenWork): CallWork => ({
  issue: work.issue ?? null,
  pullRequest: work.pullRequest ?? null,
});

export function createAgentWork(): AgentWork {
  /** Each Agent's held work, the latest last. */
  const held = new Map<string, { readonly work: CallWork }[]>();
  /** Open work, by token. */
  const opened = new Map<
    string,
    { readonly agentId: string; readonly work: CallWork }
  >();

  return {
    hold(agentId, work) {
      const entry = { work: callWork(work) };
      held.set(agentId, [...(held.get(agentId) ?? []), entry]);
      return () => {
        const rest = (held.get(agentId) ?? []).filter(
          (candidate) => candidate !== entry,
        );
        if (rest.length === 0) {
          held.delete(agentId);
        } else {
          held.set(agentId, rest);
        }
      };
    },

    open(agentId, work) {
      const token = randomBytes(24).toString("base64url");
      opened.set(token, { agentId, work: callWork(work) });
      return {
        token,
        close: () => {
          opened.delete(token);
        },
      };
    },

    of(agentId, token) {
      const own = token === undefined ? undefined : opened.get(token);
      if (own?.agentId === agentId) {
        return own.work;
      }
      return held.get(agentId)?.at(-1)?.work ?? noWork;
    },
  };
}
