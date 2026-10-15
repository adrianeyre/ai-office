import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Who may set the first password (A1-2, PRD FR-1). Until a password exists
// the setup screen is the whole of the Office's authorisation, so it needs
// something only the host has: a request from this machine's loopback, or
// the one-time setup token AI Office writes to a file when it starts with
// no password. The token is never logged; the file's path is. Either way,
// the request must be for a name AI Office is served at, so a page whose
// own name has been rebound to the app (DNS rebinding) cannot use it.

/** The one-time setup token, while no password exists. */
export interface SetupToken {
  /** Whether `candidate` is the token, compared in constant time. */
  matches(candidate: string): boolean;
  /** Where the Owner reads it on the host, for the setup screen to say. */
  readonly where: string;
  /** The password is set, so setup is over for good: the file goes. */
  spend(): Promise<void>;
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value.trim()).digest();

/** A setup token kept in memory only (tests, and `writeSetupToken`). */
export function setupToken(
  token: string,
  where: string,
  onSpent: () => Promise<void> = () => Promise.resolve(),
): SetupToken {
  const expected = digest(token);
  return {
    matches: (candidate) => timingSafeEqual(digest(candidate), expected),
    where,
    spend: onSpent,
  };
}

/**
 * Makes a new token and writes it, readable by this user alone, to a file
 * in a new private directory under `parent` (the system's temporary
 * directory by default), whose name cannot be guessed or planted.
 */
export async function writeSetupToken(
  parent: string = tmpdir(),
): Promise<SetupToken> {
  const directory = await mkdtemp(join(parent, "ai-office-setup-"));
  const path = join(directory, "token");
  const token = randomBytes(24).toString("base64url");
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  return setupToken(token, path, () =>
    rm(directory, { recursive: true, force: true }),
  );
}

/** Whether `ip` is this machine's loopback (127.0.0.0/8 or ::1). */
export function isLoopback(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4 !== undefined) {
    return isIP(v4) === 4 && v4.startsWith("127.");
  }
  return ip === "::1";
}

/** The name in a URL, without an IPv6 address's brackets. */
const nameOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return undefined;
  }
};

/**
 * Whether a request for `host` is for a name AI Office is served at:
 * PUBLIC_URL's, `localhost`, or an address. A rebinding page's request is
 * for the page's own name, which is none of these.
 */
export function isServedAt(
  host: string | undefined,
  publicUrl: string | undefined,
): boolean {
  const name = host === undefined ? undefined : nameOf(`http://${host}`);
  if (name === undefined || name === "") {
    return false;
  }
  if (publicUrl !== undefined && name === nameOf(publicUrl)) {
    return true;
  }
  return name === "localhost" || isIP(name) !== 0;
}
