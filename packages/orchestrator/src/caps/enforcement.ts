import type { EventBus } from "@ai-office/events";
import {
  capPeriods,
  capWarningShare,
  periodBounds,
  tokenCapActions,
  type CapLevel,
  type CapPeriod,
  type CapUse,
  type NoticeAction,
} from "@ai-office/shared";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";
import type { CapPause, CapPauseStore } from "./pauses.ts";
import type { CapSubject, TokenCapService } from "./token-caps.ts";

// Token Cap enforcement (PRD FR-33, §5 scenario 5; ADR 0001). The AI
// Gateway asks before each of an Agent's calls (`check`) and tells after
// each one is recorded (`observe`):
// - at 80% of a cap in force, the Owner gets a warning Notice, once per
//   cap and period;
// - at 100%, the Agent is paused: the Gateway refuses its calls with a cap
//   error, so its agent tool stops at its next call (the safe point), and
//   no new work starts for it. An action Notice offers to raise the cap or
//   to resume when the cap's period is over ("Resume tomorrow" for a daily
//   cap, "Resume next month" for a monthly one).
// Raising the cap, from the Notice or anywhere else, resumes the Agent at
// once; resuming later lets it go when its resume time comes. Pauses are
// kept in the database, so they outlast a restart.

/** Why the Gateway refuses an Agent's call: the cap it reached. */
export interface CapRefusal {
  readonly period: CapPeriod;
  readonly level: CapLevel;
  readonly cap: number;
  readonly used: number;
  /** What the agent tool is told: no credential, no secret. */
  readonly message: string;
}

export interface CapEnforcement {
  /** Reads the pauses, and starts following cap changes and resume times. */
  start(): Promise<void>;
  stop(): void;
  /**
   * Before an Agent's call: the cap it is refused at, if it is paused or
   * has reached a cap in force (which pauses it); otherwise undefined,
   * after warning the Owner at 80%.
   */
  check(subject: CapSubject): Promise<CapRefusal | undefined>;
  /** After an Agent's call is recorded: warns at 80%, pauses at 100%. */
  observe(subject: CapSubject): Promise<void>;
  /** Whether the Agent is paused at a Token Cap. */
  isPaused(agentId: string): boolean;
  /** Every Agent paused at a Token Cap. */
  pausedAgents(): readonly string[];
}

export interface CapEnforcementOptions {
  readonly caps: Pick<TokenCapService, "capUse" | "issueCaps" | "setIssueCaps">;
  readonly agents: AgentStore;
  readonly pauses: CapPauseStore;
  readonly notices: Notices;
  readonly events: EventBus;
  readonly now?: () => Date;
  /** How often to resume Agents whose resume time has come; a minute. */
  readonly sweepMs?: number;
  /** Told when an Agent resumes, so its work can start. */
  readonly onResume?: (agentId: string) => void;
  /** Told of what went wrong outside a request. */
  readonly onError?: (error: unknown) => void;
}

const formatted = (tokens: number): string => tokens.toLocaleString("en-US");

/** Whose cap it is, as a Notice says it. */
function levelName(level: CapLevel, issue: number | null | undefined): string {
  switch (level) {
    case "issue":
      return issue === null || issue === undefined
        ? "its issue's"
        : `#${String(issue)}'s`;
    case "agent":
      return "its own";
    case "floor":
      return "the Floor's";
    case "office":
      return "the office's";
  }
}

/** The cap that `use` has reached or passed, if one has. */
const reachedIn = (use: Record<CapPeriod, CapUse>): CapPeriod | undefined =>
  capPeriods.find((period) => use[period].used >= use[period].cap);

/**
 * A cap raised for the work that reached it: doubled, or to what is used
 * plus the cap if that is more, so there is a cap's worth of room.
 */
export const raisedCap = (cap: number, used: number): number =>
  Math.min(Math.max(cap * 2, used + cap), Number.MAX_SAFE_INTEGER);

/** The resume action for a period's cap. */
const resumeAction = (period: CapPeriod): NoticeAction =>
  period === "daily"
    ? { id: tokenCapActions.resumeTomorrow, label: "Resume tomorrow" }
    : { id: tokenCapActions.resumeNextMonth, label: "Resume next month" };

const capConfigKey = /(^|\.)tokenCaps\./;

export function createCapEnforcement(
  options: CapEnforcementOptions,
): CapEnforcement {
  const { caps, agents, pauses, notices, events } = options;
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  /** Every pause, by Agent: the Gateway reads it on every call. */
  const paused = new Map<string, CapPause>();
  /** Warnings raised: by Agent, cap, period and when the period began. */
  const warned = new Set<string>();

  // Pausing, resuming and warning happen one at a time, so an Agent is
  // never paused twice nor warned twice for one cap.
  let previous: Promise<unknown> = Promise.resolve();
  const serial = <Result>(task: () => Promise<Result>): Promise<Result> => {
    const result = previous.then(task);
    previous = result.catch(() => undefined);
    return result;
  };

  const agentOf = async (
    floorId: string,
    agentId: string,
  ): Promise<AgentRecord | undefined> =>
    (await agents.list(floorId)).find(({ id }) => id === agentId);

  const refusalOf = (pause: CapPause, name: string): CapRefusal => ({
    period: pause.period,
    level: pause.level,
    cap: pause.cap,
    used: pause.used,
    message: `${name} reached ${levelName(pause.level, pause.issue)} ${pause.period} Token Cap (${formatted(pause.cap)} tokens), so AI Office has paused it. Stop now: the Owner can raise the cap or resume it later.`,
  });

  const save = async (pause: CapPause): Promise<void> => {
    await pauses.put(pause);
    paused.set(pause.agentId, pause);
  };

  /** Pauses the Agent at `period`'s cap, unless it is paused already. */
  const pause = (
    subject: CapSubject,
    period: CapPeriod,
    use: CapUse,
  ): Promise<CapPause> =>
    serial(async () => {
      const existing = paused.get(subject.agentId);
      if (existing !== undefined) {
        return existing;
      }
      const agent = await agentOf(subject.floorId, subject.agentId);
      const name = agent?.name ?? subject.agentId;
      const issue = subject.issue ?? null;
      const record: CapPause = {
        floorId: subject.floorId,
        agentId: subject.agentId,
        issue,
        period,
        level: use.level,
        cap: use.cap,
        used: use.used,
        noticeId: null,
        pausedAt: now(),
        resumeAt: null,
      };
      // Paused first: from here on the Gateway refuses its calls.
      await save(record);
      const capName = `${levelName(use.level, issue)} ${period} Token Cap`;
      await events.publish({
        type: "cap.reached",
        version: 1,
        level: use.level,
        period,
        floorId: subject.floorId,
        agentId: subject.agentId,
        ...(issue === null ? {} : { issue }),
        used: use.used,
        cap: use.cap,
      });
      await events.publish({
        type: "agent.status_changed",
        version: 1,
        floorId: subject.floorId,
        agentId: subject.agentId,
        status: "capped",
        ...(issue === null ? {} : { issue }),
        reason: `Paused at ${capName}`,
      });
      const notice = await notices.raise({
        kind: "action",
        title: `Token Cap reached: ${name} is paused at ${capName} (${formatted(use.used)} of ${formatted(use.cap)} tokens)`,
        floorId: subject.floorId,
        agentId: subject.agentId,
        actions: [
          { id: tokenCapActions.raiseCap, label: "Raise cap" },
          resumeAction(period),
        ],
      });
      const withNotice = { ...record, noticeId: notice.id };
      await save(withNotice);
      return withNotice;
    });

  /** Lets a paused Agent work again. */
  const resume = async (record: CapPause): Promise<void> => {
    await pauses.remove(record.agentId);
    paused.delete(record.agentId);
    await events.publish({
      type: "agent.status_changed",
      version: 1,
      floorId: record.floorId,
      agentId: record.agentId,
      status: "idle",
    });
    options.onResume?.(record.agentId);
  };

  /** Warns the Owner of each cap at 80% or more, once per cap and period. */
  const warn = (subject: CapSubject, use: Record<CapPeriod, CapUse>) => {
    const at = now();
    const due = capPeriods.filter((period) => {
      const { used, cap, level } = use[period];
      const key = JSON.stringify([
        subject.agentId,
        period,
        level,
        level === "issue" ? (subject.issue ?? null) : null,
        cap,
        periodBounds(period, at).from.toISOString(),
      ]);
      if (used < cap * capWarningShare || warned.has(key)) {
        return false;
      }
      warned.add(key);
      return true;
    });
    if (due.length === 0) {
      return Promise.resolve();
    }
    return serial(async () => {
      const agent = await agentOf(subject.floorId, subject.agentId);
      const name = agent?.name ?? subject.agentId;
      const open = await notices.open({ floorId: subject.floorId });
      for (const period of due) {
        const { used, cap, level } = use[period];
        const issue = level === "issue" ? (subject.issue ?? null) : null;
        const capName = `${levelName(level, issue)} ${period} Token Cap`;
        await events.publish({
          type: "cap.warning",
          version: 1,
          level,
          period,
          floorId: subject.floorId,
          agentId: subject.agentId,
          ...(subject.issue === undefined ? {} : { issue: subject.issue }),
          used,
          cap,
        });
        const prefix = `Token Cap warning: ${name} has used `;
        const suffix = ` of ${capName}`;
        const already = open.some(
          (notice) =>
            notice.agentId === subject.agentId &&
            notice.title.startsWith(prefix) &&
            notice.title.includes(`${suffix} (`),
        );
        if (!already) {
          await notices.raise({
            kind: "action",
            title: `${prefix}${String(Math.floor((used / cap) * 100))}%${suffix} (${formatted(used)} of ${formatted(cap)} tokens)`,
            floorId: subject.floorId,
            agentId: subject.agentId,
          });
        }
      }
    });
  };

  /** Pauses at a cap reached, or warns near one; the pause, if paused. */
  const evaluate = async (
    subject: CapSubject,
  ): Promise<CapPause | undefined> => {
    const existing = paused.get(subject.agentId);
    if (existing !== undefined) {
      if (existing.resumeAt === null || existing.resumeAt > now()) {
        return existing;
      }
      await serial(async () => {
        if (paused.get(subject.agentId) === existing) {
          await resume(existing);
        }
      });
    }
    const use = await caps.capUse(subject);
    const period = reachedIn(use);
    if (period !== undefined) {
      return pause(subject, period, use[period]);
    }
    await warn(subject, use);
    return undefined;
  };

  /** The pause the Notice is about, if its Agent is still paused. */
  const pauseOf = (notice: NoticeRecord): CapPause | undefined =>
    notice.agentId === null ? undefined : paused.get(notice.agentId);

  const unregister = [
    notices.registerAction(tokenCapActions.raiseCap, (notice) =>
      serial(async () => {
        const record = pauseOf(notice);
        if (record === undefined) {
          return;
        }
        const raised = raisedCap(record.cap, record.used);
        // Resumed first, so the cap's change finds nothing to resume.
        await resume(record);
        try {
          if (record.level === "issue" && record.issue !== null) {
            const current = await caps.issueCaps(record.floorId, record.issue);
            await caps.setIssueCaps(record.floorId, record.issue, {
              ...current,
              [record.period]: raised,
            });
          } else {
            // The office's or the Floor's cap stays as it is for the other
            // Agents: this Agent gets its own.
            const agent = await agentOf(record.floorId, record.agentId);
            if (agent === undefined) {
              throw new Error("The Agent is no longer on its Floor.");
            }
            const result = await agents.update({
              ...agent,
              tokenCaps: { ...agent.tokenCaps, [record.period]: raised },
            });
            if (result !== "updated") {
              throw new Error(
                `The Agent's cap could not be raised (${result}).`,
              );
            }
            await events.publish({
              type: "config.changed",
              version: 1,
              scope: "agent",
              floorId: record.floorId,
              agentId: record.agentId,
              keys: [`tokenCaps.${record.period}`],
            });
          }
        } catch (error) {
          // Still paused, and the Notice stays.
          await save(record);
          await events.publish({
            type: "agent.status_changed",
            version: 1,
            floorId: record.floorId,
            agentId: record.agentId,
            status: "capped",
            ...(record.issue === null ? {} : { issue: record.issue }),
            reason: `Paused at ${levelName(record.level, record.issue)} ${record.period} Token Cap`,
          });
          throw error;
        }
      }),
    ),
    ...[tokenCapActions.resumeTomorrow, tokenCapActions.resumeNextMonth].map(
      (action) =>
        notices.registerAction(action, (notice) =>
          serial(async () => {
            const record = pauseOf(notice);
            if (record !== undefined) {
              await save({
                ...record,
                resumeAt: periodBounds(record.period, now()).to,
              });
            }
          }),
        ),
    ),
  ];

  /** Resumes paused Agents whose resume time has come. */
  const sweep = (): Promise<void> =>
    serial(async () => {
      const at = now();
      for (const record of [...paused.values()]) {
        if (record.resumeAt !== null && record.resumeAt <= at) {
          await resume(record);
        }
      }
    });

  /** After a cap changed: resumes paused Agents no longer at their cap. */
  const recheck = async (): Promise<void> => {
    const resumed = await serial(async () => {
      const noticeIds: string[] = [];
      for (const record of [...paused.values()]) {
        const use = await caps.capUse({
          floorId: record.floorId,
          agentId: record.agentId,
          ...(record.issue === null ? {} : { issue: record.issue }),
        });
        if (reachedIn(use) === undefined) {
          await resume(record);
          if (record.noticeId !== null) {
            noticeIds.push(record.noticeId);
          }
        }
      }
      return noticeIds;
    });
    // Their Notices' action has been taken, elsewhere. Acted on outside
    // the queue: the action's handler waits its turn in it.
    for (const id of resumed) {
      const notice = await notices.get(id).catch(() => undefined);
      if (notice?.dismissedAt === null && notice.actedAt === null) {
        await notices.act(id, tokenCapActions.raiseCap);
      }
    }
  };

  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  return {
    async start() {
      for (const record of await pauses.list()) {
        paused.set(record.agentId, record);
      }
      unsubscribe = events.subscribe(
        ({ event }) => {
          if (
            event.type === "config.changed" &&
            event.keys.some((key) => capConfigKey.test(key))
          ) {
            void recheck().catch(report);
          } else if (event.type === "agent.removed") {
            paused.delete(event.agentId);
          }
        },
        { types: ["config.changed", "agent.removed"] },
      );
      clearInterval(timer);
      timer = setInterval(() => {
        void sweep().catch(report);
      }, options.sweepMs ?? 60_000);
      timer.unref();
      await sweep();
    },

    stop() {
      clearInterval(timer);
      unsubscribe?.();
      for (const off of unregister) {
        off();
      }
    },

    async check(subject) {
      const record = await evaluate(subject);
      if (record === undefined) {
        return undefined;
      }
      const agent = await agentOf(subject.floorId, subject.agentId);
      return refusalOf(record, agent?.name ?? subject.agentId);
    },

    async observe(subject) {
      await evaluate(subject);
    },

    isPaused: (agentId) => paused.has(agentId),

    pausedAgents: () => [...paused.keys()],
  };
}
