// The pen-test stack's seed, run by the `seed` service at stand-up
// (docs/pen-testing/stack.md, Enablement E2, #188). It:
//
// 1. seeds the database (`seed.ts`, `seed-stores.ts`): the Floors, the Agents
//    in every Stage, the unattended-merge Floor, the AI Accounts at the stub,
//    and the corpus's Skill, Floor Template and memory proposal;
// 2. adds the stack's GitHub App to the database, as the Owner adds one in
//    Floor Settings (ADR 0011), and generates the throwaway target
//    repository's issues and files from the corpus (`generate-target.ts`), as
//    the App, when the App's settings are set; the app takes the App up
//    within a minute;
// 3. writes the fixture ID listing (`fixtures.ts`) for the credentials package
//    (E4, #190), to FIXTURES_FILE.
//
// It reads DATABASE_URL, ENCRYPTION_KEY, STUB_UPSTREAM_URL, the target
// repository and the GitHub App's settings from the environment. It prints
// each account, Floor and issue, never a credential.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect } from "../../packages/db/src/index.ts";
import {
  createGitHubApp,
  defaultGitHubApiUrl,
} from "../../packages/github/src/index.ts";
import { commitFiles } from "../../packages/orchestrator/src/git/commit-file.ts";
import {
  createGitHubConnections,
  GitHubConnectionError,
  githubConnectionErrorCodes,
} from "../../packages/orchestrator/src/github-connections/connections.ts";
import { databaseGitHubConnectionStore } from "../../packages/orchestrator/src/github-connections/store.ts";
import { encryptorFromVersionedKey } from "../../packages/shared/src/crypto.ts";
import { githubAppConnectionCreateSchema } from "../../packages/shared/src/github-connections.ts";

import { fixtureListing, writeFixtureListing } from "./fixtures.ts";
import {
  generateTarget,
  type GenerateTargetResult,
} from "./generate-target.ts";
import { seed } from "./seed.ts";
import { databaseSeedStores } from "./seed-stores.ts";
import { stubUpstreamUrl as defaultStubUrl } from "./stub-accounts.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
};

const optional = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

const databaseUrl = required("DATABASE_URL");
const encryptionKey = required("ENCRYPTION_KEY");
const stubUpstreamUrl = optional("STUB_UPSTREAM_URL") ?? defaultStubUrl;
const targetRepository =
  optional("TARGET_REPOSITORY") ?? required("PEN_TEST_TARGET_REPOSITORY");

const database = connect(databaseUrl);
try {
  const result = await seed({
    stores: databaseSeedStores(database.db, encryptionKey),
    targetRepository,
    stubUpstreamUrl,
  });
  for (const name of result.aiAccounts) {
    console.log(`AI Account: ${name}`);
  }
  for (const floor of result.floors) {
    console.log(
      `Floor ${floor.id} (${floor.mergePolicy}): ${String(floor.agents.length)} Agents.`,
    );
  }
  console.log(
    `Corpus: Skill ${result.skill.id}, Floor Template ${result.template.id}, memory proposal ${String(result.memoryProposal.id)}.`,
  );

  // Generate the throwaway repository's issues and files, if the App is set.
  let generated: GenerateTargetResult | undefined;
  const appId = optional("GITHUB_APP_ID");
  const privateKey = optional("GITHUB_APP_PRIVATE_KEY");
  if (appId !== undefined && privateKey !== undefined) {
    try {
      await createGitHubConnections({
        store: databaseGitHubConnectionStore(database.db),
        encryptor: encryptorFromVersionedKey(encryptionKey),
      }).addApp(
        githubAppConnectionCreateSchema.parse({
          name: "The pen-test stack's App",
          appId,
          privateKey,
        }),
      );
      console.log(`GitHub App ${appId}: added.`);
    } catch (error) {
      if (
        !(error instanceof GitHubConnectionError) ||
        error.code !== githubConnectionErrorCodes.appTaken
      ) {
        throw error;
      }
      console.log(`GitHub App ${appId}: added before.`);
    }
    const app = createGitHubApp({
      appId,
      privateKey,
      baseUrl: optional("GITHUB_API_URL") ?? defaultGitHubApiUrl,
    });
    const scratchDir = await mkdtemp(join(tmpdir(), "pen-test-seed-"));
    try {
      const repo = app.repository(targetRepository);
      generated = await generateTarget({
        app,
        repository: targetRepository,
        stubUpstreamUrl,
        commit: async (files, message) => {
          const [repository, token] = await Promise.all([
            repo.get(),
            repo.installationToken(),
          ]);
          await commitFiles({
            url: `${repository.htmlUrl}.git`,
            token: token.token,
            from: repository.defaultBranch,
            to: repository.defaultBranch,
            files,
            message,
            identity: {
              name: "AI Office pen-test",
              email: "pen-test@pen-test.local",
            },
            agent: {
              name: "pen-test seed",
              role: "seed",
              aiProvider: "none",
              model: "none",
            },
            scratchDir,
            allowEmpty: false,
          });
        },
      });
      for (const issue of generated.issues) {
        console.log(`Issue #${String(issue.number)}: ${issue.id}.`);
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  } else {
    console.log(
      "The GitHub App is not set: the target repository's issues and files were not generated.",
    );
  }

  const listing = fixtureListing(result, {
    targetRepository,
    ...(generated === undefined ? {} : { generated }),
  });
  const fixturesFile = optional("FIXTURES_FILE");
  if (fixturesFile !== undefined) {
    writeFixtureListing(fixturesFile, listing);
    console.log(`Wrote the fixture ID listing to ${fixturesFile}.`);
  } else {
    console.log(JSON.stringify(listing));
  }
} finally {
  await database.close();
}
