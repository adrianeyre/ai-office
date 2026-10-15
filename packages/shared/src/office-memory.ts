import { z } from "zod";

import { roleIdSchema } from "./roles.ts";
import { createRedactor, redactedText, type Redactor } from "./redact.ts";

// Office-wide and Role memory (PRD FR-54, FR-55, FR-56), kept in AI Office
// rather than in a repository.
//
// - Office-wide memory is the Owner's: coding standards, preferred
//   libraries, review rules. It is edited in the office admin and mounted
//   read-only into every sandbox, and quoted in every reviewer's prompt.
// - Role memory is what Agents of one Role on one Floor have learned, one
//   line per entry. Agents propose entries in their Handoff (or QA's
//   report); the Floor's Manager or the Owner accepts or rejects each.
//
// Memory is untrusted input and never holds a credential: a credential
// check refuses whatever looks like a secret. Every change is an event.
// The server, the web app and the orchestrator share these.

/** The longest the office-wide memory may be. */
export const maxOfficeMemoryLength = 12_000;

/** The most entries one Role's memory on a Floor keeps. */
export const maxRoleMemoryEntries = 40;

/**
 * Where office-wide and Role memory are mounted in every sandbox, one
 * file each (`OFFICE.md`, `ROLE.md`), read-only.
 */
export const sandboxMemoryDirectory = "/home/agent/.ai-office/memory";

/**
 * Where a Role memory entry stands (ADR 0005: only the Owner accepts one):
 * - `proposed`: an Agent proposed it; it waits for the Manager or the Owner;
 * - `recommended`: the Manager recommends it; it waits for the Owner, and
 *   no Agent reads it;
 * - `accepted`: the Owner accepted it; Agents of its Role read it;
 * - `rejected`: the Manager or the Owner turned it down;
 * - `removed`: the Owner took it out of the memory after accepting it.
 */
export const roleMemoryStatuses = [
  "proposed",
  "recommended",
  "accepted",
  "rejected",
  "removed",
] as const;
export type RoleMemoryStatus = (typeof roleMemoryStatuses)[number];

/**
 * Who decided on an entry: the Floor's Manager (which only recommends or
 * rejects) or the Owner.
 */
export const roleMemoryDeciders = ["manager", "owner"] as const;
export type RoleMemoryDecider = (typeof roleMemoryDeciders)[number];

/** The longest reason given for a decision. */
export const maxRoleMemoryReasonLength = 300;

export const memoryErrorCodes = {
  /** Something in it looks like a credential, which memory never holds. */
  memoryHoldsSecret: "memory_holds_secret",
  /** The office-wide memory is longer than it may be. */
  officeMemoryTooLong: "office_memory_too_long",
  roleMemoryNotFound: "role_memory_not_found",
  /**
   * It was decided already: only a proposal, or one the Manager
   * recommended, is accepted or rejected.
   */
  roleMemoryDecided: "role_memory_decided",
  /** Only an accepted entry is removed. */
  roleMemoryNotAccepted: "role_memory_not_accepted",
  /** The Role's memory holds as many entries as it may. */
  roleMemoryFull: "role_memory_full",
} as const;
export type MemoryErrorCode =
  (typeof memoryErrorCodes)[keyof typeof memoryErrorCodes];

/** `GET /api/memory/office`: the office-wide memory. */
export const officeMemorySchema = z.object({
  content: z.string(),
  /** When the Owner last saved it; null until they have. */
  updatedAt: z.iso.datetime().nullable(),
});
export type OfficeMemory = z.infer<typeof officeMemorySchema>;

/** `PUT /api/memory/office`: the whole office-wide memory, as Markdown. */
export const officeMemoryUpdateSchema = z.strictObject({
  content: z.string().max(maxOfficeMemoryLength, {
    error: `The office-wide memory is at most ${maxOfficeMemoryLength.toLocaleString("en-GB")} characters.`,
  }),
});
export type OfficeMemoryUpdate = z.infer<typeof officeMemoryUpdateSchema>;

/** One Role memory entry, as the API sends it. */
export const roleMemoryEntrySchema = z.object({
  id: z.number().int().positive(),
  /** A library Role's id: every Role but the Manager keeps Role memory. */
  role: roleIdSchema,
  text: z.string(),
  status: z.enum(roleMemoryStatuses),
  /** The issue whose Handoff proposed it. */
  issue: z.number().int().positive(),
  /** The Agent that proposed it. */
  agentId: z.string(),
  createdAt: z.iso.datetime(),
  decidedBy: z.enum(roleMemoryDeciders).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  /** Why it was recommended, accepted or rejected, if a reason was given. */
  reason: z.string().nullable(),
});
export type RoleMemoryEntry = z.infer<typeof roleMemoryEntrySchema>;

/** `GET /api/floors/:floorId/role-memory`: what is proposed and accepted. */
export const roleMemoryListSchema = z.object({
  entries: z.array(roleMemoryEntrySchema),
});
export type RoleMemoryList = z.infer<typeof roleMemoryListSchema>;

/** `POST …/role-memory/:id/reject`: an optional reason. */
export const roleMemoryRejectionSchema = z.strictObject({
  reason: z.string().trim().max(maxRoleMemoryReasonLength).optional(),
});

/**
 * The Manager's decisions on its Floor's Role memory proposals, which its
 * Model must answer as one JSON object: every proposal it was given,
 * accepted or rejected, each with a reason.
 */
export const roleMemoryDecisionsSchema = z.strictObject({
  decisions: z.array(
    z.strictObject({
      id: z.number({ error: "Each decision names a proposal's id." }).int(),
      decision: z.enum(["accept", "reject"], {
        error: 'decision is "accept" or "reject".',
      }),
      reason: z
        .string({ error: "Each decision gives its reason." })
        .trim()
        .min(1, { error: "Each decision gives its reason." })
        .max(maxRoleMemoryReasonLength, {
          error: `A reason is at most ${String(maxRoleMemoryReasonLength)} characters.`,
        }),
    }),
    { error: "decisions is a list." },
  ),
});
export type RoleMemoryDecisions = z.infer<typeof roleMemoryDecisionsSchema>;

// Shapes of secrets beyond those every log is redacted of: Slack, Stripe
// and npm tokens, and a long key or token given a value (`token: …`,
// `api-key = …`) of letters and digits together.
const secretShapes: readonly RegExp[] = [
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\b[A-Za-z0-9_-]*(?:token|key|passw(?:or)?d|pwd|credential)s?[ \t]*[:=][ \t]*["']?(?=[^\s"']*\d)(?=[^\s"']*[A-Za-z])[A-Za-z0-9+/_.=-]{20,}/i,
];

/**
 * Whether `text` looks like it holds a credential (FR-56): the redactor
 * would change it (a credential's shape, or a secret registered with it),
 * it holds a redaction already, or it has the shape of another secret.
 */
export function looksLikeSecret(
  text: string,
  redactor: Redactor = createRedactor(),
): boolean {
  return (
    redactor.redactText(text) !== text ||
    text.includes(redactedText) ||
    secretShapes.some((shape) => shape.test(text))
  );
}

/**
 * The lines of `text` (numbered from 1) that look like they hold a
 * credential, so the Owner can be told where without the secret being
 * repeated. A secret spanning lines, such as a private key, is found on
 * its first line.
 */
export function secretLikeLines(
  text: string,
  redactor: Redactor = createRedactor(),
): number[] {
  const lines = text.split(/\r?\n/);
  const found = new Set<number>();
  lines.forEach((line, index) => {
    if (looksLikeSecret(line, redactor)) {
      found.add(index + 1);
    }
  });
  if (found.size === 0 && looksLikeSecret(text, redactor)) {
    // Only the whole text gives it away: name where it starts.
    const redacted = redactor.redactText(text);
    let at = 0;
    while (at < text.length && text[at] === redacted[at]) {
      at += 1;
    }
    found.add(text.slice(0, at).split(/\r?\n/).length);
  }
  return [...found].sort((a, b) => a - b);
}
