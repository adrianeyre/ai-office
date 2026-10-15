import { delimiter } from "node:path";

import { gitGuardDirectory, withoutGitGuard } from "../git/command.ts";

// Sandcastle runs Git on the host, in the app's process, to manage an
// Agent's worktree: it makes or reuses it (`git worktree add`, a fetch and
// `git merge --ff-only`), reads its status, collects its commits and
// removes it. Its `.git` is the one the Agent's sandbox wrote, as it is
// mounted there. Sandcastle runs `git` from the PATH with the app's whole
// environment, so it would run whatever that repository names: its
// hooks, `core.fsmonitor`, filters (S1-2).
//
// So before AI Office runs Sandcastle, it puts its own `git` first on the
// app's PATH (`../git/bin/git`), which runs each command as AI Office runs
// its own (`runGit`, S1-1): nothing the repository names runs. It is the
// whole app's PATH, as Sandcastle reads it when it runs Git, and stays.
// AI Office's own Git (`runGit`) skips it. Sandboxes do not see it: their
// environment is allow-listed.

/** Puts AI Office's guarded `git` first on the PATH, once. */
export function guardSandcastleGit(): void {
  const path = process.env["PATH"] ?? "";
  if (path.split(delimiter)[0] === gitGuardDirectory) {
    return;
  }
  const rest = withoutGitGuard(path);
  process.env["PATH"] =
    rest === "" ? gitGuardDirectory : `${gitGuardDirectory}${delimiter}${rest}`;
}
