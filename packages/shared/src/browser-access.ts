import { z } from "zod";

// Browser access (ADR 0013): whether an Owner tool's Gateway Key may be
// used from a web page in a browser (CORS), calling the AI Gateway's `/v1`
// routes: off (the default), from the exact origins the Owner lists, or
// from any origin. Never credentialed: the key is the only credential.
// The server and the web app share these.

/** The most origins one key's Browser access may list. */
export const maxBrowserOrigins = 20;

/** The hosts a page may be served from over plain http: this machine's. */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * One origin a key's Browser access lists: `https://` and a host, with a
 * port if it is not the default; `http://` only for localhost, 127.0.0.1
 * or [::1]. No path, not even a trailing slash, no query and no
 * credentials. Given back as the browser sends it in `Origin`: lowercased,
 * without a default port.
 */
export const browserOriginSchema = z
  .string({ error: "A browser origin is an address, such as https://x.dev." })
  .trim()
  .min(1, { error: "A browser origin is an address, such as https://x.dev." })
  .transform((value, context) => {
    const problem = (message: string) => {
      context.addIssue({ code: "custom", message, input: value });
      return z.NEVER;
    };
    if (value.includes("*")) {
      return problem(
        `${value}: list each origin in full; a wildcard is not allowed.`,
      );
    }
    if (value.toLowerCase() === "null") {
      return problem("The null origin is not allowed: list a real address.");
    }
    // A scheme, `//`, and a host and port: nothing after them.
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]+$/i.test(value)) {
      return problem(
        `${value}: an origin is a scheme, a host and an optional port, such as https://x.dev or http://localhost:4870, with no path or trailing slash.`,
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return problem(`${value} is not an address.`);
    }
    if (url.protocol === "http:") {
      if (!loopbackHosts.has(url.hostname)) {
        return problem(
          `${value}: plain http is allowed only for localhost, 127.0.0.1 and [::1]; use https.`,
        );
      }
    } else if (url.protocol !== "https:") {
      return problem(`${value}: an origin is https:// (or http:// locally).`);
    }
    return url.origin.toLowerCase();
  });

/**
 * An Owner tool's key's Browser access: `off`, as every key is until it is
 * set; `origins`, from those listed only (one to 20, each once, in the
 * order given); or `any`, from a page on any origin.
 */
export const keyBrowserAccessSchema = z.discriminatedUnion(
  "mode",
  [
    z.strictObject({ mode: z.literal("off") }),
    z.strictObject({
      mode: z.literal("origins"),
      origins: z
        .array(browserOriginSchema, {
          error: "List the browser origins as an array.",
        })
        .transform((origins) => [...new Set(origins)])
        .refine((origins) => origins.length > 0, {
          error: "List at least one origin, or turn browser access off.",
        })
        .refine((origins) => origins.length <= maxBrowserOrigins, {
          error: `List at most ${String(maxBrowserOrigins)} browser origins.`,
        }),
    }),
    z.strictObject({ mode: z.literal("any") }),
  ],
  { error: "Browser access is off, origins or any." },
);
export type KeyBrowserAccess = z.infer<typeof keyBrowserAccessSchema>;

/** Off: the key is refused to a page in a browser on another origin. */
export const noBrowserAccess: KeyBrowserAccess = { mode: "off" };

/** Whether a key's Browser access lets a page on `origin` use it. */
export const browserAccessAllows = (
  access: KeyBrowserAccess | undefined,
  origin: string,
): boolean =>
  access?.mode === "any" ||
  (access?.mode === "origins" && access.origins.includes(origin));
