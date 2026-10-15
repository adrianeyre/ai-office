import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createAiAccounts, memoryAiAccountStore } from "@ai-office/gateway";
import {
  aiAccountListSchema,
  aiAccountSchema,
  apiErrorSchema,
  createRedactor,
} from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, testEncryptor } from "../test-support.ts";

// AWS Bedrock and Google Vertex AI AI Accounts through the API (PRD FR-35):
// added with their region and their credentials (an IAM access key or a
// profile in the server's AWS files; a service account's key), which no
// answer or log line ever carries again.

const accessKey = {
  accessKeyId: "AKIAROUTESTESTKEY001",
  secretAccessKey: "routesTestSecretAccessKey/0123456789abcdef",
};
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const serviceAccount = {
  type: "service_account",
  project_id: "ai-office-routes",
  private_key_id: "routes0123456789abcdef0123456789abcdef01",
  private_key: privateKey,
  client_email: "ai-office@ai-office-routes.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  token_uri: "https://oauth2.googleapis.com/token",
};
/** What only the key file holds: never in an answer or a log line. */
const keyLines = privateKey.split("\n").filter((line) => line.length > 40);

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function setUp() {
  const directory = await mkdtemp(join(tmpdir(), "ai-office-aws-"));
  directories.push(directory);
  const awsConfigFiles = {
    credentials: join(directory, "credentials"),
    config: join(directory, "config"),
  };
  await writeFile(
    awsConfigFiles.credentials,
    `[ai-office]\naws_access_key_id = AKIAPROFILEKEY000001\naws_secret_access_key = profileSecretAccessKey/0123456789abcdef\n`,
  );
  const logs: string[] = [];
  const redactor = createRedactor();
  const bus = createEventBus({ store: memoryEventStore() });
  const server = await buildApp({
    logger: createLogger({
      level: "trace",
      secrets: [],
      redactor,
      destination: { write: (line: string) => logs.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    aiAccounts: createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor: testEncryptor,
      events: bus,
      awsConfigFiles,
      onCredential: (value) => {
        redactor.register(value);
      },
    }),
  });
  const owner = await signIn(server);
  const post = (payload: object) =>
    server.inject({
      method: "POST",
      url: "/api/ai-accounts",
      headers: owner.headers,
      payload,
    });
  const list = async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/ai-accounts",
      headers: owner.headers,
    });
    return {
      body: response.body,
      accounts: aiAccountListSchema.parse(response.json()).accounts,
    };
  };
  const refused = async (payload: object) => {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    return apiErrorSchema.parse(response.json());
  };
  return { logs, post, list, refused };
}

const bedrock = {
  name: "Bedrock",
  aiProvider: "Claude",
  accountType: "bedrock",
  region: "us-east-1",
  awsCredentials: accessKey,
};

const vertex = {
  name: "Vertex",
  aiProvider: "Claude",
  accountType: "vertex",
  region: "global",
  serviceAccount: JSON.stringify(serviceAccount),
};

describe("AWS Bedrock AI Accounts through the API", () => {
  it("adds one with an IAM access key, and never sends or logs the key", async () => {
    const setup = await setUp();
    const added = await setup.post(bedrock);
    expect(added.statusCode).toBe(201);
    expect(aiAccountSchema.parse(added.json())).toMatchObject({
      name: "Bedrock",
      aiProvider: "Claude",
      accountType: "bedrock",
      region: "us-east-1",
      projectId: null,
      endpointUrl: null,
      tokenHealth: null,
      extraUsage: null,
    });
    const listed = await setup.list();
    for (const text of [added.body, listed.body, setup.logs.join("\n")]) {
      expect(text).not.toContain(accessKey.secretAccessKey);
      expect(text).not.toContain(accessKey.accessKeyId);
    }
  });

  it("adds one with a profile in the server's AWS files, and refuses a profile it cannot read", async () => {
    const setup = await setUp();
    const added = await setup.post({
      ...bedrock,
      awsCredentials: { profile: "ai-office" },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ accountType: "bedrock" });

    const missing = await setup.post({
      ...bedrock,
      name: "Bedrock missing",
      awsCredentials: { profile: "missing" },
    });
    expect(missing.statusCode).toBe(400);
    expect(apiErrorSchema.parse(missing.json())).toMatchObject({
      error: "cloud_credentials_unusable",
      message: expect.stringContaining(
        'There is no AWS profile "missing"',
      ) as unknown,
    });
    expect((await setup.list()).accounts).toHaveLength(1);
    expect(setup.logs.join("\n")).not.toContain(
      "profileSecretAccessKey/0123456789abcdef",
    );
  });

  it("refuses a bad region or half a key, quoting neither", async () => {
    const setup = await setUp();
    expect(
      (await setup.refused({ ...bedrock, region: "Virginia" })).problems,
    ).toEqual(["Enter the AWS region, such as us-east-1."]);
    const half = await setup.refused({
      ...bedrock,
      awsCredentials: { accessKeyId: accessKey.accessKeyId },
    });
    expect(JSON.stringify(half)).not.toContain(accessKey.accessKeyId);
    expect(
      (
        await setup.refused({
          ...bedrock,
          awsCredentials: {
            ...accessKey,
            secretAccessKey: `${accessKey.secretAccessKey} more`,
          },
        })
      ).problems,
    ).toBeDefined();
    expect(
      (await setup.refused({ ...bedrock, aiProvider: "Grok" })).problems,
    ).toEqual(["AWS Bedrock accounts serve Claude Models."]);
    expect(
      (await setup.refused({ ...bedrock, accountType: "oauth" })).problems,
    ).toEqual([
      "Add an API key, an endpoint, an AWS Bedrock or a Google Vertex AI account here; a subscription signs in instead.",
    ]);
    expect((await setup.list()).accounts).toEqual([]);
  });
});

describe("Google Vertex AI AI Accounts through the API", () => {
  it("adds one with a service account's key, in its project, and never sends or logs the key", async () => {
    const setup = await setUp();
    const added = await setup.post(vertex);
    expect(added.statusCode).toBe(201);
    expect(aiAccountSchema.parse(added.json())).toMatchObject({
      name: "Vertex",
      aiProvider: "Claude",
      accountType: "vertex",
      region: "global",
      projectId: "ai-office-routes",
    });
    const listed = await setup.list();
    for (const text of [added.body, listed.body, setup.logs.join("\n")]) {
      for (const line of keyLines) {
        expect(text).not.toContain(line);
      }
      expect(text).not.toContain(serviceAccount.private_key_id);
    }
  });

  it("takes another project than the key's", async () => {
    const setup = await setUp();
    const added = await setup.post({
      ...vertex,
      region: "us-east5",
      projectId: "billing-project-1",
    });
    expect(added.json()).toMatchObject({
      region: "us-east5",
      projectId: "billing-project-1",
    });
  });

  it("refuses what is not a service account's key, without quoting it", async () => {
    const setup = await setUp();
    expect(
      (await setup.refused({ ...vertex, serviceAccount: "{not json" }))
        .problems,
    ).toEqual(["The service account key is not JSON."]);
    const user = await setup.refused({
      ...vertex,
      serviceAccount: JSON.stringify({
        ...serviceAccount,
        type: "authorized_user",
      }),
    });
    expect(user.problems).toEqual([
      "That is not a service account key: its type is not service_account.",
    ]);
    expect(JSON.stringify(user)).not.toContain(keyLines[0]);
    const withoutProject: Partial<typeof serviceAccount> = {
      ...serviceAccount,
    };
    delete withoutProject.project_id;
    expect(
      (
        await setup.refused({
          ...vertex,
          serviceAccount: JSON.stringify(withoutProject),
        })
      ).problems,
    ).toEqual([
      "The service account key names no project: enter the Google Cloud project ID.",
    ]);
    expect(
      (await setup.refused({ ...vertex, region: "US East" })).problems,
    ).toEqual(["Enter the Vertex AI region, such as global or us-east5."]);
    expect((await setup.list()).accounts).toEqual([]);
  });
});
