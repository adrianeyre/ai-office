import { issueTokenCaps, officeSettings, type Database } from "@ai-office/db";
import type { OfficeTokenCaps, TokenCaps } from "@ai-office/shared";
import { and, desc, eq } from "drizzle-orm";

// Where Token Caps set at the office and issue levels live (PRD FR-32):
// the office's defaults in `office_settings`, issues' caps in
// `issue_token_caps`. Floors' and Agents' caps live with them.

/** One issue's own caps. */
export interface IssueTokenCapRecord {
  readonly floorId: string;
  readonly issue: number;
  readonly caps: TokenCaps;
}

export interface TokenCapStore {
  /** The office's caps the Owner set; each unset one absent. */
  officeCaps(): Promise<Partial<OfficeTokenCaps>>;
  setOfficeCaps(caps: OfficeTokenCaps, at: Date): Promise<void>;
  /** A Floor's issues with caps of their own, newest issue first. */
  issueCaps(floorId: string): Promise<IssueTokenCapRecord[]>;
  /** Sets an issue's caps; with neither period set, it has none. */
  setIssueCaps(
    floorId: string,
    issue: number,
    caps: TokenCaps,
    at: Date,
  ): Promise<void>;
}

const hasCaps = (caps: TokenCaps): boolean =>
  caps.daily !== null || caps.monthly !== null;

/** Keeps Token Caps in memory: for tests. */
export function memoryTokenCapStore(): TokenCapStore {
  let office: Partial<OfficeTokenCaps> = {};
  const issues = new Map<string, IssueTokenCapRecord>();
  const key = (floorId: string, issue: number) => `${floorId}#${String(issue)}`;
  return {
    officeCaps: () => Promise.resolve({ ...office }),
    setOfficeCaps(caps) {
      office = { ...caps };
      return Promise.resolve();
    },
    issueCaps: (floorId) =>
      Promise.resolve(
        [...issues.values()]
          .filter((record) => record.floorId === floorId)
          .sort((a, b) => b.issue - a.issue)
          .map((record) => ({ ...record, caps: { ...record.caps } })),
      ),
    setIssueCaps(floorId, issue, caps) {
      if (hasCaps(caps)) {
        issues.set(key(floorId, issue), { floorId, issue, caps: { ...caps } });
      } else {
        issues.delete(key(floorId, issue));
      }
      return Promise.resolve();
    },
  };
}

/** Keeps Token Caps in `office_settings` and `issue_token_caps`. */
export function databaseTokenCapStore(db: Database): TokenCapStore {
  return {
    async officeCaps() {
      const [row] = await db
        .select({
          daily: officeSettings.dailyTokenCap,
          monthly: officeSettings.monthlyTokenCap,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return {
        ...(row?.daily == null ? {} : { daily: row.daily }),
        ...(row?.monthly == null ? {} : { monthly: row.monthly }),
      };
    },
    async setOfficeCaps(caps, at) {
      const values = {
        dailyTokenCap: caps.daily,
        monthlyTokenCap: caps.monthly,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async issueCaps(floorId) {
      const rows = await db
        .select()
        .from(issueTokenCaps)
        .where(eq(issueTokenCaps.floorId, floorId))
        .orderBy(desc(issueTokenCaps.issue));
      return rows.map((row) => ({
        floorId: row.floorId,
        issue: row.issue,
        caps: { daily: row.dailyTokenCap, monthly: row.monthlyTokenCap },
      }));
    },
    async setIssueCaps(floorId, issue, caps, at) {
      if (!hasCaps(caps)) {
        await db
          .delete(issueTokenCaps)
          .where(
            and(
              eq(issueTokenCaps.floorId, floorId),
              eq(issueTokenCaps.issue, issue),
            ),
          );
        return;
      }
      const values = {
        dailyTokenCap: caps.daily,
        monthlyTokenCap: caps.monthly,
        updatedAt: at,
      };
      await db
        .insert(issueTokenCaps)
        .values({ floorId, issue, ...values })
        .onConflictDoUpdate({
          target: [issueTokenCaps.floorId, issueTokenCaps.issue],
          set: values,
        });
    },
  };
}
