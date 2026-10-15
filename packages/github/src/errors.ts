/**
 * A call to GitHub failed. `status` is GitHub's HTTP status (404 for a
 * repository, issue or branch that does not exist or that the App cannot
 * see, 422 for a request GitHub refused, 409 for a conflict); 0 when
 * GitHub could not be reached. The message never holds a credential.
 */
export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** Whether `error` is a `GitHubError` with `status`. */
export const isGitHubError = (
  error: unknown,
  status?: number,
): error is GitHubError =>
  error instanceof GitHubError &&
  (status === undefined || error.status === status);
