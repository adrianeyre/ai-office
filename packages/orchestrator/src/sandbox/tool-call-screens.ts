import { claudeHookAnswer, claudeHookCall } from "./agent-tools.ts";

// AI Office's tool-call screen as a sandbox asks it before a call runs
// (FR-17, P1-8). Each running sandbox session opens its screen here: the
// sandbox runner's for an Agent's task, fact-finding's for a Grilling
// Session's fact or a research Contractor. Claude Code's `PreToolUse` hook
// posts each call to the AI Gateway's screen route, with the Agent's
// Gateway Key and its session (`agentToolSetup`), and the Gateway passes
// it here with the Agent its key belongs to. A call is let run only when
// its session's screen has judged it and found nothing unsafe: a call from
// a session not running, or not the Agent's, one that cannot be read, and
// one the screen cannot judge in time are all denied.

/** Judges a call: why it is unsafe, or undefined to let it run. */
export type CallJudge = (call: {
  readonly name: string;
  readonly args: string;
}) => Promise<string | undefined>;

/** A call as the Gateway's screen route passes it on. */
export interface ToolCallScreenRequest {
  /** The Agent whose Gateway Key the request presented. */
  readonly agentId: string;
  /** The session its header names; null when it names none. */
  readonly session: string | null;
  /** What the agent tool's hook posted. */
  readonly body: unknown;
}

export interface ToolCallScreens {
  /**
   * Opens `session`'s screen, for `agentId`'s calls, judged by `judge`;
   * the function returned closes it.
   */
  open(session: string, agentId: string, judge: CallJudge): () => void;
  /** The hook's answer to a call: to let it run, or why it does not. */
  answer(request: ToolCallScreenRequest): Promise<object>;
}

/** How long a call may wait on its screen before it is denied. */
export const screenDeadlineMs = 90_000;

export function createToolCallScreens(
  options: { readonly deadlineMs?: number } = {},
): ToolCallScreens {
  const deadlineMs = options.deadlineMs ?? screenDeadlineMs;
  const sessions = new Map<
    string,
    { readonly agentId: string; readonly judge: CallJudge }
  >();

  return {
    open(session, agentId, judge) {
      const opened = { agentId, judge };
      sessions.set(session, opened);
      return () => {
        if (sessions.get(session) === opened) {
          sessions.delete(session);
        }
      };
    },

    async answer(request) {
      const open =
        request.session === null ? undefined : sessions.get(request.session);
      if (open?.agentId !== request.agentId) {
        return claudeHookAnswer(
          "the call is from no running session of this Agent",
        );
      }
      const call = claudeHookCall(request.body);
      if (call === undefined) {
        return claudeHookAnswer("the call could not be read");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          resolve("the call could not be screened in time");
        }, deadlineMs);
      });
      try {
        return claudeHookAnswer(
          await Promise.race([
            open.judge(call).catch(() => "the call could not be screened"),
            late,
          ]),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
