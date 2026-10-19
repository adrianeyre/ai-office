import type { Fetch } from "./oauth.ts";

// Google's Code Assist API (`cloudcode-pa.googleapis.com/v1internal`), as
// Gemini CLI's Google sign-in reaches it: every request names the Code
// Assist project its Google account is onboarded to, which a Google AI
// Pro or Ultra plan's limits come with. A login is looked up the way
// Gemini CLI sets one up (`loadCodeAssist`, then `onboardUser` for a
// Google account that has never used it). Google does not document these
// for other tools; they are what Gemini CLI uses. No token is ever logged
// or put in an error's message.

/** Where Code Assist's API is, before `/v1internal`. */
export const codeAssistUrl = "https://cloudcode-pa.googleapis.com";

/** How Gemini CLI says what it is, which Code Assist asks for. */
const clientMetadata = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

/** Why a Google account's Code Assist project could not be had. */
export class CodeAssistError extends Error {
  /** `refused` when Google said no; `unavailable` when it failed. */
  readonly reason: "refused" | "unavailable";

  constructor(
    reason: "refused" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeAssistError";
    this.reason = reason;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Why Code Assist says the account cannot be onboarded, in its words. */
const ineligibility = (answer: Record<string, unknown>): string | undefined => {
  const tiers = answer["ineligibleTiers"];
  if (!Array.isArray(tiers)) {
    return undefined;
  }
  const reasons = tiers
    .map((tier) => (isObject(tier) ? text(tier["reasonMessage"]) : undefined))
    .filter((reason): reason is string => reason !== undefined);
  return reasons.length === 0 ? undefined : reasons.join(" ");
};

/**
 * The Code Assist project a Google login's requests name: the one it is
 * onboarded to, onboarding it to its default tier (a Google AI plan's, or
 * the free one) if it never has been, as Gemini CLI does.
 */
export async function codeAssistProject(
  accessToken: string,
  options: {
    readonly fetch: Fetch;
    readonly baseUrl?: string;
    /** How long to wait between asking after an onboarding. */
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const base = `${(options.baseUrl ?? codeAssistUrl).replace(/\/+$/, "")}/v1internal`;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const call = async (
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        // The token goes to Code Assist only (pen-testing G1-7).
        redirect: "manual",
      });
    } catch (error) {
      throw new CodeAssistError(
        "unavailable",
        "Google's Code Assist API could not be reached.",
        { cause: error },
      );
    }
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isObject(parsed)) {
      throw new CodeAssistError(
        response.status === 401 || response.status === 403
          ? "refused"
          : "unavailable",
        `Google's Code Assist API answered ${String(response.status)}.`,
      );
    }
    return parsed;
  };

  const loaded = await call(":loadCodeAssist", { metadata: clientMetadata });
  const current = text(loaded["cloudaicompanionProject"]);
  if (isObject(loaded["currentTier"])) {
    if (current !== undefined) {
      return current;
    }
    throw new CodeAssistError(
      "refused",
      ineligibility(loaded) ??
        "This Google account's Gemini plan names no Code Assist project: sign in to Gemini CLI with it once, then try again.",
    );
  }
  const tiers = Array.isArray(loaded["allowedTiers"])
    ? loaded["allowedTiers"].filter(isObject)
    : [];
  const tier = text(tiers.find((each) => each["isDefault"] === true)?.["id"]);
  if (tier === undefined) {
    throw new CodeAssistError(
      "refused",
      ineligibility(loaded) ??
        "This Google account cannot use Gemini through Code Assist.",
    );
  }
  let operation = await call(":onboardUser", {
    tierId: tier,
    metadata: clientMetadata,
  });
  // Onboarding may take a while: Gemini CLI asks every five seconds.
  const name = text(operation["name"]);
  for (let tries = 0; operation["done"] !== true && name !== undefined;) {
    if ((tries += 1) > 12) {
      throw new CodeAssistError(
        "unavailable",
        "Google's Code Assist API did not finish setting up this Google account: try again in a minute.",
      );
    }
    await sleep(5000);
    operation = await call(`/${name}`);
  }
  const response = isObject(operation["response"]) ? operation["response"] : {};
  const project = isObject(response["cloudaicompanionProject"])
    ? text(response["cloudaicompanionProject"]["id"])
    : undefined;
  if (project === undefined) {
    throw new CodeAssistError(
      "refused",
      ineligibility(loaded) ??
        "Google's Code Assist API set up this Google account without a project.",
    );
  }
  return project;
}
