import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { GitHubError } from "./errors.ts";
import { grants, type FakeGitHub, type FakeTokenScope } from "./fake.ts";
import type {
  CheckRun,
  Commit,
  Issue,
  IssueComment,
  IssueVersion,
  LabelEvent,
  PullRequest,
  PullRequestFile,
  Repository,
  Review,
  ReviewComment,
  TokenPermissions,
} from "./types.ts";
import { appPermissions } from "./types.ts";

// The fake GitHub served over HTTP, as the part of GitHub's REST API that
// AI Office calls. The real App client can then be run against it: the
// contract suite does, and so do the end-to-end tests, by pointing the
// server's GITHUB_API_URL here. Like GitHub, it accepts only JWTs signed
// with the App's key for the App's own endpoints, and only unexpired
// installation tokens for a repository they cover.

export interface FakeGitHubServer {
  /** The API's base URL, such as `http://127.0.0.1:41234`. */
  readonly url: string;
  /** Every installation token minted, in order (what it was minted for). */
  readonly mintedTokens: readonly {
    readonly installationId: number;
    readonly repositories?: readonly string[];
    readonly permissions?: TokenPermissions;
  }[];
  close(): Promise<void>;
}

/** An RSA key pair for a fake App: the private key signs, the fake checks. */
export function createAppKeys(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const user = (login: string) => ({ login, type: "User" });

const restRepository = (repository: Repository) => ({
  id: repository.id,
  name: repository.name,
  full_name: repository.fullName,
  owner: user(repository.owner),
  private: repository.private,
  html_url: repository.htmlUrl,
  default_branch: repository.defaultBranch,
});

const restIssue = (issue: Issue) => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: issue.state,
  labels: issue.labels.map((name) => ({ name })),
  user: user(issue.author),
  html_url: issue.htmlUrl,
  ...(issue.htmlUrl.includes("/pull/") ? { pull_request: {} } : {}),
});

const restPullRequest = (pull: PullRequest) => ({
  number: pull.number,
  title: pull.title,
  body: pull.body,
  state: pull.state,
  merged: pull.merged,
  merged_at: pull.merged ? new Date(0).toISOString() : null,
  draft: pull.draft,
  user: user(pull.author),
  head: { ref: pull.head.name, sha: pull.head.sha },
  base: { ref: pull.base },
  html_url: pull.htmlUrl,
});

const restComment = (comment: IssueComment) => ({
  id: comment.id,
  body: comment.body,
  user: user(comment.author),
  created_at: comment.createdAt,
  html_url: comment.htmlUrl,
});

const restLabelEvent = (event: LabelEvent, id: number) => ({
  id,
  event: event.action,
  label: { name: event.label },
  actor: user(event.actor),
  created_at: event.createdAt,
});

const restReview = (review: Review) => ({
  id: review.id,
  body: review.body,
  state: review.state,
  user: user(review.author),
  commit_id: review.commitSha,
  html_url: review.htmlUrl,
});

const restPullRequestFile = (file: PullRequestFile) => ({
  filename: file.path,
  status: file.status,
  ...(file.previousPath === undefined
    ? {}
    : { previous_filename: file.previousPath }),
  ...(file.patch === null ? {} : { patch: file.patch }),
});

/** A review's inline comments, as GitHub takes them. */
const reviewComments = (value: unknown): ReviewComment[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(422, "Invalid request: comments is not an array");
  }
  return value.map((comment: unknown) => {
    const { path, line, body } = (comment ?? {}) as Body;
    if (
      typeof path !== "string" ||
      typeof line !== "number" ||
      typeof body !== "string"
    ) {
      throw new HttpError(
        422,
        "Invalid request: a comment needs a path, a line and a body",
      );
    }
    return { path, line, body };
  });
};

/** A commit as GitHub's compare lists it: Git's view, and GitHub's. */
const restCommit = (commit: Commit) => ({
  sha: commit.sha,
  html_url: commit.htmlUrl,
  commit: {
    message: commit.message,
    author: { name: commit.author, email: "", date: commit.authoredAt },
    committer: { name: commit.author, email: "", date: commit.authoredAt },
  },
  author: null,
  parents: [],
});

const restCheckRun = (run: CheckRun) => ({
  id: run.id,
  name: run.name,
  status: run.status,
  conclusion: run.conclusion,
  head_sha: run.headSha,
  html_url: run.htmlUrl,
  details_url: null,
});

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as unknown);
};

type Body = Record<string, unknown>;

const text = (body: Body, key: string): string | undefined =>
  typeof body[key] === "string" ? body[key] : undefined;

/** Serves `fake` on a free loopback port as the App `appId` would see GitHub. */
export async function serveFakeGitHub(
  fake: FakeGitHub,
  options: {
    readonly appId: string;
    /** The App's public key, to check its JWTs. */
    readonly publicKey: string;
    readonly now?: () => Date;
    /**
     * Access tokens it also takes, as GitHub takes a personal access
     * token: each its user's, reaching the repositories listed, with the
     * permissions given (every one an App may have, unless it says).
     */
    readonly accessTokens?: Readonly<
      Record<
        string,
        {
          readonly login: string;
          readonly repositories: readonly string[];
          readonly permissions?: TokenPermissions;
        }
      >
    >;
  },
): Promise<FakeGitHubServer> {
  const now = options.now ?? (() => new Date());
  const mintedTokens: {
    installationId: number;
    repositories?: readonly string[];
    permissions?: TokenPermissions;
  }[] = [];

  const authorization = (request: IncomingMessage): string => {
    const header = request.headers.authorization ?? "";
    const [, credential = ""] = /^(?:Bearer|token) (.+)$/i.exec(header) ?? [];
    if (credential === "") {
      throw new HttpError(401, "Requires authentication");
    }
    return credential;
  };

  const requireApp = (request: IncomingMessage): void => {
    const [header, payload, signature, ...rest] =
      authorization(request).split(".");
    const valid =
      header !== undefined &&
      payload !== undefined &&
      signature !== undefined &&
      rest.length === 0 &&
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(options.publicKey, Buffer.from(signature, "base64url"));
    if (!valid) {
      throw new HttpError(401, "A JSON web token could not be decoded");
    }
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { iss?: unknown; exp?: unknown; iat?: unknown };
    const seconds = now().getTime() / 1000;
    if (
      String(claims.iss) !== options.appId ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      claims.exp <= seconds ||
      claims.iat > seconds + 60 ||
      claims.exp - claims.iat > 600
    ) {
      throw new HttpError(
        401,
        "'Expiration time' claim ('exp') is too far in the future, or the token is not for this App",
      );
    }
  };

  const requireToken = (request: IncomingMessage): FakeTokenScope => {
    const scope = fake.tokenScope(authorization(request));
    if (scope === undefined) {
      throw new HttpError(401, "Bad credentials");
    }
    return scope;
  };

  const requireRepository = (
    request: IncomingMessage,
    fullName: string,
    permission: string,
    level: "read" | "write" = request.method === "GET" ? "read" : "write",
  ): void => {
    const access = options.accessTokens?.[authorization(request)];
    if (access !== undefined) {
      if (
        !access.repositories.some(
          (each) => each.toLowerCase() === fullName.toLowerCase(),
        )
      ) {
        throw new HttpError(404, "Not Found");
      }
      if (!grants(access.permissions ?? appPermissions, permission, level)) {
        throw new HttpError(
          403,
          "Resource not accessible by personal access token",
        );
      }
      return;
    }
    const scope = requireToken(request);
    const covered =
      fake.installationOf(fullName) === scope.installationId &&
      (scope.repositories === undefined ||
        scope.repositories.includes(fullName.toLowerCase()));
    // GitHub hides what a token cannot reach.
    if (!covered) {
      throw new HttpError(404, "Not Found");
    }
    // Each call needs its permission: to read it for a GET (or a GraphQL
    // query), to write it otherwise. A token minted with no permissions
    // has all its installation was granted.
    if (
      !grants(
        scope.permissions ?? fake.installationPermissions(scope.installationId),
        permission,
        level,
      )
    ) {
      throw new HttpError(403, "Resource not accessible by integration");
    }
  };

  type Handler = (context: {
    readonly request: IncomingMessage;
    readonly params: readonly string[];
    readonly query: URLSearchParams;
    readonly body: Body;
  }) => Promise<{ status?: number; body?: unknown }>;

  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, pattern: string, handler: Handler): void => {
    const source = pattern
      .replaceAll(/:rest\b/g, "(.+)")
      .replaceAll(/:\w+/g, "([^/]+)");
    routes.push([method, new RegExp(`^${source}$`), handler]);
  };
  /**
   * A route on one repository, with the token checked for it and for the
   * permission GitHub requires for the call (`issues`, `contents`, …).
   */
  const repoRoute = (
    method: string,
    pattern: string,
    permission: string,
    handler: (context: {
      readonly repo: ReturnType<FakeGitHub["repository"]>;
      readonly params: readonly string[];
      readonly query: URLSearchParams;
      readonly body: Body;
    }) => Promise<{ status?: number; body?: unknown }>,
  ): void => {
    route(method, `/repos/:owner/:repo${pattern}`, async (context) => {
      const [owner = "", name = "", ...params] = context.params;
      const fullName = `${owner}/${name}`;
      requireRepository(context.request, fullName, permission);
      return handler({ ...context, repo: fake.repository(fullName), params });
    });
  };
  const number = (value: string | undefined): number => Number(value);

  /** The access token the request carries, or a 401. */
  const requireAccessToken = (request: IncomingMessage) => {
    const access = options.accessTokens?.[authorization(request)];
    if (access === undefined) {
      throw new HttpError(401, "Bad credentials");
    }
    return access;
  };
  route("GET", "/user", ({ request }) => {
    const { login } = requireAccessToken(request);
    return Promise.resolve({ body: { id: login.length, login } });
  });
  route("GET", "/user/repos", async ({ request }) => {
    const { repositories } = requireAccessToken(request);
    return {
      body: await Promise.all(
        repositories.map(async (fullName) =>
          restRepository(await fake.repository(fullName).get()),
        ),
      ),
    };
  });
  route("GET", "/app/installations", async ({ request }) => {
    requireApp(request);
    return {
      body: (await fake.installations()).map((installation) => ({
        id: installation.id,
        account: user(installation.account),
        repository_selection: installation.repositorySelection,
      })),
    };
  });
  route("GET", "/repos/:owner/:repo/installation", ({ request, params }) => {
    requireApp(request);
    const id = fake.installationOf(params.join("/"));
    if (id === undefined) {
      throw new HttpError(404, "Not Found");
    }
    return Promise.resolve({
      body: { id, permissions: fake.installationPermissions(id) },
    });
  });
  route(
    "POST",
    "/app/installations/:id/access_tokens",
    ({ request, params, body }) => {
      requireApp(request);
      const installationId = number(params[0]);
      const repositories = Array.isArray(body["repositories"])
        ? (body["repositories"] as string[])
        : undefined;
      const permissions =
        typeof body["permissions"] === "object" && body["permissions"] !== null
          ? (body["permissions"] as TokenPermissions)
          : undefined;
      const token = fake.mintToken(installationId, repositories, permissions);
      mintedTokens.push({
        installationId,
        ...(repositories === undefined ? {} : { repositories }),
        ...(permissions === undefined ? {} : { permissions }),
      });
      return Promise.resolve({
        status: 201,
        body: { token: token.token, expires_at: token.expiresAt.toISOString() },
      });
    },
  );
  route("DELETE", "/installation/token", ({ request }) => {
    requireToken(request);
    fake.revokeToken(authorization(request));
    return Promise.resolve({ status: 204 });
  });
  route("GET", "/installation/repositories", ({ request }) => {
    const scope = requireToken(request);
    const repositories = fake
      .installationRepositories(scope.installationId)
      .filter(
        (repository) =>
          scope.repositories === undefined ||
          scope.repositories.includes(repository.fullName.toLowerCase()),
      );
    return Promise.resolve({
      body: {
        total_count: repositories.length,
        repositories: repositories.map(restRepository),
      },
    });
  });

  repoRoute("GET", "", "metadata", async ({ repo }) => ({
    body: restRepository(await repo.get()),
  }));

  repoRoute("POST", "/issues", "issues", async ({ repo, body }) => ({
    status: 201,
    body: restIssue(
      await repo.createIssue({
        title: text(body, "title") ?? "",
        ...(text(body, "body") === undefined
          ? {}
          : { body: text(body, "body") ?? "" }),
        ...(Array.isArray(body["labels"])
          ? { labels: body["labels"] as string[] }
          : {}),
      }),
    ),
  }));
  repoRoute("GET", "/issues", "issues", async ({ repo, query }) => {
    const labels = query.get("labels");
    const state = query.get("state");
    return {
      body: (
        await repo.listIssues({
          ...(labels === null ? {} : { labels: labels.split(",") }),
          ...(state === "open" || state === "closed" || state === "all"
            ? { state }
            : {}),
        })
      ).map(restIssue),
    };
  });
  repoRoute("GET", "/issues/:number", "issues", async ({ repo, params }) => ({
    body: restIssue(await repo.getIssue(number(params[0]))),
  }));
  repoRoute(
    "PATCH",
    "/issues/:number",
    "issues",
    async ({ repo, params, body }) => {
      if (text(body, "state") !== "closed") {
        throw new HttpError(422, "The fake only closes issues");
      }
      return { body: restIssue(await repo.closeIssue(number(params[0]))) };
    },
  );

  const hasLabel = (fullName: string, name: string): boolean =>
    fake
      .labels(fullName)
      .some((label) => label.name.toLowerCase() === name.toLowerCase());
  repoRoute("POST", "/labels", "issues", async ({ repo, body }) => {
    const name = text(body, "name") ?? "";
    if (hasLabel(repo.fullName, name)) {
      throw new HttpError(422, "Validation Failed: already_exists");
    }
    const description = text(body, "description");
    await repo.ensureLabel({
      name,
      color: text(body, "color") ?? "",
      ...(description === undefined ? {} : { description }),
    });
    return { status: 201, body: { name } };
  });
  repoRoute("GET", "/labels/:name", "issues", ({ repo, params }) => {
    const name = params[0] ?? "";
    if (!hasLabel(repo.fullName, name)) {
      throw new HttpError(404, "Not Found");
    }
    return Promise.resolve({ body: { name } });
  });
  repoRoute(
    "PATCH",
    "/labels/:name",
    "issues",
    async ({ repo, params, body }) => {
      const name = text(body, "new_name") ?? params[0] ?? "";
      const color = text(body, "color");
      const description = text(body, "description");
      if (
        !(await repo.renameLabel(params[0] ?? "", {
          name,
          ...(color === undefined ? {} : { color }),
          ...(description === undefined ? {} : { description }),
        }))
      ) {
        throw new HttpError(404, "Not Found");
      }
      return { body: { name } };
    },
  );
  repoRoute(
    "POST",
    "/issues/:number/labels",
    "issues",
    async ({ repo, params, body }) => ({
      body: (
        await repo.addLabels(
          number(params[0]),
          Array.isArray(body["labels"]) ? (body["labels"] as string[]) : [],
        )
      ).map((name) => ({ name })),
    }),
  );
  repoRoute(
    "DELETE",
    "/issues/:number/labels/:name",
    "issues",
    async ({ repo, params }) => {
      const issue = await repo.getIssue(number(params[0]));
      const label = params[1] ?? "";
      if (
        !issue.labels.some((name) => name.toLowerCase() === label.toLowerCase())
      ) {
        throw new HttpError(404, "Label does not exist");
      }
      await repo.removeLabel(issue.number, label);
      const after = await repo.getIssue(issue.number);
      return { body: after.labels.map((name) => ({ name })) };
    },
  );

  // GraphQL: the one query AI Office makes, for an issue's versions
  // (pen-test finding P1-5). GitHub keeps a title's changes as renamed
  // events, and a body's as edits, the first of them the body as opened.
  route("POST", "/graphql", async ({ request, body }) => {
    const variables = (body["variables"] ?? {}) as Record<string, unknown>;
    const fullName = `${String(variables["owner"])}/${String(variables["name"])}`;
    requireRepository(request, fullName, "issues", "read");
    const versions = await fake
      .repository(fullName)
      .issueVersions(Number(variables["number"]));
    const [first] = versions;
    const current = versions.at(-1);
    if (first === undefined || current === undefined) {
      throw new HttpError(404, "Not Found");
    }
    const changes = versions.slice(1).map((version, index) => ({
      version,
      before: versions[index] ?? first,
    }));
    const edits = changes.filter(
      ({ version, before }) => version.body !== before.body,
    );
    const asEdit = (version: IssueVersion) => ({
      editedAt: version.at,
      deletedAt: version.body === null ? version.at : null,
      diff: version.body,
      editor: { login: version.author },
    });
    const renames = changes
      .filter(({ version, before }) => version.title !== before.title)
      .map(({ version, before }) => ({
        createdAt: version.at,
        previousTitle: before.title,
        currentTitle: version.title,
        actor: { login: version.author },
      }));
    return {
      body: {
        data: {
          repository: {
            issue: {
              title: current.title,
              body: current.body,
              createdAt: first.at,
              viewerDidAuthor: first.byApp,
              author: { login: first.author },
              includesCreatedEdit: edits.length > 0,
              userContentEdits: {
                totalCount: edits.length === 0 ? 0 : edits.length + 1,
                nodes:
                  edits.length === 0
                    ? []
                    : [
                        asEdit(first),
                        ...edits.map(({ version }) => asEdit(version)),
                      ],
              },
              titles: { totalCount: renames.length, nodes: renames },
            },
          },
        },
      },
    };
  });

  // GitHub lists every kind of issue event here; the fake has only these.
  repoRoute(
    "GET",
    "/issues/:number/events",
    "issues",
    async ({ repo, params }) => ({
      body: (await repo.labelEvents(number(params[0]))).map(restLabelEvent),
    }),
  );

  repoRoute(
    "POST",
    "/issues/:number/comments",
    "issues",
    async ({ repo, params, body }) => ({
      status: 201,
      body: restComment(
        await repo.createComment(number(params[0]), text(body, "body") ?? ""),
      ),
    }),
  );
  repoRoute(
    "GET",
    "/issues/:number/comments",
    "issues",
    async ({ repo, params }) => ({
      body: (await repo.listComments(number(params[0]))).map(restComment),
    }),
  );
  repoRoute(
    "PATCH",
    "/issues/comments/:id",
    "issues",
    async ({ repo, params, body }) => ({
      body: restComment(
        await repo.updateComment(number(params[0]), text(body, "body") ?? ""),
      ),
    }),
  );

  // A protected branch's required checks come as its protection's, and
  // again as a ruleset's rule: the App reads both, as GitHub has both.
  repoRoute(
    "GET",
    "/branches/:branch",
    "contents",
    async ({ repo, params }) => {
      const branch = await repo.getBranch(params[0] ?? "");
      if (branch === undefined) {
        throw new HttpError(404, "Branch not found");
      }
      const required = await repo.requiredChecks(branch.name);
      return {
        body: {
          name: branch.name,
          commit: { sha: branch.sha },
          protected: required.length > 0,
          // As GitHub has it for every branch, protected or not.
          protection: {
            enabled: required.length > 0,
            required_status_checks: {
              enforcement_level: required.length > 0 ? "non_admins" : "off",
              contexts: required,
              checks: required.map((context) => ({ context, app_id: null })),
            },
          },
        },
      };
    },
  );
  repoRoute(
    "GET",
    "/rules/branches/:branch",
    "metadata",
    async ({ repo, params }) => {
      const required = await repo.requiredChecks(params[0] ?? "");
      return {
        body:
          required.length === 0
            ? []
            : [
                {
                  type: "required_status_checks",
                  parameters: {
                    strict_required_status_checks_policy: false,
                    required_status_checks: required.map((context) => ({
                      context,
                    })),
                  },
                },
              ],
      };
    },
  );
  repoRoute("POST", "/git/refs", "contents", async ({ repo, body }) => {
    const ref = text(body, "ref") ?? "";
    if (!ref.startsWith("refs/heads/")) {
      throw new HttpError(422, "The fake only creates branches");
    }
    const branch = await repo.createBranch(
      ref.slice("refs/heads/".length),
      text(body, "sha") ?? "",
    );
    return { status: 201, body: { ref, object: { sha: branch.sha } } };
  });
  repoRoute(
    "DELETE",
    "/git/refs/:rest",
    "contents",
    async ({ repo, params }) => {
      const ref = params[0] ?? "";
      if (!ref.startsWith("heads/")) {
        throw new HttpError(422, "The fake only deletes branches");
      }
      await repo.deleteBranch(ref.slice("heads/".length));
      return { status: 204 };
    },
  );

  repoRoute("POST", "/pulls", "pull_requests", async ({ repo, body }) => ({
    status: 201,
    body: restPullRequest(
      await repo.createPullRequest({
        title: text(body, "title") ?? "",
        body: text(body, "body") ?? "",
        head: text(body, "head") ?? "",
        base: text(body, "base") ?? "",
        ...(typeof body["draft"] === "boolean" ? { draft: body["draft"] } : {}),
      }),
    ),
  }));
  repoRoute("GET", "/pulls", "pull_requests", async ({ repo, query }) => {
    const state = query.get("state");
    // `owner:branch`, as GitHub takes it.
    const head = query.get("head")?.split(":").slice(1).join(":");
    return {
      body: (
        await repo.listPullRequests({
          ...(state === "open" || state === "closed" || state === "all"
            ? { state }
            : {}),
          ...(head === undefined ? {} : { head }),
        })
      ).map(restPullRequest),
    };
  });
  repoRoute(
    "GET",
    "/pulls/:number",
    "pull_requests",
    async ({ repo, params }) => ({
      body: restPullRequest(await repo.getPullRequest(number(params[0]))),
    }),
  );
  repoRoute(
    "PATCH",
    "/pulls/:number",
    "pull_requests",
    async ({ repo, params, body }) => {
      const title = text(body, "title");
      const changed = text(body, "body");
      return {
        body: restPullRequest(
          await repo.updatePullRequest(number(params[0]), {
            ...(title === undefined ? {} : { title }),
            ...(changed === undefined ? {} : { body: changed }),
          }),
        ),
      };
    },
  );
  repoRoute(
    "GET",
    "/pulls/:number/files",
    "pull_requests",
    async ({ repo, params }) => ({
      body: (await repo.listPullRequestFiles(number(params[0]))).map(
        restPullRequestFile,
      ),
    }),
  );
  // The commits come a page at a time, oldest first, as GitHub pages them;
  // the files, from base to head, on every page.
  repoRoute(
    "GET",
    "/compare/:basehead",
    "contents",
    async ({ repo, params, query }) => {
      const [base = "", head = ""] = (params[0] ?? "").split("...");
      const comparison = fake.compare(repo.fullName, base, head);
      const commitSha = async (ref: string): Promise<string> =>
        (await repo.getBranch(ref))?.sha ?? ref;
      const perPage = Math.min(250, Number(query.get("per_page") ?? 250));
      const page = Math.max(1, Number(query.get("page") ?? 1));
      const commits = comparison.commits.slice(
        (page - 1) * perPage,
        page * perPage,
      );
      return {
        body: {
          status:
            comparison.aheadBy === 0
              ? comparison.behindBy === 0
                ? "identical"
                : "behind"
              : comparison.behindBy === 0
                ? "ahead"
                : "diverged",
          ahead_by: comparison.aheadBy,
          behind_by: comparison.behindBy,
          total_commits: comparison.aheadBy,
          merge_base_commit: restCommit(comparison.mergeBase),
          commits: commits.map(restCommit),
          files: (
            await repo.compareCommits(
              await commitSha(base),
              await commitSha(head),
            )
          ).map((file) => ({
            filename: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.additions + file.deletions,
            ...(file.patch === null ? {} : { patch: file.patch }),
          })),
        },
      };
    },
  );
  // GitHub lists every ref that starts with the one asked for.
  repoRoute(
    "GET",
    "/git/matching-refs/:rest",
    "contents",
    async ({ repo, params }) => {
      const ref = params[0] ?? "";
      if (!ref.startsWith("heads/")) {
        throw new HttpError(422, "The fake only lists branches");
      }
      return {
        body: (await repo.listBranches(ref.slice("heads/".length))).map(
          (branch) => ({
            ref: `refs/heads/${branch.name}`,
            url: "",
            object: { sha: branch.sha, type: "commit", url: "" },
          }),
        ),
      };
    },
  );
  repoRoute(
    "GET",
    "/git/trees/:rest",
    "contents",
    async ({ repo, params }) => ({
      body: {
        sha: params[0] ?? "",
        truncated: false,
        tree: (await repo.listFiles(decodeURIComponent(params[0] ?? ""))).map(
          (path) => ({ path, mode: "100644", type: "blob" }),
        ),
      },
    }),
  );
  repoRoute(
    "GET",
    "/contents/:rest",
    "contents",
    async ({ repo, params, query }) => {
      const path = params[0] ?? "";
      const ref = query.get("ref") ?? (await repo.get()).defaultBranch;
      const content = await repo.getFileContent(path, ref);
      if (content === undefined) {
        const entries = await repo.listDirectory(path, ref);
        if (entries === undefined) {
          throw new HttpError(404, "Not Found");
        }
        return {
          body: entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
          })),
        };
      }
      return {
        body: {
          type: "file",
          encoding: "base64",
          path,
          content: Buffer.from(content).toString("base64"),
        },
      };
    },
  );
  repoRoute(
    "POST",
    "/pulls/:number/reviews",
    "pull_requests",
    async ({ repo, params, body }) => {
      const pull = await repo.getPullRequest(number(params[0]));
      const event = text(body, "event") ?? "COMMENT";
      if (event !== "COMMENT" && pull.author === fake.botLogin) {
        throw new HttpError(
          422,
          event === "APPROVE"
            ? "Can not approve your own pull request"
            : "Can not request changes on your own pull request",
        );
      }
      return {
        body: restReview(
          await repo.createReview(pull.number, {
            body: text(body, "body") ?? "",
            comments: reviewComments(body["comments"]),
            ...(text(body, "commit_id") === undefined
              ? {}
              : { commitSha: text(body, "commit_id") ?? "" }),
          }),
        ),
      };
    },
  );
  repoRoute(
    "GET",
    "/pulls/:number/reviews",
    "pull_requests",
    async ({ repo, params }) => ({
      body: (await repo.listReviews(number(params[0]))).map(restReview),
    }),
  );
  repoRoute(
    "PUT",
    "/pulls/:number/merge",
    "contents",
    async ({ repo, params, body }) => {
      const method = text(body, "merge_method") ?? "merge";
      if (method !== "merge" && method !== "squash" && method !== "rebase") {
        throw new HttpError(422, "Invalid merge_method");
      }
      const { sha } = await repo.mergePullRequest(number(params[0]), {
        method,
        ...(text(body, "sha") === undefined
          ? {}
          : { sha: text(body, "sha") ?? "" }),
      });
      return {
        body: {
          sha,
          merged: true,
          message: "Pull Request successfully merged",
        },
      };
    },
  );

  repoRoute(
    "GET",
    "/commits/:ref/check-runs",
    "checks",
    async ({ repo, params }) => {
      const runs = await repo.listCheckRuns(params[0] ?? "");
      return {
        body: { total_count: runs.length, check_runs: runs.map(restCheckRun) },
      };
    },
  );

  const respond = (
    response: ServerResponse,
    status: number,
    body?: unknown,
  ): void => {
    if (body === undefined) {
      response.writeHead(status).end();
      return;
    }
    response
      .writeHead(status, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify(body));
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://fake.github");
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (method !== request.method || match === null) {
        continue;
      }
      try {
        const result = await handler({
          request,
          params: match.slice(1).map((part) => decodeURIComponent(part)),
          query: url.searchParams,
          body: (await readBody(request)) as Body,
        });
        respond(response, result.status ?? 200, result.body);
      } catch (error) {
        const status =
          error instanceof HttpError || error instanceof GitHubError
            ? error.status
            : 500;
        respond(response, status, {
          message: error instanceof Error ? error.message : String(error),
          documentation_url: "https://docs.github.com/rest",
        });
      }
      return;
    }
    respond(response, 404, { message: "Not Found" });
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    mintedTokens,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
