import { z } from "zod";

import {
  defaultRetentionSettings,
  historyKindRetention,
  historyKinds,
  maxRetentionDays,
  type HistoryKind,
  type RetentionRule,
} from "./retention.ts";

// Storage (PRD §7, FR-65): how much of the database each kind of history
// takes, and deleting what is older than a number of days, to free space.
// The kinds, the days each always keeps and the days suggested are
// retention's (`historyKindRetention`, `defaultRetentionSettings`), so a
// clean-up by hand and the retention jobs agree.

export const storageCategories = historyKinds;
export type StorageCategory = HistoryKind;

const labels: Record<
  StorageCategory,
  { readonly label: string; readonly description: string }
> = {
  activity: {
    label: "Activity",
    description: "Every event in the Activity Feed and Agents' live views.",
  },
  request_bodies: {
    label: "Request and response bodies",
    description: "The Gateway's kept bodies, encrypted.",
  },
  requests: {
    label: "Gateway requests",
    description:
      "The request history, with its bodies. Token Caps and Analytics keep counting what deleted requests used.",
  },
  usage_history: {
    label: "Usage history",
    description: "Each change of an AI Account's usage windows.",
  },
  sign_ins: {
    label: "Sign-in history",
    description: "Each sign-in, and each failed one.",
  },
  connection_deliveries: {
    label: "Connection deliveries",
    description:
      "Each Connection's log of what it sent. Deliveries still waiting to go stay.",
  },
};

export const storageCategoryInfo = Object.fromEntries(
  storageCategories.map((category) => {
    const { rule, minDays } = historyKindRetention[category];
    return [
      category,
      {
        ...labels[category],
        rule,
        minDays,
        suggestedDays: defaultRetentionSettings[rule],
      },
    ];
  }),
) as Record<
  StorageCategory,
  {
    readonly label: string;
    readonly description: string;
    /** The retention rule that deletes it on its own (PRD §7). */
    readonly rule: RetentionRule;
    /** The fewest days that are always kept. */
    readonly minDays: number;
    /** The retention PRD §7 sets by default, in days. */
    readonly suggestedDays: number;
  }
>;

/** The largest number of days that can be given. */
export const maxStorageDays = maxRetentionDays;

export const storageCategoryUsageSchema = z.object({
  category: z.enum(storageCategories),
  rows: z.number().int().min(0),
  /** On disk, with its indexes; null where it cannot be told. */
  bytes: z.number().int().min(0).nullable(),
  /** The oldest row's time; null when there are none. */
  oldest: z.iso.datetime({ offset: true }).nullable(),
});
export type StorageCategoryUsage = z.infer<typeof storageCategoryUsageSchema>;

/** `GET /api/office/storage`. */
export const storageUsageSchema = z.object({
  categories: z.array(storageCategoryUsageSchema),
  /** The whole database; null where it cannot be told. */
  databaseBytes: z.number().int().min(0).nullable(),
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;

/** `POST /api/office/storage/prune`: delete what is older than `olderThanDays`. */
export const storagePruneRequestSchema = z
  .strictObject({
    category: z.enum(storageCategories, {
      error: `Choose what to delete: ${storageCategories.join(", ")}.`,
    }),
    olderThanDays: z
      .number({ error: "Give a whole number of days." })
      .int({ error: "Give a whole number of days." })
      .min(0, { error: "Give a number of days from 0." })
      .max(maxStorageDays, {
        error: `Give a number of days up to ${String(maxStorageDays)}.`,
      }),
  })
  .superRefine((request, context) => {
    const { label, minDays } = storageCategoryInfo[request.category];
    if (request.olderThanDays < minDays) {
      context.addIssue({
        code: "custom",
        path: ["olderThanDays"],
        message:
          minDays === 1
            ? `${label}: the last day is always kept.`
            : `${label}: the last ${String(minDays)} days are always kept.`,
      });
    }
  });
export type StoragePruneRequest = z.infer<typeof storagePruneRequestSchema>;

export const storagePruneResultSchema = z.object({
  category: z.enum(storageCategories),
  /** How many rows were deleted. */
  deleted: z.number().int().min(0),
});
export type StoragePruneResult = z.infer<typeof storagePruneResultSchema>;
