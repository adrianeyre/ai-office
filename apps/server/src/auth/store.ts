import {
  owner,
  ownerPasswords,
  recoveryCodes,
  sessions,
  signInEvents,
  type Database,
} from "@ai-office/db";
import { and, count, eq, gte, isNull, lt, lte, or } from "drizzle-orm";

/** A signed-in session, as stored: `id` is the SHA-256 of its token. */
export interface SessionRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** The API key that signed in; null or absent for the Owner's password. */
  readonly gatewayKeyId?: string | null;
  /**
   * Which of the Owner's further passwords signed in; null or absent for
   * the first, or an API key.
   */
  readonly passwordId?: string | null;
  /**
   * When it was last used, to the minute; null or absent if not since it
   * began (A1-8).
   */
  readonly lastSeenAt?: Date | null;
}

/** One of the Owner's further passwords, as stored: never the password. */
export interface OwnerPasswordRecord {
  readonly id: string;
  readonly name: string;
  readonly nickname: string;
  readonly timeZone: string;
  /** Argon2id, in PHC string form. */
  readonly passwordHash: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** A checked sign-in attempt, as `sign_in_events` stores it. */
export interface SignInEvent {
  readonly occurredAt: Date;
  readonly outcome: "succeeded" | "failed";
  readonly ip: string;
  readonly userAgent: string | null;
  /** The second factor checked; absent for a password check. */
  readonly secondFactor?: "totp" | "recovery_code";
}

/** The Owner's TOTP state. Secrets are sealed (`aio1:…`), never in clear. */
export interface TotpRecord {
  /** The secret in use; null while TOTP is off. */
  readonly secret: string | null;
  /** A secret set up but not yet confirmed with a code. */
  readonly pendingSecret: string | null;
  /** The last time step a code was used for. */
  readonly lastTimeStep: number | null;
  readonly recoveryCodesLeft: number;
}

/** Where the Owner's password hash, sessions and sign-in events live. */
export interface AuthStore {
  /** The Owner's password hash; undefined until the first-run setup. */
  passwordHash(): Promise<string | undefined>;
  /**
   * Stores the Owner's first password hash. Returns false, changing
   * nothing, when a password already exists: it is set only once.
   */
  createPasswordHash(passwordHash: string): Promise<boolean>;
  createSession(session: SessionRecord): Promise<void>;
  findSession(id: string): Promise<SessionRecord | undefined>;
  deleteSession(id: string): Promise<void>;
  /** Notes that the session was used at `at` (A1-8). */
  touchSession(id: string, at: Date): Promise<void>;
  /** Ends every session ("sign out everywhere"); returns how many ended. */
  deleteAllSessions(): Promise<number>;
  /** Removes the sessions that expired at or before `now`. */
  deleteExpiredSessions(now: Date): Promise<void>;
  recordSignInEvent(event: SignInEvent): Promise<void>;
  /**
   * The sign-in events that occurred at or after `since`, oldest first:
   * what the sign-in limiter starts from (A1-7).
   */
  signInEventsSince(since: Date): Promise<SignInEvent[]>;
  /**
   * Deletes the sign-in events that occurred before `before` (retention,
   * PRD §7); resolves with how many went.
   */
  deleteSignInEventsBefore(before: Date): Promise<number>;
  totp(): Promise<TotpRecord>;
  /** Keeps a new sealed secret until a code confirms it. */
  setPendingTotpSecret(sealed: string): Promise<void>;
  /**
   * Turns TOTP on with the pending secret, if it is still `pendingSecret`
   * and TOTP is off, replacing any recovery codes. `timeStep` is the step
   * of the code that confirmed it. Returns whether it was turned on.
   */
  enableTotp(options: {
    readonly pendingSecret: string;
    readonly timeStep: number;
    readonly recoveryCodeHashes: readonly string[];
    readonly at: Date;
  }): Promise<boolean>;
  /** Turns TOTP off and deletes the recovery codes. */
  disableTotp(): Promise<void>;
  /**
   * Records that a code for `timeStep` was used. Returns false, changing
   * nothing, when that step or a later one already was (a replay).
   */
  useTotpTimeStep(timeStep: number): Promise<boolean>;
  /** Uses the unused recovery code with this hash; false if there is none. */
  useRecoveryCode(codeHash: string, at: Date): Promise<boolean>;
  /** The Owner's further passwords, oldest first. */
  ownerPasswords(): Promise<OwnerPasswordRecord[]>;
  addOwnerPassword(password: OwnerPasswordRecord): Promise<void>;
  /** Sets one's name, nickname and time zone; false if there is none. */
  updateOwnerPassword(
    id: string,
    changes: Pick<OwnerPasswordRecord, "name" | "nickname" | "timeZone">,
  ): Promise<OwnerPasswordRecord | undefined>;
  /** Removes one and ends its sessions; false if there was none. */
  deleteOwnerPassword(id: string): Promise<boolean>;
  /**
   * Replaces an Owner password's hash, the first's for `null`, and ends
   * the sessions it began (A1-9); false if there was none.
   */
  replaceOwnerPassword(
    id: string | null,
    passwordHash: string,
  ): Promise<boolean>;
  /** Notes that it signed in at `at`. */
  touchOwnerPassword(id: string, at: Date): Promise<void>;
}

/** Keeps the Owner in the `owner` table and sessions in `sessions`. */
export function databaseAuthStore(db: Database): AuthStore {
  return {
    async passwordHash() {
      const [row] = await db
        .select({ passwordHash: owner.passwordHash })
        .from(owner)
        .limit(1);
      return row?.passwordHash;
    },
    async ownerPasswords() {
      return db
        .select()
        .from(ownerPasswords)
        .orderBy(ownerPasswords.createdAt, ownerPasswords.id);
    },
    async addOwnerPassword(password) {
      await db.insert(ownerPasswords).values(password);
    },
    async updateOwnerPassword(id, changes) {
      const [row] = await db
        .update(ownerPasswords)
        .set(changes)
        .where(eq(ownerPasswords.id, id))
        .returning();
      return row;
    },
    async deleteOwnerPassword(id) {
      // Its sessions go with it (ON DELETE CASCADE).
      const deleted = await db
        .delete(ownerPasswords)
        .where(eq(ownerPasswords.id, id))
        .returning({ id: ownerPasswords.id });
      return deleted.length > 0;
    },
    async replaceOwnerPassword(id, passwordHash) {
      return db.transaction(async (tx) => {
        const replaced =
          id === null
            ? await tx
                .update(owner)
                .set({ passwordHash })
                .returning({ id: owner.id })
            : await tx
                .update(ownerPasswords)
                .set({ passwordHash })
                .where(eq(ownerPasswords.id, id))
                .returning({ id: ownerPasswords.id });
        if (replaced.length === 0) {
          return false;
        }
        // The first's sessions are those neither a further password nor
        // an API key began.
        await tx
          .delete(sessions)
          .where(
            id === null
              ? and(isNull(sessions.passwordId), isNull(sessions.gatewayKeyId))
              : eq(sessions.passwordId, id),
          );
        return true;
      });
    },
    async touchOwnerPassword(id, at) {
      await db
        .update(ownerPasswords)
        .set({ lastUsedAt: at })
        .where(eq(ownerPasswords.id, id));
    },
    async createPasswordHash(passwordHash) {
      // The table holds one row, with id 1, so a second setup (even a
      // concurrent one) inserts nothing.
      const inserted = await db
        .insert(owner)
        .values({ passwordHash })
        .onConflictDoNothing()
        .returning({ id: owner.id });
      return inserted.length === 1;
    },
    async createSession(session) {
      await db.insert(sessions).values(session);
    },
    async findSession(id) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      return row;
    },
    async deleteSession(id) {
      await db.delete(sessions).where(eq(sessions.id, id));
    },
    async touchSession(id, at) {
      await db
        .update(sessions)
        .set({ lastSeenAt: at })
        .where(eq(sessions.id, id));
    },
    async deleteAllSessions() {
      const deleted = await db.delete(sessions).returning({ id: sessions.id });
      return deleted.length;
    },
    async deleteExpiredSessions(now) {
      await db.delete(sessions).where(lte(sessions.expiresAt, now));
    },
    async recordSignInEvent(event) {
      await db.insert(signInEvents).values(event);
    },
    async signInEventsSince(since) {
      const rows = await db
        .select()
        .from(signInEvents)
        .where(gte(signInEvents.occurredAt, since))
        .orderBy(signInEvents.occurredAt, signInEvents.id);
      return rows.map(
        ({ occurredAt, outcome, ip, userAgent, secondFactor }) => ({
          occurredAt,
          outcome: outcome === "succeeded" ? "succeeded" : "failed",
          ip,
          userAgent,
          ...(secondFactor === "totp" || secondFactor === "recovery_code"
            ? { secondFactor }
            : {}),
        }),
      );
    },
    async deleteSignInEventsBefore(before) {
      const deleted = await db
        .delete(signInEvents)
        .where(lt(signInEvents.occurredAt, before));
      return deleted.rowCount ?? 0;
    },
    async totp() {
      const [row] = await db
        .select({
          secret: owner.totpSecret,
          pendingSecret: owner.totpPendingSecret,
          lastTimeStep: owner.totpLastTimeStep,
        })
        .from(owner)
        .limit(1);
      const [left] = await db
        .select({ count: count() })
        .from(recoveryCodes)
        .where(isNull(recoveryCodes.usedAt));
      return {
        secret: row?.secret ?? null,
        pendingSecret: row?.pendingSecret ?? null,
        lastTimeStep: row?.lastTimeStep ?? null,
        recoveryCodesLeft: left?.count ?? 0,
      };
    },
    async setPendingTotpSecret(sealed) {
      await db.update(owner).set({ totpPendingSecret: sealed });
    },
    async enableTotp({ pendingSecret, timeStep, recoveryCodeHashes, at }) {
      return db.transaction(async (tx) => {
        const enabled = await tx
          .update(owner)
          .set({
            totpSecret: pendingSecret,
            totpPendingSecret: null,
            totpLastTimeStep: timeStep,
            totpEnabledAt: at,
          })
          .where(
            and(
              eq(owner.totpPendingSecret, pendingSecret),
              isNull(owner.totpSecret),
            ),
          )
          .returning({ id: owner.id });
        if (enabled.length === 0) {
          return false;
        }
        await tx.delete(recoveryCodes);
        await tx
          .insert(recoveryCodes)
          .values(
            recoveryCodeHashes.map((codeHash) => ({ codeHash, createdAt: at })),
          );
        return true;
      });
    },
    async disableTotp() {
      await db.transaction(async (tx) => {
        await tx.update(owner).set({
          totpSecret: null,
          totpPendingSecret: null,
          totpLastTimeStep: null,
          totpEnabledAt: null,
        });
        await tx.delete(recoveryCodes);
      });
    },
    async useTotpTimeStep(timeStep) {
      // One statement, so two requests with the same code cannot both pass.
      const used = await db
        .update(owner)
        .set({ totpLastTimeStep: timeStep })
        .where(
          or(
            isNull(owner.totpLastTimeStep),
            lt(owner.totpLastTimeStep, timeStep),
          ),
        )
        .returning({ id: owner.id });
      return used.length === 1;
    },
    async useRecoveryCode(codeHash, at) {
      const used = await db
        .update(recoveryCodes)
        .set({ usedAt: at })
        .where(
          and(
            eq(recoveryCodes.codeHash, codeHash),
            isNull(recoveryCodes.usedAt),
          ),
        )
        .returning({ id: recoveryCodes.id });
      return used.length === 1;
    },
  };
}

interface MemoryState {
  passwordHash?: string;
  readonly ownerPasswords: Map<string, OwnerPasswordRecord>;
  readonly sessions: Map<string, SessionRecord>;
  readonly signInEvents: SignInEvent[];
  totp: Omit<TotpRecord, "recoveryCodesLeft">;
  /** Recovery code hashes, and whether each has been used. */
  readonly recoveryCodes: Map<string, boolean>;
}

/** Keeps the Owner in memory, for tests. */
export function memoryAuthStore(
  initial: { passwordHash?: string } = {},
): AuthStore & { readonly state: MemoryState } {
  const state: MemoryState = {
    ...initial,
    ownerPasswords: new Map(),
    sessions: new Map(),
    signInEvents: [],
    totp: { secret: null, pendingSecret: null, lastTimeStep: null },
    recoveryCodes: new Map(),
  };
  return {
    state,
    passwordHash() {
      return Promise.resolve(state.passwordHash);
    },
    ownerPasswords() {
      return Promise.resolve(
        [...state.ownerPasswords.values()].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        ),
      );
    },
    addOwnerPassword(password) {
      state.ownerPasswords.set(password.id, password);
      return Promise.resolve();
    },
    updateOwnerPassword(id, changes) {
      const password = state.ownerPasswords.get(id);
      if (password === undefined) {
        return Promise.resolve(undefined);
      }
      const updated = { ...password, ...changes };
      state.ownerPasswords.set(id, updated);
      return Promise.resolve(updated);
    },
    deleteOwnerPassword(id) {
      for (const [sessionId, session] of state.sessions) {
        if (session.passwordId === id) {
          state.sessions.delete(sessionId);
        }
      }
      return Promise.resolve(state.ownerPasswords.delete(id));
    },
    replaceOwnerPassword(id, passwordHash) {
      if (id === null) {
        if (state.passwordHash === undefined) {
          return Promise.resolve(false);
        }
        state.passwordHash = passwordHash;
      } else {
        const password = state.ownerPasswords.get(id);
        if (password === undefined) {
          return Promise.resolve(false);
        }
        state.ownerPasswords.set(id, { ...password, passwordHash });
      }
      for (const [sessionId, session] of state.sessions) {
        const began =
          id === null
            ? (session.passwordId ?? null) === null &&
              (session.gatewayKeyId ?? null) === null
            : session.passwordId === id;
        if (began) {
          state.sessions.delete(sessionId);
        }
      }
      return Promise.resolve(true);
    },
    touchOwnerPassword(id, at) {
      const password = state.ownerPasswords.get(id);
      if (password !== undefined) {
        state.ownerPasswords.set(id, { ...password, lastUsedAt: at });
      }
      return Promise.resolve();
    },
    createPasswordHash(passwordHash) {
      if (state.passwordHash !== undefined) {
        return Promise.resolve(false);
      }
      state.passwordHash = passwordHash;
      return Promise.resolve(true);
    },
    createSession(session) {
      state.sessions.set(session.id, session);
      return Promise.resolve();
    },
    findSession(id) {
      return Promise.resolve(state.sessions.get(id));
    },
    deleteSession(id) {
      state.sessions.delete(id);
      return Promise.resolve();
    },
    touchSession(id, at) {
      const session = state.sessions.get(id);
      if (session !== undefined) {
        state.sessions.set(id, { ...session, lastSeenAt: at });
      }
      return Promise.resolve();
    },
    deleteAllSessions() {
      const count = state.sessions.size;
      state.sessions.clear();
      return Promise.resolve(count);
    },
    deleteExpiredSessions(now) {
      for (const [id, session] of state.sessions) {
        if (session.expiresAt <= now) {
          state.sessions.delete(id);
        }
      }
      return Promise.resolve();
    },
    recordSignInEvent(event) {
      state.signInEvents.push(event);
      return Promise.resolve();
    },
    signInEventsSince(since) {
      return Promise.resolve(
        state.signInEvents
          .filter(({ occurredAt }) => occurredAt >= since)
          .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
      );
    },
    deleteSignInEventsBefore(before) {
      const kept = state.signInEvents.filter(
        ({ occurredAt }) => occurredAt >= before,
      );
      const deleted = state.signInEvents.length - kept.length;
      state.signInEvents.splice(0, state.signInEvents.length, ...kept);
      return Promise.resolve(deleted);
    },
    totp() {
      return Promise.resolve({
        ...state.totp,
        recoveryCodesLeft: [...state.recoveryCodes.values()].filter(
          (used) => !used,
        ).length,
      });
    },
    setPendingTotpSecret(sealed) {
      state.totp = { ...state.totp, pendingSecret: sealed };
      return Promise.resolve();
    },
    enableTotp({ pendingSecret, timeStep, recoveryCodeHashes }) {
      if (
        state.totp.pendingSecret !== pendingSecret ||
        state.totp.secret !== null
      ) {
        return Promise.resolve(false);
      }
      state.totp = {
        secret: pendingSecret,
        pendingSecret: null,
        lastTimeStep: timeStep,
      };
      state.recoveryCodes.clear();
      for (const codeHash of recoveryCodeHashes) {
        state.recoveryCodes.set(codeHash, false);
      }
      return Promise.resolve(true);
    },
    disableTotp() {
      state.totp = { secret: null, pendingSecret: null, lastTimeStep: null };
      state.recoveryCodes.clear();
      return Promise.resolve();
    },
    useTotpTimeStep(timeStep) {
      const last = state.totp.lastTimeStep;
      if (last !== null && last >= timeStep) {
        return Promise.resolve(false);
      }
      state.totp = { ...state.totp, lastTimeStep: timeStep };
      return Promise.resolve(true);
    },
    useRecoveryCode(codeHash) {
      if (state.recoveryCodes.get(codeHash) !== false) {
        return Promise.resolve(false);
      }
      state.recoveryCodes.set(codeHash, true);
      return Promise.resolve(true);
    },
  };
}
