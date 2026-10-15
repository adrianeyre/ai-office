import { githubConnections, type Database } from "@ai-office/db";
import type { GitHubConnectionKind } from "@ai-office/shared";
import { asc, eq } from "drizzle-orm";

// Where the GitHub Apps and access tokens the Owner added live (ADR 0011):
// the `github_connections` table, or memory for tests. The private key and
// the tokens are kept sealed, as the service sealed them.

/** One GitHub connection, as AI Office stores it. */
export interface GitHubConnectionRecord {
  readonly id: string;
  readonly kind: GitHubConnectionKind;
  readonly name: string;
  /** An App's ID; null for an access token. */
  readonly appId: string | null;
  /** An App's PEM private key, sealed; null for an access token. */
  readonly privateKey: string | null;
  /** The access token, sealed; null for an App. */
  readonly token: string | null;
  /** The read-only token sandboxes get, sealed; null for an App. */
  readonly readOnlyToken: string | null;
  /** The key's or the token's last characters. */
  readonly hint: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/** What can change about a connection once it is stored. */
export interface GitHubConnectionChanges {
  readonly name?: string;
  readonly enabled?: boolean;
}

export interface GitHubConnectionStore {
  /** Oldest first. */
  list(): Promise<GitHubConnectionRecord[]>;
  /** Adds a connection, unless an App of its ID is kept already. */
  add(record: GitHubConnectionRecord): Promise<"added" | "app_id_taken">;
  /** Changes a connection; undefined if there is none by that id. */
  update(
    id: string,
    changes: GitHubConnectionChanges,
  ): Promise<GitHubConnectionRecord | undefined>;
  /** Deletes a connection: whether there was one. */
  remove(id: string): Promise<boolean>;
}

const oldestFirst = (
  a: GitHubConnectionRecord,
  b: GitHubConnectionRecord,
): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** Keeps GitHub connections in memory: for tests. */
export function memoryGitHubConnectionStore(): GitHubConnectionStore & {
  readonly connections: Map<string, GitHubConnectionRecord>;
} {
  const connections = new Map<string, GitHubConnectionRecord>();
  return {
    connections,
    list: () =>
      Promise.resolve(
        [...connections.values()].sort(oldestFirst).map((row) => ({ ...row })),
      ),
    add(record) {
      if (
        record.appId !== null &&
        [...connections.values()].some(({ appId }) => appId === record.appId)
      ) {
        return Promise.resolve("app_id_taken");
      }
      connections.set(record.id, { ...record });
      return Promise.resolve("added");
    },
    update(id, changes) {
      const kept = connections.get(id);
      if (kept === undefined) {
        return Promise.resolve(undefined);
      }
      const updated = { ...kept, ...changes };
      connections.set(id, updated);
      return Promise.resolve({ ...updated });
    },
    remove: (id) => Promise.resolve(connections.delete(id)),
  };
}

const toRecord = (
  row: typeof githubConnections.$inferSelect,
): GitHubConnectionRecord => ({
  ...row,
  kind: row.kind as GitHubConnectionKind,
});

/** Keeps GitHub connections in `github_connections`. */
export function databaseGitHubConnectionStore(
  db: Database,
): GitHubConnectionStore {
  return {
    async list() {
      const rows = await db
        .select()
        .from(githubConnections)
        .orderBy(asc(githubConnections.createdAt), asc(githubConnections.id));
      return rows.map(toRecord);
    },
    async add(record) {
      const added = await db
        .insert(githubConnections)
        .values(record)
        .onConflictDoNothing()
        .returning({ id: githubConnections.id });
      return added.length === 0 ? "app_id_taken" : "added";
    },
    async update(id, changes) {
      const [row] =
        Object.keys(changes).length === 0
          ? await db
              .select()
              .from(githubConnections)
              .where(eq(githubConnections.id, id))
          : await db
              .update(githubConnections)
              .set(changes)
              .where(eq(githubConnections.id, id))
              .returning();
      return row === undefined ? undefined : toRecord(row);
    },
    async remove(id) {
      const removed = await db
        .delete(githubConnections)
        .where(eq(githubConnections.id, id))
        .returning({ id: githubConnections.id });
      return removed.length > 0;
    },
  };
}
