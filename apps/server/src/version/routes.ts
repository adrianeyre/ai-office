import {
  latestPackageUrl,
  latestVersionSchema,
  versionErrorCodes,
  type ApiError,
  type LatestVersion,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

// The version check (Admin's "Check for latest version", and the one the
// web app makes as it opens): the latest version, from the root
// package.json on the repository's `main`. Asked by the server rather
// than the browser, so the web app still loads nothing from other sites;
// GitHub is sent nothing but the request. Its answer is taken only as a
// version number (`latestVersionSchema`); anything else is a failure, kept
// as one, so no other text it carries reaches the web app.

export interface VersionCheckOptions {
  /** Asks GitHub; the platform's own `fetch` unless given (tests). */
  readonly fetch?: typeof fetch;
  /** How long GitHub may take to answer; 5 seconds by default. */
  readonly timeoutMs?: number;
  /** How long an answer is kept; 10 minutes by default. */
  readonly cacheMs?: number;
  /** How long a failure is kept before GitHub is asked again; 1 minute. */
  readonly failureCacheMs?: number;
  readonly now?: () => number;
}

type Answer =
  | { readonly ok: true; readonly latest: LatestVersion }
  | { readonly ok: false; readonly message: string };

/** Asks GitHub which version is latest. */
async function askGitHub(
  fetchLatest: typeof fetch,
  timeoutMs: number,
): Promise<Answer> {
  try {
    const response = await fetchLatest(latestPackageUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `GitHub answered ${String(response.status)}.`,
      };
    }
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = latestVersionSchema.safeParse(body);
    if (parsed.success) {
      return { ok: true, latest: { version: parsed.data.version } };
    }
    // Anything but a version number is "could not find out": its text is
    // neither kept, shown, linked to nor logged.
    const given =
      typeof body === "object" && body !== null && "version" in body
        ? body.version
        : undefined;
    return {
      ok: false,
      message:
        typeof given === "string" && given !== ""
          ? "Its package.json's version is not a version number."
          : "Its package.json has no version.",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "GitHub took too long to answer."
          : "GitHub could not be reached.",
    };
  }
}

export function registerVersionRoutes(
  app: FastifyInstance,
  options: VersionCheckOptions = {},
): void {
  const {
    fetch: fetchLatest = globalThis.fetch,
    timeoutMs = 5000,
    cacheMs = 10 * 60_000,
    failureCacheMs = 60_000,
    now = Date.now,
  } = options;
  // The last answer, and when it stops being kept; one question at a time.
  let kept: { answer: Promise<Answer>; until: number } | undefined;

  const latest = (): Promise<Answer> => {
    if (kept !== undefined && now() < kept.until) {
      return kept.answer;
    }
    const answer = askGitHub(fetchLatest, timeoutMs);
    const entry = { answer, until: Number.POSITIVE_INFINITY };
    kept = entry;
    void answer.then((settled) => {
      entry.until = now() + (settled.ok ? cacheMs : failureCacheMs);
    });
    return answer;
  };

  app.get(
    "/api/version/latest",
    { config: { access: "owner" } },
    async (request, reply) => {
      const answer = await latest();
      if (!answer.ok) {
        request.log.info(
          { reason: answer.message },
          "The latest version could not be found out.",
        );
        const body: ApiError = {
          error: versionErrorCodes.versionCheckFailed,
          message: answer.message,
        };
        return reply.code(502).header("cache-control", "no-store").send(body);
      }
      return reply.header("cache-control", "no-store").send(answer.latest);
    },
  );
}
