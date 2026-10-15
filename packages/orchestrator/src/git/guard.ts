import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { gitEnvironment } from "./command.ts";

// The `git` Sandcastle runs on the host (S1-2), run by `bin/git`, which
// `guardSandcastleGit` puts first on the app's PATH. Sandcastle manages
// an Agent's worktree with Git in the app's process, in a repository the
// Agent's sandbox has written: making and reusing the worktree, merging
// it, reading its status and removing it. So each of those commands is
// run as `runGit` runs AI Office's own: its repository is read first, and
// nothing it names runs (no hook, `core.fsmonitor`, driver, transport or
// remote program). Its environment is `runGit`'s too; of the caller's,
// only the locale and a commit's identity are kept. Git's own output,
// errors and exit status are the caller's to read, as before.

/** Of the caller's environment, what is kept. */
const kept = /^(LC_ALL|LANG|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE))$/;

const args = process.argv.slice(2);
// `git -C <dir> …` runs in `<dir>`: that is the repository to read.
let cwd = process.cwd();
for (let index = 0; args[index] === "-C"; index += 2) {
  cwd = resolve(cwd, args[index + 1] ?? ".");
}

try {
  const env = await gitEnvironment("run", {
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) =>
        kept.test(key) && value !== undefined ? [[key, value]] : [],
      ),
    ),
  });
  const git = spawn("git", args, { env, stdio: "inherit" });
  git.on("error", (error) => {
    process.stderr.write(`fatal: ${error.message}\n`);
    process.exitCode = 128;
  });
  git.on("exit", (code) => {
    process.exitCode = code ?? 128;
  });
} catch (error) {
  process.stderr.write(`fatal: ${(error as Error).message}\n`);
  process.exitCode = 128;
}
