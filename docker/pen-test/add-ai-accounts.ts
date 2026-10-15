// Adds the pen-test stack's AI Accounts (`stub-accounts.ts`) to its
// database, each pointing at the stub upstream with a new canary
// credential. The stack's `ai-accounts` service runs it, in the app's
// image, after the schema is applied and before the app starts (`stand-up`), so
// the app finds them as it starts. An account already there, by name, is
// left as it is.
//
// It reads DATABASE_URL, ENCRYPTION_KEY (the stack's own) and
// STUB_UPSTREAM_URL. It prints each account's name and endpoint, never its
// credential.
import { randomBytes } from "node:crypto";

import { connect } from "../../packages/db/src/index.ts";
import {
  createEventBus,
  databaseEventStore,
} from "../../packages/events/src/index.ts";
import {
  createAiAccounts,
  databaseAiAccountStore,
} from "../../packages/gateway/src/index.ts";
import { encryptorFromVersionedKey } from "../../packages/shared/src/crypto.ts";
import {
  canaryPrefix,
  stubAccounts,
  stubUpstreamUrl,
} from "./stub-accounts.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
};

const database = connect(required("DATABASE_URL"));
try {
  const store = databaseAiAccountStore(database.db);
  const accounts = createAiAccounts({
    store,
    encryptor: encryptorFromVersionedKey(required("ENCRYPTION_KEY")),
    // So the Activity Feed records each one added.
    events: createEventBus({ store: databaseEventStore(database.db) }),
  });
  const existing = new Set((await accounts.list()).map(({ name }) => name));
  const wanted = stubAccounts(
    process.env["STUB_UPSTREAM_URL"] ?? stubUpstreamUrl,
    (provider) =>
      `${canaryPrefix}${provider}-${randomBytes(18).toString("hex")}`,
  );
  for (const { request } of wanted) {
    if (existing.has(request.name)) {
      console.log(`Kept the AI Account "${request.name}".`);
      continue;
    }
    await accounts.add(request);
    console.log(
      `Added the AI Account "${request.name}", at ${request.endpointUrl ?? ""}.`,
    );
  }
} finally {
  await database.close();
}
