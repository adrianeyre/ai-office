// The AI Account a prompt-cache keep-alive goes to (PRD FR-39): the one
// that served the Agent's request, only while it can serve now. A
// keep-alive never waits on, or probes, an account that cannot.
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { createAiAccounts, credentialContext } from "../accounts/accounts.ts";
import {
  memoryAiAccountStore,
  type AiAccountChanges,
  type AiAccountRecord,
} from "../accounts/store.ts";

const encryptor = encryptorFromKey(Buffer.alloc(32, 43));
const start = Date.parse("2026-10-10T12:00:00.000Z");
const minute = 60_000;
const id = "00000000-0000-4000-8000-000000000001";
const accessToken = "sk-ant-oat01-keepaliveaccountstoken-0123456789";

async function setUp() {
  let time = start;
  const store = memoryAiAccountStore();
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    now: () => new Date(time),
  });
  const account: AiAccountRecord = {
    id,
    name: "Max",
    accountType: "oauth",
    aiProvider: "Claude",
    credential: encryptor.encrypt(accessToken, credentialContext(id)),
    endpointUrl: null,
    region: null,
    projectId: null,
    priority: 1,
    paused: false,
    refreshToken: null,
    tokenExpiresAt: new Date(start + 60 * minute),
    reauthenticationNeeded: false,
    limitReason: null,
    limitedUntil: null,
    fiveHourUtilization: null,
    fiveHourResetsAt: null,
    weeklyUtilization: null,
    weeklyResetsAt: null,
    fiveHourPauseThreshold: null,
    weeklyPauseThreshold: null,
    forcedModel: null,
    extraUsage: false,
    createdAt: new Date(start),
    updatedAt: new Date(start),
  };
  await store.add(account);
  return {
    accounts,
    store,
    at: (ms: number) => {
      time = start + ms;
    },
  };
}

describe("the AI Account a keep-alive goes to", () => {
  it("is the account, ready to send to, while it can serve", async () => {
    const { accounts } = await setUp();
    expect(
      await accounts.keepAliveAccount(id, "claude-opus-5-5"),
    ).toMatchObject({
      id,
      name: "Max",
      apiKey: accessToken,
      baseUrl: "https://api.anthropic.com",
      authorization: "bearer",
    });
    expect(
      await accounts.keepAliveAccount(
        "00000000-0000-4000-8000-000000000009",
        null,
      ),
    ).toBeUndefined();
  });

  it("is none while it is paused, held back or signed out", async () => {
    const { accounts, store, at } = await setUp();
    const ready = () => accounts.keepAliveAccount(id, "claude-opus-5-5");
    const update = (changes: Omit<AiAccountChanges, "updatedAt">) =>
      store.update(id, { ...changes, updatedAt: new Date(start) });

    await update({ paused: true });
    expect(await ready()).toBeUndefined();
    await update({ paused: false });

    await update({
      limitReason: "rate_limited",
      limitedUntil: new Date(start + 5 * minute),
    });
    expect(await ready()).toBeUndefined();
    at(5 * minute);
    expect(await ready()).toBeDefined();

    await update({ reauthenticationNeeded: true });
    expect(await ready()).toBeUndefined();
    await update({ reauthenticationNeeded: false });
    at(60 * minute);
    // Its token has expired.
    expect(await ready()).toBeUndefined();
  });

  it("is none while it is exhausted for the Model's family, but not for others", async () => {
    const { accounts } = await setUp();
    const opened = await accounts.keepAliveAccount(id, "claude-opus-5-5");
    if (opened === undefined) {
      throw new Error("Max should be ready.");
    }
    await accounts.report(opened, {
      kind: "rate_limited",
      until: new Date(start + 10 * minute),
      modelFamily: "claude-opus",
    });
    expect(
      await accounts.keepAliveAccount(id, "claude-opus-5-5"),
    ).toBeUndefined();
    expect(
      await accounts.keepAliveAccount(id, "claude-sonnet-5-5"),
    ).toBeDefined();
  });
});
