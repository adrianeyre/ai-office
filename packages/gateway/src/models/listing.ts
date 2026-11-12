import type { AiAccountType } from "@ai-office/shared";

import type { GatewayModel } from "../gateway.ts";
import type { CatalogueEntry } from "./store.ts";

/**
 * The Models `GET /v1/models` lists: the catalogue's (FR-41), for each kind
 * of AI Account the Owner has an unpaused account of, each Model once (the
 * first kind to list it names its AI Provider), by name.
 */
export function gatewayModels(
  catalogue: readonly CatalogueEntry[],
  accounts: readonly {
    readonly aiProvider: string;
    readonly accountType: AiAccountType;
    readonly paused: boolean;
  }[],
): GatewayModel[] {
  const kinds = new Set(
    accounts
      .filter(({ paused }) => !paused)
      .map(({ aiProvider, accountType }) => `${aiProvider}:${accountType}`),
  );
  const models = new Map<string, GatewayModel>();
  for (const entry of catalogue) {
    if (
      kinds.has(`${entry.aiProvider}:${entry.accountType}`) &&
      !models.has(entry.model)
    ) {
      models.set(entry.model, {
        id: entry.model,
        displayName: entry.displayName,
        aiProvider: entry.aiProvider,
      });
    }
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
