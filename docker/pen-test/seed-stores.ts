// Wires the pen-test seed (`seed.ts`) to a real database: the Floor, Agent,
// Skill, Floor Template and memory stores, and the AI Accounts through the AI
// Gateway's own code (so each canary credential is encrypted as the app
// encrypts it, and each account added is in the Activity Feed). The seed-cli
// (`seed-cli.ts`) and the database integration test use it.

import type { Database } from "../../packages/db/src/index.ts";
import {
  createEventBus,
  databaseEventStore,
} from "../../packages/events/src/index.ts";
import {
  createAiAccounts,
  databaseAiAccountStore,
} from "../../packages/gateway/src/index.ts";
import { databaseAgentStore } from "../../packages/orchestrator/src/agents/store.ts";
import { databaseFloorStore } from "../../packages/orchestrator/src/floors/store.ts";
import { databaseMemoryStore } from "../../packages/orchestrator/src/memory/store.ts";
import { databaseSkillStore } from "../../packages/orchestrator/src/skills/store.ts";
import { databaseFloorTemplateStore } from "../../packages/orchestrator/src/templates/store.ts";
import { encryptorFromVersionedKey } from "../../packages/shared/src/crypto.ts";

import type { SeedStores } from "./seed.ts";

/** The seed's stores, backed by `db`, with AI Accounts encrypted by `encryptionKey`. */
export function databaseSeedStores(
  db: Database,
  encryptionKey: string,
): SeedStores {
  const accounts = createAiAccounts({
    store: databaseAiAccountStore(db),
    encryptor: encryptorFromVersionedKey(encryptionKey),
    // So the Activity Feed records each AI Account added.
    events: createEventBus({ store: databaseEventStore(db) }),
  });
  return {
    floors: databaseFloorStore(db),
    agents: databaseAgentStore(db),
    skills: databaseSkillStore(db),
    templates: databaseFloorTemplateStore(db),
    memory: databaseMemoryStore(db),
    aiAccounts: {
      list: () => accounts.list(),
      add: (request) => accounts.add(request),
    },
  };
}
