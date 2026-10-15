// The credentials package's minting and revocation (credentials.ts,
// Enablement E4, #190), run by the stack's `credentials` service in the
// app's image: `docker/pen-test/credentials mint` and `... revoke` run it.
//
// - `mint` mints the red team's Owner password, UI-capable API key and
//   Gateway Key in the stack's database, then writes them, with the fixture
//   ID listing and the pinned commit, to PACKAGE_FILE with 0600 permissions.
// - `revoke` removes the Owner password and revokes both keys, and names
//   any other Owner password or key made since they were minted.
//
// It reads DATABASE_URL, PACKAGE_FILE, FIXTURES_FILE, PUBLIC_URL and
// PINNED_COMMIT. It is never given ENCRYPTION_KEY: an Owner tool's key is
// never sealed, so nothing here seals or opens anything. It prints each
// credential's name and id, never the credential.

import { hashPassword } from "../../apps/server/src/auth/password.ts";
import { databaseAuthStore } from "../../apps/server/src/auth/store.ts";
import { connect } from "../../packages/db/src/index.ts";
import {
  createEventBus,
  databaseEventStore,
} from "../../packages/events/src/index.ts";
import {
  createGatewayKeys,
  databaseGatewayKeyStore,
} from "../../packages/gateway/src/index.ts";
import type { Encryptor } from "../../packages/shared/src/crypto.ts";

import { CredentialsError, runCredentials } from "./credentials.ts";

/** Owner tools' keys are never sealed: this never needs ENCRYPTION_KEY. */
const sealsNothing: Encryptor = {
  currentKeyVersion: 1,
  encrypt() {
    throw new CredentialsError("The credentials package seals nothing.");
  },
  decrypt() {
    throw new CredentialsError("The credentials package opens nothing.");
  },
  keyVersionOf() {
    throw new CredentialsError("The credentials package opens nothing.");
  },
};

const [command] = process.argv.slice(2);
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (command !== "mint" && command !== "revoke") {
  console.error("Run docker/pen-test/credentials mint, or ... revoke.");
  process.exit(1);
}
if (databaseUrl === "") {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const database = connect(databaseUrl);
try {
  await runCredentials(command, {
    stores: {
      auth: databaseAuthStore(database.db),
      gatewayKeys: createGatewayKeys({
        store: databaseGatewayKeyStore(database.db),
        encryptor: sealsNothing,
        // So the Activity Feed records each key made and revoked, by name.
        events: createEventBus({ store: databaseEventStore(database.db) }),
      }),
    },
    env: process.env,
    hashPassword,
    log: console.log,
  });
} catch (error) {
  if (error instanceof CredentialsError) {
    console.error(error.message);
  } else {
    // Only what kind of failure it was: an unexpected error's message is
    // not printed, in case it quotes what it was given.
    const { name, code } = error as { name?: unknown; code?: unknown };
    const kind = [name, code].filter((part) => typeof part === "string");
    console.error(
      `The credentials package's ${command} failed (${kind.join(", ") || "an error"}).`,
    );
  }
  process.exitCode = 1;
} finally {
  await database.close();
}
