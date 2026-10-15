import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AwsProfileError,
  defaultAwsConfigFiles,
  parseIni,
  readAwsProfile,
} from "./aws-profile.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function files(contents: { credentials?: string; config?: string }) {
  const directory = await mkdtemp(join(tmpdir(), "ai-office-aws-"));
  directories.push(directory);
  const paths = {
    credentials: join(directory, "credentials"),
    config: join(directory, "config"),
  };
  if (contents.credentials !== undefined) {
    await writeFile(paths.credentials, contents.credentials);
  }
  if (contents.config !== undefined) {
    await writeFile(paths.config, contents.config);
  }
  return paths;
}

describe("parseIni", () => {
  it("reads sections and keys, leaving comments and nested settings out", () => {
    const sections = parseIni(
      "# comment\n[default]\nAWS_Access_Key_Id = A\n; another\n[profile x]\ns3 =\n  max_concurrent_requests = 20\nregion=eu-west-1\n",
    );
    expect(Object.fromEntries(sections.get("default") ?? [])).toEqual({
      aws_access_key_id: "A",
    });
    expect(Object.fromEntries(sections.get("profile x") ?? [])).toEqual({
      s3: "",
      region: "eu-west-1",
    });
  });
});

describe("readAwsProfile", () => {
  it("reads a profile's key from the credentials file first", async () => {
    const paths = await files({
      credentials:
        "[work]\naws_access_key_id = AKIAWORK\naws_secret_access_key = workSecret\naws_session_token = workToken\n",
      config:
        "[profile work]\naws_access_key_id = AKIACONFIG\naws_secret_access_key = configSecret\n",
    });
    expect(await readAwsProfile("work", paths)).toEqual({
      accessKeyId: "AKIAWORK",
      secretAccessKey: "workSecret",
      sessionToken: "workToken",
    });
  });

  it("reads one from the config file's [profile name], or its [default]", async () => {
    const paths = await files({
      config:
        "[default]\naws_access_key_id = AKIADEFAULT\naws_secret_access_key = defaultSecret\n[profile work]\naws_access_key_id = AKIACONFIG\naws_secret_access_key = configSecret\n",
    });
    expect(await readAwsProfile("work", paths)).toEqual({
      accessKeyId: "AKIACONFIG",
      secretAccessKey: "configSecret",
    });
    expect(await readAwsProfile("default", paths)).toEqual({
      accessKeyId: "AKIADEFAULT",
      secretAccessKey: "defaultSecret",
    });
  });

  it("refuses a profile it cannot find, or one without a key, never quoting a secret", async () => {
    const paths = await files({
      credentials: "[half]\naws_access_key_id = AKIAHALF\n",
      config:
        "[profile sso]\nsso_session = work\n[profile role]\nrole_arn = arn:aws:iam::123456789012:role/x\nsource_profile = half\n",
    });
    for (const name of ["sso", "role", "half"]) {
      await expect(readAwsProfile(name, paths)).rejects.toThrow(
        `The AWS profile "${name}" has no access key.`,
      );
    }
    await expect(readAwsProfile("nowhere", paths)).rejects.toBeInstanceOf(
      AwsProfileError,
    );
    await expect(
      readAwsProfile("nowhere", {
        credentials: "/no/such",
        config: "/no/such",
      }),
    ).rejects.toThrow('There is no AWS profile "nowhere"');
  });

  it("finds the AWS CLI's files where its environment says", () => {
    expect(
      defaultAwsConfigFiles({
        AWS_SHARED_CREDENTIALS_FILE: "/run/aws/credentials",
        AWS_CONFIG_FILE: "/run/aws/config",
      }),
    ).toEqual({
      credentials: "/run/aws/credentials",
      config: "/run/aws/config",
    });
    expect(defaultAwsConfigFiles({}).credentials).toMatch(
      /\.aws\/credentials$/,
    );
  });
});
