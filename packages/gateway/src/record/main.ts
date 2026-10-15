// `pnpm --filter @ai-office/gateway record`: records the AI Gateway's
// contract-test fixtures (#45) through a running AI Office. See
// `packages/gateway/fixtures/README.md`, "Recording".
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { AiProvider } from "@ai-office/shared";

import {
  parseAccount,
  parseTarget,
  record,
  RecordError,
  redactorFor,
  summary,
} from "./record.ts";
import { scenarioIds } from "./scenarios.ts";

const usage = `Usage: pnpm --filter @ai-office/gateway record --target <AI Provider>:<Model> [options]

Sends the scripted scenarios (plain message, streaming, tool call, image)
through the AI Gateway for each target, so the server's recorder mode
writes one fixture per exchange, and says which file each produced.

  --target <AI Provider>:<Model>     what to record, such as Claude:claude-haiku-5-5;
                                     repeat it for each AI Provider
  --account <AI Provider>:<AI Account>
                                     serve that AI Provider's requests from this AI
                                     Account (name or id) only; repeat it per AI Provider
  --scenario <id>                    run only these: ${scenarioIds.join(", ")}
  --url <url>                        the AI Gateway (AI_OFFICE_GATEWAY_URL;
                                     http://localhost:3045 by default)
  --key <Gateway Key>                an Owner tool's Gateway Key (AI_OFFICE_GATEWAY_KEY;
                                     the variable is better: a flag shows in ps)
  --fixtures-dir <dir>               where the server writes fixtures (GATEWAY_FIXTURES_DIR)
  --help                             this text`;

function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", multiple: true },
      account: { type: "string", multiple: true },
      scenario: { type: "string", multiple: true },
      url: { type: "string" },
      key: { type: "string" },
      "fixtures-dir": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help === true) {
    console.log(usage);
    return Promise.resolve(0);
  }
  const gatewayKey = values.key ?? process.env["AI_OFFICE_GATEWAY_KEY"] ?? "";
  if (gatewayKey === "") {
    throw new RecordError(
      "A Gateway Key is needed: set AI_OFFICE_GATEWAY_KEY to an Owner tool's key (AI Settings → Gateway Keys).",
    );
  }
  const fixturesDir =
    values["fixtures-dir"] ?? process.env["GATEWAY_FIXTURES_DIR"];
  if (fixturesDir === undefined || fixturesDir === "") {
    throw new RecordError(
      "Set GATEWAY_FIXTURES_DIR (or --fixtures-dir) to the directory the server was started with, as this machine reaches it.",
    );
  }
  const accounts = new Map<AiProvider, string>(
    (values.account ?? []).map(parseAccount),
  );
  const targets = (values.target ?? []).map((text) =>
    parseTarget(text, accounts),
  );
  if (targets.length === 0) {
    throw new RecordError(
      "Name at least one --target <AI Provider>:<Model>, such as Claude:claude-haiku-5-5.",
    );
  }
  for (const id of values.scenario ?? []) {
    if (!scenarioIds.includes(id)) {
      throw new RecordError(
        `"${id}" is not a scenario; one of: ${scenarioIds.join(", ")}.`,
      );
    }
  }
  const gatewayUrl =
    values.url ??
    process.env["AI_OFFICE_GATEWAY_URL"] ??
    "http://localhost:3045";
  const options = {
    gatewayUrl,
    gatewayKey,
    // From where the Owner ran pnpm, not this package.
    fixturesDir: resolve(process.env["INIT_CWD"] ?? process.cwd(), fixturesDir),
    targets,
    scenarios: values.scenario,
  };
  // The URL without anything it may carry in its user info.
  const shownUrl = (() => {
    try {
      const url = new URL(gatewayUrl);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      throw new RecordError(`"${gatewayUrl}" is not the AI Gateway's URL.`);
    }
  })();
  console.log(
    `Recording through the AI Gateway at ${shownUrl}; fixtures in ${options.fixturesDir}.`,
  );
  return record(options).then((results) => {
    console.log(redactorFor(gatewayKey).redactText(summary(results, options)));
    return results.some(({ status }) => status === "failed") ? 1 : 0;
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  // Whatever went wrong is shown without a credential, even one typed in
  // the wrong place.
  const message = redactorFor(
    process.env["AI_OFFICE_GATEWAY_KEY"] ?? "",
  ).redactText(error instanceof Error ? error.message : String(error));
  const mistaken =
    error instanceof RecordError ||
    String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS");
  console.error(mistaken ? `${message}\n\n${usage}` : message);
  process.exitCode = mistaken ? 2 : 1;
}
