import type { EventBus } from "@ai-office/events";
import {
  addTokens,
  capPeriods,
  communicationsAgentId,
  defaultOfficeTokenCaps,
  floorErrorCodes,
  noTokenCaps,
  noTokens,
  periodBounds,
  resolveTokenCap,
  type CapPeriod,
  type CapUse,
  type FloorTokenUsage,
  type OfficeTokenCaps,
  type OfficeTokenUsage,
  type PeriodCapUse,
  type PeriodTotals,
  type TokenCaps,
  type TokenTotals,
  type TokenUsageRow,
} from "@ai-office/shared";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { TokenCapStore } from "./store.ts";

// Token accounting and Token Caps (PRD §6.7, FR-31, FR-32). Tokens are
// added up from the AI Gateway's request records per Agent, Floor, issue
// and Owner tool, for the day and the month (UTC). Caps are set at four
// levels: the office's daily and monthly defaults, and optional overrides
// per Floor, per Agent and per issue. For an Agent's work the most
// specific cap set applies, period by period (`resolveTokenCap`): an
// issue's cap counts the tokens every Agent used on that issue; an Agent's,
// its Floor's or the office's count the Agent's own. Each level is shown
// with its use. Refusing calls at a cap is `createCapEnforcement`.

/**
 * Why the Gateway refuses the Communications Agent's call (FR-90): the
 * office's cap it has reached; undefined while it is under them.
 */
export async function communicationsCapRefusal(
  caps: Pick<TokenCapService, "communicationsCapUse">,
): Promise<{ readonly message: string } | undefined> {
  const use = await caps.communicationsCapUse();
  const period = capPeriods.find(
    (candidate) => use[candidate].used >= use[candidate].cap,
  );
  if (period === undefined) {
    return undefined;
  }
  return {
    message: `The Communications Agent reached the office's ${period} Token Cap (${use[period].cap.toLocaleString("en-US")} tokens). Its Digests are written without a model until the ${period === "daily" ? "day" : "month"} is over, or the Owner raises the cap.`,
  };
}

/**
 * Why the Gateway refuses an Owner tool's call (FR-33, FR-46; pen-testing
 * G1-3): the office's cap its own tokens have reached; undefined while it
 * is under them. The Terminal is an Owner tool too.
 */
export async function ownerToolCapRefusal(
  caps: Pick<TokenCapService, "ownerToolCapUse">,
  ownerTool: string,
): Promise<{ readonly message: string } | undefined> {
  const use = await caps.ownerToolCapUse(ownerTool);
  const period = capPeriods.find(
    (candidate) => use[candidate].used >= use[candidate].cap,
  );
  if (period === undefined) {
    return undefined;
  }
  return {
    message: `The Owner tool "${ownerTool}" reached the office's ${period} Token Cap (${use[period].cap.toLocaleString("en-US")} tokens), so AI Office refuses its calls until the ${period === "daily" ? "day" : "month"} is over, or the Owner raises the office's cap.`,
  };
}

/** Who is working: an Agent on its Floor, perhaps on an issue. */
export interface CapSubject {
  readonly floorId: string;
  readonly agentId: string;
  readonly issue?: number | undefined;
}

export interface TokenCapService {
  /** The office's default caps: the Owner's, or `defaultOfficeTokenCaps`. */
  officeCaps(): Promise<OfficeTokenCaps>;
  /** Sets the office's caps; `config.changed` names them, not their values. */
  setOfficeCaps(caps: OfficeTokenCaps): Promise<OfficeTokenCaps>;
  /**
   * Sets an issue's caps on a Floor in use; null in both periods removes
   * them. `config.changed` names the issue, not the caps.
   */
  setIssueCaps(
    floorId: string,
    issue: number,
    caps: TokenCaps,
  ): Promise<TokenCaps>;
  /** An issue's own caps; null in a period it sets none. */
  issueCaps(floorId: string, issue: number): Promise<TokenCaps>;
  /** The caps in force for an Agent's work now, and their use. */
  capUse(subject: CapSubject): Promise<PeriodCapUse>;
  /**
   * The office's caps, against the Communications Agent's own use (FR-90):
   * it belongs to no Floor, so they are the only ones it has.
   */
  communicationsCapUse(): Promise<PeriodCapUse>;
  /**
   * The office's caps, against one Owner tool's own use (FR-33; pen-testing
   * G1-3): each Owner tool's key, the Terminal's too, is held to them as
   * each Agent is by default.
   */
  ownerToolCapUse(ownerTool: string): Promise<PeriodCapUse>;
  /** The office's caps and the Office's use: totals, Floors, Owner tools. */
  officeUsage(): Promise<OfficeTokenUsage>;
  /** A Floor's caps and use: its Agents' against their caps, its issues'. */
  floorUsage(floorId: string): Promise<FloorTokenUsage>;
}

export interface TokenCapsOptions {
  readonly store: TokenCapStore;
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly events: Pick<EventBus, "publish">;
  /**
   * What requests started in [`from`, `to`) used, per Floor, Agent, issue
   * and Owner tool: the AI Gateway's request history.
   */
  readonly usage: (from: Date, to: Date) => Promise<TokenUsageRow[]>;
  readonly now?: () => Date;
}

/** One period's request rows, added up the ways the caps need. */
class PeriodUsage {
  readonly total: TokenTotals;
  private readonly rows: readonly TokenUsageRow[];

  constructor(rows: readonly TokenUsageRow[]) {
    this.rows = rows;
    this.total = PeriodUsage.sum(rows);
  }

  private static sum(rows: readonly TokenUsageRow[]): TokenTotals {
    return rows.reduce((sum, row) => addTokens(sum, row.totals), noTokens);
  }

  /** Every row where `match` holds, added up. */
  where(match: (row: TokenUsageRow) => boolean): TokenTotals {
    return PeriodUsage.sum(this.rows.filter(match));
  }

  agent(agentId: string): TokenTotals {
    return this.where((row) => row.agentId === agentId);
  }

  floor(floorId: string): TokenTotals {
    return this.where((row) => row.floorId === floorId);
  }

  issue(floorId: string, issue: number): TokenTotals {
    return this.where((row) => row.floorId === floorId && row.issue === issue);
  }

  /** The distinct values of `key` that used anything, in first-seen order. */
  keys<Key>(key: (row: TokenUsageRow) => Key | null): Key[] {
    return [
      ...new Set(
        this.rows.flatMap((row) => {
          const value = key(row);
          return value === null ? [] : [value];
        }),
      ),
    ];
  }
}

type Usage = Record<CapPeriod, PeriodUsage>;

const both = (
  usage: Usage,
  pick: (period: PeriodUsage) => TokenTotals,
): PeriodTotals => ({ daily: pick(usage.daily), monthly: pick(usage.monthly) });

export function createTokenCaps(options: TokenCapsOptions): TokenCapService {
  const { store, floors, agents, events } = options;
  const now = options.now ?? (() => new Date());

  const officeCaps = async (): Promise<OfficeTokenCaps> => ({
    ...defaultOfficeTokenCaps,
    ...(await store.officeCaps()),
  });

  /** The day's and the month's request rows, as of now. */
  const usageNow = async (): Promise<Usage> => {
    const at = now();
    const [daily, monthly] = await Promise.all(
      capPeriods.map(async (period) => {
        const { from, to } = periodBounds(period, at);
        return new PeriodUsage(await options.usage(from, to));
      }),
    );
    return {
      daily: daily ?? new PeriodUsage([]),
      monthly: monthly ?? new PeriodUsage([]),
    };
  };

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  const issueCapsOf = async (floorId: string, issue: number) =>
    (await store.issueCaps(floorId)).find((record) => record.issue === issue)
      ?.caps;

  /** The caps in force for an Agent's work, with what they count. */
  const capUseOf = (
    levels: {
      readonly office: OfficeTokenCaps;
      readonly floor: FloorRecord;
      readonly agent: AgentRecord;
      readonly issue?: number | undefined;
      readonly issueCaps?: TokenCaps | undefined;
    },
    usage: Usage,
  ): PeriodCapUse => {
    const use = (period: CapPeriod): CapUse => {
      const resolved = resolveTokenCap(
        {
          office: levels.office,
          floor: levels.floor.tokenCaps,
          agent: levels.agent.tokenCaps,
          issue: levels.issueCaps,
        },
        period,
      );
      // An issue's cap counts the issue's tokens; the others the Agent's.
      const used =
        resolved.level === "issue" && levels.issue !== undefined
          ? usage[period].issue(levels.floor.id, levels.issue)
          : usage[period].agent(levels.agent.id);
      return { ...resolved, used: used.tokens };
    };
    return { daily: use("daily"), monthly: use("monthly") };
  };

  return {
    officeCaps,

    async setOfficeCaps(caps) {
      const current = await officeCaps();
      const keys = capPeriods
        .filter((period) => caps[period] !== current[period])
        .map((period) => `tokenCaps.${period}`);
      if (keys.length > 0) {
        await store.setOfficeCaps(caps, now());
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "office",
          keys,
        });
      }
      return officeCaps();
    },

    async setIssueCaps(floorId, issue, caps) {
      const floor = await floorOf(floorId);
      if (floor.archivedAt !== null) {
        throw new FloorError(
          floorErrorCodes.floorArchived,
          `The Floor "${floor.name}" is archived.`,
        );
      }
      const current = (await issueCapsOf(floorId, issue)) ?? noTokenCaps;
      const changed = capPeriods.filter(
        (period) => caps[period] !== current[period],
      );
      if (changed.length > 0) {
        await store.setIssueCaps(floorId, issue, caps, now());
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "floor",
          floorId,
          keys: changed.map(
            (period) => `issues.${String(issue)}.tokenCaps.${period}`,
          ),
        });
      }
      return { ...caps };
    },

    async issueCaps(floorId, issue) {
      return { ...((await issueCapsOf(floorId, issue)) ?? noTokenCaps) };
    },

    async capUse({ floorId, agentId, issue }) {
      const floor = await floorOf(floorId);
      const agent = (await agents.list(floorId)).find(
        ({ id }) => id === agentId,
      );
      if (agent === undefined) {
        throw new Error(`There is no Agent "${agentId}" on ${floor.name}.`);
      }
      const [office, issueCaps, usage] = await Promise.all([
        officeCaps(),
        issue === undefined ? undefined : issueCapsOf(floorId, issue),
        usageNow(),
      ]);
      return capUseOf({ office, floor, agent, issue, issueCaps }, usage);
    },

    async communicationsCapUse() {
      const [office, usage] = await Promise.all([officeCaps(), usageNow()]);
      const use = (period: CapPeriod): CapUse => ({
        level: "office",
        cap: office[period],
        used: usage[period].agent(communicationsAgentId).tokens,
      });
      return { daily: use("daily"), monthly: use("monthly") };
    },

    async ownerToolCapUse(ownerTool) {
      const [office, usage] = await Promise.all([officeCaps(), usageNow()]);
      const use = (period: CapPeriod): CapUse => ({
        level: "office",
        cap: office[period],
        used: usage[period].where(
          (row) => row.agentId === null && row.ownerTool === ownerTool,
        ).tokens,
      });
      return { daily: use("daily"), monthly: use("monthly") };
    },

    async officeUsage() {
      const [office, usage, allFloors] = await Promise.all([
        officeCaps(),
        usageNow(),
        floors.list({ includeArchived: true }),
      ]);
      const teams = new Map(
        await Promise.all(
          allFloors.map(
            async (floor) => [floor.id, await agents.list(floor.id)] as const,
          ),
        ),
      );
      // The Agent nearest its cap in each period, outside issue caps.
      const nearest = (period: CapPeriod) => {
        let found: OfficeTokenUsage["busiestAgents"][CapPeriod] = null;
        for (const floor of allFloors) {
          for (const agent of teams.get(floor.id) ?? []) {
            const use = capUseOf({ office, floor, agent }, usage)[period];
            if (
              use.used > 0 &&
              (found === null ||
                use.used / use.cap > found.use.used / found.use.cap)
            ) {
              found = { floorId: floor.id, agentId: agent.id, use };
            }
          }
        }
        return found;
      };
      return {
        caps: office,
        usage: both(usage, (period) => period.total),
        busiestAgents: { daily: nearest("daily"), monthly: nearest("monthly") },
        floors: usage.monthly
          .keys((row) => row.floorId)
          .sort()
          .map((floorId) => ({
            floorId,
            usage: both(usage, (period) => period.floor(floorId)),
          })),
        ownerTools: usage.monthly
          .keys((row) => row.ownerTool)
          .sort()
          .map((ownerTool) => ({
            ownerTool,
            usage: both(usage, (period) =>
              period.where((row) => row.ownerTool === ownerTool),
            ),
          })),
      };
    },

    async floorUsage(floorId) {
      const floor = await floorOf(floorId);
      const [office, usage, team, issueCaps] = await Promise.all([
        officeCaps(),
        usageNow(),
        agents.list(floorId),
        store.issueCaps(floorId),
      ]);
      const defaults = (period: CapPeriod) =>
        resolveTokenCap({ office, floor: floor.tokenCaps }, period);
      const used = usage.monthly.keys((row) =>
        row.floorId === floorId ? row.issue : null,
      );
      const issues = [
        ...new Set([...issueCaps.map(({ issue }) => issue), ...used]),
      ].sort((a, b) => b - a);
      return {
        floorId,
        caps: floor.tokenCaps,
        agentDefaults: {
          daily: defaults("daily"),
          monthly: defaults("monthly"),
        },
        usage: both(usage, (period) => period.floor(floorId)),
        agents: team.map((agent) => ({
          agentId: agent.id,
          usage: both(usage, (period) => period.agent(agent.id)),
          caps: capUseOf({ office, floor, agent }, usage),
        })),
        issues: issues.map((issue) => ({
          issue,
          caps:
            issueCaps.find((record) => record.issue === issue)?.caps ??
            noTokenCaps,
          usage: both(usage, (period) => period.issue(floorId, issue)),
        })),
      };
    },
  };
}
