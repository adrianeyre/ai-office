// What AI Office needs from GitHub (PRD FR-6, FR-70; ADR 0002), in its own
// terms. The GitHub App client (`createGitHubApp`) and the fake GitHub
// (`createFakeGitHub`) both implement these, and the contract suite holds
// them to the same behaviour.
//
// Repositories are named `owner/name`, as GitHub does; names are matched
// without regard to case, as GitHub matches them.

/** An installation of the App on a user's or organisation's account. */
export interface Installation {
  readonly id: number;
  /** The login of the account it is installed on. */
  readonly account: string;
  /** Whether it covers every repository of the account or chosen ones. */
  readonly repositorySelection: "all" | "selected";
}

export interface Repository {
  /** GitHub's id: it survives a rename, unlike the name. */
  readonly id: number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
}

export type IssueState = "open" | "closed";

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly labels: readonly string[];
  /** The login of whoever opened it. */
  readonly author: string;
  readonly htmlUrl: string;
}

/**
 * One version of an issue's text: as it was opened, then after each edit
 * of its title or body. AI Office works the version the Owner approved,
 * not whatever the issue says now (PRD FR-8; pen-test finding P1-5).
 */
export interface IssueVersion {
  readonly title: string;
  /**
   * Null when GitHub no longer has it: its edit was deleted from the
   * issue's history, or is older than the history GitHub gives.
   */
  readonly body: string | null;
  /** The login of whoever wrote it: the issue's author, then each editor. */
  readonly author: string;
  /** Whether the App wrote it, as it does an issue it files. */
  readonly byApp: boolean;
  /** When it was written. */
  readonly at: string;
}

/** Someone added or removed a label on an issue or pull request. */
export interface LabelEvent {
  readonly action: "labeled" | "unlabeled";
  readonly label: string;
  /** The login of whoever added or removed it. */
  readonly actor: string;
  readonly createdAt: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  /** The comment on its issue's (or pull request's) page. */
  readonly htmlUrl: string;
}

export interface Branch {
  readonly name: string;
  /** The commit the branch points at. */
  readonly sha: string;
}

/** A commit, as a branch's history shows it. */
export interface Commit {
  readonly sha: string;
  /** Its whole message: the subject line, then any body and trailers. */
  readonly message: string;
  /** Its author's name, as Git records it (the Owner's, ADR 0002). */
  readonly author: string;
  /** When it was authored, as an ISO time. */
  readonly authoredAt: string;
  /** The commit's page on GitHub. */
  readonly htmlUrl: string;
}

/**
 * How a branch stands against another, as GitHub compares `base...head`
 * (and `git rev-list --left-right --count base...head` counts).
 */
export interface BranchComparison {
  /** Commits on `head` that `base` does not have. */
  readonly aheadBy: number;
  /** Commits on `base` that `head` does not have. */
  readonly behindBy: number;
  /** The newest commit both have: where `head` split off `base`. */
  readonly mergeBase: Commit;
  /**
   * `head`'s own commits (those `base` does not have), oldest first: the
   * newest `maxComparedCommits` of them when it has more.
   */
  readonly commits: readonly Commit[];
}

/** The most of a branch's own commits `compareBranches` gives. */
export const maxComparedCommits = 100;

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly merged: boolean;
  readonly draft: boolean;
  readonly author: string;
  readonly head: Branch;
  /** The branch it merges into. */
  readonly base: string;
  readonly htmlUrl: string;
}

/** A comment on one line of a pull request's diff. */
export interface ReviewComment {
  readonly path: string;
  /** The line in the new version of the file. */
  readonly line: number;
  readonly body: string;
}

export interface Review {
  readonly id: number;
  readonly body: string;
  /** GitHub's review state, such as `COMMENTED` or `APPROVED`. */
  readonly state: string;
  readonly author: string;
  /** The commit it reviewed. */
  readonly commitSha: string;
  /** The review on the pull request's page. */
  readonly htmlUrl: string;
}

/** A file a pull request changes, as GitHub compares its branches. */
export interface PullRequestFile {
  /** Its path in the new version (the old one, if it was removed). */
  readonly path: string;
  readonly status:
    | "added"
    | "removed"
    | "modified"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  /** Its path before it was renamed or copied. */
  readonly previousPath?: string;
  /**
   * The change as unified diff hunks (from `@@`, without file headers);
   * null when GitHub gives none, as for a binary file or a huge diff.
   */
  readonly patch: string | null;
}

/** A file changed between two commits, with how many lines changed. */
export interface ComparedFile {
  readonly path: string;
  readonly status: PullRequestFile["status"];
  readonly additions: number;
  readonly deletions: number;
  /**
   * The change as unified diff hunks (from `@@`, without file headers);
   * null when GitHub gives none, as for a binary file or a huge diff.
   */
  readonly patch: string | null;
}

/** An entry in a repository's directory. */
export interface DirectoryEntry {
  /** Its name in the directory. */
  readonly name: string;
  /** Its path from the repository's top. */
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
}

export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale";

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  /** Null until it has completed. */
  readonly conclusion: CheckRunConclusion | null;
  readonly headSha: string;
  /** The check run's page on GitHub. */
  readonly htmlUrl: string;
}

/** What an installation token may do, by permission (`contents`, …). */
export type TokenPermissions = Readonly<Record<string, "read" | "write">>;

/**
 * The repository permissions the AI Office GitHub App is registered with,
 * and all it needs (PRD FR-70; the setup guide,
 * `docs/processes/setting-up-a-floor.md`, lists them). Every call
 * `RepositoryClient` makes needs one of these: the fake GitHub served over
 * HTTP refuses a call its token's permissions do not cover, as GitHub
 * does. `metadata` is granted to every App.
 */
export const appPermissions: TokenPermissions = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
};

/**
 * What the App's own token asks for, the one that pushes, merges, labels
 * and comments: `appPermissions`, and **Workflows** only when the Owner
 * granted it, so Agents may change CI as the setup guide offers (W1-2).
 * Nothing else the installation was granted is asked for.
 */
export function writingPermissions(
  granted: TokenPermissions,
): TokenPermissions {
  return granted["workflows"] === "write"
    ? { ...appPermissions, workflows: "write" }
    : appPermissions;
}

/** What the token that lists the installation's repositories asks for. */
export const listingPermissions: TokenPermissions = { metadata: "read" };

/** The permissions of a token that can read but not write. */
export const readOnlyPermissions: TokenPermissions = {
  contents: "read",
  issues: "read",
  pull_requests: "read",
  checks: "read",
};

export type MergeMethod = "merge" | "squash" | "rebase";

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** The AI Office GitHub App, acting on the repositories it is installed on. */
export interface GitHubApp {
  installations(): Promise<Installation[]>;
  /** Every repository the App is installed on, across its installations. */
  repositories(): Promise<Repository[]>;
  /**
   * The calls AI Office makes on one repository, as the App, with an
   * installation token scoped to that repository alone. Nothing is called
   * until a method is: a repository the App is not installed on fails then,
   * with a 404 `GitHubError`.
   */
  repository(fullName: string): RepositoryClient;
}

/** The App's calls on one repository. Failures are `GitHubError`s. */
export interface RepositoryClient {
  readonly fullName: string;
  get(): Promise<Repository>;
  /**
   * A short-lived installation token for this repository alone (for
   * `git push` over HTTPS). It is a credential: never log it.
   */
  installationToken(): Promise<InstallationToken>;
  /**
   * A new installation token for this repository alone that can read its
   * contents, issues, pull requests and checks but change none of them:
   * what a sandbox gets (PRD FR-19). Each call mints its own, never shared
   * with another caller (W1-3), so revoke it with `revokeToken` once its
   * sandbox, session or run has stopped. It is a credential: never log it.
   */
  readOnlyToken(): Promise<InstallationToken>;
  /**
   * Revokes a token `readOnlyToken` gave, so it stops working at once
   * rather than at the end of its hour (GitHub's
   * `DELETE /installation/token`). One that has expired or was revoked
   * already is no error.
   */
  revokeToken(token: string): Promise<void>;

  // Issues
  createIssue(input: {
    readonly title: string;
    readonly body?: string;
    readonly labels?: readonly string[];
  }): Promise<Issue>;
  getIssue(number: number): Promise<Issue>;
  /** Issues only, never pull requests; open ones unless `state` says. */
  listIssues(options?: {
    /** Only issues with every one of these labels. */
    readonly labels?: readonly string[];
    readonly state?: IssueState | "all";
  }): Promise<Issue[]>;
  closeIssue(number: number): Promise<Issue>;

  // Labels
  /** Creates the label unless the repository already has it. */
  ensureLabel(label: {
    readonly name: string;
    /** Six hex digits, without `#`. */
    readonly color: string;
    readonly description?: string;
  }): Promise<void>;
  /**
   * Renames the label `name` to `label.name`, with its colour and
   * description when given. It stays on every issue and pull request that
   * has it, as GitHub renames one. False when the repository has no label
   * `name`; refused (422) when it has one called `label.name` already.
   */
  renameLabel(
    name: string,
    label: {
      readonly name: string;
      /** Six hex digits, without `#`. */
      readonly color?: string;
      readonly description?: string;
    },
  ): Promise<boolean>;
  /** Adds labels to an issue or pull request; returns all its labels. */
  addLabels(issue: number, labels: readonly string[]): Promise<string[]>;
  /** Removes a label; nothing happens if the issue does not have it. */
  removeLabel(issue: number, label: string): Promise<void>;
  /**
   * Who added and removed the issue's labels, oldest first: to tell
   * whether the Owner applied a label personally (PRD FR-8).
   */
  labelEvents(issue: number): Promise<LabelEvent[]>;
  /**
   * Every version of the issue's title and body, oldest first: the last
   * is the issue as it is now (pen-test finding P1-5).
   */
  issueVersions(issue: number): Promise<IssueVersion[]>;

  // Comments, on issues and pull requests alike
  createComment(issue: number, body: string): Promise<IssueComment>;
  /** Oldest first. */
  listComments(issue: number): Promise<IssueComment[]>;
  /**
   * Rewrites a comment's body in place, by the comment's id: the App
   * edits one comment rather than posting many (PRD FR-21).
   */
  updateComment(commentId: number, body: string): Promise<IssueComment>;

  // Branches
  /** The branch, or undefined if there is none by that name. */
  getBranch(name: string): Promise<Branch | undefined>;
  /** Creates a branch at `sha`; a 422 if it already exists. */
  createBranch(name: string, sha: string): Promise<Branch>;
  deleteBranch(name: string): Promise<void>;
  /**
   * The branches whose names start with `prefix` (every branch when it is
   * empty), sorted by name: one call however many there are, as GitHub
   * lists matching refs.
   */
  listBranches(prefix?: string): Promise<Branch[]>;
  /**
   * How `head` stands against `base` (each a branch or a commit): how far
   * ahead and behind it is, where it split off, and its own commits. A 404
   * when either does not exist.
   */
  compareBranches(base: string, head: string): Promise<BranchComparison>;

  // Pull requests
  createPullRequest(input: {
    readonly title: string;
    readonly body: string;
    /** The branch with the changes. */
    readonly head: string;
    /** The branch to merge into. */
    readonly base: string;
    readonly draft?: boolean;
  }): Promise<PullRequest>;
  getPullRequest(number: number): Promise<PullRequest>;
  /**
   * Rewrites the pull request's title or body, or both: a Batch's one pull
   * request is written again as each of its issues joins it.
   */
  updatePullRequest(
    pullRequest: number,
    changes: { readonly title?: string; readonly body?: string },
  ): Promise<PullRequest>;
  /** The files the pull request changes, as GitHub lists them. */
  listPullRequestFiles(pullRequest: number): Promise<PullRequestFile[]>;
  /** Open ones unless `state` says; only those from `head` if given. */
  listPullRequests(options?: {
    readonly state?: IssueState | "all";
    readonly head?: string;
  }): Promise<PullRequest[]>;

  /**
   * The files that differ from commit `base` to commit `head`, with the
   * lines each adds and deletes, as GitHub compares them.
   */
  compareCommits(base: string, head: string): Promise<ComparedFile[]>;

  // Contents
  /**
   * A file's text at `ref` (a branch or a commit); undefined when there is
   * no file at that path (or it is a directory).
   */
  getFileContent(path: string, ref: string): Promise<string | undefined>;
  /**
   * What a directory holds at `ref`, by name; undefined when there is no
   * directory at that path (nothing, or a file).
   */
  listDirectory(
    path: string,
    ref: string,
  ): Promise<DirectoryEntry[] | undefined>;
  /**
   * Every file's path in the repository's tree at `ref`, sorted: what the
   * Manager chat's `@` mentions offer (FR-24). GitHub answers at most
   * 100,000 entries (7 MB) at once; a larger tree is answered as far as
   * it goes.
   */
  listFiles(ref: string): Promise<string[]>;

  // Reviews
  /**
   * Posts a review as the App, with `comments` on lines of the diff. It is
   * always a comment review: the App opens AI Office's pull requests, and
   * GitHub refuses an approval (or a request for changes) from a pull
   * request's own author. The Merge Policy, not GitHub's approval count,
   * decides a merge (ADR 0002). A comment on a line outside the diff is
   * refused with a 422.
   */
  createReview(
    pullRequest: number,
    input: {
      readonly body: string;
      readonly comments?: readonly ReviewComment[];
      /** The commit reviewed; the pull request's head by default. */
      readonly commitSha?: string;
    },
  ): Promise<Review>;
  listReviews(pullRequest: number): Promise<Review[]>;

  // Merges
  /**
   * Merges the pull request. With `sha`, only if its head is still that
   * commit (a 409 otherwise). Resolves with the merge commit's sha.
   */
  mergePullRequest(
    pullRequest: number,
    options: {
      readonly method: MergeMethod;
      readonly sha?: string;
      readonly title?: string;
    },
  ): Promise<{ readonly sha: string }>;

  // Check runs (CI)
  /** The check runs on a commit, or on a branch's head commit. */
  listCheckRuns(ref: string): Promise<CheckRun[]>;
  /**
   * The checks that must pass before anything merges into `branch`, by
   * name: its branch protection's required status checks and its
   * rulesets' (the Merge Policy's gate, PRD FR-29). Empty when it requires
   * none; a 404 when there is no such branch.
   */
  requiredChecks(branch: string): Promise<string[]>;
}
