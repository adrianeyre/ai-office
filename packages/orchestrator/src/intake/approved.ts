import type {
  GitHubApp,
  Issue,
  IssueVersion,
  LabelEvent,
  RepositoryClient,
} from "@ai-office/github";
import { intakeLabel } from "@ai-office/shared";

// The issue text the Agents work (PRD FR-8, PRD §4; pen-test finding
// P1-5): the text the Owner approved, never whatever the issue says now.
// The Owner's label approves the text as it was when they labelled it, but
// anyone who can edit the issue could change it afterwards, and every
// Stage read it afresh. So of the issue's versions (its title and body as
// opened, then after each edit), the one worked is the latest that is
// - the Owner's own, or the App's (an issue AI Office filed for the
//   Owner's chat request or Grilling Session); or
// - another's, written before the Owner's latest `ai-office` label.
// An edit by anyone else after that label is not worked until the Owner
// labels the issue again (removing the label and adding it back). A
// version written in the same second as the label cannot be put on either
// side of it, and one GitHub no longer has cannot be read: either leaves
// nothing approved, and the issue is not worked.

/** Why an issue has no text the Owner approved. */
export class UnapprovedIssueError extends Error {
  readonly issue: number;

  constructor(issue: number) {
    super(
      `Issue #${String(issue)} was edited after the Owner approved it, by someone else, so AI Office does not work it: to work it as it is now, the Owner removes its ai-office label and adds it again.`,
    );
    this.name = "UnapprovedIssueError";
    this.issue = issue;
  }
}

const sameLogin = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/**
 * The version of an issue the Owner approved: the latest the Owner or the
 * App wrote, or another wrote before the Owner's latest `ai-office` label.
 * Undefined when there is none, or it cannot be read.
 */
export function approvedVersion(
  versions: readonly IssueVersion[],
  labelEvents: readonly LabelEvent[],
  owner: string,
): IssueVersion | undefined {
  const labelled = labelEvents
    .filter(
      ({ action, label, actor }) =>
        action === "labeled" &&
        sameLogin(label, intakeLabel) &&
        sameLogin(actor, owner),
    )
    .at(-1);
  const approvedAt =
    labelled === undefined ? undefined : Date.parse(labelled.createdAt);
  let approved: IssueVersion | undefined;
  for (const version of versions) {
    const at = Date.parse(version.at);
    if (version.byApp || sameLogin(version.author, owner)) {
      approved = version;
    } else if (approvedAt !== undefined && at < approvedAt) {
      approved = version;
    } else if (approvedAt !== undefined && at === approvedAt) {
      // Before the label or after it: nobody can tell.
      approved = undefined;
    }
  }
  return approved?.body === null ? undefined : approved;
}

/**
 * The issue, with the title and body the Owner approved; an
 * `UnapprovedIssueError` when it has none.
 */
export async function approvedIssue(
  repository: Pick<
    RepositoryClient,
    "getIssue" | "issueVersions" | "labelEvents"
  >,
  number: number,
  owner: string,
): Promise<Issue> {
  const [issue, versions, labelEvents] = await Promise.all([
    repository.getIssue(number),
    repository.issueVersions(number),
    repository.labelEvents(number),
  ]);
  const approved = approvedVersion(versions, labelEvents, owner);
  if (approved?.body === null || approved === undefined) {
    throw new UnapprovedIssueError(number);
  }
  return { ...issue, title: approved.title, body: approved.body };
}

/**
 * The GitHub App as a Stage uses it: each repository's `getIssue` answers
 * with the title and body the Owner approved (`approvedIssue`), so no
 * Agent is given an edit made after the Owner's approval.
 */
export function withApprovedIssues(
  github: GitHubApp,
  ownerLogin: () => Promise<string>,
): GitHubApp {
  return {
    installations: () => github.installations(),
    repositories: () => github.repositories(),
    repository(fullName) {
      const client = github.repository(fullName);
      return {
        ...client,
        getIssue: async (number) =>
          approvedIssue(client, number, await ownerLogin()),
      };
    },
  };
}
