import { useSyncExternalStore } from "react";

// What the Owner is waiting on: every request a click sends (each save,
// add, delete or action through `sendJson` and `sendDelete`, and each
// Refresh), tracked from when it is sent until it is answered, so the
// Activity indicator can show what is happening, for how long, and how it
// ended. Background reads (queries, live streams) are not tracked: the
// Owner did not ask for them and is not waiting on them.

/** One thing the Owner is waiting on. */
export interface Activity {
  readonly id: number;
  /** What it is doing, in words: "Saving the office's currency". */
  readonly label: string;
  /** The request behind it: "PUT /api/office/currency". */
  readonly detail: string;
  /** When it was sent (`performance.now()`). */
  readonly startedAt: number;
  readonly status: "running" | "done" | "failed";
  /** When it was answered, once it has been. */
  readonly finishedAt?: number;
  /** Why it failed: the server's answer, or the network's error. */
  readonly problem?: string;
}

/** How long an ended activity stays on show, so its outcome can be read. */
export const endedVisibleMs = 2500;

type Listener = () => void;

let activities: readonly Activity[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const now = () => performance.now();

function publish(next: readonly Activity[]) {
  activities = next;
  for (const listener of listeners) {
    listener();
  }
}

function settle(id: number, ended: Pick<Activity, "status" | "problem">) {
  publish(
    activities.map((activity) =>
      activity.id === id
        ? {
            ...activity,
            ...ended,
            finishedAt: now(),
          }
        : activity,
    ),
  );
  setTimeout(() => {
    publish(activities.filter((activity) => activity.id !== id));
  }, endedVisibleMs);
}

/** Whether a settled value counts as a failure: a response that was not ok. */
const failureOf = (value: unknown): string | undefined =>
  value instanceof Response && !value.ok
    ? `The server answered ${String(value.status)}${value.statusText === "" ? "" : ` ${value.statusText}`}.`
    : undefined;

/**
 * Tracks `work` as something the Owner is waiting on, described by `what`,
 * until it settles; resolves or rejects as `work` does. A `Response` that
 * is not ok counts as a failure, as a rejection does.
 */
export function track<T>(
  what: { readonly label: string; readonly detail: string },
  work: Promise<T>,
): Promise<T> {
  const id = nextId++;
  publish([
    ...activities,
    { id, ...what, startedAt: now(), status: "running" },
  ]);
  work.then(
    (value) => {
      const problem = failureOf(value);
      settle(
        id,
        problem === undefined
          ? { status: "done" }
          : { status: "failed", problem },
      );
    },
    (error: unknown) => {
      settle(id, {
        status: "failed",
        problem:
          error instanceof Error
            ? error.message
            : "The request could not be sent.",
      });
    },
  );
  return work;
}

/** Everything being waited on, and what ended in the last few seconds. */
export function useActivities(): readonly Activity[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activities,
    () => activities,
  );
}

/** Forgets every activity: for tests. */
export function resetActivities(): void {
  publish([]);
}

// What a request is doing, in words, from its method and path.

/** A path segment that names one thing (an id), not a kind of thing. */
const isId = (segment: string, before: string | undefined): boolean =>
  /^\d+$/.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) ||
  segment.length > 40 ||
  // What follows a collection (floors/web-shop, prices/claude-opus-5-5).
  (before !== undefined && before.endsWith("s") && !actions.has(segment));

/** Paths' last segments that are something to do, not something to change. */
const actions = new Set([
  "approve",
  "archive",
  "cancel",
  "check",
  "complete",
  "import",
  "login",
  "logout",
  "pause",
  "preview",
  "reauthenticate",
  "refresh",
  "reject",
  "restore",
  "resume",
  "retry",
  "rotate",
  "send",
  "start",
  "stop",
  "test",
  "unarchive",
]);

/** Requests named for what they do, where the path alone says it poorly. */
const named: readonly (readonly [RegExp, string])[] = [
  [/^POST \/api\/login$/, "Signing in"],
  [/^POST \/api\/logout$/, "Signing out"],
  [/^POST \/api\/setup$/, "Setting up AI Office"],
  [/^PUT \/api\/office\/currency$/, "Saving the office's currency"],
  [/^POST \/api\/gateway-keys$/, "Making an API key"],
  [/^POST \/api\/ai-accounts$/, "Adding an AI Account"],
  [/^POST \/api\/ai-accounts\/oauth$/, "Starting the AI Provider's sign-in"],
  [/^POST \/api\/ai-accounts\/oauth\/[^/]+$/, "Finishing the sign-in"],
  [
    /^POST \/api\/configuration\/import\/preview$/,
    "Checking the configuration",
  ],
  [/^POST \/api\/configuration\/import$/, "Importing the configuration"],
  [/^POST \/api\/floors$/, "Adding a Floor"],
];

/** Words AI Office writes in capitals, or as their own names. */
const proper: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  github: "GitHub",
  oauth: "OAuth",
  totp: "TOTP",
  url: "URL",
};

const words = (segment: string) =>
  segment
    .split(/[-_]/)
    .map((word) => proper[word] ?? word)
    .join(" ");
const capitalised = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What a request is doing, in words, and the request itself: "Saving
 * prompt budget" for `PUT /api/office/prompt-budget`, "Deleting price"
 * for `DELETE /api/gateway/prices/gpt-5`, "Rotate gateway key" for
 * `POST …/gateway-key/rotate`.
 */
export function describeRequest(
  method: string,
  url: string,
): { readonly label: string; readonly detail: string } {
  const path = (url.split(/[?#]/)[0] ?? url).replace(/\/+$/, "");
  const detail = `${method} ${path}`;
  for (const [pattern, label] of named) {
    if (pattern.test(detail)) {
      return { label, detail };
    }
  }
  const segments = path
    .split("/")
    .filter((segment) => segment !== "" && segment !== "api")
    .map((segment) => decodeURIComponent(segment));
  const ids = segments.map((segment, index) =>
    isId(segment, segments[index - 1]),
  );
  const kept = segments.filter((_segment, index) => ids[index] !== true);
  const last = kept.at(-1) ?? "changes";
  const before = kept.at(-2);
  // One of a collection when an id follows it (floors/web-shop).
  const one = ids.at(-1) === true;
  const plural = (text: string) => /[^s]s$/.test(text);
  const singular = (text: string) => (plural(text) ? text.slice(0, -1) : text);
  const thing = words(last);
  let label: string;
  if (method === "DELETE") {
    label = `Deleting ${singular(thing)}`;
  } else if (method === "POST") {
    label =
      plural(thing) && !one
        ? `Adding ${singular(thing)}`
        : // Something to do to a thing: "Rotate gateway key".
          capitalised(
            [thing, before === undefined ? "" : singular(words(before))]
              .join(" ")
              .trim(),
          );
  } else {
    label = `Saving ${one ? singular(thing) : thing}`;
  }
  return { label, detail };
}

/** Tracks a request the Owner is waiting on, described from its path. */
export const trackRequest = (
  method: string,
  url: string,
  work: Promise<Response>,
): Promise<Response> => track(describeRequest(method, url), work);
