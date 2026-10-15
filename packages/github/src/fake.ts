import { createHash, randomBytes } from "node:crypto";

import { GitHubError } from "./errors.ts";
import type {
  Branch,
  BranchComparison,
  CheckRun,
  CheckRunConclusion,
  Commit,
  DirectoryEntry,
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
  ReviewComment,
  TokenPermissions,
} from "./types.ts";
import {
  appPermissions,
  maxComparedCommits,
  readOnlyPermissions,
  writingPermissions,
} from "./types.ts";

// An in-memory GitHub for tests across the codebase. It implements
// `GitHubApp` as the App would see GitHub (the contract suite holds it to
// the real App's behaviour), plus a scenario API for what happens on
// GitHub without the App: the Owner opens an issue or labels it, a branch
// gets a commit, CI finishes.

export interface FakeGitHubOptions {
  /** The App's slug; it acts as `<slug>[bot]`. */
  readonly appSlug?: string;
  readonly now?: () => Date;
}

/** A token the fake minted, and what it may reach. */
export interface FakeTokenScope {
  readonly installationId: number;
  /** Lower-cased `owner/name`s; every repository of the installation if absent. */
  readonly repositories?: readonly string[];
  /** What it may do; all the App may do if absent. */
  readonly permissions?: TokenPermissions;
  readonly expiresAt: Date;
}

export interface FakeLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface FakeGitHub extends GitHubApp {
  /** The login the App acts as, such as `ai-office[bot]`. */
  readonly botLogin: string;

  // The scenario API
  /**
   * Installs the App on `owner/name`, creating the repository with one
   * commit on its default branch. The owner's installation is created with
   * its first repository.
   */
  installRepository(
    fullName: string,
    options?: { readonly defaultBranch?: string; readonly private?: boolean },
  ): Repository;
  /** Removes the repository from the App's installation. */
  uninstallRepository(fullName: string): void;
  /** Someone (the repository's owner unless `author` says) opens an issue. */
  createIssue(
    fullName: string,
    issue: {
      readonly title: string;
      readonly body?: string;
      readonly labels?: readonly string[];
      readonly author?: string;
    },
  ): Issue;
  /**
   * Someone (the issue's author unless `actor` says) edits an issue's (or
   * pull request's) title or body: a new version of it.
   */
  editIssue(
    fullName: string,
    issue: number,
    changes: { readonly title?: string; readonly body?: string },
    options?: { readonly actor?: string },
  ): Issue;
  /**
   * Someone deletes a version's body from the issue's history, as GitHub
   * lets an issue's author and maintainers do: GitHub no longer has it.
   */
  forgetIssueVersion(fullName: string, issue: number, index: number): void;
  /**
   * Someone (the repository's owner unless `actor` says) adds a label to an
   * issue or pull request.
   */
  setLabel(
    fullName: string,
    issue: number,
    label: string,
    options?: { readonly actor?: string },
  ): void;
  /**
   * Someone (the repository's owner unless `actor` says) removes a label
   * from an issue or pull request.
   */
  removeLabel(
    fullName: string,
    issue: number,
    label: string,
    options?: { readonly actor?: string },
  ): void;
  /** The repository's labels. */
  labels(fullName: string): FakeLabel[];
  /**
   * A commit is pushed to `branch`, which is created from the default
   * branch if it does not exist. Returns the new commit's sha: `sha` if
   * given (a commit pushed to a real Git remote standing in for GitHub's).
   * `files` are what it changes: each path's new text, or null to remove
   * it; every other file is as it was on the branch. Its parent is the
   * branch's head; its message, author (the repository's owner, as AI
   * Office authors commits, ADR 0002) and time may be given.
   */
  pushCommit(
    fullName: string,
    branch: string,
    options?: {
      readonly sha?: string;
      readonly files?: Readonly<Record<string, string | null>>;
      readonly message?: string;
      readonly author?: string;
      readonly authoredAt?: Date;
    },
  ): string;
  /** The inline comments of a pull request's reviews, oldest first. */
  reviewComments(
    fullName: string,
    pullRequest: number,
  ): (ReviewComment & { readonly reviewId: number })[];
  /** CI starts on a commit, or on a branch's head commit. */
  startCI(
    fullName: string,
    ref: string,
    options?: { readonly name?: string },
  ): CheckRun;
  /**
   * CI finishes on a commit, or on a branch's head commit: the check run
   * of that name (`CI` by default) completes, started first if need be.
   */
  finishCI(
    fullName: string,
    ref: string,
    options?: {
      readonly conclusion?: CheckRunConclusion;
      readonly name?: string;
    },
  ): CheckRun;
  /**
   * The Owner protects a branch: the checks named must pass before
   * anything merges into it (none, to lift it).
   */
  requireChecks(
    fullName: string,
    branch: string,
    names: readonly string[],
  ): void;

  /**
   * The Owner grants the App more permissions on `fullName`'s installation,
   * which accepts them: such as **Workflows**, or anything granted by
   * mistake. It starts with `appPermissions`.
   */
  grantPermissions(fullName: string, permissions: TokenPermissions): void;

  // For serving the fake over HTTP (`serveFakeGitHub`)
  /** The installation covering `fullName`, if the App is installed there. */
  installationOf(fullName: string): number | undefined;
  /**
   * `base...head` on `fullName` as GitHub's compare pages it: with every
   * one of `head`'s own commits, oldest first.
   */
  compare(fullName: string, base: string, head: string): BranchComparison;
  /** What an installation was granted: a token minted with none has these. */
  installationPermissions(installationId: number): TokenPermissions;
  /** The repositories an installation covers. */
  installationRepositories(installationId: number): Repository[];
  /**
   * Mints an hour-long installation token, optionally for some repositories
   * and with fewer permissions.
   */
  mintToken(
    installationId: number,
    repositories?: readonly string[],
    permissions?: TokenPermissions,
  ): InstallationToken;
  /**
   * What a token may reach, if the fake minted it and it has neither
   * expired nor been revoked.
   */
  tokenScope(token: string): FakeTokenScope | undefined;
  /** Revokes a token the fake minted: it reaches nothing from now on. */
  revokeToken(token: string): void;
}

interface PullState {
  readonly head: string;
  headSha: string;
  readonly base: string;
  readonly draft: boolean;
  merged: boolean;
  readonly reviews: (Review & { readonly comments: ReviewComment[] })[];
}

interface IssueRecord {
  readonly number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  readonly author: string;
  readonly comments: IssueComment[];
  readonly labelEvents: LabelEvent[];
  /** Its title and body as opened, then after each edit. */
  readonly versions: IssueVersion[];
  readonly pull?: PullState;
}

/** A commit's place in the history, and what `git log` says of it. */
interface CommitRecord {
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly authoredAt: string;
  /** Made after every commit with a lower one: the history's order. */
  readonly order: number;
}

interface RepositoryState {
  repository: Repository;
  installationId: number;
  readonly branches: Map<string, string>;
  readonly commits: Set<string>;
  /** Each commit's parents, message, author and time. */
  readonly history: Map<string, CommitRecord>;
  /** Each commit's files: path to text. */
  readonly trees: Map<string, ReadonlyMap<string, string>>;
  /** By lower-cased name. */
  readonly labels: Map<string, FakeLabel>;
  readonly issues: Map<number, IssueRecord>;
  readonly checkRuns: CheckRun[];
  /** Each protected branch's required checks, by branch. */
  readonly requiredChecks: Map<string, readonly string[]>;
  nextNumber: number;
}

const tokenLifetimeMs = 60 * 60 * 1000;

const notFound = (what: string): GitHubError =>
  new GitHubError(404, `Not Found: ${what}`);
/**
 * Whether `permissions` let a token `level` `permission`, as GitHub grants
 * them: write includes read, and every token may read metadata.
 */
export const grants = (
  permissions: TokenPermissions,
  permission: string,
  level: "read" | "write",
): boolean =>
  (permission === "metadata" && level === "read") ||
  permissions[permission] === "write" ||
  (level === "read" && permissions[permission] === "read");

const unprocessable = (message: string): GitHubError =>
  new GitHubError(422, message);

const linesOf = (text: string): string[] => {
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
};

/**
 * The change from `before` to `after` as one hunk replacing every line:
 * not the smallest diff, as GitHub's is, but one of the same form, on
 * whose new lines a review can comment.
 */
const wholeFilePatch = (
  before: string | undefined,
  after: string | undefined,
): string => {
  const old = before === undefined ? [] : linesOf(before);
  const next = after === undefined ? [] : linesOf(after);
  const range = (lines: readonly string[]) =>
    `${String(lines.length === 0 ? 0 : 1)},${String(lines.length)}`;
  return [
    `@@ -${range(old)} +${range(next)} @@`,
    ...old.map((line) => `-${line}`),
    ...next.map((line) => `+${line}`),
  ].join("\n");
};

/**
 * How many lines go and come from `before` to `after`, by their longest
 * common run of lines, as a smallest diff counts them.
 */
const lineChanges = (
  before: string | undefined,
  after: string | undefined,
): { readonly additions: number; readonly deletions: number } => {
  const old = before === undefined ? [] : linesOf(before);
  const next = after === undefined ? [] : linesOf(after);
  let row = new Array<number>(next.length + 1).fill(0);
  for (const line of old) {
    const current = [0];
    next.forEach((other, index) => {
      current.push(
        line === other
          ? (row[index] ?? 0) + 1
          : Math.max(row[index + 1] ?? 0, current[index] ?? 0),
      );
    });
    row = current;
  }
  const common = row[next.length] ?? 0;
  return { additions: next.length - common, deletions: old.length - common };
};

/** `Closes #4`, `fixes #4`, `resolved #4` and the like. */
const closingReferences = (body: string): number[] =>
  [
    ...body.matchAll(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi,
    ),
  ].map((match) => Number(match[1]));

export function createFakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const now = options.now ?? (() => new Date());
  const botLogin = `${options.appSlug ?? "ai-office"}[bot]`;
  /**
   * When something happens to an issue: now, but always after the last,
   * so its labels and versions keep their order however fast they come.
   */
  let lastStamp = 0;
  const stamp = (): string => {
    lastStamp = Math.max(now().getTime(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };
  const repositories = new Map<string, RepositoryState>();
  const installations = new Map<string, Installation>();
  const tokens = new Map<string, FakeTokenScope>();
  /** What each installation was granted beyond `appPermissions`. */
  const granted = new Map<number, TokenPermissions>();
  const grantedTo = (installationId: number): TokenPermissions => ({
    ...appPermissions,
    ...granted.get(installationId),
  });
  let nextId = 1;
  const id = (): number => nextId++;
  const newSha = (): string =>
    createHash("sha1")
      .update(`commit ${String(id())}`)
      .digest("hex");

  const stateOf = (fullName: string): RepositoryState => {
    const state = repositories.get(fullName.toLowerCase());
    if (state === undefined) {
      throw notFound(`repository ${fullName}`);
    }
    return state;
  };

  const issueOf = (state: RepositoryState, number: number): IssueRecord => {
    const issue = state.issues.get(number);
    if (issue === undefined) {
      throw notFound(`issue #${String(number)}`);
    }
    return issue;
  };

  const pullOf = (
    state: RepositoryState,
    number: number,
  ): IssueRecord & { pull: PullState } => {
    const issue = state.issues.get(number);
    if (issue?.pull === undefined) {
      throw notFound(`pull request #${String(number)}`);
    }
    return issue as IssueRecord & { pull: PullState };
  };

  /** A branch's head, or the commit itself. */
  const resolveRef = (state: RepositoryState, ref: string): string => {
    const sha = state.branches.get(ref) ?? (state.commits.has(ref) ? ref : "");
    if (sha === "") {
      throw unprocessable(`No commit found for ref ${ref}`);
    }
    return sha;
  };

  const treeOf = (
    state: RepositoryState,
    ref: string,
  ): ReadonlyMap<string, string> =>
    state.trees.get(resolveRef(state, ref)) ?? new Map<string, string>();

  /** The files a pull request changes: its base's files against its head's. */
  const pullFiles = (
    state: RepositoryState,
    pull: PullState,
  ): PullRequestFile[] => {
    const base = treeOf(state, pull.base);
    const head = treeOf(state, pull.headSha);
    return [...new Set([...base.keys(), ...head.keys()])]
      .sort()
      .filter((path) => base.get(path) !== head.get(path))
      .map((path) => ({
        path,
        status: !base.has(path)
          ? "added"
          : !head.has(path)
            ? "removed"
            : "modified",
        patch: wholeFilePatch(base.get(path), head.get(path)),
      }));
  };

  const htmlUrl = (state: RepositoryState, path: string): string =>
    `${state.repository.htmlUrl}/${path}`;

  let nextOrder = 0;
  /** Records a commit with its parents and files. */
  const addCommit = (
    state: RepositoryState,
    sha: string,
    commit: Omit<CommitRecord, "order">,
    tree: ReadonlyMap<string, string>,
  ): void => {
    state.commits.add(sha);
    state.trees.set(sha, tree);
    if (!state.history.has(sha)) {
      state.history.set(sha, { ...commit, order: nextOrder++ });
    }
  };

  const toCommit = (state: RepositoryState, sha: string): Commit => {
    const record = state.history.get(sha);
    return {
      sha,
      message: record?.message ?? "",
      author: record?.author ?? state.repository.owner,
      authoredAt: record?.authoredAt ?? new Date(0).toISOString(),
      htmlUrl: htmlUrl(state, `commit/${sha}`),
    };
  };

  /** `sha` and every commit it descends from. */
  const ancestry = (state: RepositoryState, sha: string): Set<string> => {
    const seen = new Set<string>();
    const pending = [sha];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(...(state.history.get(next)?.parents ?? []));
      }
    }
    return seen;
  };

  /** A branch's head, or the commit itself; a 404 when it is neither. */
  const commitOf = (state: RepositoryState, ref: string): string => {
    const sha = state.branches.get(ref) ?? (state.commits.has(ref) ? ref : "");
    if (sha === "") {
      throw notFound(`No commit found for ${ref}`);
    }
    return sha;
  };

  const byOrder =
    (state: RepositoryState) =>
    (a: string, b: string): number =>
      (state.history.get(a)?.order ?? 0) - (state.history.get(b)?.order ?? 0);

  /** `base...head`, with every one of `head`'s own commits. */
  const compare = (
    state: RepositoryState,
    base: string,
    head: string,
  ): BranchComparison => {
    const from = ancestry(state, commitOf(state, base));
    const to = ancestry(state, commitOf(state, head));
    const shared = [...from].filter((sha) => to.has(sha));
    // The common ancestor no other common ancestor descends from: in these
    // histories, the newest.
    const [mergeBase] = shared.sort(byOrder(state)).slice(-1);
    if (mergeBase === undefined) {
      throw notFound(`No common ancestor between ${base} and ${head}`);
    }
    const ahead = [...to].filter((sha) => !from.has(sha));
    return {
      aheadBy: ahead.length,
      behindBy: [...from].filter((sha) => !to.has(sha)).length,
      mergeBase: toCommit(state, mergeBase),
      commits: ahead.sort(byOrder(state)).map((sha) => toCommit(state, sha)),
    };
  };

  const addLabel = (state: RepositoryState, name: string): string => {
    const known = state.labels.get(name.toLowerCase());
    if (known !== undefined) {
      return known.name;
    }
    // GitHub creates a label that is added before it exists.
    state.labels.set(name.toLowerCase(), {
      name,
      color: "ededed",
      description: "",
    });
    return name;
  };

  const labelIssue = (
    state: RepositoryState,
    number: number,
    labels: readonly string[],
    actor: string,
  ): string[] => {
    const issue = issueOf(state, number);
    for (const label of labels) {
      const name = addLabel(state, label);
      if (!issue.labels.includes(name)) {
        issue.labels.push(name);
        issue.labelEvents.push({
          action: "labeled",
          label: name,
          actor,
          createdAt: stamp(),
        });
      }
    }
    return [...issue.labels];
  };

  const unlabelIssue = (
    state: RepositoryState,
    number: number,
    label: string,
    actor: string,
  ): void => {
    const issue = issueOf(state, number);
    const removed = issue.labels.find(
      (name) => name.toLowerCase() === label.toLowerCase(),
    );
    if (removed === undefined) {
      return;
    }
    issue.labels = issue.labels.filter((name) => name !== removed);
    issue.labelEvents.push({
      action: "unlabeled",
      label: removed,
      actor,
      createdAt: stamp(),
    });
  };

  const toIssue = (state: RepositoryState, issue: IssueRecord): Issue => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: [...issue.labels],
    author: issue.author,
    htmlUrl: htmlUrl(
      state,
      `${issue.pull === undefined ? "issues" : "pull"}/${String(issue.number)}`,
    ),
  });

  const toPullRequest = (
    state: RepositoryState,
    issue: IssueRecord & { pull: PullState },
  ): PullRequest => {
    const { pull } = issue;
    // An open pull request follows its branch.
    const branchHead = state.branches.get(pull.head);
    if (issue.state === "open" && branchHead !== undefined) {
      pull.headSha = branchHead;
    }
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      merged: pull.merged,
      draft: pull.draft,
      author: issue.author,
      head: { name: pull.head, sha: pull.headSha },
      base: pull.base,
      htmlUrl: htmlUrl(state, `pull/${String(issue.number)}`),
    };
  };

  const openIssue = (
    state: RepositoryState,
    input: {
      readonly title: string;
      readonly body?: string | undefined;
      readonly labels?: readonly string[] | undefined;
      readonly author: string;
      readonly pull?: PullState;
    },
  ): IssueRecord => {
    if (input.title.trim() === "") {
      throw unprocessable("Validation Failed: title is missing");
    }
    const issue: IssueRecord = {
      number: state.nextNumber++,
      title: input.title,
      body: input.body ?? "",
      state: "open",
      labels: [],
      author: input.author,
      comments: [],
      labelEvents: [],
      versions: [
        {
          title: input.title,
          body: input.body ?? "",
          author: input.author,
          byApp: input.author === botLogin,
          at: stamp(),
        },
      ],
      ...(input.pull === undefined ? {} : { pull: input.pull }),
    };
    state.issues.set(issue.number, issue);
    labelIssue(state, issue.number, input.labels ?? [], input.author);
    return issue;
  };

  const checkRun = (
    state: RepositoryState,
    ref: string,
    name: string,
  ): { run: CheckRun; index: number } => {
    const sha = resolveRef(state, ref);
    const index = state.checkRuns.findIndex(
      (run) => run.headSha === sha && run.name === name,
    );
    const existing = state.checkRuns[index];
    if (existing !== undefined) {
      return { run: existing, index };
    }
    const runId = id();
    const run: CheckRun = {
      id: runId,
      name,
      status: "in_progress",
      conclusion: null,
      headSha: sha,
      htmlUrl: `${state.repository.htmlUrl}/runs/${String(runId)}`,
    };
    state.checkRuns.push(run);
    return { run, index: state.checkRuns.length - 1 };
  };

  const mintToken = (
    installationId: number,
    repositoryNames?: readonly string[],
    permissions?: TokenPermissions,
  ): InstallationToken => {
    const covered = [...repositories.values()].filter(
      (state) => state.installationId === installationId,
    );
    if (
      ![...installations.values()].some(
        ({ id: known }) => known === installationId,
      )
    ) {
      throw notFound(`installation ${String(installationId)}`);
    }
    // Names without the owner, as GitHub takes them.
    const scoped = repositoryNames?.map((name) => {
      const state = covered.find(
        ({ repository }) =>
          repository.name.toLowerCase() === name.toLowerCase(),
      );
      if (state === undefined) {
        throw unprocessable(
          `There is at least one repository that does not exist or is not accessible to the parent installation: ${name}`,
        );
      }
      return state.repository.fullName.toLowerCase();
    });
    // A token can have no more than the installation was granted.
    for (const [permission, level] of Object.entries(permissions ?? {})) {
      if (!grants(grantedTo(installationId), permission, level)) {
        throw unprocessable(
          "The permissions requested are not granted to this installation.",
        );
      }
    }
    const token: InstallationToken = {
      token: `ghs_fake${randomBytes(16).toString("hex")}`,
      expiresAt: new Date(now().getTime() + tokenLifetimeMs),
    };
    tokens.set(token.token, {
      installationId,
      ...(scoped === undefined ? {} : { repositories: scoped }),
      ...(permissions === undefined ? {} : { permissions: { ...permissions } }),
      expiresAt: token.expiresAt,
    });
    return token;
  };

  /** The App's calls, acting as its bot. */
  const repository = (fullName: string): RepositoryClient => {
    const state = (): RepositoryState => stateOf(fullName);
    // Every call is asynchronous, as GitHub's are, and fails as they do.
    const run = <Result>(work: () => Result): Promise<Result> =>
      Promise.resolve().then(work);

    return {
      fullName,
      get: () => run(() => ({ ...state().repository })),
      installationToken: () =>
        run(() => {
          const { installationId, repository: repo } = state();
          return mintToken(
            installationId,
            [repo.name],
            writingPermissions(grantedTo(installationId)),
          );
        }),
      readOnlyToken: () =>
        run(() => {
          const { installationId, repository: repo } = state();
          return mintToken(installationId, [repo.name], readOnlyPermissions);
        }),
      revokeToken: (token) =>
        run(() => {
          tokens.delete(token);
        }),

      createIssue: ({ title, body, labels }) =>
        run(() => {
          const repo = state();
          return toIssue(
            repo,
            openIssue(repo, { title, body, labels, author: botLogin }),
          );
        }),
      getIssue: (number) =>
        run(() => toIssue(state(), issueOf(state(), number))),
      listIssues: ({ labels = [], state: wanted = "open" } = {}) =>
        run(() => {
          const repo = state();
          return [...repo.issues.values()]
            .filter(
              (issue) =>
                issue.pull === undefined &&
                (wanted === "all" || issue.state === wanted) &&
                labels.every((label) =>
                  issue.labels.some(
                    (name) => name.toLowerCase() === label.toLowerCase(),
                  ),
                ),
            )
            .sort((a, b) => b.number - a.number)
            .map((issue) => toIssue(repo, issue));
        }),
      closeIssue: (number) =>
        run(() => {
          const repo = state();
          const issue = issueOf(repo, number);
          issue.state = "closed";
          return toIssue(repo, issue);
        }),

      ensureLabel: ({ name, color, description }) =>
        run(() => {
          const repo = state();
          if (!/^[0-9a-f]{6}$/i.test(color)) {
            throw unprocessable("Validation Failed: color is invalid");
          }
          if (!repo.labels.has(name.toLowerCase())) {
            repo.labels.set(name.toLowerCase(), {
              name,
              color,
              description: description ?? "",
            });
          }
        }),
      renameLabel: (name, { name: newName, color, description }) =>
        run(() => {
          const repo = state();
          const label = repo.labels.get(name.toLowerCase());
          if (label === undefined) {
            return false;
          }
          if (
            newName.toLowerCase() !== name.toLowerCase() &&
            repo.labels.has(newName.toLowerCase())
          ) {
            throw unprocessable("Validation Failed: already_exists");
          }
          if (color !== undefined && !/^[0-9a-f]{6}$/i.test(color)) {
            throw unprocessable("Validation Failed: color is invalid");
          }
          repo.labels.delete(name.toLowerCase());
          repo.labels.set(newName.toLowerCase(), {
            name: newName,
            color: color ?? label.color,
            description: description ?? label.description,
          });
          // Its issues keep it, under its new name, with no label event.
          for (const issue of repo.issues.values()) {
            issue.labels = issue.labels.map((each) =>
              each === label.name ? newName : each,
            );
          }
          return true;
        }),
      addLabels: (issue, labels) =>
        run(() => labelIssue(state(), issue, labels, botLogin)),
      removeLabel: (issue, label) =>
        run(() => {
          unlabelIssue(state(), issue, label, botLogin);
        }),
      labelEvents: (issue) =>
        run(() => issueOf(state(), issue).labelEvents.map((e) => ({ ...e }))),
      issueVersions: (issue) =>
        run(() => issueOf(state(), issue).versions.map((v) => ({ ...v }))),

      createComment: (issue, body) =>
        run(() => {
          const record = issueOf(state(), issue);
          if (body.trim() === "") {
            throw unprocessable("Validation Failed: body is missing");
          }
          const commentId = id();
          const comment: IssueComment = {
            id: commentId,
            body,
            author: botLogin,
            createdAt: now().toISOString(),
            htmlUrl: htmlUrl(
              state(),
              `${record.pull === undefined ? "issues" : "pull"}/${String(issue)}#issuecomment-${String(commentId)}`,
            ),
          };
          record.comments.push(comment);
          return { ...comment };
        }),
      listComments: (issue) =>
        run(() => issueOf(state(), issue).comments.map((c) => ({ ...c }))),
      updateComment: (commentId, body) =>
        run(() => {
          const comments = [...state().issues.values()].flatMap(
            ({ comments: onIssue }) => onIssue,
          );
          const index = comments.findIndex(
            ({ id: known }) => known === commentId,
          );
          const comment = comments[index];
          if (comment === undefined) {
            throw notFound(`comment ${String(commentId)}`);
          }
          if (body.trim() === "") {
            throw unprocessable("Validation Failed: body is missing");
          }
          const updated: IssueComment = { ...comment, body };
          for (const issue of state().issues.values()) {
            const at = issue.comments.indexOf(comment);
            if (at !== -1) {
              issue.comments[at] = updated;
            }
          }
          return { ...updated };
        }),

      getBranch: (name) =>
        run(() => {
          const sha = state().branches.get(name);
          return sha === undefined ? undefined : { name, sha };
        }),
      createBranch: (name, sha) =>
        run(() => {
          const repo = state();
          if (repo.branches.has(name)) {
            throw unprocessable("Reference already exists");
          }
          if (!repo.commits.has(sha)) {
            throw unprocessable("Object does not exist");
          }
          repo.branches.set(name, sha);
          return { name, sha };
        }),
      deleteBranch: (name) =>
        run(() => {
          const repo = state();
          if (!repo.branches.delete(name)) {
            throw unprocessable("Reference does not exist");
          }
        }),
      listBranches: (prefix = "") =>
        run(() =>
          [...state().branches]
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, sha]): Branch => ({ name, sha }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        ),
      compareBranches: (base, head) =>
        run((): BranchComparison => {
          const comparison = compare(state(), base, head);
          return {
            ...comparison,
            commits: comparison.commits.slice(-maxComparedCommits),
          };
        }),

      createPullRequest: ({ title, body, head, base, draft }) =>
        run(() => {
          const repo = state();
          const headSha = repo.branches.get(head);
          const baseSha = repo.branches.get(base);
          if (headSha === undefined || baseSha === undefined) {
            throw unprocessable(
              `Validation Failed: ${headSha === undefined ? "head" : "base"} is invalid`,
            );
          }
          if (headSha === baseSha) {
            throw unprocessable(
              `Validation Failed: No commits between ${base} and ${head}`,
            );
          }
          const open = [...repo.issues.values()].some(
            (issue) =>
              issue.state === "open" &&
              issue.pull?.head === head &&
              issue.pull.base === base,
          );
          if (open) {
            throw unprocessable(
              `Validation Failed: A pull request already exists for ${head}.`,
            );
          }
          const issue = openIssue(repo, {
            title,
            body,
            author: botLogin,
            pull: {
              head,
              headSha,
              base,
              draft: draft ?? false,
              merged: false,
              reviews: [],
            },
          });
          return toPullRequest(
            repo,
            issue as IssueRecord & { pull: PullState },
          );
        }),
      getPullRequest: (number) =>
        run(() => toPullRequest(state(), pullOf(state(), number))),
      updatePullRequest: (number, { title, body }) =>
        run(() => {
          const repo = state();
          const issue = pullOf(repo, number);
          issue.title = title ?? issue.title;
          issue.body = body ?? issue.body;
          return toPullRequest(repo, issue);
        }),
      listPullRequestFiles: (pullRequest) =>
        run(() => {
          const repo = state();
          const issue = pullOf(repo, pullRequest);
          toPullRequest(repo, issue);
          return pullFiles(repo, issue.pull);
        }),
      compareCommits: (base, head) =>
        run(() => {
          const repo = state();
          const [from, to] = [base, head].map((ref) => {
            if (!repo.commits.has(ref)) {
              throw notFound(`commit ${ref}`);
            }
            return repo.trees.get(ref) ?? new Map<string, string>();
          }) as [ReadonlyMap<string, string>, ReadonlyMap<string, string>];
          return [...new Set([...from.keys(), ...to.keys()])]
            .sort()
            .filter((path) => from.get(path) !== to.get(path))
            .map((path) => ({
              path,
              status: !from.has(path)
                ? "added"
                : !to.has(path)
                  ? "removed"
                  : "modified",
              ...lineChanges(from.get(path), to.get(path)),
              patch: wholeFilePatch(from.get(path), to.get(path)),
            }));
        }),
      listPullRequests: ({ state: wanted = "open", head } = {}) =>
        run(() => {
          const repo = state();
          return [...repo.issues.values()]
            .filter(
              (issue): issue is IssueRecord & { pull: PullState } =>
                issue.pull !== undefined &&
                (wanted === "all" || issue.state === wanted) &&
                (head === undefined || issue.pull.head === head),
            )
            .sort((a, b) => b.number - a.number)
            .map((issue) => toPullRequest(repo, issue));
        }),

      getFileContent: (path, ref) => run(() => treeOf(state(), ref).get(path)),
      listDirectory: (path, ref) =>
        run(() => {
          const tree = treeOf(state(), ref);
          const prefix = path === "" ? "" : `${path.replace(/\/+$/, "")}/`;
          const entries = new Map<string, DirectoryEntry>();
          for (const file of tree.keys()) {
            if (!file.startsWith(prefix)) {
              continue;
            }
            const [name = "", ...rest] = file.slice(prefix.length).split("/");
            entries.set(name, {
              name,
              path: `${prefix}${name}`,
              type: rest.length === 0 ? "file" : "dir",
            });
          }
          return entries.size === 0
            ? undefined
            : [...entries.values()].sort((a, b) =>
                a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
              );
        }),

      listFiles: (ref) => run(() => [...treeOf(state(), ref).keys()].sort()),

      createReview: (pullRequest, { body, comments = [], commitSha }) =>
        run(() => {
          const repo = state();
          const issue = pullOf(repo, pullRequest);
          const pull = toPullRequest(repo, issue);
          if (body.trim() === "") {
            throw unprocessable("Validation Failed: a review needs a body");
          }
          // GitHub takes comments only on lines of the diff.
          const files = pullFiles(repo, issue.pull);
          const head = treeOf(repo, issue.pull.headSha);
          for (const comment of comments) {
            const file = files.find(({ path }) => path === comment.path);
            const lines = linesOf(head.get(comment.path) ?? "").length;
            if (
              file === undefined ||
              file.status === "removed" ||
              !Number.isInteger(comment.line) ||
              comment.line < 1 ||
              comment.line > lines
            ) {
              throw unprocessable(
                "Unprocessable Entity: Pull request review thread line must be part of the diff",
              );
            }
          }
          const reviewId = id();
          const review: Review = {
            id: reviewId,
            body,
            state: "COMMENTED",
            author: botLogin,
            commitSha: commitSha ?? pull.head.sha,
            htmlUrl: `${pull.htmlUrl}#pullrequestreview-${String(reviewId)}`,
          };
          issue.pull.reviews.push({
            ...review,
            comments: comments.map((comment) => ({ ...comment })),
          });
          return { ...review };
        }),
      listReviews: (pullRequest) =>
        run(() =>
          pullOf(state(), pullRequest).pull.reviews.map((review): Review => ({
            id: review.id,
            body: review.body,
            state: review.state,
            author: review.author,
            commitSha: review.commitSha,
            htmlUrl: review.htmlUrl,
          })),
        ),

      mergePullRequest: (pullRequest, { method, sha, title }) =>
        run(() => {
          const repo = state();
          const issue = pullOf(repo, pullRequest);
          const current = toPullRequest(repo, issue);
          if (current.state !== "open") {
            throw new GitHubError(405, "Pull Request is not mergeable");
          }
          if (sha !== undefined && sha !== current.head.sha) {
            throw new GitHubError(
              409,
              "Head branch was modified. Review and try the merge again.",
            );
          }
          const merge = newSha();
          const baseSha = resolveRef(repo, current.base);
          addCommit(
            repo,
            merge,
            {
              // A squash or a rebase leaves one parent; a merge, two.
              parents:
                method === "merge" ? [baseSha, current.head.sha] : [baseSha],
              message:
                title ??
                `Merge pull request #${String(pullRequest)} from ${current.head.name}`,
              author: repo.repository.owner,
              authoredAt: stamp(),
            },
            treeOf(repo, current.head.sha),
          );
          repo.branches.set(current.base, merge);
          issue.pull.merged = true;
          issue.state = "closed";
          if (current.base === repo.repository.defaultBranch) {
            for (const number of closingReferences(issue.body)) {
              const referenced = repo.issues.get(number);
              if (referenced !== undefined && referenced.pull === undefined) {
                referenced.state = "closed";
              }
            }
          }
          return { sha: merge };
        }),

      listCheckRuns: (ref) =>
        run(() => {
          const repo = state();
          const sha = resolveRef(repo, ref);
          return repo.checkRuns
            .filter((check) => check.headSha === sha)
            .map((check) => ({ ...check }));
        }),

      requiredChecks: (branch) =>
        run(() => {
          const repo = state();
          if (!repo.branches.has(branch)) {
            throw notFound(`branch ${branch}`);
          }
          return [...(repo.requiredChecks.get(branch) ?? [])];
        }),
    };
  };

  return {
    botLogin,

    installations: () =>
      Promise.resolve([...installations.values()].map((i) => ({ ...i }))),
    repositories: () =>
      Promise.resolve(
        [...repositories.values()].map(({ repository: repo }) => ({
          ...repo,
        })),
      ),
    repository,

    installRepository(
      fullName,
      { defaultBranch = "main", private: isPrivate = true } = {},
    ) {
      const [owner = "", name = ""] = fullName.split("/");
      if (repositories.has(fullName.toLowerCase())) {
        throw new Error(`${fullName} is already installed.`);
      }
      let installation = installations.get(owner.toLowerCase());
      if (installation === undefined) {
        installation = {
          id: id(),
          account: owner,
          repositorySelection: "selected",
        };
        installations.set(owner.toLowerCase(), installation);
      }
      const repository: Repository = {
        id: id(),
        fullName,
        owner,
        name,
        defaultBranch,
        private: isPrivate,
        htmlUrl: `https://github.com/${fullName}`,
      };
      const initial = newSha();
      const state: RepositoryState = {
        repository,
        installationId: installation.id,
        branches: new Map([[defaultBranch, initial]]),
        commits: new Set(),
        history: new Map(),
        trees: new Map(),
        labels: new Map(),
        issues: new Map(),
        checkRuns: [],
        requiredChecks: new Map(),
        nextNumber: 1,
      };
      addCommit(
        state,
        initial,
        {
          parents: [],
          message: "Initial commit",
          author: owner,
          authoredAt: stamp(),
        },
        new Map(),
      );
      repositories.set(fullName.toLowerCase(), state);
      return { ...repository };
    },

    uninstallRepository(fullName) {
      stateOf(fullName);
      repositories.delete(fullName.toLowerCase());
    },

    createIssue(fullName, { title, body, labels, author }) {
      const state = stateOf(fullName);
      return toIssue(
        state,
        openIssue(state, {
          title,
          body,
          labels,
          author: author ?? state.repository.owner,
        }),
      );
    },

    editIssue(fullName, number, { title, body }, { actor } = {}) {
      const state = stateOf(fullName);
      const issue = issueOf(state, number);
      // GitHub keeps no version for an edit that changes nothing.
      if (
        (title ?? issue.title) === issue.title &&
        (body ?? issue.body) === issue.body
      ) {
        return toIssue(state, issue);
      }
      issue.title = title ?? issue.title;
      issue.body = body ?? issue.body;
      const author = actor ?? issue.author;
      issue.versions.push({
        title: issue.title,
        body: issue.body,
        author,
        byApp: author === botLogin,
        at: stamp(),
      });
      return toIssue(state, issue);
    },

    forgetIssueVersion(fullName, number, index) {
      const issue = issueOf(stateOf(fullName), number);
      const version = issue.versions[index];
      if (version !== undefined) {
        issue.versions[index] = { ...version, body: null };
      }
    },

    setLabel(fullName, issue, label, { actor } = {}) {
      const state = stateOf(fullName);
      labelIssue(state, issue, [label], actor ?? state.repository.owner);
    },

    removeLabel(fullName, issue, label, { actor } = {}) {
      const state = stateOf(fullName);
      unlabelIssue(state, issue, label, actor ?? state.repository.owner);
    },

    labels(fullName) {
      return [...stateOf(fullName).labels.values()].map((label) => ({
        ...label,
      }));
    },

    pushCommit(
      fullName,
      branch,
      { sha = newSha(), files = {}, message, author, authoredAt } = {},
    ) {
      const state = stateOf(fullName);
      const parent =
        state.branches.get(branch) ??
        state.branches.get(state.repository.defaultBranch);
      const tree = new Map(
        parent === undefined ? [] : (state.trees.get(parent) ?? []),
      );
      for (const [path, text] of Object.entries(files)) {
        if (text === null) {
          tree.delete(path);
        } else {
          tree.set(path, text);
        }
      }
      addCommit(
        state,
        sha,
        {
          parents: parent === undefined || parent === sha ? [] : [parent],
          message: message ?? `Update ${branch}`,
          author: author ?? state.repository.owner,
          authoredAt: authoredAt?.toISOString() ?? stamp(),
        },
        tree,
      );
      state.branches.set(branch, sha);
      return sha;
    },

    reviewComments(fullName, pullRequest) {
      return pullOf(stateOf(fullName), pullRequest).pull.reviews.flatMap(
        ({ id: reviewId, comments }) =>
          comments.map((comment) => ({ ...comment, reviewId })),
      );
    },

    startCI(fullName, ref, { name = "CI" } = {}) {
      return { ...checkRun(stateOf(fullName), ref, name).run };
    },

    finishCI(fullName, ref, { conclusion = "success", name = "CI" } = {}) {
      const state = stateOf(fullName);
      const { run, index } = checkRun(state, ref, name);
      const finished: CheckRun = { ...run, status: "completed", conclusion };
      state.checkRuns[index] = finished;
      return { ...finished };
    },

    requireChecks(fullName, branch, names) {
      stateOf(fullName).requiredChecks.set(branch, [...names]);
    },

    grantPermissions(fullName, permissions) {
      const { installationId } = stateOf(fullName);
      granted.set(installationId, {
        ...granted.get(installationId),
        ...permissions,
      });
    },

    installationOf(fullName) {
      return repositories.get(fullName.toLowerCase())?.installationId;
    },

    compare(fullName, base, head) {
      return compare(stateOf(fullName), base, head);
    },

    installationPermissions: grantedTo,

    installationRepositories(installationId) {
      return [...repositories.values()]
        .filter((state) => state.installationId === installationId)
        .map(({ repository: repo }) => ({ ...repo }));
    },

    mintToken,

    tokenScope(token) {
      const scope = tokens.get(token);
      return scope !== undefined && scope.expiresAt > now() ? scope : undefined;
    },

    revokeToken(token) {
      tokens.delete(token);
    },
  };
}
