import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  gatewayKeyErrorCodes,
  gatewayKeyHintLength,
  gatewayKeyPrefix,
  terminalKeyName,
  type GatewayKeyAccess,
  type GatewayKeyErrorCode,
  type KeyProfile,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import type { GatewayKeyRecord, GatewayKeyStore } from "./store.ts";

// Gateway Keys (PRD FR-42, FR-46; ADR 0001): every request to the AI
// Gateway presents one, and is attributed to whoever it belongs to. Each
// Agent gets its own when it is made, and a new one when its key is
// rotated; its sandboxes are given it. The Owner makes named keys for
// their own tools, shown once, and revokes them. A key only calls models:
// it opens nothing else in AI Office.

/** A Gateway Key without its hash or sealed key: all the Owner sees of it. */
export type GatewayKeyInfo = Omit<GatewayKeyRecord, "keyHash" | "sealedKey">;

/** Who made a request, by the key it presented. */
export type GatewayCaller =
  | {
      readonly kind: "agent";
      readonly keyId: string;
      readonly agentId: string;
      readonly floorId: string;
      /** The Agent's name when the key was made. */
      readonly name: string;
      /**
       * The Agent's AI Provider, as AI Office knows it now: its agent tool
       * (FR-16) is the only one its calls are served as (FR-35;
       * pen-testing G1-5). Absent when not known: then none is.
       */
      readonly aiProvider?: string;
    }
  | {
      /** The Communications Agent (FR-90): Digests and reports. */
      readonly kind: "communications";
      readonly keyId: string;
      /** Its name when the key was made. */
      readonly name: string;
    }
  | {
      readonly kind: "owner_tool";
      readonly keyId: string;
      /** The Owner tool's name. */
      readonly name: string;
    };

/** How the Gateway tells who is calling. */
export interface GatewayKeyAuthenticator {
  /** The caller a key belongs to; undefined for an unknown or revoked key. */
  authenticate(key: string): Promise<GatewayCaller | undefined>;
}

/** Why a Gateway Key operation was refused. */
export class GatewayKeyError extends Error {
  readonly code: GatewayKeyErrorCode;

  constructor(code: GatewayKeyErrorCode, message: string) {
    super(message);
    this.name = "GatewayKeyError";
    this.code = code;
  }
}

/** What a Gateway Key needs to know about its Agent. */
export interface KeyedAgent {
  readonly id: string;
  readonly floorId: string;
  readonly name: string;
}

export interface GatewayKeys extends GatewayKeyAuthenticator {
  /** The keys in use, newest first: Agents' and Owner tools'. */
  list(): Promise<GatewayKeyInfo[]>;
  /** Makes a key for one of the Owner's tools: the only time it is shown. */
  createOwnerToolKey(
    name: string,
    access?: GatewayKeyAccess,
  ): Promise<{ gatewayKey: GatewayKeyInfo; key: string }>;
  /** Sets an Owner tool's key's access, and whether it is enabled. */
  update(
    id: string,
    changes: {
      readonly name?: string | undefined;
      readonly access?: GatewayKeyAccess | undefined;
      readonly enabled?: boolean | undefined;
    },
  ): Promise<GatewayKeyInfo>;
  /**
   * The key, if it may sign in to the web app now: an Owner tool's, in
   * use, enabled, with UI access. Undefined for any other.
   */
  uiKey(key: string): Promise<GatewayKeyInfo | undefined>;
  /** Whether the key with this id may still use the web app. */
  allowsUi(id: string): Promise<boolean>;
  /** Revokes an Owner tool's key: the Gateway refuses it from now on. */
  revoke(id: string): Promise<void>;
  /** Sets who uses a key in use: names and time zone. */
  setProfile(id: string, profile: KeyProfile): Promise<GatewayKeyInfo>;
  /** Gives the Agent a new key, revoking the one it had (rotation). */
  issueAgentKey(agent: KeyedAgent): Promise<GatewayKeyInfo>;
  /** Gives the Agent a key if it has none in use. */
  ensureAgentKey(agent: KeyedAgent): Promise<void>;
  /** The Agent's key in use, for its sandboxes; undefined if none. */
  agentKey(agentId: string): Promise<string | undefined>;
  /** The Agent's key in use, without the key. */
  agentKeyInfo(agentId: string): Promise<GatewayKeyInfo | undefined>;
  /** Revokes the Agent's key, as when the Agent is removed. */
  revokeAgentKey(agentId: string): Promise<void>;
  /**
   * Gives the Communications Agent (FR-90), which belongs to no Floor, a
   * key if it has none in use: its Digests' model calls present it.
   */
  ensureCommunicationsKey(name: string): Promise<void>;
  /** The Communications Agent's key in use; undefined if none. */
  communicationsKey(): Promise<string | undefined>;
  /**
   * The Terminal's key, made the first time it is needed and kept sealed,
   * as the Communications Agent's is. Its calls are attributed to the
   * Owner tool `terminalKeyName`.
   */
  terminalKey(): Promise<string>;
}

export interface GatewayKeysOptions {
  readonly store: GatewayKeyStore;
  /** Seals Agents' keys at rest (ENCRYPTION_KEY). */
  readonly encryptor: Encryptor;
  /** Each change is a `config.changed` event, naming what changed. */
  readonly events: Pick<EventBus, "publish">;
  /**
   * Told each key in clear the first time this process holds it, so it
   * can be redacted from everything AI Office writes.
   */
  readonly onKey?: (key: string) => void;
  /**
   * How long a key's last use may go unrecorded, so a busy key is not
   * written on every request; a minute by default.
   */
  readonly lastUsedResolutionMs?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The context an Agent's key is sealed with: it opens only in its own row. */
export const gatewayKeyContext = (id: string): string => `gateway_key:${id}`;

/** The SHA-256 a key is stored and looked up by. */
export const hashGatewayKey = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

/** A new random key: the prefix, then 32 random bytes. */
const newKey = (): string =>
  `${gatewayKeyPrefix}${randomBytes(32).toString("base64url")}`;

/** Whether a key may sign in to, and use, the web app. */
const usableInUi = (key: GatewayKeyRecord): boolean =>
  key.revokedAt === null &&
  key.kind === "owner_tool" &&
  key.enabled !== false &&
  key.access === "proxy_and_ui";

/** Everything but the hash and the sealed key, field by field. */
export const gatewayKeyInfo = (key: GatewayKeyRecord): GatewayKeyInfo => ({
  id: key.id,
  kind: key.kind,
  name: key.name,
  agentId: key.agentId,
  floorId: key.floorId,
  hint: key.hint,
  createdAt: key.createdAt,
  lastUsedAt: key.lastUsedAt,
  revokedAt: key.revokedAt,
  ...(key.profile === undefined ? {} : { profile: key.profile }),
  access: key.access ?? "proxy",
  enabled: key.enabled ?? true,
});

export function createGatewayKeys(options: GatewayKeysOptions): GatewayKeys {
  const { store, encryptor, events } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const resolutionMs = options.lastUsedResolutionMs ?? 60_000;
  const told = new Set<string>();
  // When each key's use was last written, so it is written at most once
  // per `resolutionMs`.
  const lastWritten = new Map<string, number>();

  const tell = (key: string): void => {
    if (!told.has(key)) {
      told.add(key);
      options.onKey?.(key);
    }
  };

  const changed = (
    keys: string[],
    agent?: { readonly id: string; readonly floorId: string | null },
  ) =>
    events.publish({
      type: "config.changed",
      version: 1,
      scope: "gateway",
      ...(agent === undefined
        ? {}
        : {
            agentId: agent.id,
            ...(agent.floorId === null ? {} : { floorId: agent.floorId }),
          }),
      keys,
    });

  const notFound = (id: string) =>
    new GatewayKeyError(
      gatewayKeyErrorCodes.gatewayKeyNotFound,
      `There is no Gateway Key "${id}" in use.`,
    );

  const record = (
    key: string,
    fields: Pick<GatewayKeyRecord, "kind" | "name" | "agentId" | "floorId">,
  ): GatewayKeyRecord => {
    const id = newId();
    return {
      id,
      ...fields,
      keyHash: hashGatewayKey(key),
      hint: key.slice(0, gatewayKeyHintLength),
      // Only an Owner tool's key is never kept: it is shown once.
      sealedKey:
        fields.kind === "owner_tool"
          ? null
          : encryptor.encrypt(key, gatewayKeyContext(id)),
      createdAt: now(),
      lastUsedAt: null,
      revokedAt: null,
    };
  };

  const issueAgentKey = async (agent: KeyedAgent, rotated: boolean) => {
    const key = newKey();
    tell(key);
    const added = record(key, {
      kind: "agent",
      name: agent.name,
      agentId: agent.id,
      floorId: agent.floorId,
    });
    await store.add(added);
    // A key made with its Agent is part of `agent.created`; a rotation is
    // the Owner's change.
    if (rotated) {
      await changed(["gatewayKeys.rotated"], agent);
    }
    return gatewayKeyInfo(added);
  };

  /** Opens a key kept sealed, telling of it. */
  const opened = (found: GatewayKeyRecord | undefined): string | undefined => {
    if (found?.sealedKey == null) {
      return undefined;
    }
    const key = encryptor.decrypt(found.sealedKey, gatewayKeyContext(found.id));
    tell(key);
    return key;
  };

  return {
    async authenticate(key) {
      if (!key.startsWith(gatewayKeyPrefix)) {
        return undefined;
      }
      const found = await store.byHash(hashGatewayKey(key));
      // Unknown, revoked or disabled.
      if (found?.revokedAt !== null || found.enabled === false) {
        return undefined;
      }
      const at = now();
      const written = lastWritten.get(found.id) ?? 0;
      if (at.getTime() - written >= resolutionMs) {
        lastWritten.set(found.id, at.getTime());
        // Not awaited: noting the use never holds up the request.
        store.touch(found.id, at).catch(() => {
          lastWritten.delete(found.id);
        });
      }
      if (found.kind === "communications") {
        return { kind: "communications", keyId: found.id, name: found.name };
      }
      // The Terminal is attributed like one of the Owner's own tools.
      if (found.kind === "terminal") {
        return { kind: "owner_tool", keyId: found.id, name: terminalKeyName };
      }
      return found.kind === "agent" &&
        found.agentId !== null &&
        found.floorId !== null
        ? {
            kind: "agent",
            keyId: found.id,
            agentId: found.agentId,
            floorId: found.floorId,
            name: found.name,
          }
        : { kind: "owner_tool", keyId: found.id, name: found.name };
    },

    async list() {
      return (await store.list()).map(gatewayKeyInfo);
    },

    async createOwnerToolKey(name, access = "proxy") {
      const key = newKey();
      tell(key);
      const added = {
        ...record(key, {
          kind: "owner_tool",
          name,
          agentId: null,
          floorId: null,
        }),
        access,
      };
      if ((await store.add(added)) === "name_taken") {
        throw new GatewayKeyError(
          gatewayKeyErrorCodes.gatewayKeyNameTaken,
          `A Gateway Key in use is already called "${name}".`,
        );
      }
      await changed(["gatewayKeys.created"]);
      return { gatewayKey: gatewayKeyInfo(added), key };
    },

    async revoke(id) {
      const current = await store.get(id);
      if (current?.revokedAt !== null) {
        throw notFound(id);
      }
      if (current.kind !== "owner_tool") {
        throw new GatewayKeyError(
          gatewayKeyErrorCodes.agentKeyNotRevocable,
          "An Agent's Gateway Key goes with the Agent: rotate it instead.",
        );
      }
      if ((await store.revoke(id, now())) === undefined) {
        throw notFound(id);
      }
      await changed(["gatewayKeys.revoked"]);
    },

    async update(id, changes) {
      const current = await store.get(id);
      if (current?.revokedAt !== null) {
        throw notFound(id);
      }
      if (current.kind !== "owner_tool") {
        throw new GatewayKeyError(
          gatewayKeyErrorCodes.agentKeyNoUi,
          "An Agent's Gateway Key is always enabled, and only calls models.",
        );
      }
      const updated = await store.update(id, changes);
      if (updated === undefined) {
        throw notFound(id);
      }
      if (updated === "name_taken") {
        throw new GatewayKeyError(
          gatewayKeyErrorCodes.gatewayKeyNameTaken,
          `A Gateway Key in use is already called "${changes.name ?? ""}".`,
        );
      }
      await changed(
        Object.keys(changes)
          .filter(
            (change) => changes[change as keyof typeof changes] !== undefined,
          )
          .map((change) => `gatewayKeys.${change}`),
      );
      return gatewayKeyInfo(updated);
    },

    async uiKey(key) {
      if (!key.startsWith(gatewayKeyPrefix)) {
        return undefined;
      }
      const found = await store.byHash(hashGatewayKey(key));
      return found !== undefined && usableInUi(found)
        ? gatewayKeyInfo(found)
        : undefined;
    },

    async allowsUi(id) {
      const found = await store.get(id);
      return found !== undefined && usableInUi(found);
    },

    async setProfile(id, profile) {
      const updated = await store.setProfile(id, profile);
      if (updated === undefined) {
        throw notFound(id);
      }
      // Which setting changed, never its value.
      await changed(["gatewayKeys.profile"]);
      return gatewayKeyInfo(updated);
    },

    issueAgentKey: (agent) => issueAgentKey(agent, true),

    async ensureAgentKey(agent) {
      if ((await store.forAgent(agent.id)) === undefined) {
        await issueAgentKey(agent, false);
      }
    },

    async agentKey(agentId) {
      return opened(await store.forAgent(agentId));
    },

    async agentKeyInfo(agentId) {
      const found = await store.forAgent(agentId);
      return found === undefined ? undefined : gatewayKeyInfo(found);
    },

    async revokeAgentKey(agentId) {
      const found = await store.forAgent(agentId);
      if (found !== undefined && (await store.revokeForAgent(agentId, now()))) {
        await changed(["gatewayKeys.revoked"], {
          id: agentId,
          floorId: found.floorId,
        });
      }
    },

    async ensureCommunicationsKey(name) {
      if ((await store.forCommunications()) !== undefined) {
        return;
      }
      const key = newKey();
      tell(key);
      // Made with the Communications Agent: part of its first start.
      await store.add(
        record(key, {
          kind: "communications",
          name,
          agentId: null,
          floorId: null,
        }),
      );
    },

    async communicationsKey() {
      return opened(await store.forCommunications());
    },

    async terminalKey() {
      const found = opened(await store.forTerminal());
      if (found !== undefined) {
        return found;
      }
      const key = newKey();
      tell(key);
      // Made when the Terminal is first used.
      await store.add(
        record(key, {
          kind: "terminal",
          name: terminalKeyName,
          agentId: null,
          floorId: null,
        }),
      );
      return key;
    },
  };
}

/** Always the same callers, by key: for tests. */
export const staticKeys = (
  callers: Readonly<Record<string, GatewayCaller>>,
): GatewayKeyAuthenticator => ({
  authenticate: (key) => Promise.resolve(callers[key]),
});
