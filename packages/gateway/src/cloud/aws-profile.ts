import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AwsAccessKey } from "./aws-sigv4.ts";

// An AWS Bedrock account may name a profile in the server's AWS shared
// credentials and config files (PRD FR-35), as the AWS CLI writes them,
// rather than hold an access key itself. The files are read each time the
// account signs a request, so a rotated key is used at once. Only a
// profile's access key (`aws_access_key_id`, `aws_secret_access_key` and
// an optional `aws_session_token`) is read: single sign-on, roles and
// credential processes are not run.

/** Where the AWS CLI's files are: its environment variables, or `~/.aws`. */
export interface AwsConfigFiles {
  readonly credentials: string;
  readonly config: string;
}

export const defaultAwsConfigFiles = (
  env: NodeJS.ProcessEnv = process.env,
): AwsConfigFiles => ({
  credentials:
    env["AWS_SHARED_CREDENTIALS_FILE"] ??
    join(homedir(), ".aws", "credentials"),
  config: env["AWS_CONFIG_FILE"] ?? join(homedir(), ".aws", "config"),
});

/** Why a profile gave no access key; its message never holds one. */
export class AwsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsProfileError";
  }
}

/** An INI file's sections, by name, each its keys (lowercase) and values. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const section = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (section !== null) {
      const name = section[1] ?? "";
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    // Lines indented under a key (nested settings) are not keys.
    if (pair !== null && current !== undefined && !/^\s/.test(raw)) {
      current.set((pair[1] ?? "").toLowerCase(), pair[2] ?? "");
    }
  }
  return sections;
}

const readIfThere = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new AwsProfileError(`The AWS file ${path} could not be read.`);
  }
};

/**
 * The access key of profile `name`: from the credentials file's `[name]`,
 * else the config file's `[profile name]` (`[default]` for the default
 * profile). An `AwsProfileError` when neither gives one.
 */
export async function readAwsProfile(
  name: string,
  files: AwsConfigFiles,
): Promise<AwsAccessKey> {
  const credentials = await readIfThere(files.credentials);
  const config = await readIfThere(files.config);
  const sections = [
    credentials === undefined ? undefined : parseIni(credentials).get(name),
    config === undefined
      ? undefined
      : parseIni(config).get(name === "default" ? name : `profile ${name}`),
  ].filter((section) => section !== undefined);
  if (sections.length === 0) {
    throw new AwsProfileError(
      `There is no AWS profile "${name}" in ${files.credentials} or ${files.config}.`,
    );
  }
  for (const section of sections) {
    const accessKeyId = section.get("aws_access_key_id")?.trim();
    const secretAccessKey = section.get("aws_secret_access_key")?.trim();
    if (accessKeyId && secretAccessKey) {
      const sessionToken = section.get("aws_session_token")?.trim();
      return {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
  }
  throw new AwsProfileError(
    `The AWS profile "${name}" has no access key. AI Office reads only aws_access_key_id and aws_secret_access_key (and aws_session_token) from a profile, not single sign-on, roles or a credential process.`,
  );
}
