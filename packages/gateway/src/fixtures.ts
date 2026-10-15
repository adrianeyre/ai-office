import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRedactor, type Redactor } from "@ai-office/shared";

// A request/response pair through the Gateway, saved in recorder mode and
// replayed by the contract tests (PRD §9). Bodies are kept as the exact text
// that crossed the wire, so a replay can check they arrive unchanged.

export interface Fixture {
  readonly request: {
    readonly method: string;
    /** With its query string. */
    readonly path: string;
    /** As forwarded to the AI Provider, without the AI Account's credential. */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

export interface FixtureRecorder {
  save(fixture: Fixture): Promise<void>;
}

/**
 * Writes each fixture as a JSON file in `directory`. Everything passes
 * through the central redactor first: `redactor`, with the AI Accounts'
 * credentials registered as they are opened, or a new one with `secrets`.
 * So no credential is ever written to disk.
 */
export function directoryFixtureRecorder(
  directory: string,
  options:
    { readonly secrets: readonly string[] } | { readonly redactor: Redactor },
): FixtureRecorder {
  const redactor =
    "redactor" in options
      ? options.redactor
      : createRedactor({ secrets: options.secrets });
  let saved = 0;
  return {
    async save(fixture) {
      saved += 1;
      // Named after the AI Provider's endpoint: `messages`,
      // `count-tokens` (Vertex AI's `count-tokens:rawPredict` too),
      // `chat-completions` or `responses`.
      const endpoint = /count[_-]tokens/.test(fixture.request.path)
        ? "count-tokens"
        : fixture.request.path.includes("/chat/completions")
          ? "chat-completions"
          : fixture.request.path.includes("/responses")
            ? "responses"
            : "messages";
      const name = [
        new Date().toISOString().replaceAll(/[:.]/g, "-"),
        String(saved).padStart(4, "0"),
        endpoint,
        String(fixture.response.status),
      ].join("-");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${name}.json`),
        `${JSON.stringify(redactor.redact(fixture), null, 2)}\n`,
      );
    },
  };
}

/** Reads a fixture file written by `directoryFixtureRecorder`. */
export async function readFixture(path: string): Promise<Fixture> {
  return JSON.parse(await readFile(path, "utf8")) as Fixture;
}
