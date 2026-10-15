import { statusUpdates, type Database } from "@ai-office/db";
import type { EventBus, EventType, StoredEvent } from "@ai-office/events";
import {
  addDays,
  dayIn,
  dayName,
  dayStart,
  floorErrorCodes,
  managerRole,
  reportedDay,
  roleName,
  statusUpdateHeading,
  statusUpdateLookBackDays,
  statusUpdateTriggers,
  type StatusUpdate,
  type StatusUpdateEntry,
  type StatusUpdateTrigger,
} from "@ai-office/shared";
import { and, eq } from "drizzle-orm";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { BatchStore } from "../batches/store.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorStore } from "../floors/store.ts";
import type { WorkQueueStore } from "../work/store.ts";
import type { ManagerChat } from "./chat.ts";

// A Floor's Status update (PRD FR-23a): a stand-up. The whole Floor walks
// to the meeting room and sits, and each Agent, the Manager first, says
// what it did on the last working day and what it plans today. The last
// working day is yesterday, or, when nothing happened then, the latest day
// with work in the week before (Friday, on a Monday after a quiet
// weekend); the days are the Owner's, in their profile's time zone.
//
// It is written in plain code from AI Office's own records, as the status
// report is (report.ts): what each Agent did, from the event log (pull
// requests opened, reviews, QA, Handoffs, commits, sandboxes); what it
// plans, from the work queue and the Floor's Batches. It costs no tokens
// and no model sees issue text. It is kept in the Manager chat, and
// `status_update.given` tells the Office, which walks everyone in.
//
// The Owner gives one with Status update, whenever; and the first time
// they open a Floor each day, AI Office gives the day's own, once a day
// however many browsers open it (`status_updates`, keyed by Floor and day).
// While a Floor's Agents work, AI Office gives one each hour too (hourly-status-updates.ts),
// saying what each did in the last hour; those are not the day's, so they
// are not kept there. The latest given on each Floor is kept in memory, for
// a browser that hears of it from its `status_update.given` event.

/** A Status update kept for a Floor and day. */
export interface StatusUpdateRecord {
  readonly floorId: string;
  /** The Owner's day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly trigger: StatusUpdateTrigger;
  readonly givenAt: Date;
  /** Its message in the Manager chat, once kept. */
  readonly messageId: number | null;
}

/** Where each Floor's Status updates are kept: one a day. */
export interface StatusUpdateStore {
  /**
   * Keeps the Floor's Status update for its day, unless one was kept for
   * that day already: false then, and nothing changes.
   */
  claim(record: Omit<StatusUpdateRecord, "messageId">): Promise<boolean>;
  /** Records the chat message of the Floor's Status update for `day`. */
  setMessage(floorId: string, day: string, messageId: number): Promise<void>;
  get(floorId: string, day: string): Promise<StatusUpdateRecord | undefined>;
}

/** Keeps Status updates in memory: for tests. */
export function memoryStatusUpdateStore(): StatusUpdateStore {
  const records = new Map<string, StatusUpdateRecord>();
  const key = (floorId: string, day: string) => `${floorId}\n${day}`;
  return {
    claim(record) {
      const at = key(record.floorId, record.day);
      if (records.has(at)) {
        return Promise.resolve(false);
      }
      records.set(at, { ...record, messageId: null });
      return Promise.resolve(true);
    },
    setMessage(floorId, day, messageId) {
      const record = records.get(key(floorId, day));
      if (record !== undefined) {
        records.set(key(floorId, day), { ...record, messageId });
      }
      return Promise.resolve();
    },
    get(floorId, day) {
      const record = records.get(key(floorId, day));
      return Promise.resolve(record === undefined ? undefined : { ...record });
    },
  };
}

/** Keeps Status updates in the `status_updates` table. */
export function databaseStatusUpdateStore(db: Database): StatusUpdateStore {
  return {
    async claim(record) {
      const rows = await db
        .insert(statusUpdates)
        .values({
          floorId: record.floorId,
          day: record.day,
          trigger: record.trigger,
          givenAt: record.givenAt,
        })
        .onConflictDoNothing()
        .returning({ day: statusUpdates.day });
      return rows.length > 0;
    },
    async setMessage(floorId, day, messageId) {
      await db
        .update(statusUpdates)
        .set({ messageId })
        .where(
          and(eq(statusUpdates.floorId, floorId), eq(statusUpdates.day, day)),
        );
    },
    async get(floorId, day) {
      const [row] = await db
        .select()
        .from(statusUpdates)
        .where(
          and(eq(statusUpdates.floorId, floorId), eq(statusUpdates.day, day)),
        );
      return row === undefined
        ? undefined
        : {
            floorId: row.floorId,
            day: row.day,
            trigger:
              statusUpdateTriggers.find((each) => each === row.trigger) ??
              "owner",
            givenAt: row.givenAt,
            messageId: row.messageId,
          };
    },
  };
}

/** The events that say an Agent did something on a day. */
export const workEventTypes = [
  "issue.triaged",
  "manager.issue_filed",
  "batch.kickoff_started",
  "batch.finished",
  "sandbox.started",
  "branch.pushed",
  "pull_request.opened",
  "pull_request.merged",
  "review.posted",
  "qa.reported",
  "design.reported",
  "handoff",
] as const satisfies readonly EventType[];

/** The most events a Status update reads: a busy week's. */
const maxEvents = 5000;

/** How far back an hourly Status update looks: the last hour. */
const hourMs = 60 * 60 * 1000;

/** A Floor's Status update, as composed, before it is given. */
export interface ComposedStatusUpdate {
  readonly floorId: string;
  readonly floorName: string;
  readonly managerId: string;
  /** The Owner's day. */
  readonly day: string;
  /** The day reported on: today, for the last hour's. */
  readonly reportedDay: string;
  /** Whether it says what each did in the last hour, not on a day. */
  readonly lastHour: boolean;
  /** The Manager first, then the Floor's other Agents in its order. */
  readonly entries: readonly StatusUpdateEntry[];
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const issueList = (issues: readonly number[]): string => {
  const named = issues.map((issue) => `#${String(issue)}`);
  return named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
};

/** What `agent` did, from the day's `events`, oldest first, each a sentence. */
export function didOn(
  agent: AgentRecord,
  events: readonly StoredEvent[],
  team: readonly AgentRecord[],
): string[] {
  const nameOf = (id: string) =>
    team.find((each) => each.id === id)?.name ?? "another Agent";
  const said: string[] = [];
  const mentioned = new Set<number>();
  const commits = new Map<number, number>();
  const worked: number[] = [];
  if (agent.role === managerRole) {
    const triaged = new Set<number>();
    const filed: number[] = [];
    const merged: number[] = [];
    for (const { event } of events) {
      switch (event.type) {
        case "issue.triaged":
          if (event.agentId === agent.id) {
            triaged.add(event.issue);
          }
          break;
        case "manager.issue_filed":
          if (event.agentId === agent.id) {
            filed.push(event.issue);
          }
          break;
        case "batch.kickoff_started":
          if (event.agentId === agent.id) {
            said.push(`Ran the Kickoff of Batch ${String(event.batchId)}.`);
          }
          break;
        case "batch.finished":
          if (event.agentId === agent.id) {
            said.push(
              `Presented the Wrap-up of Batch ${String(event.batchId)}: ${String(event.merged)} of ${plural(event.issues.length, "issue")} merged.`,
            );
          }
          break;
        case "pull_request.merged":
          merged.push(event.pullRequest);
          break;
        default:
          break;
      }
    }
    return [
      ...(triaged.size === 0
        ? []
        : [`Triaged ${plural(triaged.size, "issue")}.`]),
      ...(filed.length === 0
        ? []
        : [`Filed ${issueList(filed)} from your chat requests.`]),
      ...said,
      ...(merged.length === 0
        ? []
        : [
            `Saw ${plural(merged.length, "pull request")} merged: ${issueList(merged)}.`,
          ]),
    ];
  }
  for (const { event } of events) {
    switch (event.type) {
      case "pull_request.opened":
        if (event.agentId === agent.id) {
          said.push(
            `Opened pull request #${String(event.pullRequest)} for #${String(event.issue)}.`,
          );
          mentioned.add(event.issue);
        }
        break;
      case "review.posted":
        if (event.agentId === agent.id) {
          said.push(
            `Reviewed pull request #${String(event.pullRequest)} for #${String(event.issue)}: ${
              event.verdict === "approve"
                ? "approved it"
                : `asked for changes${event.blocking > 0 ? ` (${plural(event.blocking, "blocking comment")})` : ""}`
            }.`,
          );
          mentioned.add(event.issue);
        }
        break;
      case "qa.reported":
        if (event.agentId === agent.id) {
          said.push(
            `Tested #${String(event.issue)}: ${event.result === "pass" ? "it passed" : "it failed"}.`,
          );
          mentioned.add(event.issue);
        }
        break;
      case "design.reported":
        if (event.agentId === agent.id) {
          said.push(
            `Reviewed the design of #${String(event.issue)}: ${event.result === "pass" ? "approved it" : "asked for changes"}.`,
          );
          mentioned.add(event.issue);
        }
        break;
      case "handoff":
        if (event.fromAgentId === agent.id) {
          said.push(
            `Handed #${String(event.issue)} on to ${nameOf(event.toAgentId)}, at ${event.stage}.`,
          );
          mentioned.add(event.issue);
        }
        break;
      case "branch.pushed":
        if (event.agentId === agent.id) {
          commits.set(
            event.issue,
            (commits.get(event.issue) ?? 0) + event.commits,
          );
        }
        break;
      case "sandbox.started":
        if (event.agentId === agent.id && !worked.includes(event.issue)) {
          worked.push(event.issue);
        }
        break;
      default:
        break;
    }
  }
  for (const [issue, count] of commits) {
    if (count > 0) {
      said.push(`Pushed ${plural(count, "commit")} to #${String(issue)}.`);
      mentioned.add(issue);
    }
  }
  const only = worked.filter((issue) => !mentioned.has(issue));
  if (only.length > 0) {
    said.push(`Worked on ${issueList(only)}.`);
  }
  return said;
}

export interface StatusUpdatesOptions {
  readonly floors: FloorStore;
  readonly agents: Pick<AgentStore, "list">;
  readonly work: Pick<WorkQueueStore, "active">;
  readonly batches: Pick<BatchStore, "open">;
  readonly events: EventBus;
  readonly store: StatusUpdateStore;
  /** Where it is said: the Floor's Manager chat. */
  readonly chat: Pick<ManagerChat, "postReport">;
  /** The Owner's time zone, from their profile: whose days they are. */
  readonly timeZone: () => Promise<string>;
  readonly now?: () => Date;
}

export interface StatusUpdates {
  /**
   * The Floor's Status update now, without giving it: on the last working
   * day, or, with `lastHour`, in the last hour.
   */
  compose(
    floorId: string,
    options?: { readonly lastHour?: boolean },
  ): Promise<ComposedStatusUpdate>;
  /**
   * Gives the Floor's Status update: kept in its Manager chat, and told
   * to the Office. `daily` gives it only if none was given today: undefined
   * otherwise, and for a Floor with no Manager or that is archived.
   * `hourly` says what each did in the last hour, and is not the day's.
   */
  give(
    floorId: string,
    trigger: StatusUpdateTrigger,
  ): Promise<StatusUpdate | undefined>;
  /** The latest Status update given on the Floor since the server started. */
  latest(floorId: string): StatusUpdate | undefined;
}

/** The Status update's message in the Manager chat. */
export function statusUpdateMessage(composed: ComposedStatusUpdate): string {
  const reported = composed.lastHour
    ? "in the last hour"
    : `on ${dayName(composed.reportedDay)}`;
  return [
    `${statusUpdateHeading} ${composed.floorName}, ${dayName(composed.day)}: what each of us did ${reported}, and what we plan today.`,
    ...composed.entries.map((entry) =>
      [
        "",
        `**${entry.name}** (${entry.role})`,
        `${reported.charAt(0).toUpperCase()}${reported.slice(1)}:`,
        ...(entry.did.length === 0
          ? ["- Nothing to report."]
          : entry.did.map((line) => `- ${line}`)),
        "Today:",
        ...entry.today.map((line) => `- ${line}`),
      ].join("\n"),
    ),
  ].join("\n");
}

export function createStatusUpdates(
  options: StatusUpdatesOptions,
): StatusUpdates {
  const now = options.now ?? (() => new Date());
  const latest = new Map<string, StatusUpdate>();

  const compose = async (
    floorId: string,
    { lastHour = false }: { readonly lastHour?: boolean } = {},
  ): Promise<ComposedStatusUpdate> => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    const at = now();
    const timeZone = await options.timeZone();
    const day = dayIn(at, timeZone);
    const team = (await options.agents.list(floorId)).filter(
      ({ leavingAt }) => leavingAt === null,
    );
    const manager = team.find(({ role }) => role === managerRole);
    // The week before today, oldest first, each with its day; or, for the
    // last hour's, that hour's.
    const read = await options.events.history({
      filter: { floorId, types: [...workEventTypes] },
      from: lastHour
        ? new Date(at.getTime() - hourMs)
        : dayStart(addDays(day, -statusUpdateLookBackDays), timeZone),
      to: lastHour ? at : dayStart(day, timeZone),
      limit: maxEvents,
    });
    const week = read
      .map((stored) => ({ stored, day: dayIn(stored.occurredAt, timeZone) }))
      .reverse();
    const busy = new Set(week.map(({ day: on }) => on));
    const reported = lastHour ? day : reportedDay(day, (on) => busy.has(on));
    const onThatDay = week
      .filter(({ day: on }) => lastHour || on === reported)
      .map(({ stored }) => stored);

    const active = (await options.work.active()).filter(
      (work) => work.floorId === floorId,
    );
    const open = await options.batches.open(floorId);
    const todayOf = (agent: AgentRecord): string[] => {
      if (agent.role === managerRole) {
        const waiting = active.filter(
          ({ agentId, status }) => agentId === null && status === "queued",
        );
        return [
          ...open.map((batch) =>
            batch.status === "awaiting_approval"
              ? `Batch ${String(batch.id)} waits for you to approve its Plan.`
              : `Keep Batch ${String(batch.id)} moving: ${plural(batch.issues.length, "issue")}.`,
          ),
          ...(waiting.length === 0
            ? []
            : [
                `Find Agents for ${issueList(waiting.map(({ issue }) => issue))}, waiting for one.`,
              ]),
          "Triage whatever comes in, and tell you what needs you.",
        ];
      }
      const mine = active.filter(({ agentId }) => agentId === agent.id);
      const running = mine.filter(({ status }) => status === "running");
      const queued = mine.filter(({ status }) => status === "queued");
      if (mine.length === 0) {
        return [
          agent.enabled
            ? "Nothing queued: ready for the next issue."
            : "Paused, so nothing today until resumed.",
        ];
      }
      return [
        ...running.map(
          ({ issue, stage }) => `Carry on with #${String(issue)}, at ${stage}.`,
        ),
        ...queued.map(
          ({ issue, stage }) => `Then #${String(issue)}, at ${stage}.`,
        ),
      ];
    };
    const ordered = [
      ...(manager === undefined ? [] : [manager]),
      ...team.filter(({ role }) => role !== managerRole),
    ];
    return {
      floorId,
      floorName: floor.name,
      managerId: manager?.id ?? "",
      day,
      reportedDay: reported,
      lastHour,
      entries: ordered.map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        role: roleName(agent.role),
        did: didOn(agent, onThatDay, team),
        today: todayOf(agent),
      })),
    };
  };

  return {
    compose,

    async give(floorId, trigger) {
      const floor = await options.floors.get(floorId);
      if (floor?.archivedAt != null) {
        return undefined;
      }
      const hourly = trigger === "hourly";
      const composed = await compose(floorId, { lastHour: hourly });
      if (composed.managerId === "") {
        return undefined;
      }
      const givenAt = now();
      // The day's own is given once; the Owner's whenever they ask, and
      // it counts as the day's. The hour's never does.
      const claimed =
        !hourly &&
        (await options.store.claim({
          floorId,
          day: composed.day,
          trigger,
          givenAt,
        }));
      if (!claimed && trigger === "daily") {
        return undefined;
      }
      const message = await options.chat.postReport(
        floorId,
        statusUpdateMessage(composed),
      );
      if (claimed) {
        await options.store.setMessage(floorId, composed.day, message.id);
      }
      const stored = await options.events.publish({
        type: "status_update.given",
        version: 1,
        floorId,
        agentId: composed.managerId,
        agentIds: composed.entries
          .map(({ agentId }) => agentId)
          .filter((id) => id !== composed.managerId),
        day: composed.day,
        reportedDay: composed.reportedDay,
        trigger,
        messageId: message.id,
      });
      const given: StatusUpdate = {
        floorId,
        eventId: stored.id,
        trigger,
        day: composed.day,
        reportedDay: composed.reportedDay,
        givenAt: givenAt.toISOString(),
        entries: [...composed.entries],
      };
      latest.set(floorId, given);
      return given;
    },

    latest: (floorId) => latest.get(floorId),
  };
}
