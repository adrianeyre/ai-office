import { aiAccounts, aiAccountUsage, type Database } from "@ai-office/db";
import {
  creditBalanceSchema,
  rateLimitsSchema,
  type AiAccountLimitReason,
  type AiAccountType,
  type CreditBalance,
  type RateLimits,
  type UsageWindow,
} from "@ai-office/shared";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

// Where AI Accounts live (PRD FR-35, FR-36): the `ai_accounts` table, or
// memory for tests. The store only ever sees credentials sealed.

/** An AI Account as the Gateway holds it, its credential sealed. */
export interface AiAccountRecord {
  readonly id: string;
  readonly name: string;
  readonly accountType: AiAccountType;
  readonly aiProvider: string;
  /** Sealed with ENCRYPTION_KEY (`aio1:…`); never in clear. */
  readonly credential: string;
  /** In place of the AI Provider's own API; null for that. */
  readonly endpointUrl: string | null;
  /**
   * A cloud platform's account's region (an AWS region, or a Vertex AI
   * location), and a Vertex AI account's Google Cloud project; null for
   * every other account.
   */
  readonly region: string | null;
  readonly projectId: string | null;
  /** 1 is used first. */
  readonly priority: number;
  readonly paused: boolean;
  /**
   * An OAuth account's refresh token, sealed (`aio1:…`), when its access
   * token (`credential`) expires, and whether the Owner must sign in
   * again. Null, null and false for a key-based account.
   */
  readonly refreshToken: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly reauthenticationNeeded: boolean;
  /**
   * Why the AI Gateway holds it back (FR-38, FR-39), and until when; both
   * null while it is not.
   */
  readonly limitReason: AiAccountLimitReason | null;
  readonly limitedUntil: Date | null;
  /**
   * Its usage windows as its AI Provider last reported them (FR-36): the
   * share used, in percent, and when each resets; null for windows not
   * reported. And the share of each it is held back at; null for none.
   */
  readonly fiveHourUtilization: number | null;
  readonly fiveHourResetsAt: Date | null;
  readonly weeklyUtilization: number | null;
  readonly weeklyResetsAt: Date | null;
  readonly fiveHourPauseThreshold: number | null;
  readonly weeklyPauseThreshold: number | null;
  /** The Model it is always sent (FR-41); null for the Model asked for. */
  readonly forcedModel: string | null;
  /**
   * Whether it goes on past its plan's limits on extra usage (FR-41); only
   * ever true for a kind that offers it.
   */
  readonly extraUsage: boolean;
  /**
   * An API key's per-minute rate limits as its latest answer reported them
   * (FR-36); null (or absent) for none.
   */
  readonly rateLimits?: RateLimits | null;
  /** A prepaid account's credit, as last read (FR-36); null for none. */
  readonly balance?: CreditBalance | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One reading of a usage window, in an account's usage history. */
export interface UsageRecord {
  readonly aiAccountId: string;
  readonly window: UsageWindow;
  /** In percent. */
  readonly utilization: number;
  readonly resetsAt: Date;
  readonly observedAt: Date;
}

/** What can change about an AI Account after it is added. */
export interface AiAccountChanges {
  readonly name?: string;
  readonly priority?: number;
  readonly paused?: boolean;
  /** An OAuth account's new tokens, sealed, after a refresh or sign-in. */
  readonly credential?: string;
  readonly refreshToken?: string;
  readonly tokenExpiresAt?: Date;
  readonly reauthenticationNeeded?: boolean;
  /** Where a sign-in says its API is now (Qwen's `resource_url`). */
  readonly endpointUrl?: string | null;
  /** Held back, or (both null) no longer. */
  readonly limitReason?: AiAccountLimitReason | null;
  readonly limitedUntil?: Date | null;
  /** New usage windows, or (null) none: a force-reset. */
  readonly fiveHourUtilization?: number | null;
  readonly fiveHourResetsAt?: Date | null;
  readonly weeklyUtilization?: number | null;
  readonly weeklyResetsAt?: Date | null;
  readonly fiveHourPauseThreshold?: number | null;
  readonly weeklyPauseThreshold?: number | null;
  readonly forcedModel?: string | null;
  readonly extraUsage?: boolean;
  readonly rateLimits?: RateLimits | null;
  readonly balance?: CreditBalance | null;
  readonly updatedAt: Date;
}

export interface AiAccountStore {
  /** In the order they are used: by priority, then oldest first. */
  list(): Promise<AiAccountRecord[]>;
  get(id: string): Promise<AiAccountRecord | undefined>;
  /** Adds an account, unless another one has its name. */
  add(account: AiAccountRecord): Promise<"added" | "name_taken">;
  /**
   * Changes an account; undefined if there is none by that id, and
   * `name_taken` if another one has the new name.
   */
  update(
    id: string,
    changes: AiAccountChanges,
  ): Promise<AiAccountRecord | "name_taken" | undefined>;
  /** Deletes an account, and its usage history; false if there was none. */
  remove(id: string): Promise<boolean>;
  /** Keeps a reading of a usage window. */
  addUsage(reading: UsageRecord): Promise<void>;
  /** An account's readings since `since`, newest first, at most `limit`. */
  usageHistory(
    id: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<UsageRecord[]>;
  /**
   * Deletes every account's readings observed before `before` (retention,
   * PRD §7); resolves with how many went.
   */
  deleteUsageBefore(before: Date): Promise<number>;
}

const inOrder = (a: AiAccountRecord, b: AiAccountRecord): number =>
  a.priority - b.priority ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  a.id.localeCompare(b.id);

/** Keeps AI Accounts in memory: for tests. */
export function memoryAiAccountStore(): AiAccountStore & {
  readonly accounts: Map<string, AiAccountRecord>;
  readonly usage: UsageRecord[];
} {
  const accounts = new Map<string, AiAccountRecord>();
  const usage: UsageRecord[] = [];
  const nameTaken = (name: string, except?: string): boolean =>
    [...accounts.values()].some(
      (account) => account.name === name && account.id !== except,
    );
  return {
    accounts,
    usage,
    list() {
      return Promise.resolve([...accounts.values()].sort(inOrder));
    },
    get(id) {
      return Promise.resolve(accounts.get(id));
    },
    add(account) {
      if (accounts.has(account.id)) {
        return Promise.reject(new Error(`AI Account ${account.id} exists.`));
      }
      if (nameTaken(account.name)) {
        return Promise.resolve("name_taken");
      }
      accounts.set(account.id, account);
      return Promise.resolve("added");
    },
    update(id, changes) {
      const account = accounts.get(id);
      if (account === undefined) {
        return Promise.resolve(undefined);
      }
      if (changes.name !== undefined && nameTaken(changes.name, id)) {
        return Promise.resolve("name_taken");
      }
      const updated = { ...account, ...changes };
      accounts.set(id, updated);
      return Promise.resolve(updated);
    },
    remove(id) {
      for (let index = usage.length - 1; index >= 0; index -= 1) {
        if (usage[index]?.aiAccountId === id) {
          usage.splice(index, 1);
        }
      }
      return Promise.resolve(accounts.delete(id));
    },
    addUsage(reading) {
      usage.push(reading);
      return Promise.resolve();
    },
    usageHistory(id, { since, limit }) {
      return Promise.resolve(
        usage
          .filter(
            (reading) =>
              reading.aiAccountId === id && reading.observedAt >= since,
          )
          .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
          .slice(0, limit),
      );
    },
    deleteUsageBefore(before) {
      const kept = usage.filter(({ observedAt }) => observedAt >= before);
      const deleted = usage.length - kept.length;
      usage.splice(0, usage.length, ...kept);
      return Promise.resolve(deleted);
    },
  };
}

type AiAccountRow = typeof aiAccounts.$inferSelect;

const toRecord = (row: AiAccountRow): AiAccountRecord => ({
  ...row,
  // The table's check constraints allow only these.
  accountType: row.accountType as AiAccountType,
  limitReason: row.limitReason as AiAccountLimitReason | null,
  // Kept as JSON: what does not read as one is none.
  rateLimits: rateLimitsSchema.nullable().catch(null).parse(row.rateLimits),
  balance: creditBalanceSchema.nullable().catch(null).parse(row.balance),
});

/** Whether `error` is Postgres refusing a second account of one name. */
const isNameTaken = (error: unknown): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && constraint === "ai_accounts_name_unique") {
      return true;
    }
  }
  return false;
};

/** Keeps AI Accounts in the `ai_accounts` table. */
export function databaseAiAccountStore(db: Database): AiAccountStore {
  return {
    async list() {
      const rows = await db
        .select()
        .from(aiAccounts)
        .orderBy(
          asc(aiAccounts.priority),
          asc(aiAccounts.createdAt),
          asc(aiAccounts.id),
        );
      return rows.map(toRecord);
    },

    async get(id) {
      const [row] = await db
        .select()
        .from(aiAccounts)
        .where(eq(aiAccounts.id, id));
      return row === undefined ? undefined : toRecord(row);
    },

    async add(account) {
      try {
        await db.insert(aiAccounts).values(account);
        return "added";
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },

    async update(id, changes) {
      try {
        const [row] = await db
          .update(aiAccounts)
          .set(changes)
          .where(eq(aiAccounts.id, id))
          .returning();
        return row === undefined ? undefined : toRecord(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },

    async remove(id) {
      const deleted = await db
        .delete(aiAccounts)
        .where(eq(aiAccounts.id, id))
        .returning({ id: aiAccounts.id });
      return deleted.length > 0;
    },

    async addUsage(reading) {
      await db.insert(aiAccountUsage).values(reading);
    },

    async usageHistory(id, { since, limit }) {
      const rows = await db
        .select()
        .from(aiAccountUsage)
        .where(
          and(
            eq(aiAccountUsage.aiAccountId, id),
            gte(aiAccountUsage.observedAt, since),
          ),
        )
        .orderBy(desc(aiAccountUsage.observedAt), desc(aiAccountUsage.id))
        .limit(limit);
      return rows.map(
        ({ aiAccountId, window, utilization, resetsAt, observedAt }) => ({
          aiAccountId,
          // The table's check constraint allows only these.
          window: window as UsageWindow,
          utilization,
          resetsAt,
          observedAt,
        }),
      );
    },

    async deleteUsageBefore(before) {
      const deleted = await db
        .delete(aiAccountUsage)
        .where(lt(aiAccountUsage.observedAt, before));
      return deleted.rowCount ?? 0;
    },
  };
}
