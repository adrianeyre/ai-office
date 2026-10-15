import { randomUUID } from "node:crypto";

import {
  appsFirst,
  createGitHubConnection,
  type GitHubConnectionConfig,
  type LiveGitHub,
} from "@ai-office/github";
import {
  githubConnectionHintLength,
  githubConnectionSecretContext,
  type GitHubAccessTokenConnectionCreate,
  type GitHubAppConnectionCreate,
  type GitHubConnection,
  type GitHubConnectionSecret,
  type GitHubConnectionUpdate,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import type { GitHubConnectionRecord, GitHubConnectionStore } from "./store.ts";

// The GitHub Apps and access tokens AI Office reaches GitHub through (ADR
// 0011), added, renamed, disabled and removed by the Owner in Floor
// Settings and kept in the database: the only place they are set. The
// private key and the tokens are sealed with ENCRYPTION_KEY, each for its
// own row and column, and never given back: only their last characters.
// Every change is taken up by the live GitHub at once, with no restart;
// `refresh` takes up one made elsewhere (a seed, another process).

export const githubConnectionErrorCodes = {
  notFound: "github_connection_not_found",
  /** An App of that ID is added already. */
  appTaken: "github_app_taken",
} as const;

export class GitHubConnectionError extends Error {
  readonly code: (typeof githubConnectionErrorCodes)[keyof typeof githubConnectionErrorCodes];

  constructor(code: GitHubConnectionError["code"], message: string) {
    super(message);
    this.name = "GitHubConnectionError";
    this.code = code;
  }
}

export interface GitHubConnections {
  /** Every connection, in the order they are tried: Apps first, then oldest first. */
  list(): Promise<GitHubConnection[]>;
  /** Adds a GitHub App; refused when an App of that ID is added already. */
  addApp(request: GitHubAppConnectionCreate): Promise<GitHubConnection>;
  /** Adds an access token and its read-only partner. */
  addAccessToken(
    request: GitHubAccessTokenConnectionCreate,
  ): Promise<GitHubConnection>;
  /** Renames a connection, or turns it off or on again. */
  update(id: string, update: GitHubConnectionUpdate): Promise<GitHubConnection>;
  /** Deletes a connection for good. */
  remove(id: string): Promise<void>;
  /** The enabled connections' credentials, opened, in the order they are tried. */
  configs(): Promise<GitHubConnectionConfig[]>;
  /**
   * Gives the live GitHub the enabled connections, if they changed since
   * it was last given them.
   */
  refresh(): Promise<void>;
}

export interface GitHubConnectionsOptions {
  readonly store: GitHubConnectionStore;
  readonly encryptor: Encryptor;
  /** The GitHub the server works through, kept to the connections. */
  readonly live?: LiveGitHub;
  /** GitHub's REST API; `https://api.github.com` unless GitHub Enterprise. */
  readonly baseUrl?: string;
  /** Each secret opened or added, for the redactor. */
  readonly onSecret?: (secret: string) => void;
  /** A connection whose secrets no configured key opens: it is not used. */
  readonly onUnreadable?: (id: string, error: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The last characters of a token, or of a PEM key's body. */
const hintOf = (secret: string): string =>
  secret
    .replaceAll(/-----[A-Z ]+-----/g, "")
    .replaceAll(/\s/g, "")
    .slice(-githubConnectionHintLength);

const view = (record: GitHubConnectionRecord): GitHubConnection => ({
  id: record.id,
  kind: record.kind,
  name: record.name,
  appId: record.appId,
  hint: record.hint,
  enabled: record.enabled,
  createdAt: record.createdAt.toISOString(),
});

export function createGitHubConnections(
  options: GitHubConnectionsOptions,
): GitHubConnections {
  const { store, encryptor } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const seal = (id: string, secret: GitHubConnectionSecret, value: string) =>
    encryptor.encrypt(value, githubConnectionSecretContext(id, secret));
  const open = (id: string, secret: GitHubConnectionSecret, value: string) => {
    const opened = encryptor.decrypt(
      value,
      githubConnectionSecretContext(id, secret),
    );
    options.onSecret?.(opened);
    return opened;
  };

  /** What the live GitHub was last given, by its sealed rows. */
  let given: string | undefined;

  const configOf = (
    record: GitHubConnectionRecord,
  ): GitHubConnectionConfig | undefined => {
    try {
      if (record.kind === "app") {
        return {
          kind: "app",
          appId: record.appId ?? "",
          privateKey: open(record.id, "private_key", record.privateKey ?? ""),
        };
      }
      return {
        kind: "access-token",
        token: open(record.id, "token", record.token ?? ""),
        readOnlyToken: open(
          record.id,
          "read_only_token",
          record.readOnlyToken ?? "",
        ),
      };
    } catch (error) {
      options.onUnreadable?.(record.id, error);
      return undefined;
    }
  };

  const enabled = async (): Promise<GitHubConnectionRecord[]> =>
    appsFirst((await store.list()).filter((record) => record.enabled));

  const configs = async (): Promise<GitHubConnectionConfig[]> =>
    (await enabled()).flatMap((record) => {
      const config = configOf(record);
      return config === undefined ? [] : [config];
    });

  const refresh = async (): Promise<void> => {
    const live = options.live;
    if (live === undefined) {
      return;
    }
    const records = await enabled();
    const fingerprint = JSON.stringify(
      records.map(({ id, privateKey, token, readOnlyToken }) => [
        id,
        privateKey,
        token,
        readOnlyToken,
      ]),
    );
    if (fingerprint === given) {
      return;
    }
    live.set(
      records.flatMap((record) => {
        const config = configOf(record);
        return config === undefined
          ? []
          : [
              createGitHubConnection(config, {
                ...(options.baseUrl === undefined
                  ? {}
                  : { baseUrl: options.baseUrl }),
              }),
            ];
      }),
    );
    given = fingerprint;
  };

  const add = async (
    record: GitHubConnectionRecord,
  ): Promise<GitHubConnection> => {
    if ((await store.add(record)) === "app_id_taken") {
      throw new GitHubConnectionError(
        githubConnectionErrorCodes.appTaken,
        `The GitHub App ${record.appId ?? ""} is added already.`,
      );
    }
    await refresh();
    return view(record);
  };

  return {
    list: async () => appsFirst(await store.list()).map(view),

    async addApp(request) {
      const id = newId();
      options.onSecret?.(request.privateKey);
      return add({
        id,
        kind: "app",
        name: request.name ?? `GitHub App ${request.appId}`,
        appId: request.appId,
        privateKey: seal(id, "private_key", request.privateKey),
        token: null,
        readOnlyToken: null,
        hint: hintOf(request.privateKey),
        enabled: true,
        createdAt: now(),
      });
    },

    async addAccessToken(request) {
      const id = newId();
      options.onSecret?.(request.token);
      options.onSecret?.(request.readOnlyToken);
      const hint = hintOf(request.token);
      return add({
        id,
        kind: "access-token",
        name: request.name ?? `Access token …${hint}`,
        appId: null,
        privateKey: null,
        token: seal(id, "token", request.token),
        readOnlyToken: seal(id, "read_only_token", request.readOnlyToken),
        hint,
        enabled: true,
        createdAt: now(),
      });
    },

    async update(id, update) {
      const updated = await store.update(id, {
        ...(update.name === undefined ? {} : { name: update.name }),
        ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
      });
      if (updated === undefined) {
        throw new GitHubConnectionError(
          githubConnectionErrorCodes.notFound,
          "There is no such GitHub connection.",
        );
      }
      await refresh();
      return view(updated);
    },

    async remove(id) {
      if (!(await store.remove(id))) {
        throw new GitHubConnectionError(
          githubConnectionErrorCodes.notFound,
          "There is no such GitHub connection.",
        );
      }
      await refresh();
    },

    configs,
    refresh,
  };
}
