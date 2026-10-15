import type { GitHubApp, Issue } from "@ai-office/github";
import {
  createRedactor,
  intakeLabel,
  periodBounds,
  type NewNotice,
  type NoticeLink,
  type PipelineStage,
  type Redactor,
  type TokenUsageRow,
} from "@ai-office/shared";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { Notices } from "../notices/notices.ts";
import { positionOf } from "../pipeline/pipeline.ts";
import type { WorkItem, WorkQueueStore } from "../work/store.ts";
import { managerGitHub } from "./authority.ts";
import type { ManagerChat } from "./chat.ts";
import type { ChatMessageRecord, ManagerChatStore } from "./store.ts";

// The Manager's status reports (PRD FR-23, "Reporting"): on request in the
// Manager chat ("status") and once a day, each Floor's Manager writes a
// short report of its work. What is in flight, what is blocked, what needs
// the Owner, and the tokens the Floor has used. It is kept in the chat and
// raised as an info Notice. It is written in plain code from AI Office's
// own records and the issues' labels on GitHub, read with the Manager's
// GitHub client, so it costs no tokens and no model sees issue text.
//
// - **In flight:** issues at a stage, with the Agent working each one, or
//   waiting for one.
// - **Blocked:** an issue whose latest work at its stage failed, with
//   nothing queued again; or work waiting for an Agent that is paused (in
//   the Agent editor or at a Token Cap).
// - **Needing the Owner:** the Floor's open action Notices, and issues at
//   `needs-human`, or at `ready-to-merge` when the Floor's Merge Policy
//   sends pull requests to the Owner.
// - **Tokens:** what the Floor's Agents used today and this month (UTC), as
//   Token Caps count them (FR-31).
//
// The daily report is written at the hour set (09:00 UTC by default), once
// a day, and not at all for a Floor with nothing to report.

/** An issue in the pipeline, and who is on it. */
export interface InFlightIssue {
  readonly issue: number;
  readonly title: string | null;
  readonly url: string | null;
  readonly stage: PipelineStage;
  /**
   * `running`: an Agent is working it. `queued`: its work waits to start.
   * `waiting`: it is at its stage with no work queued.
   */
  readonly status: "running" | "queued" | "waiting";
  /** The Agent working it, or that its work waits for. */
  readonly agentName: string | null;
  /** When its work started, or was queued. */
  readonly since: Date | null;
}

/** An issue whose work cannot go on by itself. */
export interface BlockedIssue {
  readonly issue: number;
  readonly title: string | null;
  readonly url: string | null;
  readonly stage: PipelineStage;
  /** Why, in words. */
  readonly why: string;
}

/** Something that waits for the Owner. */
export interface OwnerItem {
  readonly issue: number | null;
  readonly title: string | null;
  readonly url: string | null;
  /** Why, in words: an action Notice's title, or where the issue is. */
  readonly why: string;
}

/** A Floor's status, as its Manager reports it. */
export interface FloorStatusReport {
  readonly floorId: string;
  readonly floorName: string;
  readonly managerId: string;
  readonly managerName: string;
  readonly at: Date;
  readonly inFlight: readonly InFlightIssue[];
  readonly blocked: readonly BlockedIssue[];
  readonly needsOwner: readonly OwnerItem[];
  /** The Floor's tokens (input plus output), today and this month, UTC. */
  readonly tokens: { readonly today: number; readonly month: number };
  /**
   * Why GitHub could not be read, if it could not: the report then comes
   * from AI Office's own records alone.
   */
  readonly githubError: string | null;
}

export interface StatusReports {
  /** The Floor's status now. */
  compose(floorId: string): Promise<FloorStatusReport>;
  /**
   * Writes the Floor's status report: kept in its Manager chat (answering
   * the Owner's message `replyTo`, if any) and raised as an info Notice.
   * Returns the chat message.
   */
  write(
    floorId: string,
    options?: { readonly replyTo?: number },
  ): Promise<ChatMessageRecord>;
  /**
   * Writes each Floor's daily report that is due and not yet written;
   * returns the Floors written for.
   */
  check(): Promise<string[]>;
  /** Checks every interval until stopped. */
  start(): void;
  /** Stops checking, waiting for a check in progress. */
  stop(): Promise<void>;
}

export interface StatusReportsOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** The work queue's records, read. */
  readonly work: Pick<WorkQueueStore, "active" | "recent">;
  /** The GitHub App; read only, as `managerGitHub` allows. */
  readonly github?: GitHubApp;
  readonly notices: Notices;
  /** Where the report is kept and shown. */
  readonly chat: Pick<ManagerChat, "postReport">;
  /** Where the last daily report is read from, so one is written a day. */
  readonly chatStore: Pick<ManagerChatStore, "latestDailyReport">;
  /** What requests started in [`from`, `to`) used. */
  readonly usage: (from: Date, to: Date) => Promise<TokenUsageRow[]>;
  /** The Agents paused at a Token Cap. */
  readonly pausedAgents?: () => readonly string[];
  /** AI Office's address, for the Notice's link to the Manager chat. */
  readonly publicUrl?: string;
  /**
   * Removes credentials from issue titles and Notices' titles before they
   * are shortened, so no part of one is left.
   */
  readonly redactor?: Redactor;
  /** The hour of the day (UTC) the daily report is written; 9. */
  readonly dailyHourUtc?: number;
  readonly now?: () => Date;
  /** How often to check for a daily report due; a minute. */
  readonly intervalMs?: number;
  /** Told when a check or a Notice fails. */
  readonly onError?: (error: unknown) => void;
}

/** When the daily report is written, by default: 09:00 UTC. */
export const defaultDailyReportHourUtc = 9;

/** How much of a Floor's latest work a report reads. */
const historyLimit = 200;

/** The longest issue title a report quotes. */
const titleLength = 60;

const shorten = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

const tokenCount = (count: number): string => count.toLocaleString("en-GB");

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

/** How long ago `since` was, from `at`, in words. */
const duration = (since: Date, at: Date): string => {
  const minutes = Math.max(
    0,
    Math.floor((at.getTime() - since.getTime()) / 60_000),
  );
  if (minutes < 60) {
    return plural(minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48
    ? plural(hours, "hour")
    : plural(Math.floor(hours / 24), "day");
};

/** `2026-10-09 09:00 UTC`. */
const when = (at: Date): string =>
  `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** `#4 Add a basket`, or `#4` when its title is not known. */
const named = (item: {
  readonly issue: number;
  readonly title: string | null;
}): string =>
  item.title === null
    ? `#${String(item.issue)}`
    : `#${String(item.issue)} ${shorten(item.title, titleLength)}`;

/** Whether a report has anything in it worth a daily Notice. */
export const isQuiet = (report: FloorStatusReport): boolean =>
  report.inFlight.length === 0 &&
  report.blocked.length === 0 &&
  report.needsOwner.length === 0 &&
  report.tokens.today === 0;

/** The report, as the Manager writes it in the chat. */
export function statusReportText(report: FloorStatusReport): string {
  const at = report.at;
  const section = <Item>(
    heading: string,
    items: readonly Item[],
    line: (item: Item) => string,
  ): string[] =>
    items.length === 0
      ? [`${heading}: none.`]
      : [
          `${heading} (${String(items.length)}):`,
          ...items.map((item) => `- ${line(item)}`),
        ];
  const inFlight = (item: InFlightIssue): string => {
    const agent = item.agentName ?? "an Agent";
    switch (item.status) {
      case "running":
        return `${named(item)}: ${agent} is working on it at ${item.stage}${
          item.since === null ? "" : `, for ${duration(item.since, at)}`
        }.`;
      case "queued":
        return `${named(item)}: queued at ${item.stage}${
          item.agentName === null ? "" : ` for ${item.agentName}`
        }${item.since === null ? "" : `, for ${duration(item.since, at)}`}.`;
      case "waiting":
        return `${named(item)}: at ${item.stage}, with no work queued.`;
    }
  };
  return [
    `Status report on ${report.floorName}, ${when(at)}.`,
    "",
    ...section("In flight", report.inFlight, inFlight),
    ...section(
      "Blocked",
      report.blocked,
      (item) => `${named(item)} (${item.stage}): ${item.why}.`,
    ),
    ...section("Needing you", report.needsOwner, (item) =>
      item.issue === null
        ? `${item.why}.`
        : `${named({ issue: item.issue, title: item.title })}: ${item.why}.`,
    ),
    `Tokens used: ${tokenCount(report.tokens.today)} today, ${tokenCount(report.tokens.month)} this month (UTC).`,
    ...(report.githubError === null
      ? []
      : [
          "",
          `GitHub could not be read (${report.githubError}), so this comes from AI Office's own records alone.`,
        ]),
  ].join("\n");
}

/** The report as an info Notice: its counts, and links to its issues. */
export function statusReportNotice(
  report: FloorStatusReport,
  publicUrl?: string,
): NewNotice {
  const title = `Status report on ${report.floorName}: ${String(report.inFlight.length)} in flight, ${String(report.blocked.length)} blocked, ${String(report.needsOwner.length)} needing you, ${tokenCount(report.tokens.today)} tokens today`;
  const links: NoticeLink[] = [];
  if (publicUrl !== undefined) {
    links.push({
      label: "The report in the Manager chat",
      url: new URL(
        `/floors/${encodeURIComponent(report.floorId)}/manager`,
        publicUrl,
      ).toString(),
    });
  }
  const linked = new Set<number>();
  const link = (
    item: { readonly issue: number | null; readonly url: string | null },
    label: string,
  ): void => {
    if (
      item.issue === null ||
      item.url === null ||
      linked.has(item.issue) ||
      links.length >= 10
    ) {
      return;
    }
    linked.add(item.issue);
    links.push({ label: shorten(label, 60), url: item.url });
  };
  // What most needs the Owner first, while there is room.
  for (const item of report.needsOwner) {
    link(item, `#${String(item.issue)} needs you`);
  }
  for (const item of report.blocked) {
    link(item, `#${String(item.issue)} blocked at ${item.stage}`);
  }
  for (const item of report.inFlight) {
    link(item, `#${String(item.issue)} in flight at ${item.stage}`);
  }
  return {
    kind: "info",
    title: shorten(title, 200),
    floorId: report.floorId,
    agentId: report.managerId,
    links,
  };
}

export function createStatusReports(
  options: StatusReportsOptions,
): StatusReports {
  const { floors, agents, work, notices } = options;
  const now = options.now ?? (() => new Date());
  const github =
    options.github === undefined ? undefined : managerGitHub(options.github);
  const dailyHour = options.dailyHourUtc ?? defaultDailyReportHourUtc;
  const redactor = options.redactor ?? createRedactor();
  const titleOf = (issue: Issue | undefined): string | null =>
    issue === undefined ? null : redactor.redactText(issue.title);
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await floors.get(floorId);
    if (floor === undefined) {
      throw new Error(`There is no Floor "${floorId}".`);
    }
    return floor;
  };

  /** The Floor's tokens in the period holding `at`. */
  const tokensIn = async (
    floorId: string,
    period: "daily" | "monthly",
    at: Date,
  ): Promise<number> => {
    const { from, to } = periodBounds(period, at);
    return (await options.usage(from, to))
      .filter((row) => row.floorId === floorId)
      .reduce((sum, row) => sum + row.totals.tokens, 0);
  };

  /** The Floor's open issues labelled `ai-office`, from GitHub. */
  const openIssues = async (
    floor: FloorRecord,
  ): Promise<
    | { issues: Map<number, Issue>; error: null }
    | { issues: null; error: string }
  > => {
    if (github === undefined) {
      return { issues: null, error: "the GitHub App is not configured" };
    }
    try {
      const listed = await github
        .repository(floor.repository)
        .listIssues({ labels: [intakeLabel] });
      return {
        issues: new Map(listed.map((issue) => [issue.number, issue])),
        error: null,
      };
    } catch (error) {
      return { issues: null, error: reasonOf(error) };
    }
  };

  /** Where GitHub's labels put an issue; null when they cannot say. */
  const stageOf = (issue: Issue): PipelineStage | null => {
    try {
      return positionOf(issue.number, issue.labels).stage;
    } catch {
      return null;
    }
  };

  const compose = async (floorId: string): Promise<FloorStatusReport> => {
    const floor = await floorOf(floorId);
    const team = await agents.list(floor.id);
    const manager = team.find(({ role }) => role === "manager");
    if (manager === undefined) {
      throw new Error(`The Floor "${floor.name}" has no Manager.`);
    }
    const at = now();
    const byId = new Map(team.map((agent) => [agent.id, agent]));
    const nameOf = (agentId: string | null): string | null =>
      agentId === null ? null : (byId.get(agentId)?.name ?? null);
    const capPaused = new Set(options.pausedAgents?.() ?? []);
    const active = (await work.active()).filter(
      (item) => item.floorId === floor.id,
    );
    const recent = await work.recent(floor.id, historyLimit);
    const github = await openIssues(floor);
    const actionNotices = (await notices.open({ floorId: floor.id })).filter(
      ({ kind }) => kind === "action",
    );

    const issueOf = (number: number): Issue | undefined =>
      github.issues?.get(number);
    const about = (number: number) => {
      const issue = issueOf(number);
      return {
        issue: number,
        title: titleOf(issue),
        url: issue?.htmlUrl ?? null,
      };
    };

    /** Why queued work cannot start by itself, if it cannot. */
    const held = (item: WorkItem): string | null => {
      const waitingFor = (agent: AgentRecord): string | null =>
        capPaused.has(agent.id)
          ? `${agent.name} is paused at a Token Cap`
          : agent.enabled
            ? null
            : `${agent.name} is paused`;
      if (item.agentId !== null) {
        const agent = byId.get(item.agentId);
        if (agent === undefined) {
          return null;
        }
        const why = waitingFor(agent);
        return why === null
          ? null
          : `its work waits for ${agent.name}, and ${why}`;
      }
      if (item.stage === "needs-review") {
        const reviewers = floor.requiredReviewerAgentIds
          .map((id) => byId.get(id))
          .filter((agent) => agent !== undefined);
        const why = reviewers
          .map(waitingFor)
          .filter((reason) => reason !== null);
        return why.length === 0
          ? null
          : `its review waits for its required reviewers, and ${why.join(", and ")}`;
      }
      return null;
    };

    const inFlight: InFlightIssue[] = [];
    const blocked: BlockedIssue[] = [];
    const needsOwner: OwnerItem[] = [];
    const listed = new Set<number>();

    // The issues the Owner is asked about, by their action Notices.
    for (const notice of actionNotices) {
      const number = notice.issue?.number ?? notice.pullRequest?.number ?? null;
      const issue = number === null ? undefined : issueOf(number);
      needsOwner.push({
        issue: number,
        title: titleOf(issue),
        url: issue?.htmlUrl ?? notice.issue?.url ?? null,
        why: redactor.redactText(notice.title),
      });
    }
    const askedAbout = new Set(
      needsOwner.flatMap(({ issue }) => (issue === null ? [] : [issue])),
    );

    // Work queued or running, oldest first: what is in flight, or blocked.
    for (const item of active) {
      if (listed.has(item.issue)) {
        continue;
      }
      const issue = issueOf(item.issue);
      if (github.issues !== null && issue === undefined) {
        // Closed, or no longer AI Office's, since it was queued.
        continue;
      }
      listed.add(item.issue);
      const why = item.status === "queued" ? held(item) : null;
      if (why !== null) {
        blocked.push({ ...about(item.issue), stage: item.stage, why });
        continue;
      }
      inFlight.push({
        ...about(item.issue),
        stage: item.stage,
        status: item.status === "running" ? "running" : "queued",
        agentName: nameOf(item.agentId),
        since: item.status === "running" ? item.startedAt : item.createdAt,
      });
    }

    // Each issue's latest work at each stage, newest first.
    const latest = new Map<string, WorkItem>();
    for (const item of recent) {
      const key = `${String(item.issue)}|${item.stage}`;
      if (!latest.has(key)) {
        latest.set(key, item);
      }
    }
    const failedAt = (issue: number, stage: PipelineStage) => {
      const item = latest.get(`${String(issue)}|${stage}`);
      return item?.status === "failed" ? item : undefined;
    };
    const failed = (item: WorkItem): BlockedIssue => {
      const agent = nameOf(item.agentId);
      return {
        ...about(item.issue),
        stage: item.stage,
        why: `its work at ${item.stage} failed${
          agent === null ? "" : ` (${agent})`
        }, and nothing is queued again`,
      };
    };

    if (github.issues === null) {
      // From AI Office's own records: failed work with nothing after it.
      for (const item of latest.values()) {
        if (item.status === "failed" && !listed.has(item.issue)) {
          listed.add(item.issue);
          blocked.push(failed(item));
        }
      }
    } else {
      // The labels on GitHub are where each issue is (FR-18).
      for (const issue of [...github.issues.values()].sort(
        (a, b) => a.number - b.number,
      )) {
        if (listed.has(issue.number)) {
          continue;
        }
        const stage = stageOf(issue);
        if (stage === null) {
          continue;
        }
        listed.add(issue.number);
        if (
          stage === "needs-human" ||
          (stage === "ready-to-merge" && floor.mergePolicy === "send_to_me")
        ) {
          if (!askedAbout.has(issue.number)) {
            needsOwner.push({
              ...about(issue.number),
              why:
                stage === "needs-human"
                  ? "handed to you, at needs-human"
                  : "ready to merge, for your approval",
            });
          }
          continue;
        }
        const failure = failedAt(issue.number, stage);
        if (failure !== undefined) {
          blocked.push(failed(failure));
          continue;
        }
        inFlight.push({
          ...about(issue.number),
          stage,
          status: "waiting",
          agentName: null,
          since: null,
        });
      }
    }

    return {
      floorId: floor.id,
      floorName: floor.name,
      managerId: manager.id,
      managerName: manager.name,
      at,
      inFlight,
      blocked,
      needsOwner,
      tokens: {
        today: await tokensIn(floor.id, "daily", at),
        month: await tokensIn(floor.id, "monthly", at),
      },
      githubError: github.error,
    };
  };

  const deliver = async (
    composed: FloorStatusReport,
    replyTo?: number,
  ): Promise<ChatMessageRecord> => {
    const message = await options.chat.postReport(
      composed.floorId,
      statusReportText(composed),
      replyTo,
    );
    // The chat has the report; a Notice that cannot be raised never undoes it.
    await notices
      .raise(statusReportNotice(composed, options.publicUrl))
      .catch(report);
    return message;
  };

  /** Today's daily report time, at `at`. */
  const slotOf = (at: Date): Date =>
    new Date(
      Date.UTC(
        at.getUTCFullYear(),
        at.getUTCMonth(),
        at.getUTCDate(),
        dailyHour,
      ),
    );

  /** Each Floor's latest daily report time it was handled for, this process. */
  const handled = new Map<string, number>();

  const check = async (): Promise<string[]> => {
    const at = now();
    const slot = slotOf(at);
    if (at < slot) {
      return [];
    }
    const written: string[] = [];
    for (const floor of await floors.list()) {
      if (handled.get(floor.id) === slot.getTime()) {
        continue;
      }
      try {
        const team = await agents.list(floor.id);
        if (!team.some(({ role }) => role === "manager")) {
          continue;
        }
        const last = await options.chatStore.latestDailyReport(floor.id);
        if (last === undefined || last.createdAt < slot) {
          const composed = await compose(floor.id);
          // A Floor with nothing to report is not told so every day.
          if (!isQuiet(composed)) {
            await deliver(composed);
            written.push(floor.id);
          }
        }
        handled.set(floor.id, slot.getTime());
      } catch (error) {
        report(error);
      }
    }
    return written;
  };

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    round = (async () => {
      await check().catch(report);
      if (running) {
        timer = setTimeout(tick, options.intervalMs ?? 60_000);
      }
    })();
  };

  return {
    compose,
    async write(floorId, { replyTo } = {}) {
      return deliver(await compose(floorId), replyTo);
    },
    check,
    start() {
      if (running) {
        return;
      }
      running = true;
      timer = setTimeout(tick, options.intervalMs ?? 60_000);
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await round;
    },
  };
}
