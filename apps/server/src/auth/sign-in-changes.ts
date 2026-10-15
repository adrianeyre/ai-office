import type { EventBus, StoredEvent } from "@ai-office/events";

// Changes to how the Owner signs in (A1-5, PRD FR-52): an Owner password
// set, added, replaced or removed, and TOTP turned on or off. Each is a
// `config.changed` in the `security` scope, naming what changed: never a
// password, a secret or a code.

export type SignInChange =
  | "ownerPasswords.firstSet"
  | "ownerPasswords.added"
  | "ownerPasswords.replaced"
  | "ownerPasswords.removed"
  | "totp.enabled"
  | "totp.disabled";

/** Publishes `change` for the Activity Feed. */
export const signInChanged = (
  events: EventBus,
  change: SignInChange,
): Promise<StoredEvent> =>
  events.publish({
    type: "config.changed",
    version: 1,
    scope: "security",
    keys: [change],
  });
