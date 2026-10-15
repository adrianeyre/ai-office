import { Octokit } from "@octokit/rest";

import { GitHubError } from "./errors.ts";
import { appJwt } from "./jwt.ts";
import { createTokenCache } from "./tokens.ts";
import type {
  Branch,
  BranchComparison,
  CheckRun,
  Commit,
  ComparedFile,
  GitHubApp,
  Installation,
  InstallationToken,
  Issue,
  IssueComment,
  IssueVersion,
  LabelEvent,
  PullRequest,
  PullRequestFile,
  Repository,
  RepositoryClient,
  Review,
  TokenPermissions,
} from "./types.ts";
import {
  listingPermissions,
  maxComparedCommits,
  readOnlyPermissions,
  writingPermissions,
} from "./types.ts";

// The AI Office GitHub App (ADR 0002): it signs a JWT with its private key
// to speak as the App, mints an installation token per repository to act on
// it, and keeps each token until shortly before it expires. Every token
// asks for the permissions its use needs and no more (W1-2), whatever the
// installation was granted: GitHub would otherwise give a token every one.
// Or a GitHub access token (ADR 0011): the same calls, made with the
// token itself, and a second, read-only token for sandboxes, as an access
// token cannot mint narrower ones.

export interface GitHubAppOptions {
  /** The App's numeric id. */
  readonly appId: string;
  /** The App's PEM private key. A credential. */
  readonly privateKey: string;
  /** GitHub's REST API; `https://api.github.com` unless GitHub Enterprise. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** How long before expiry an installation token is replaced. */
  readonly refreshTokensBeforeMs?: number;
}

export const defaultGitHubApiUrl = "https://api.github.com";

const perPage = 100;

/** Turns whatever Octokit threw into a `GitHubError` (without credentials). */
const toGitHubError = (error: unknown): GitHubError => {
  if (error instanceof GitHubError) {
    return error;
  }
  // Octokit calls a request that got no response a 500; it was not GitHub.
  const response = (error as { response?: { status?: unknown } }).response;
  const status = typeof response?.status === "number" ? response.status : 0;
  // Octokit puts GitHub's own message first, then a documentation link.
  const message = (error instanceof Error ? error.message : String(error))
    .split(" - https://docs.github.com", 1)[0]
    ?.trim();
  return new GitHubError(
    status,
    status === 0
      ? `GitHub could not be reached: ${message ?? "unknown error"}`
      : `GitHub answered ${String(status)}: ${message ?? ""}`,
    { cause: error },
  );
};

const call = async <Result>(
  request: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await request();
  } catch (error) {
    throw toGitHubError(error);
  }
};

const login = (user: { login: string } | null | undefined): string =>
  user?.login ?? "ghost";

const labelNames = (
  labels: readonly (string | { name?: string | undefined })[],
): string[] =>
  labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name) => name !== "");

const splitFullName = (fullName: string): { owner: string; repo: string } => {
  const [owner, repo, ...rest] = fullName.split("/");
  if (
    owner === undefined ||
    owner === "" ||
    repo === undefined ||
    repo === "" ||
    rest.length > 0
  ) {
    throw new GitHubError(404, `"${fullName}" is not an owner/name.`);
  }
  return { owner, repo };
};

interface RestRepository {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch?: string;
  private: boolean;
  html_url: string;
}

const toRepository = (repository: RestRepository): Repository => ({
  id: repository.id,
  fullName: repository.full_name,
  owner: repository.owner.login,
  name: repository.name,
  defaultBranch: repository.default_branch ?? "main",
  private: repository.private,
  htmlUrl: repository.html_url,
});

interface RestIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: (string | { name?: string })[];
  user: { login: string } | null;
  html_url: string;
  pull_request?: unknown;
}

const toIssue = (issue: RestIssue): Issue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body ?? "",
  state: issue.state === "closed" ? "closed" : "open",
  labels: labelNames(issue.labels),
  author: login(issue.user),
  htmlUrl: issue.html_url,
});

interface RestPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  merged_at: string | null;
  draft?: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
}

const toPullRequest = (pull: RestPullRequest): PullRequest => ({
  number: pull.number,
  title: pull.title,
  body: pull.body ?? "",
  state: pull.state === "closed" ? "closed" : "open",
  merged: pull.merged ?? pull.merged_at !== null,
  draft: pull.draft ?? false,
  author: login(pull.user),
  head: { name: pull.head.ref, sha: pull.head.sha },
  base: pull.base.ref,
  htmlUrl: pull.html_url,
});

const toComment = (comment: {
  id: number;
  body?: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}): IssueComment => ({
  id: comment.id,
  body: comment.body ?? "",
  author: login(comment.user),
  createdAt: comment.created_at,
  htmlUrl: comment.html_url,
});

/** A `labeled` or `unlabeled` issue event; undefined for any other kind. */
const toLabelEvent = (event: {
  event: string;
  label?: { name?: string } | null;
  actor: { login: string } | null;
  created_at: string;
}): LabelEvent | undefined =>
  (event.event === "labeled" || event.event === "unlabeled") &&
  event.label?.name !== undefined
    ? {
        action: event.event,
        label: event.label.name,
        actor: login(event.actor),
        createdAt: event.created_at,
      }
    : undefined;

/**
 * An issue's versions, from GitHub's GraphQL API: REST keeps no body but
 * the latest. A title's changes are renamed events; a body's are its
 * edits, the first of them the body as opened. GitHub gives the latest
 * hundred of each: anything older is not known (`body: null`).
 */
const issueVersionsQuery = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      title
      body
      createdAt
      viewerDidAuthor
      author { login }
      includesCreatedEdit
      userContentEdits(last: 100) {
        totalCount
        nodes { editedAt deletedAt diff editor { login } }
      }
      titles: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 100) {
        totalCount
        nodes {
          ... on RenamedTitleEvent {
            createdAt
            previousTitle
            currentTitle
            actor { login }
          }
        }
      }
    }
  }
}`;

interface GraphQLIssueVersions {
  readonly repository: {
    readonly issue: {
      readonly title: string;
      readonly body: string;
      readonly createdAt: string;
      readonly viewerDidAuthor: boolean;
      readonly author: { readonly login: string } | null;
      readonly includesCreatedEdit: boolean;
      readonly userContentEdits: {
        readonly totalCount: number;
        readonly nodes: readonly ({
          readonly editedAt: string;
          readonly deletedAt: string | null;
          readonly diff: string | null;
          readonly editor: { readonly login: string } | null;
        } | null)[];
      };
      readonly titles: {
        readonly totalCount: number;
        readonly nodes: readonly ({
          readonly createdAt?: string;
          readonly previousTitle?: string;
          readonly currentTitle?: string;
          readonly actor?: { readonly login: string } | null;
        } | null)[];
      };
    } | null;
  } | null;
}

/** The versions of an issue, oldest first, from what GraphQL answered. */
export function toIssueVersions(
  answer: GraphQLIssueVersions,
): IssueVersion[] | undefined {
  const issue = answer.repository?.issue;
  if (issue === null || issue === undefined) {
    return undefined;
  }
  const author = login(issue.author);
  const edits = issue.userContentEdits.nodes
    .filter((edit) => edit !== null)
    .sort((a, b) => Date.parse(a.editedAt) - Date.parse(b.editedAt));
  const renames = issue.titles.nodes
    .filter(
      (rename) =>
        rename?.createdAt !== undefined &&
        rename.currentTitle !== undefined &&
        rename.previousTitle !== undefined,
    )
    .map((rename) => ({
      at: rename?.createdAt ?? "",
      previous: rename?.previousTitle ?? "",
      title: rename?.currentTitle ?? "",
      author: login(rename?.actor),
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // The body as opened is the first edit's, when GitHub has it.
  const createdKnown =
    edits.length === 0 ||
    (issue.includesCreatedEdit &&
      issue.userContentEdits.totalCount <= edits.length);
  const bodyAt = (edit: (typeof edits)[number]): string | null =>
    edit.deletedAt === null ? edit.diff : null;
  // Older renames than GitHub gives leave the issue as opened unknown.
  const titlesKnown = issue.titles.totalCount <= renames.length;
  const firstEdit = edits[0];
  const opened: IssueVersion = {
    title: renames[0]?.previous ?? issue.title,
    body: !titlesKnown
      ? null
      : firstEdit === undefined
        ? issue.body
        : createdKnown
          ? bodyAt(firstEdit)
          : null,
    author,
    byApp: issue.viewerDidAuthor,
    at: issue.createdAt,
  };
  const changes = [
    ...(createdKnown ? edits.slice(1) : edits).map((edit) => ({
      at: edit.editedAt,
      author: login(edit.editor),
      body: bodyAt(edit),
    })),
    ...renames.map(({ at, title, author: by }) => ({ at, author: by, title })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const versions: IssueVersion[] = [opened];
  for (const change of changes) {
    const before = versions.at(-1) ?? opened;
    versions.push({
      title: "title" in change ? change.title : before.title,
      body: "body" in change ? change.body : before.body,
      author: change.author,
      byApp: false,
      at: change.at,
    });
  }
  // What the issue says now is its last version; if the history does not
  // end there, nobody known wrote what it says now.
  const last = versions.at(-1) ?? opened;
  if (last.title !== issue.title || last.body !== issue.body) {
    versions.push({
      title: issue.title,
      body: issue.body,
      author: "ghost",
      byApp: false,
      at: last.at,
    });
  }
  return versions;
}

const toReview = (review: {
  id: number;
  body: string;
  state: string;
  user: { login: string } | null;
  commit_id: string | null;
  html_url: string;
}): Review => ({
  id: review.id,
  body: review.body,
  state: review.state,
  author: login(review.user),
  commitSha: review.commit_id ?? "",
  htmlUrl: review.html_url,
});

const fileStatuses: readonly PullRequestFile["status"][] = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
];

const toPullRequestFile = (file: {
  filename: string;
  status: string;
  previous_filename?: string;
  patch?: string;
}): PullRequestFile => ({
  path: file.filename,
  status: fileStatuses.find((status) => status === file.status) ?? "changed",
  ...(file.previous_filename === undefined
    ? {}
    : { previousPath: file.previous_filename }),
  patch: file.patch ?? null,
});

const toComparedFile = (file: {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}): ComparedFile => ({
  path: file.filename,
  status: fileStatuses.find((status) => status === file.status) ?? "changed",
  additions: file.additions,
  deletions: file.deletions,
  patch: file.patch ?? null,
});

const toCommit = (commit: {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
    committer: { date?: string } | null;
  };
}): Commit => ({
  sha: commit.sha,
  message: commit.commit.message,
  author: commit.commit.author?.name ?? "",
  authoredAt: commit.commit.author?.date ?? commit.commit.committer?.date ?? "",
  htmlUrl: commit.html_url,
});

const toCheckRun = (run: {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string | null;
  details_url: string | null;
}): CheckRun => ({
  id: run.id,
  name: run.name,
  status:
    run.status === "completed" || run.status === "in_progress"
      ? run.status
      : "queued",
  conclusion: run.conclusion as CheckRun["conclusion"],
  headSha: run.head_sha,
  htmlUrl: run.html_url ?? run.details_url ?? "",
});

/** The GitHub App client, acting through GitHub's REST API. */
/** An Octokit that authenticates each request with `authorization()`. */
type OctokitFor = (authorization: () => Promise<string>) => Octokit;

const octokitFor =
  (options: {
    readonly baseUrl?: string | undefined;
    readonly fetch?: typeof fetch | undefined;
  }): OctokitFor =>
  (authorization) => {
    const client = new Octokit({
      baseUrl: options.baseUrl ?? defaultGitHubApiUrl,
      userAgent: "ai-office",
      ...(options.fetch === undefined
        ? {}
        : { request: { fetch: options.fetch } }),
      // Octokit would log failed requests' warnings to the console.
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    client.hook.before("request", async (request) => {
      request.headers.authorization = await authorization();
    });
    return client;
  };

/**
 * How a connection speaks to GitHub: a GitHub App's installation tokens,
 * minted per repository, or an access token's own.
 */
interface Credentials {
  /** The token that pushes, merges, labels and comments on a repository. */
  readonly writingToken: (fullName: string) => Promise<InstallationToken>;
  /** A token that reads a repository and changes nothing, for a sandbox. */
  readonly readOnlyToken: (fullName: string) => Promise<InstallationToken>;
  readonly revokeToken: (token: string) => Promise<void>;
  readonly installations: () => Promise<Installation[]>;
  readonly repositories: () => Promise<Repository[]>;
}

/** A connection to GitHub: AI Office's calls on each repository, with `credentials`. */
function connection(octokit: OctokitFor, credentials: Credentials): GitHubApp {
  const {
    writingToken: repositoryToken,
    readOnlyToken,
    revokeToken,
  } = credentials;

  const repository = (fullName: string): RepositoryClient => {
    const { owner, repo } = splitFullName(fullName);
    const client = octokit(
      async () => `token ${(await repositoryToken(fullName)).token}`,
    );
    const rest = client.rest;
    const head = async (number: number): Promise<string> =>
      (await rest.pulls.get({ owner, repo, pull_number: number })).data.head
        .sha;

    return {
      fullName,
      get: async () =>
        toRepository((await call(() => rest.repos.get({ owner, repo }))).data),
      installationToken: () => repositoryToken(fullName),
      readOnlyToken: () => readOnlyToken(fullName),
      revokeToken,

      createIssue: async ({ title, body, labels }) =>
        toIssue(
          (
            await call(() =>
              rest.issues.create({
                owner,
                repo,
                title,
                ...(body === undefined ? {} : { body }),
                ...(labels === undefined ? {} : { labels: [...labels] }),
              }),
            )
          ).data,
        ),
      getIssue: async (number) =>
        toIssue(
          (
            await call(() =>
              rest.issues.get({ owner, repo, issue_number: number }),
            )
          ).data,
        ),
      listIssues: async ({ labels, state } = {}) =>
        (
          await call(() =>
            client.paginate(rest.issues.listForRepo, {
              owner,
              repo,
              state: state ?? "open",
              ...(labels === undefined || labels.length === 0
                ? {}
                : { labels: labels.join(",") }),
              per_page: perPage,
            }),
          )
        )
          .filter((issue) => issue.pull_request === undefined)
          .map(toIssue),
      closeIssue: async (number) =>
        toIssue(
          (
            await call(() =>
              rest.issues.update({
                owner,
                repo,
                issue_number: number,
                state: "closed",
              }),
            )
          ).data,
        ),

      ensureLabel: async ({ name, color, description }) => {
        try {
          await rest.issues.createLabel({
            owner,
            repo,
            name,
            color,
            ...(description === undefined ? {} : { description }),
          });
        } catch (error) {
          // 422 `already_exists`: the repository has it.
          const failure = toGitHubError(error);
          if (failure.status !== 422) {
            throw failure;
          }
          await call(() => rest.issues.getLabel({ owner, repo, name }));
        }
      },
      renameLabel: async (name, label) => {
        try {
          await rest.issues.updateLabel({
            owner,
            repo,
            name,
            new_name: label.name,
            ...(label.color === undefined ? {} : { color: label.color }),
            ...(label.description === undefined
              ? {}
              : { description: label.description }),
          });
          return true;
        } catch (error) {
          const failure = toGitHubError(error);
          if (failure.status === 404) {
            return false;
          }
          throw failure;
        }
      },
      addLabels: async (issue, labels) =>
        labelNames(
          (
            await call(() =>
              rest.issues.addLabels({
                owner,
                repo,
                issue_number: issue,
                labels: [...labels],
              }),
            )
          ).data,
        ),
      removeLabel: async (issue, label) => {
        try {
          await rest.issues.removeLabel({
            owner,
            repo,
            issue_number: issue,
            name: label,
          });
        } catch (error) {
          const failure = toGitHubError(error);
          // 404: the issue does not have it, which is what was wanted.
          if (failure.status !== 404) {
            throw failure;
          }
          await call(() =>
            rest.issues.get({ owner, repo, issue_number: issue }),
          );
        }
      },

      issueVersions: async (issue) => {
        let answer: GraphQLIssueVersions;
        try {
          answer = await call(() =>
            client.graphql<GraphQLIssueVersions>(issueVersionsQuery, {
              owner,
              name: repo,
              number: issue,
            }),
          );
        } catch (error) {
          // GraphQL answers a missing issue with an error, not a 404.
          const errors = (error as { cause?: { errors?: unknown } }).cause
            ?.errors;
          if (
            Array.isArray(errors) &&
            errors.some(
              (failure) =>
                (failure as { type?: unknown } | null)?.type === "NOT_FOUND",
            )
          ) {
            throw new GitHubError(404, `There is no issue #${String(issue)}.`);
          }
          throw error;
        }
        const versions = toIssueVersions(answer);
        if (versions === undefined) {
          throw new GitHubError(404, `There is no issue #${String(issue)}.`);
        }
        return versions;
      },

      labelEvents: async (issue) =>
        (
          await call(() =>
            client.paginate(rest.issues.listEvents, {
              owner,
              repo,
              issue_number: issue,
              per_page: perPage,
            }),
          )
        )
          .map(toLabelEvent)
          .filter((event) => event !== undefined),

      createComment: async (issue, body) =>
        toComment(
          (
            await call(() =>
              rest.issues.createComment({
                owner,
                repo,
                issue_number: issue,
                body,
              }),
            )
          ).data,
        ),
      listComments: async (issue) =>
        (
          await call(() =>
            client.paginate(rest.issues.listComments, {
              owner,
              repo,
              issue_number: issue,
              per_page: perPage,
            }),
          )
        ).map(toComment),

      updateComment: async (commentId, body) =>
        toComment(
          (
            await call(() =>
              rest.issues.updateComment({
                owner,
                repo,
                comment_id: commentId,
                body,
              }),
            )
          ).data,
        ),

      getBranch: async (name): Promise<Branch | undefined> => {
        try {
          const { data } = await rest.repos.getBranch({
            owner,
            repo,
            branch: name,
          });
          return { name: data.name, sha: data.commit.sha };
        } catch (error) {
          const failure = toGitHubError(error);
          if (failure.status === 404) {
            return undefined;
          }
          throw failure;
        }
      },
      createBranch: async (name, sha) => {
        const { data } = await call(() =>
          rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha }),
        );
        return { name, sha: data.object.sha };
      },
      deleteBranch: async (name) => {
        await call(() =>
          rest.git.deleteRef({ owner, repo, ref: `heads/${name}` }),
        );
      },
      listBranches: async (prefix = "") =>
        (
          await call(() =>
            rest.git.listMatchingRefs({ owner, repo, ref: `heads/${prefix}` }),
          )
        ).data
          .filter(({ ref }) => ref.startsWith("refs/heads/"))
          .map(({ ref, object }) => ({
            name: ref.slice("refs/heads/".length),
            sha: object.sha,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      compareBranches: async (base, head): Promise<BranchComparison> => {
        // GitHub pages the commits oldest first: a branch with more than a
        // page's has its newest on the last pages.
        const page = (number: number) =>
          call(() =>
            rest.repos.compareCommitsWithBasehead({
              owner,
              repo,
              basehead: `${base}...${head}`,
              per_page: maxComparedCommits,
              page: number,
            }),
          );
        const { data } = await page(1);
        let commits = data.commits;
        const pages = Math.ceil(data.total_commits / maxComparedCommits);
        if (pages > 1) {
          const [before, last] = await Promise.all([
            pages > 2 ? page(pages - 1) : Promise.resolve({ data }),
            page(pages),
          ]);
          commits = [...before.data.commits, ...last.data.commits].slice(
            -maxComparedCommits,
          );
        }
        return {
          aheadBy: data.ahead_by,
          behindBy: data.behind_by,
          mergeBase: toCommit(data.merge_base_commit),
          commits: commits.map(toCommit),
        };
      },

      createPullRequest: async ({ title, body, head, base, draft }) =>
        toPullRequest(
          (
            await call(() =>
              rest.pulls.create({
                owner,
                repo,
                title,
                body,
                head,
                base,
                ...(draft === undefined ? {} : { draft }),
              }),
            )
          ).data,
        ),
      getPullRequest: async (number) =>
        toPullRequest(
          (
            await call(() =>
              rest.pulls.get({ owner, repo, pull_number: number }),
            )
          ).data,
        ),
      updatePullRequest: async (number, { title, body }) =>
        toPullRequest(
          (
            await call(() =>
              rest.pulls.update({
                owner,
                repo,
                pull_number: number,
                ...(title === undefined ? {} : { title }),
                ...(body === undefined ? {} : { body }),
              }),
            )
          ).data,
        ),
      listPullRequestFiles: async (pullRequest) =>
        (
          await call(() =>
            client.paginate(rest.pulls.listFiles, {
              owner,
              repo,
              pull_number: pullRequest,
              per_page: perPage,
            }),
          )
        ).map(toPullRequestFile),
      compareCommits: async (base, head) =>
        (
          (
            await call(() =>
              rest.repos.compareCommitsWithBasehead({
                owner,
                repo,
                basehead: `${base}...${head}`,
              }),
            )
          ).data.files ?? []
        ).map(toComparedFile),
      listPullRequests: async ({ state, head } = {}) =>
        (
          await call(() =>
            client.paginate(rest.pulls.list, {
              owner,
              repo,
              state: state ?? "open",
              // GitHub filters by `user:branch`.
              ...(head === undefined ? {} : { head: `${owner}:${head}` }),
              per_page: perPage,
            }),
          )
        ).map(toPullRequest),

      getFileContent: async (path, ref) => {
        try {
          const { data } = await rest.repos.getContent({
            owner,
            repo,
            path,
            ref,
          });
          // A directory is a list; a file too large for this call has no
          // content.
          return !Array.isArray(data) &&
            data.type === "file" &&
            data.encoding === "base64"
            ? Buffer.from(data.content, "base64").toString("utf8")
            : undefined;
        } catch (error) {
          const failure = toGitHubError(error);
          if (failure.status === 404) {
            return undefined;
          }
          throw failure;
        }
      },

      listDirectory: async (path, ref) => {
        try {
          const { data } = await rest.repos.getContent({
            owner,
            repo,
            path,
            ref,
          });
          if (!Array.isArray(data)) {
            return undefined;
          }
          return data
            .map((entry) => ({
              name: entry.name,
              path: entry.path,
              type:
                entry.type === "dir" ||
                entry.type === "symlink" ||
                entry.type === "submodule"
                  ? entry.type
                  : ("file" as const),
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        } catch (error) {
          const failure = toGitHubError(error);
          if (failure.status === 404) {
            return undefined;
          }
          throw failure;
        }
      },

      listFiles: async (ref) => {
        const { data } = await call(() =>
          rest.git.getTree({ owner, repo, tree_sha: ref, recursive: "true" }),
        );
        return data.tree
          .flatMap((entry) => (entry.type === "blob" ? [entry.path] : []))
          .sort();
      },

      createReview: async (pullRequest, { body, comments, commitSha }) => {
        const commit = commitSha ?? (await call(() => head(pullRequest)));
        return toReview(
          (
            await call(() =>
              rest.pulls.createReview({
                owner,
                repo,
                pull_number: pullRequest,
                commit_id: commit,
                body,
                event: "COMMENT",
                ...(comments === undefined || comments.length === 0
                  ? {}
                  : {
                      comments: comments.map(({ path, line, body: text }) => ({
                        path,
                        line,
                        side: "RIGHT",
                        body: text,
                      })),
                    }),
              }),
            )
          ).data,
        );
      },
      listReviews: async (pullRequest) =>
        (
          await call(() =>
            client.paginate(rest.pulls.listReviews, {
              owner,
              repo,
              pull_number: pullRequest,
              per_page: perPage,
            }),
          )
        ).map(toReview),

      mergePullRequest: async (pullRequest, { method, sha, title }) => {
        const { data } = await call(() =>
          rest.pulls.merge({
            owner,
            repo,
            pull_number: pullRequest,
            merge_method: method,
            ...(sha === undefined ? {} : { sha }),
            ...(title === undefined ? {} : { commit_title: title }),
          }),
        );
        return { sha: data.sha };
      },

      listCheckRuns: async (ref) =>
        (
          await call(() =>
            client.paginate(rest.checks.listForRef, {
              owner,
              repo,
              ref,
              per_page: perPage,
            }),
          )
        ).map(toCheckRun),

      requiredChecks: async (branch) => {
        const { data } = await call(() =>
          rest.repos.getBranch({ owner, repo, branch }),
        );
        // GitHub sends `protection` for every branch, but not every version
        // of GitHub Enterprise Server does.
        const { protection } = data as Partial<Pick<typeof data, "protection">>;
        const required = protection?.required_status_checks;
        const names = [
          ...(required?.contexts ?? []),
          ...(required?.checks ?? []).map(({ context }) => context),
        ];
        const rules = await call(() =>
          client.paginate(rest.repos.getBranchRules, {
            owner,
            repo,
            branch,
            per_page: perPage,
          }),
        );
        for (const rule of rules) {
          if (rule.type === "required_status_checks") {
            names.push(
              ...(rule.parameters?.required_status_checks ?? []).map(
                ({ context }) => context,
              ),
            );
          }
        }
        return [...new Set(names)];
      },
    };
  };

  return {
    installations: credentials.installations,
    repositories: credentials.repositories,
    repository,
  };
}

export function createGitHubApp(options: GitHubAppOptions): GitHubApp {
  const now = options.now ?? (() => new Date());
  const tokens = createTokenCache({
    now,
    ...(options.refreshTokensBeforeMs === undefined
      ? {}
      : { refreshBeforeMs: options.refreshTokensBeforeMs }),
  });

  const octokit = octokitFor(options);

  // Speaks as the App itself, with a fresh JWT for each request.
  const asApp = octokit(() =>
    Promise.resolve(
      `Bearer ${appJwt({ appId: options.appId, privateKey: options.privateKey, now: now() })}`,
    ),
  );

  const mint = async (
    installationId: number,
    repository?: string,
    permissions?: TokenPermissions,
  ): Promise<InstallationToken> => {
    const { data } = await call(() =>
      asApp.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
        ...(repository === undefined ? {} : { repositories: [repository] }),
        ...(permissions === undefined
          ? {}
          : { permissions: { ...permissions } }),
      }),
    );
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  };

  /** Each repository's installation, once looked up. */
  const installationIds = new Map<string, Promise<number>>();
  const installationOf = (fullName: string): Promise<number> => {
    const key = fullName.toLowerCase();
    let id = installationIds.get(key);
    if (id === undefined) {
      id = call(() =>
        asApp.rest.apps.getRepoInstallation(splitFullName(fullName)),
      ).then(({ data }) => data.id);
      installationIds.set(key, id);
      id.catch(() => installationIds.delete(key));
    }
    return id;
  };

  const repositoryToken = (fullName: string): Promise<InstallationToken> => {
    const key = `repository:${fullName.toLowerCase()}`;
    return tokens.get(key, async () => {
      // Read at each mint: what the installation was granted may change.
      const { data } = await call(() =>
        asApp.rest.apps.getRepoInstallation(splitFullName(fullName)),
      );
      return mint(
        data.id,
        splitFullName(fullName).repo,
        writingPermissions(data.permissions as TokenPermissions),
      );
    });
  };

  // Never kept: each sandbox, session or run gets its own, which it
  // revokes when it stops (W1-3).
  const readOnlyToken = async (fullName: string): Promise<InstallationToken> =>
    mint(
      await installationOf(fullName),
      splitFullName(fullName).repo,
      readOnlyPermissions,
    );

  /** Revokes `token`, speaking as it: GitHub needs no more. */
  const revokeToken = async (token: string): Promise<void> => {
    const asToken = octokit(() => Promise.resolve(`token ${token}`));
    try {
      await call(() => asToken.rest.apps.revokeInstallationAccessToken());
    } catch (error) {
      // Expired, or revoked already: it works no more either way.
      if (!(error instanceof GitHubError && error.status === 401)) {
        throw error;
      }
    }
  };

  const installations = async (): Promise<Installation[]> => {
    const list = await call(() =>
      asApp.paginate(asApp.rest.apps.listInstallations, { per_page: perPage }),
    );
    return list.map((installation) => ({
      id: installation.id,
      account: installation.account?.login ?? "",
      repositorySelection: installation.repository_selection,
    }));
  };

  return connection(octokit, {
    writingToken: repositoryToken,
    readOnlyToken,
    revokeToken,
    installations,
    async repositories() {
      const repositories: Repository[] = [];
      for (const installation of await installations()) {
        const token = () =>
          tokens.get(`installation:${String(installation.id)}`, () =>
            mint(installation.id, undefined, listingPermissions),
          );
        const asInstallation = octokit(
          async () => `token ${(await token()).token}`,
        );
        const list = await call(() =>
          asInstallation.paginate(
            asInstallation.rest.apps.listReposAccessibleToInstallation,
            { per_page: perPage },
          ),
        );
        repositories.push(...list.map(toRepository));
      }
      return repositories;
    },
  });
}

export interface GitHubTokenOptions {
  /**
   * An access token (a fine-grained personal access token, or a classic
   * one) that can read and write the repositories' contents, issues and
   * pull requests, and read their checks. A credential.
   */
  readonly token: string;
  /**
   * A second token that can only read them: what sandboxes get (PRD
   * FR-19), as an access token cannot mint narrower ones. A credential.
   */
  readonly readOnlyToken: string;
  /** GitHub's REST API; `https://api.github.com` unless GitHub Enterprise. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/** An access token never expires as far as AI Office knows: its owner revokes it. */
const neverExpires = new Date(8.64e15);

/**
 * GitHub through an access token rather than an App: the repositories the
 * token's user can reach, each acted on with the token itself, and
 * sandboxes given the read-only token. AI Office never revokes either:
 * they are the Owner's, and outlive any one sandbox.
 */
export function createGitHubTokenConnection(
  options: GitHubTokenOptions,
): GitHubApp {
  const octokit = octokitFor(options);
  const asToken = octokit(() => Promise.resolve(`token ${options.token}`));
  return connection(octokit, {
    writingToken: () =>
      Promise.resolve({ token: options.token, expiresAt: neverExpires }),
    readOnlyToken: () =>
      Promise.resolve({
        token: options.readOnlyToken,
        expiresAt: neverExpires,
      }),
    revokeToken: () => Promise.resolve(),
    // The token's user stands in for an installation: there is one.
    installations: async () => {
      const { data } = await call(() => asToken.rest.users.getAuthenticated());
      return [
        { id: data.id, account: data.login, repositorySelection: "selected" },
      ];
    },
    repositories: async () =>
      (
        await call(() =>
          asToken.paginate(asToken.rest.repos.listForAuthenticatedUser, {
            affiliation: "owner,collaborator,organization_member",
            per_page: perPage,
          }),
        )
      ).map(toRepository),
  });
}
