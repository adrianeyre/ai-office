import { createGitHubApp, createGitHubTokenConnection } from "./app.ts";
import { GitHubError } from "./errors.ts";
import type {
  GitHubApp,
  Installation,
  Repository,
  RepositoryClient,
} from "./types.ts";

// More than one way into GitHub (ADR 0011): several GitHub Apps (each on
// its own accounts and organisations) and access tokens, seen as one. A
// repository is acted on through the first connection, in the order
// given, that can reach it, so an App, whose tokens are narrower, comes
// before an access token that reaches the same repository.

/** Whether an error means a connection cannot reach a repository, rather than that GitHub failed. */
const cannotReach = (error: unknown): boolean =>
  error instanceof GitHubError &&
  (error.status === 401 || error.status === 403 || error.status === 404);

/**
 * Every result of `each` connection that answered; if none did, the
 * first one's error. One connection whose credentials have gone bad does
 * not hide the others' repositories.
 */
async function fromEvery<Item>(
  connections: readonly GitHubApp[],
  each: (connection: GitHubApp) => Promise<Item[]>,
): Promise<Item[]> {
  const settled = await Promise.allSettled(connections.map(each));
  const answered = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (answered.length === 0 && failed?.status === "rejected") {
    throw failed.reason;
  }
  return answered.flat();
}

/**
 * The connections as one GitHub: every one's installations and
 * repositories (each repository once, as the first connection to reach
 * it lists it), and each repository's calls through the first that
 * reaches it, found once and remembered. With one connection, it is that
 * connection itself; there must be one.
 */
export function combineGitHubConnections(
  connections: readonly GitHubApp[],
): GitHubApp {
  const [first] = connections;
  if (first === undefined) {
    throw new Error("GitHub needs at least one connection.");
  }
  if (connections.length === 1) {
    return first;
  }
  const reaching = new Map<string, Promise<GitHubApp>>();
  const connectionFor = (fullName: string): Promise<GitHubApp> => {
    const key = fullName.toLowerCase();
    let found = reaching.get(key);
    if (found === undefined) {
      found = (async () => {
        for (const each of connections) {
          try {
            await each.repository(fullName).get();
            return each;
          } catch (error) {
            if (!cannotReach(error)) {
              throw error;
            }
          }
        }
        throw new GitHubError(
          404,
          `No GitHub connection reaches ${fullName}: install a GitHub App on it, or give an access token that can.`,
        );
      })();
      reaching.set(key, found);
      found.catch(() => reaching.delete(key));
    }
    return found;
  };
  return {
    installations: () =>
      fromEvery<Installation>(connections, (each) => each.installations()),
    async repositories() {
      const seen = new Set<string>();
      return (
        await fromEvery<Repository>(connections, (each) => each.repositories())
      ).filter(({ fullName }) => {
        const key = fullName.toLowerCase();
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    },
    repository(fullName) {
      // A plain object of the calls, each made through the connection
      // that reaches the repository, so callers may spread it.
      const shape = first.repository(fullName);
      const client: Record<string, unknown> = { fullName };
      for (const [name, value] of Object.entries(shape)) {
        if (typeof value === "function") {
          client[name] = async (...args: unknown[]) => {
            const target = (await connectionFor(fullName)).repository(
              fullName,
            ) as unknown as Record<string, (...given: unknown[]) => unknown>;
            return target[name]?.(...args);
          };
        }
      }
      return client as unknown as RepositoryClient;
    },
  };
}

/** One way into GitHub: a GitHub App, or an access token and its read-only partner. */
export type GitHubConnectionConfig =
  | {
      readonly kind: "app";
      readonly appId: string;
      readonly privateKey: string;
    }
  | {
      readonly kind: "access-token";
      readonly token: string;
      /** What sandboxes get: it can read the repositories and change nothing. */
      readonly readOnlyToken: string;
    };

/**
 * `connections` in the order they are tried: Apps first (each narrower
 * than a token reaching the same repository), otherwise as given.
 */
export const appsFirst = <Connection extends { readonly kind: string }>(
  connections: readonly Connection[],
): Connection[] => [
  ...connections.filter(({ kind }) => kind === "app"),
  ...connections.filter(({ kind }) => kind !== "app"),
];

/** The client for one connection, at GitHub's REST API `baseUrl`. */
export function createGitHubConnection(
  config: GitHubConnectionConfig,
  options: { readonly baseUrl?: string; readonly fetch?: typeof fetch } = {},
): GitHubApp {
  return config.kind === "app"
    ? createGitHubApp({
        appId: config.appId,
        privateKey: config.privateKey,
        ...options,
      })
    : createGitHubTokenConnection({
        token: config.token,
        readOnlyToken: config.readOnlyToken,
        ...options,
      });
}

/** No GitHub App or access token is set up: there is no GitHub to ask. */
export class GitHubNotConfiguredError extends GitHubError {
  constructor() {
    super(
      503,
      "GitHub is not set up: add a GitHub App or an access token in Floor Settings.",
    );
    this.name = "GitHubNotConfiguredError";
  }
}

/** GitHub as the connections it is given now, which can change. */
export interface LiveGitHub extends GitHubApp {
  /** Uses `connections` from the next call on, in the order given. */
  set(connections: readonly GitHubApp[]): void;
  /** How many connections it has now. */
  readonly size: number;
}

/** The calls a repository client makes, read once from a client's shape. */
let repositoryCalls: readonly string[] | undefined;
const callsOfRepository = (): readonly string[] => {
  repositoryCalls ??= Object.entries(
    createGitHubTokenConnection({
      token: "unused",
      readOnlyToken: "unused",
    }).repository("owner/name"),
  ).flatMap(([name, value]) => (typeof value === "function" ? [name] : []));
  return repositoryCalls;
};

/**
 * GitHub through whichever connections it has at each call, combined as
 * `combineGitHubConnections` combines them, so connections added, changed
 * or removed in Floor Settings take effect without a restart. A
 * repository client it gave keeps working, through the connections of the
 * moment. With none, every call fails with `GitHubNotConfiguredError`.
 */
export function createLiveGitHub(
  connections: readonly GitHubApp[] = [],
): LiveGitHub {
  let size = 0;
  let current: GitHubApp | undefined;
  const set = (given: readonly GitHubApp[]) => {
    size = given.length;
    current = given.length === 0 ? undefined : combineGitHubConnections(given);
  };
  set(connections);
  const now = (): GitHubApp => {
    if (current === undefined) {
      throw new GitHubNotConfiguredError();
    }
    return current;
  };
  return {
    set,
    get size() {
      return size;
    },
    installations: () => Promise.resolve().then(() => now().installations()),
    repositories: () => Promise.resolve().then(() => now().repositories()),
    repository(fullName) {
      const client: Record<string, unknown> = { fullName };
      for (const name of callsOfRepository()) {
        // A promise either way: with no connection, a rejected one.
        client[name] = (...args: unknown[]) =>
          Promise.resolve().then(() => {
            const target = now().repository(fullName) as unknown as Record<
              string,
              (...given: unknown[]) => unknown
            >;
            return target[name]?.(...args);
          });
      }
      return client as unknown as RepositoryClient;
    },
  };
}
