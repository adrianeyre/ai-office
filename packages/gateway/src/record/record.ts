import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  aiAccountKinds,
  aiOfficeHeaders,
  aiProviderTakes,
  aiProviders,
  createRedactor,
  credentialPatterns,
  redactedText,
  type AgentTool,
  type AiProvider,
} from "@ai-office/shared";

import {
  scenarios,
  skippedScenarios,
  type RecordFormat,
  type Scenario,
} from "./scenarios.ts";

// `pnpm --filter @ai-office/gateway record` (#45): sends the scripted
// scenarios through a running AI Gateway whose server was started with
// `GATEWAY_FIXTURES_DIR`, for each AI Provider and Model the Owner names,
// and finds the fixture each exchange produced. Requests are routed as any
// Owner tool's are: by their Model to its AI Provider's accounts, or to the
// AI Account the Owner forces (`x-ai-office-account`). The Gateway Key is
// never printed: everything shown passes through a redactor that knows it.

/** One AI Provider and Model to record, and the AI Account to force. */
export interface RecordTarget {
  readonly aiProvider: AiProvider;
  readonly model: string;
  /** The AI Account (name or id) every request is served from, if forced. */
  readonly account?: string | undefined;
}

export interface RecordOptions {
  /** The AI Gateway's URL, such as AI Office's own `http://localhost:3045`. */
  readonly gatewayUrl: string;
  /** An Owner tool's Gateway Key: only those may force an AI Account. */
  readonly gatewayKey: string;
  /** Where the server's recorder writes, as this process reaches it. */
  readonly fixturesDir: string;
  readonly targets: readonly RecordTarget[];
  /** The scenarios to run, by id; all of them by default. */
  readonly scenarios?: readonly string[] | undefined;
  /** How long to wait for each fixture once its answer has arrived. */
  readonly fixtureWaitMs?: number;
  /** How long each request may take. */
  readonly requestTimeoutMs?: number;
  /** Names this run's requests; random by default. */
  readonly runId?: string;
}

/** What became of one scenario for one target. */
export interface ScenarioResult {
  readonly target: RecordTarget;
  readonly scenario: string;
  readonly status: "recorded" | "failed" | "skipped";
  /** The Gateway's answer's status, when a request was sent. */
  readonly httpStatus?: number;
  /** The fixture files it produced, by name. */
  readonly fixtures: readonly string[];
  readonly note?: string;
}

/** A mistake in what the script was asked to do. */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

/** The AI Provider named `name`, whatever its case. */
export function aiProviderNamed(name: string): AiProvider {
  const found = aiProviders.find(
    (provider) => provider.toLowerCase() === name.trim().toLowerCase(),
  );
  if (found === undefined) {
    throw new RecordError(
      `"${name}" is not an AI Provider; one of: ${aiProviders.join(", ")}.`,
    );
  }
  return found;
}

/**
 * `<AI Provider>:<Model>`, such as `Claude:claude-haiku-5-5`, with the AI
 * Account `accounts` forces for that AI Provider, if any. A Model the
 * Gateway would send to another AI Provider's accounts is refused.
 */
export function parseTarget(
  text: string,
  accounts: ReadonlyMap<AiProvider, string> = new Map(),
): RecordTarget {
  const colon = text.indexOf(":");
  const model = colon === -1 ? "" : text.slice(colon + 1).trim();
  if (colon === -1 || model === "") {
    throw new RecordError(
      `"${text}" is not <AI Provider>:<Model>, such as Claude:claude-haiku-5-5.`,
    );
  }
  const aiProvider = aiProviderNamed(text.slice(0, colon));
  if (!aiProviderTakes(aiProvider, model)) {
    throw new RecordError(
      `The AI Gateway sends ${model} to another AI Provider's accounts, not ${aiProvider}'s.`,
    );
  }
  const account = accounts.get(aiProvider);
  return { aiProvider, model, ...(account === undefined ? {} : { account }) };
}

/** `<AI Provider>:<AI Account name or id>`, as `--account` gives it. */
export function parseAccount(text: string): [AiProvider, string] {
  const colon = text.indexOf(":");
  const account = colon === -1 ? "" : text.slice(colon + 1).trim();
  if (colon === -1 || account === "") {
    throw new RecordError(
      `"${text}" is not <AI Provider>:<AI Account>, such as "Claude:My API key".`,
    );
  }
  return [aiProviderNamed(text.slice(0, colon)), account];
}

/**
 * How an AI Provider is recorded: in the API its accounts that serve any
 * caller speak; or not at all, when only a subscription serves it, which
 * serves only its own agent tool (PRD FR-35).
 */
export function recordingOf(aiProvider: AiProvider):
  | {
      readonly format: RecordFormat;
      /** Its subscriptions' agent tool, if it has subscriptions. */
      readonly subscriptionTool: AgentTool | null;
    }
  | { readonly format: null; readonly subscriptionTool: AgentTool } {
  const kinds = aiAccountKinds.filter((kind) => kind.aiProvider === aiProvider);
  const open = kinds.find((kind) => kind.servesOnly === null);
  const subscriptionTool =
    kinds.find((kind) => kind.servesOnly !== null)?.servesOnly ?? null;
  if (open === undefined) {
    if (subscriptionTool === null) {
      throw new RecordError(`No AI Account of ${aiProvider} can be added.`);
    }
    return { format: null, subscriptionTool };
  }
  return {
    format: open.apiFormat === "anthropic" ? "messages" : "chat_completions",
    subscriptionTool,
  };
}

const gatewayPaths: Record<RecordFormat, string> = {
  messages: "/v1/messages",
  chat_completions: "/v1/chat/completions",
};

/** The Gateway's error message in an answer, in either API's format. */
function errorMessage(answer: string): string | undefined {
  try {
    const parsed = JSON.parse(answer) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string"
      ? parsed.error.message
      : undefined;
  } catch {
    return undefined;
  }
}

/** The fixture files in `directory`; none if it is not there yet. */
async function fixtureFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * The files written since `before` that hold `marker`, waiting up to
 * `waitMs` for one: the server saves a fixture once its answer has gone.
 */
async function fixturesWith(
  directory: string,
  before: ReadonlySet<string>,
  marker: string,
  waitMs: number,
): Promise<{ name: string; text: string }[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found: { name: string; text: string }[] = [];
    for (const name of (await fixtureFiles(directory)).sort()) {
      if (before.has(name)) {
        continue;
      }
      const text = await readFile(join(directory, name), "utf8").catch(
        () => "",
      );
      if (text.includes(marker)) {
        found.push({ name, text });
      }
    }
    if (found.length > 0 || Date.now() >= deadline) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * What in a fixture still looks like a credential, by name, never the
 * value: what redacting it again would change.
 */
function credentialsIn(text: string, gatewayKey: string): string[] {
  const found = credentialPatterns
    .filter(({ pattern, replace }) => {
      const again = new RegExp(pattern.source, pattern.flags);
      return (
        (replace === undefined
          ? text.replace(again, redactedText)
          : text.replace(again, replace)) !== text
      );
    })
    .map(({ name }) => name);
  return text.includes(gatewayKey) ? ["the Gateway Key", ...found] : found;
}

/** A redactor for everything the script shows: it knows the Gateway Key. */
export const redactorFor = (gatewayKey: string) =>
  createRedactor({ secrets: [gatewayKey] });

/** Sends each target's scenarios through the Gateway, in turn. */
export async function record(
  options: RecordOptions,
): Promise<ScenarioResult[]> {
  const redactor = redactorFor(options.gatewayKey);
  const wanted = (id: string) =>
    options.scenarios === undefined || options.scenarios.includes(id);
  const runId = options.runId ?? crypto.randomUUID().slice(0, 8);
  const base = options.gatewayUrl.replace(/\/+$/, "");
  const results: ScenarioResult[] = [];

  for (const [index, target] of options.targets.entries()) {
    const recording = recordingOf(target.aiProvider);
    const run = (scenario: Scenario) =>
      recording.format === null
        ? Promise.resolve<ScenarioResult>({
            target,
            scenario: scenario.label,
            status: "skipped",
            fixtures: [],
            note: `a ${target.aiProvider} subscription serves only ${recording.subscriptionTool}'s own requests (PRD FR-35), which this script does not make; record them by running ${recording.subscriptionTool} through the Gateway (packages/gateway/fixtures/README.md, "Recording")`,
          })
        : send(
            target,
            recording.format,
            scenario,
            `${runId}-${String(index + 1)}`,
          );

    for (const scenario of scenarios.filter(({ id }) => wanted(id))) {
      results.push(await run(scenario));
    }
    for (const skipped of skippedScenarios.filter(({ id }) => wanted(id))) {
      results.push({
        target,
        scenario: skipped.label,
        status: "skipped",
        fixtures: [],
        note: skipped.reason,
      });
    }
  }
  return results;

  async function send(
    target: RecordTarget,
    format: RecordFormat,
    scenario: Scenario,
    session: string,
  ): Promise<ScenarioResult> {
    const marker = `${session}-${scenario.id}`;
    const before = new Set(await fixtureFiles(options.fixturesDir));
    const failed = (note: string, httpStatus?: number): ScenarioResult => ({
      target,
      scenario: scenario.label,
      status: "failed",
      ...(httpStatus === undefined ? {} : { httpStatus }),
      fixtures: [],
      note: redactor.redactText(note),
    });

    let httpStatus: number;
    let answer: string;
    try {
      const response = await fetch(`${base}${gatewayPaths[format]}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.gatewayKey}`,
          // An Owner tool's: no agent tool's, so no subscription serves it.
          "user-agent": "ai-office-record/1",
          ...(format === "messages" && { "anthropic-version": "2023-06-01" }),
          // One session per target, so its scenarios stay on one account.
          [aiOfficeHeaders.session]: `fixture-recording-${session}`,
          ...(target.account !== undefined && {
            [aiOfficeHeaders.account]: target.account,
          }),
        },
        body: JSON.stringify(scenario.body(format, target.model, marker)),
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 120_000),
      });
      httpStatus = response.status;
      answer = await response.text();
    } catch (error) {
      return failed(
        `the AI Gateway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const written = await fixturesWith(
      options.fixturesDir,
      before,
      marker,
      options.fixtureWaitMs ?? 5_000,
    );
    if (written.length === 0) {
      const reason = errorMessage(answer);
      return failed(
        reason === undefined
          ? `no fixture was written: is the server started with GATEWAY_FIXTURES_DIR=${options.fixturesDir}?`
          : `no fixture was written; the answer said: ${reason} (what the AI Gateway refuses itself is never recorded)`,
        httpStatus,
      );
    }
    const notes = [
      ...written.flatMap(({ name, text }) => {
        const found = credentialsIn(text, options.gatewayKey);
        return found.length === 0
          ? []
          : [
              `${name} holds what looks like ${found.join(", ")}: do not commit it`,
            ];
      }),
      ...(httpStatus >= 400
        ? [`the AI Provider answered ${String(httpStatus)}`]
        : []),
      ...(httpStatus < 400 ? [scenario.check?.(format, answer)] : []),
    ].filter((note) => note !== undefined);
    return {
      target,
      scenario: scenario.label,
      status: "recorded",
      httpStatus,
      fixtures: written.map(({ name }) => name),
      ...(notes.length === 0
        ? {}
        : { note: redactor.redactText(notes.join("; ")) }),
    };
  }
}

/**
 * How `record`'s results are shown to the Owner: a row per scenario, with
 * its status, the Gateway's status and the fixture it produced. Why a
 * scenario was skipped is the same for many, so it is a numbered note
 * below them, given once.
 */
export function summary(
  results: readonly ScenarioResult[],
  options: Pick<RecordOptions, "fixturesDir">,
): string {
  const lines: string[] = [];
  const footnotes: string[] = [];
  const footnote = (note: string) => {
    const index = footnotes.indexOf(note);
    return `[${String(index === -1 ? footnotes.push(note) : index + 1)}]`;
  };
  let shown: RecordTarget | undefined;
  for (const result of results) {
    if (result.target !== shown) {
      shown = result.target;
      const { aiProvider, model, account } = result.target;
      lines.push(
        "",
        `${aiProvider} · ${model}${account === undefined ? "" : ` (AI Account: ${account})`}`,
      );
    }
    const { note } = result;
    const skipped = result.status === "skipped";
    const status = [
      result.status,
      ...(result.httpStatus === undefined ? [] : [String(result.httpStatus)]),
      ...result.fixtures,
      ...(skipped && note !== undefined ? [footnote(note)] : []),
    ].join("  ");
    lines.push(`  ${result.scenario.padEnd(15)}${status}`);
    if (!skipped && note !== undefined) {
      lines.push(`  ${"".padEnd(15)}${note}`);
    }
  }
  const subscriptions = new Set(
    results.flatMap(({ target }) => {
      const recording = recordingOf(target.aiProvider);
      return recording.format !== null && recording.subscriptionTool !== null
        ? [
            `${target.aiProvider}'s requests above went to its AI Accounts other than subscriptions, which serve only ${recording.subscriptionTool}.`,
          ]
        : [];
    }),
  );
  const written = results.reduce(
    (sum, { fixtures }) => sum + fixtures.length,
    0,
  );
  lines.push(
    "",
    ...footnotes.map((note, index) => `[${String(index + 1)}] ${note}.`),
    ...(footnotes.length === 0 ? [] : [""]),
    ...subscriptions,
    ...(subscriptions.size === 0
      ? []
      : [
          'To record a subscription, run its agent tool through the Gateway (packages/gateway/fixtures/README.md, "Recording").',
          "",
        ]),
    `${String(written)} fixture${written === 1 ? "" : "s"} written to ${options.fixturesDir}.`,
    "Before committing any, open each one and check by eye that it holds no credential: the recorder redacts every one it knows of, but only you know what yours look like.",
  );
  return lines.join("\n");
}
