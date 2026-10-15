import { chmod, lstat, mkdir } from "node:fs/promises";

// The sandboxes' work directory (SANDBOX_WORK_DIR), where every Floor's
// clones are made, and the directories under it. Under `pnpm dev` it is in
// the system's temporary directory by default, which every local user may
// write to (pen-testing I2-4): one who got there first could have made it,
// to read the clones, or left a symbolic link, to have them made where they
// chose. So what is there is taken only if it is a directory, not a link,
// and this process's user's own. It holds every Floor's private source, so
// it is private to that user too: no group or other access (I2-5), which
// keeps every clone beneath it from other local users and anything else
// sharing the directory.

/** Why a work directory was not taken. */
export class WorkDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkDirError";
  }
}

/**
 * Makes `path` (and any missing directory above it) private to this
 * process's user, or takes it if it is already there as that user's own
 * directory, making it private if it was not. Throws a `WorkDirError` for
 * a symbolic link, anything but a directory, or another user's directory,
 * and never follows a link.
 */
export async function makeWorkDir(path: string): Promise<void> {
  // A link, or another user's directory, already there is not replaced,
  // and is refused below.
  const made = await mkdir(path, { recursive: true, mode: 0o700 }).catch(
    (error: unknown) => error,
  );
  const found = await lstat(path).catch(() => undefined);
  if (found === undefined) {
    throw made instanceof Error
      ? made
      : new WorkDirError(`The work directory ${path} could not be made.`);
  }
  if (found.isSymbolicLink()) {
    throw new WorkDirError(
      `The work directory ${path} is a symbolic link: AI Office makes clones only in a directory of its own, so remove it, or set SANDBOX_WORK_DIR elsewhere.`,
    );
  }
  if (!found.isDirectory()) {
    throw new WorkDirError(
      `The work directory ${path} is not a directory: remove it, or set SANDBOX_WORK_DIR elsewhere.`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && found.uid !== uid) {
    throw new WorkDirError(
      `The work directory ${path} belongs to UID ${String(found.uid)}, not to AI Office's user (${String(uid)}): another user may have made it, so remove it, or set SANDBOX_WORK_DIR elsewhere.`,
    );
  }
  // As made before, or by another tool, with group or other access.
  if ((found.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
}
