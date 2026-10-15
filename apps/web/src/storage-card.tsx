import {
  maxStorageDays,
  storageCategoryInfo,
  storagePruneResultSchema,
  storageUsageSchema,
  type StorageCategoryUsage,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";

import { getJson, postJson, readApiError } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Storage (PRD §7, FR-65): how much of the database each kind of history
// takes, and deleting what is older than a number of days to free space,
// once the Owner confirms. Each kind keeps a minimum that AI Office still
// reads.

/** Each history's size (`GET /api/office/storage`). */
export const storageQuery = queryOptions({
  queryKey: ["office", "storage"],
  queryFn: () => getJson("/api/office/storage", storageUsageSchema),
});

const units = ["bytes", "KB", "MB", "GB", "TB"];

/** `1.5 MB`, or "unknown". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "unknown";
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${String(value)} bytes`
    : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? ""}`;
}

function CategoryRow({
  usage,
  csrfToken,
  onPruned,
}: {
  usage: StorageCategoryUsage;
  csrfToken: string | undefined;
  onPruned: () => Promise<void>;
}) {
  const info = storageCategoryInfo[usage.category];
  const [days, setDays] = useState(String(info.suggestedDays));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const olderThanDays = Number(days);
  const valid =
    days.trim() !== "" &&
    Number.isInteger(olderThanDays) &&
    olderThanDays >= info.minDays &&
    olderThanDays <= maxStorageDays;

  const prune = async () => {
    setBusy(true);
    setProblem(undefined);
    setOutcome(undefined);
    const response = await postJson(
      "/api/office/storage/prune",
      { category: usage.category, olderThanDays },
      csrfToken,
    );
    if (response.ok) {
      const { deleted } = storagePruneResultSchema.parse(await response.json());
      setOutcome(
        `Deleted ${deleted.toLocaleString()} ${deleted === 1 ? "row" : "rows"}.`,
      );
      await onPruned();
    } else {
      const error = await readApiError(response);
      setProblem(
        error.problems?.[0] ?? error.message ?? "Nothing was deleted.",
      );
    }
    setConfirming(false);
    setBusy(false);
  };

  const inputId = `storage-days-${usage.category}`;
  return (
    <li aria-label={info.label} className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{info.label}</p>
          <p className="text-muted-foreground">{info.description}</p>
        </div>
        <p className="text-muted-foreground">
          {usage.rows.toLocaleString()} {usage.rows === 1 ? "row" : "rows"} ·{" "}
          {formatBytes(usage.bytes)}
          {usage.oldest !== null && (
            <> · oldest {new Date(usage.oldest).toLocaleDateString()}</>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId}>Delete older than</label>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={info.minDays}
          max={maxStorageDays}
          value={days}
          aria-invalid={!valid}
          className="w-24"
          onChange={(event) => {
            setDays(event.target.value);
            setConfirming(false);
          }}
        />
        <span>days</span>
        {!confirming && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!valid || busy || csrfToken === undefined}
            aria-label={`Delete ${info.label.toLowerCase()} older than ${days} days`}
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        )}
      </div>
      {info.minDays > 0 && (
        <p className="text-xs text-muted-foreground">
          The last {info.minDays} {info.minDays === 1 ? "day is" : "days are"}{" "}
          always kept.
        </p>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full font-medium">
            Delete {info.label.toLowerCase()}{" "}
            {olderThanDays === 0
              ? "of every age"
              : `older than ${String(olderThanDays)} days`}
            ? It cannot be undone.
          </p>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void prune()}
          >
            Yes, delete it
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {outcome !== undefined && <p role="status">{outcome}</p>}
      {problem !== undefined && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}

export function StorageCard() {
  const queryClient = useQueryClient();
  const { data: usage, isError, isFetching } = useQuery(storageQuery);
  const { data: session } = useQuery(sessionQuery);
  const refresh = () => queryClient.invalidateQueries(storageQuery);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Storage</h2>
        </CardTitle>
        <CardDescription>
          How much of the database each history takes. Deleting the oldest frees
          its space for new data; Postgres hands it back to the disk over time.
          Retention deletes each one on its own once it is past its period.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The storage could not be loaded.
          </p>
        )}
        {usage !== undefined && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p>
                The database takes{" "}
                <span className="font-medium">
                  {formatBytes(usage.databaseBytes)}
                </span>
                .
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                pending={isFetching}
                onClick={() => void refresh()}
              >
                <RefreshCw aria-hidden />
                Refresh
              </Button>
            </div>
            <ul aria-label="Stored histories" className="divide-y">
              {usage.categories.map((category) => (
                <CategoryRow
                  key={category.category}
                  usage={category}
                  csrfToken={session?.csrfToken}
                  onPruned={refresh}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
