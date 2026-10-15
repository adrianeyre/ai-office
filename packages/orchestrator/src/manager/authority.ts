import type { GitHubApp, Issue, RepositoryClient } from "@ai-office/github";
import {
  intakeLabel,
  isManagerAction,
  pipelineLabels,
  type ManagerAction,
  type PipelineStage,
} from "@ai-office/shared";

// The Manager's authority (PRD FR-23): it may retry, reassign, relabel,
// pause and escalate, and it may never merge, change repository settings or
// raise any cap. Every action it takes passes `assertManagerMay` first, so
// one permission check stands between any request (the watchdog's own, or
// one a model or a person makes later) and what is done. Beneath it, the
// Manager never holds what would let it do more:
//
// - its GitHub App client (`managerGitHub`) reads, labels and comments, and
//   refuses merging, write tokens, label and branch changes and the rest;
// - it moves an issue only back to `needs-work` or out to `needs-human`,
//   never forward, so it cannot carry work past review towards a merge;
// - it is given no Token Cap service at all.
//
// For the Owner's requests in its chat (FR-24, ADR 0004) it may also file
// issues and add and let go of Contractors, within its Floor's "most
// Agents", and nothing more: its GitHub client still refuses to create an
// issue, and chat filing goes through `managerChatIssues`, a narrow path
// of its own that only files a labelled issue and notes why, as Grilling
// Sessions file theirs.

/** Why the Manager may not do something. */
export class ManagerAuthorityError extends Error {
  readonly code = "not_permitted";
  /** What it was asked to do, such as `merge` or `raise_cap`. */
  readonly action: string;

  constructor(action: string, message?: string) {
    super(
      message ??
        `A Manager may not ${action.replaceAll("_", " ")}: it may retry, reassign, relabel, pause or escalate, and never merge, change repository settings or raise a cap.`,
    );
    this.name = "ManagerAuthorityError";
    this.action = action;
  }
}

/**
 * What the Manager may do for the Owner's requests in its chat (ADR 0004),
 * beyond its watchdog's actions.
 */
export const managerChatActions = [
  "file_issue",
  "add_contractor",
  "release_contractor",
] as const;
export type ManagerChatAction = (typeof managerChatActions)[number];

/**
 * Throws a `ManagerAuthorityError` unless the Manager may take `action`
 * for a request in its chat.
 */
export function assertManagerMayForChat(
  action: string,
): asserts action is ManagerChatAction {
  if (!(managerChatActions as readonly string[]).includes(action)) {
    throw new ManagerAuthorityError(
      action,
      `A Manager may not ${action.replaceAll("_", " ")} for a chat request: it may file issues and add or let go of Contractors, and never merge, change repository settings or raise a cap.`,
    );
  }
}

/** Throws a `ManagerAuthorityError` unless the Manager may take `action`. */
export function assertManagerMay(
  action: string,
): asserts action is ManagerAction {
  if (!isManagerAction(action)) {
    throw new ManagerAuthorityError(action);
  }
}

/**
 * Where the Manager may move an issue: back to `needs-work`, or out to the
 * Owner at `needs-human`. Never forward, so never past review.
 */
export const managerMoves: readonly PipelineStage[] = [
  "needs-work",
  "needs-human",
];

/** Throws a `ManagerAuthorityError` unless the Manager may move to `to`. */
export function assertManagerMayMove(to: PipelineStage): void {
  if (!managerMoves.includes(to)) {
    throw new ManagerAuthorityError(
      `relabel_to_${to}`,
      `A Manager may move an issue only back to needs-work or out to needs-human, never to ${to}.`,
    );
  }
}

/** A call the Manager's client refuses, as the action it would have been. */
const refuse = (action: string) => (): Promise<never> =>
  Promise.reject(new ManagerAuthorityError(action));

/** A repository as the Manager may use it: reading, labels and comments. */
const managerRepository = (client: RepositoryClient): RepositoryClient => ({
  fullName: client.fullName,
  get: () => client.get(),
  // A token that can write could change anything, settings included.
  installationToken: refuse("change_repository_settings"),
  readOnlyToken: refuse("github_read_only_token"),
  revokeToken: refuse("github_read_only_token"),

  createIssue: refuse("github_create_issue"),
  getIssue: (number) => client.getIssue(number),
  listIssues: (options) => client.listIssues(options),
  closeIssue: refuse("github_close_issue"),

  // A repository's labels are its settings; an issue's labels are not.
  ensureLabel: refuse("change_repository_settings"),
  renameLabel: refuse("change_repository_settings"),
  addLabels: (issue, labels) => client.addLabels(issue, labels),
  removeLabel: (issue, label) => client.removeLabel(issue, label),
  labelEvents: (issue) => client.labelEvents(issue),
  issueVersions: (issue) => client.issueVersions(issue),

  createComment: (issue, body) => client.createComment(issue, body),
  listComments: (issue) => client.listComments(issue),
  updateComment: (commentId, body) => client.updateComment(commentId, body),

  getBranch: (name) => client.getBranch(name),
  createBranch: refuse("github_create_branch"),
  deleteBranch: refuse("github_delete_branch"),
  listBranches: (prefix) => client.listBranches(prefix),
  compareBranches: (base, head) => client.compareBranches(base, head),

  createPullRequest: refuse("github_create_pull_request"),
  getPullRequest: (number) => client.getPullRequest(number),
  updatePullRequest: refuse("github_update_pull_request"),
  listPullRequestFiles: (pullRequest) =>
    client.listPullRequestFiles(pullRequest),
  listPullRequests: (options) => client.listPullRequests(options),
  getFileContent: (path, ref) => client.getFileContent(path, ref),
  listDirectory: (path, ref) => client.listDirectory(path, ref),
  listFiles: (ref) => client.listFiles(ref),
  compareCommits: (base, head) => client.compareCommits(base, head),

  createReview: refuse("github_create_review"),
  listReviews: (pullRequest) => client.listReviews(pullRequest),
  mergePullRequest: refuse("merge"),

  listCheckRuns: (ref) => client.listCheckRuns(ref),
  requiredChecks: (branch) => client.requiredChecks(branch),
});

/**
 * The GitHub App as the Manager may use it: each repository's client
 * refuses, with a `ManagerAuthorityError`, every call beyond reading,
 * labelling issues and commenting.
 */
export const managerGitHub = (app: GitHubApp): GitHubApp => ({
  installations: () => app.installations(),
  repositories: () => app.repositories(),
  repository: (fullName) => managerRepository(app.repository(fullName)),
});

/** An issue the Manager files for one of the Owner's chat requests. */
export interface ChatIssue {
  readonly title: string;
  readonly body: string;
  /** The note it leaves on the issue: why it filed it. */
  readonly note: string;
}

/** The one thing the Manager may file on GitHub: a chat request's issue. */
export interface ManagerChatIssues {
  /**
   * Files the issue on `repository`, labelled `ai-office`, and comments
   * the note on it. Nothing else: no other label, no branch, no merge.
   */
  file(repository: string, issue: ChatIssue): Promise<Issue>;
}

/**
 * The narrow path through which the Manager files its chat requests' issues
 * (ADR 0004), with the GitHub App itself, as a Grilling Session's are: the
 * intake label made if the repository lacks it, the issue created with it,
 * and the note commented, like every decision the Manager takes.
 */
export function managerChatIssues(app: GitHubApp): ManagerChatIssues {
  const label = pipelineLabels.find(({ name }) => name === intakeLabel);
  return {
    async file(repository, { title, body, note }) {
      assertManagerMayForChat("file_issue");
      const client = app.repository(repository);
      if (label !== undefined) {
        await client.ensureLabel(label);
      }
      const issue = await client.createIssue({
        title,
        body,
        labels: [intakeLabel],
      });
      await client.createComment(issue.number, note);
      return issue;
    },
  };
}
