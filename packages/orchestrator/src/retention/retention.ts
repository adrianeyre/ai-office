import {
  retentionCutoff,
  retentionRules,
  type RetentionRule,
  type RetentionSettings,
} from "@ai-office/shared";

// Retention (PRD §7): scheduled jobs that delete what AI Office records
// once it is past the period the Owner set in the office admin (FR-65).
// Request and response bodies go after 7 days, requests' records and AI
// Accounts' usage readings after 90, the Activity Feed, closed Notices and
// sign-ins after a year, and Connections' finished deliveries after 90
// days, by default. Each rule runs on its own, so one
// that fails leaves the others to run. What Token Caps count outlives the
// records (the request history keeps it a day at a time). Beside the
// Owner's rules, Manager chat attachments uploaded but never sent go after
// a day, a period of their own (FR-24).

/** What each rule deletes: everything recorded before `before`. */
export interface RetentionTargets {
  /** Request and response bodies, keeping the requests. */
  requestBodies(before: Date): Promise<number>;
  /** Requests' records (with their bodies) and AI Accounts' readings. */
  requestMetadata(before: Date): Promise<number>;
  /** Activity Feed events, closed Notices and sign-in records. */
  activity(before: Date): Promise<number>;
  /** Connections' finished deliveries; those still to go stay. */
  connectionDeliveries(before: Date): Promise<number>;
  /**
   * Manager chat attachments uploaded before `before` and never sent
   * (FR-24); sent ones stay with their messages. Run a day back, always.
   */
  unsentChatAttachments?(before: Date): Promise<number>;
}

/** A job retention runs: one of the Owner's rules, or a fixed one. */
export type RetentionJob = RetentionRule | "unsentChatAttachments";

/** How long an attachment never sent is kept: a day. */
const unsentChatAttachmentsMs = 24 * 60 * 60 * 1000;

/** What one run did. */
export interface RetentionReport {
  /** Each rule that ran: its cutoff, and how many records went. */
  readonly deleted: readonly {
    readonly rule: RetentionJob;
    readonly before: Date;
    readonly count: number;
  }[];
  /** Each rule that failed, and why. */
  readonly failed: readonly {
    readonly rule: RetentionJob;
    readonly error: unknown;
  }[];
}

export interface Retention {
  /** Deletes everything past its retention period now. */
  run(): Promise<RetentionReport>;
  /** Runs now, then every hour (or `intervalMs`), until stopped. */
  start(): void;
  stop(): Promise<void>;
}

export interface RetentionOptions {
  /** The periods in force; read afresh for every run. */
  readonly settings: () => Promise<RetentionSettings>;
  readonly targets: RetentionTargets;
  readonly now?: () => Date;
  /** How often it runs; an hour by default. */
  readonly intervalMs?: number;
  /** Told what each scheduled run did. */
  readonly onReport?: (report: RetentionReport) => void;
  /** Told when a scheduled run could not start, such as unread settings. */
  readonly onError?: (error: unknown) => void;
}

const targetOf: Readonly<
  Record<
    RetentionRule,
    Exclude<keyof RetentionTargets, "unsentChatAttachments">
  >
> = {
  requestBodiesDays: "requestBodies",
  requestMetadataDays: "requestMetadata",
  activityDays: "activity",
  connectionDeliveriesDays: "connectionDeliveries",
};

export function createRetention(options: RetentionOptions): Retention {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;

  // One run at a time: a run asked for during another waits for it.
  let running: Promise<unknown> = Promise.resolve();
  const runOnce = async (): Promise<RetentionReport> => {
    const settings = await options.settings();
    const at = now();
    const deleted: RetentionReport["deleted"][number][] = [];
    const failed: RetentionReport["failed"][number][] = [];
    for (const rule of retentionRules) {
      const before = retentionCutoff(at, settings[rule]);
      try {
        const count = await options.targets[targetOf[rule]](before);
        deleted.push({ rule, before, count });
      } catch (error) {
        failed.push({ rule, error });
      }
    }
    const { targets } = options;
    if (targets.unsentChatAttachments !== undefined) {
      const rule = "unsentChatAttachments";
      const before = new Date(at.getTime() - unsentChatAttachmentsMs);
      try {
        deleted.push({
          rule,
          before,
          count: await targets.unsentChatAttachments(before),
        });
      } catch (error) {
        failed.push({ rule, error });
      }
    }
    return { deleted, failed };
  };
  const run = (): Promise<RetentionReport> => {
    const report = running.then(runOnce);
    running = report.catch(() => undefined);
    return report;
  };

  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<unknown> = Promise.resolve();
  const tick = (): void => {
    round = (async () => {
      await run().then(
        (report) => options.onReport?.(report),
        (error: unknown) => options.onError?.(error),
      );
      if (started) {
        timer = setTimeout(tick, intervalMs);
      }
    })();
  };

  return {
    run,
    start() {
      if (started) {
        return;
      }
      started = true;
      tick();
    },
    async stop() {
      started = false;
      clearTimeout(timer);
      await round;
    },
  };
}
