import { createHash } from "node:crypto";

import { repositoryChanges, type EventBus } from "@ai-office/events";
import { parseWebhookPayload, verifyWebhookSignature } from "@ai-office/github";
import {
  pipelineLabels,
  roleLabelPrefix,
  type Redactor,
  type WebhookSettings,
  type WebhookSettingsUpdate,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import type { Batches } from "../batches/batches.ts";
import type { FloorStore } from "../floors/store.ts";
import type { Intake } from "../intake/intake.ts";
import type { MergeFlow } from "../merge/merge.ts";
import type { OfficeSettingsStore } from "../office/settings.ts";

// The GitHub App's webhooks (PRD FR-8): with AI Office reachable from
// GitHub, the Owner turns them on in the office admin with the App's
// webhook secret. Each delivery's signature is checked against it before
// anything else is read; one that does not match is refused. A delivery
// about a Floor's repository then starts what it concerns at once, rather
// than at the next poll, which carries on as before in case one is lost:
// - an issue opened, reopened, labelled, edited or transferred: intake;
// - a pipeline label or a `role:<name>` label deleted or renamed: intake,
//   which makes it again;
// - an issue or pull request closed: the Batches' check for issues whose
//   dependencies are done (FR-25);
// - any other pull request change, a check run or a check suite: the
//   Merge Policy's wait for CI (FR-29), which reads check runs alone;
// - a push, a pull request change, a check run or a check suite: a
//   `repository.changed` event, on which the Branches page and its cache
//   read the Floor's branches from GitHub again.
// Labels on GitHub stay the source of truth: a webhook only says when to
// look, never what to do, so a delivery's payload is not trusted further.
//
// A delivery is acted on once (W1-1). GitHub signs the body alone, not
// `X-GitHub-Delivery`, so whoever holds one delivery could send it again
// under any id: each body taken is remembered by its SHA-256, and the same
// body again starts nothing, whatever id it carries. Only a body taken is
// remembered, so GitHub's Redeliver of one that was refused, or sent while
// webhooks were off, is still taken.

/** One delivery, as GitHub sent it. */
export interface WebhookDelivery {
  /** `X-GitHub-Event`, such as `issues`. */
  readonly event: string | undefined;
  /** `X-Hub-Signature-256`. */
  readonly signature: string | undefined;
  /** The raw body, exactly as signed. */
  readonly body: Uint8Array;
}

/** What a delivery started. */
export type WebhookAction = "intake" | "labels" | "batches" | "ci";

export type WebhookOutcome =
  /** Webhooks are off: the delivery is not looked at. */
  | { readonly status: "off" }
  /** The signature is missing or wrong. */
  | { readonly status: "refused" }
  /** Signed, but its body is not a JSON object. */
  | { readonly status: "malformed" }
  /** Signed, but its body was taken before: it starts nothing again. */
  | { readonly status: "repeated" }
  | {
      readonly status: "accepted";
      /** The Floor it concerns; absent for a repository that is none. */
      readonly floorId?: string;
      readonly started: readonly WebhookAction[];
    };

/** What a delivery may start; each is optional, as the GitHub App is. */
export interface WebhookTargets {
  readonly intake?: Pick<Intake, "trigger" | "recheckLabels">;
  readonly batches?: Pick<Batches, "trigger">;
  readonly merge?: Pick<MergeFlow, "ciChanged">;
}

export const webhookErrorCodes = {
  /** Turning webhooks on with no secret kept or given. */
  secretRequired: "webhook_secret_required",
} as const;

export class WebhookSettingsError extends Error {
  readonly code: (typeof webhookErrorCodes)[keyof typeof webhookErrorCodes];

  constructor(code: WebhookSettingsError["code"], message: string) {
    super(message);
    this.name = "WebhookSettingsError";
    this.code = code;
  }
}

export interface GitHubWebhooks {
  /** Whether webhooks are on, and whether a secret is kept. */
  settings(): Promise<WebhookSettings>;
  /**
   * Turns webhooks on or off, keeping a new secret when one is given.
   * Records which changed, never the secret. Throws a
   * `WebhookSettingsError` when turning them on with no secret at all.
   */
  setSettings(update: WebhookSettingsUpdate): Promise<WebhookSettings>;
  /** Checks a delivery and starts what it concerns. */
  receive(delivery: WebhookDelivery): Promise<WebhookOutcome>;
}

/** How many bodies taken are remembered, the oldest forgotten first. */
export const rememberedDeliveries = 10_000;

/** What the secret is sealed for: it opens nowhere else. */
/** The context the webhook secret is sealed with. */
export const webhookSecretContext = "office_settings.github_webhook_secret";

const issueActions = new Set([
  "opened",
  "reopened",
  "labeled",
  "edited",
  "transferred",
]);
const ciEvents = new Set(["check_run", "check_suite"]);

/** A label AI Office makes: a pipeline label, or a work Role's `role:<name>`. */
const officeLabel = (name: string | undefined): boolean =>
  name !== undefined &&
  (pipelineLabels.some(
    (label) => label.name.toLowerCase() === name.toLowerCase(),
  ) ||
    name.toLowerCase().startsWith(roleLabelPrefix.toLowerCase()));

/** What a delivery of `event` with `action` starts. */
export function webhookActions(
  event: string,
  payload: { readonly action?: string; readonly label?: string },
): WebhookAction[] {
  const { action } = payload;
  if (event === "issues") {
    if (action === "closed") {
      return ["batches"];
    }
    return action !== undefined && issueActions.has(action) ? ["intake"] : [];
  }
  if (event === "label") {
    return (action === "deleted" || action === "edited") &&
      officeLabel(payload.label)
      ? ["labels", "intake"]
      : [];
  }
  if (event === "pull_request") {
    return action === "closed" ? ["batches"] : ["ci"];
  }
  return ciEvents.has(event) ? ["ci"] : [];
}

export function createGitHubWebhooks(options: {
  readonly store: Pick<
    OfficeSettingsStore,
    "githubWebhooks" | "setGithubWebhooks"
  >;
  readonly floors: FloorStore;
  /** Seals the secret at rest (ENCRYPTION_KEY). */
  readonly encryptor: Encryptor;
  readonly events: EventBus;
  readonly targets?: WebhookTargets;
  /** Told the secret whenever this process holds it in clear. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** How many bodies taken are remembered; `rememberedDeliveries` otherwise. */
  readonly remember?: number;
}): GitHubWebhooks {
  const { store, encryptor, events } = options;
  const targets = options.targets ?? {};
  const now = options.now ?? (() => new Date());
  const remember = options.remember ?? rememberedDeliveries;
  /** The SHA-256 of each body taken, oldest first. */
  const taken = new Set<string>();

  const settings = async (): Promise<WebhookSettings> => {
    const kept = await store.githubWebhooks();
    return { enabled: kept.enabled, secretSet: kept.sealedSecret !== null };
  };

  return {
    settings,

    async setSettings(update) {
      const kept = await store.githubWebhooks();
      if (update.enabled && kept.sealedSecret === null && !update.secret) {
        throw new WebhookSettingsError(
          webhookErrorCodes.secretRequired,
          "Give the webhook secret to turn webhooks on: the one set on the GitHub App.",
        );
      }
      if (update.secret !== undefined) {
        options.redactor?.register(update.secret);
      }
      const sealedSecret =
        update.secret === undefined
          ? kept.sealedSecret
          : encryptor.encrypt(update.secret, webhookSecretContext);
      await store.setGithubWebhooks(
        { enabled: update.enabled, sealedSecret },
        now(),
      );
      // Which setting changed, never the secret's value.
      const keys = [
        ...(kept.enabled === update.enabled ? [] : ["webhooks.enabled"]),
        ...(update.secret === undefined ? [] : ["webhooks.secret"]),
      ];
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "office",
          keys,
        });
      }
      return { enabled: update.enabled, secretSet: sealedSecret !== null };
    },

    async receive(delivery) {
      const kept = await store.githubWebhooks();
      if (!kept.enabled || kept.sealedSecret === null) {
        return { status: "off" };
      }
      const secret = encryptor.decrypt(kept.sealedSecret, webhookSecretContext);
      options.redactor?.register(secret);
      if (!verifyWebhookSignature(secret, delivery.body, delivery.signature)) {
        return { status: "refused" };
      }
      const payload = parseWebhookPayload(delivery.body);
      if (payload === undefined) {
        return { status: "malformed" };
      }
      // Checked and remembered with nothing awaited between, so the same
      // body sent twice at once is taken once.
      const digest = createHash("sha256").update(delivery.body).digest("hex");
      if (taken.has(digest)) {
        return { status: "repeated" };
      }
      taken.add(digest);
      if (taken.size > remember) {
        for (const oldest of taken) {
          taken.delete(oldest);
          break;
        }
      }
      const repository = payload.repository?.toLowerCase();
      // Archived Floors are not listed: their work has stopped (FR-9).
      const floor =
        repository === undefined
          ? undefined
          : (await options.floors.list()).find(
              (candidate) => candidate.repository.toLowerCase() === repository,
            );
      if (floor === undefined) {
        return { status: "accepted", started: [] };
      }
      const started = webhookActions(delivery.event ?? "", payload).filter(
        (action) =>
          action === "batches"
            ? targets.batches !== undefined
            : action === "ci"
              ? targets.merge !== undefined
              : targets.intake !== undefined,
      );
      const change = repositoryChanges.find(
        (known) => known === delivery.event,
      );
      if (change !== undefined) {
        await events.publish({
          type: "repository.changed",
          version: 1,
          floorId: floor.id,
          change,
        });
      }
      // Started, not waited for: GitHub wants its answer within seconds.
      for (const action of started) {
        if (action === "labels") {
          targets.intake?.recheckLabels(floor.id);
        } else if (action === "intake") {
          void targets.intake?.trigger();
        } else if (action === "batches") {
          void targets.batches?.trigger();
        } else {
          targets.merge?.ciChanged(floor.id);
        }
      }
      return { status: "accepted", floorId: floor.id, started };
    },
  };
}
