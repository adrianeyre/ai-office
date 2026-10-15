import {
  maxRetentionDays,
  retentionMinDays,
  retentionSettingsSchema,
  type RetentionSettings,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Retention (PRD §7, FR-65): how long AI Office keeps what it records
// before deleting it. Whether request bodies are kept at all is the
// switch in AI Settings' Request history card; deleting history at once,
// to free space, is the Storage card's.

/** The retention periods (`GET /api/office/retention`). */
export const retentionQuery = queryOptions({
  queryKey: ["office", "retention"],
  queryFn: () => getJson("/api/office/retention", retentionSettingsSchema),
});

type FormValues = Record<keyof RetentionSettings, string>;

const formValues = (settings: RetentionSettings): FormValues => ({
  requestBodiesDays: String(settings.requestBodiesDays),
  requestMetadataDays: String(settings.requestMetadataDays),
  activityDays: String(settings.activityDays),
  connectionDeliveriesDays: String(settings.connectionDeliveriesDays),
});

/** Each field: its label, what it deletes, and its bounds. */
const fields: readonly {
  readonly key: keyof RetentionSettings;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
}[] = [
  {
    key: "requestBodiesDays",
    label: "Request and response bodies (days)",
    hint: "Each Gateway request's bodies, kept encrypted while body storage is on; 7 by default. The request itself stays.",
    min: retentionMinDays.requestBodiesDays,
  },
  {
    key: "requestMetadataDays",
    label: "Requests and usage (days)",
    hint: "Each Gateway request's record (tokens, cost, timings) and AI Accounts' usage readings; 90 by default, and at least 32. Token Caps and Analytics keep counting what deleted requests used.",
    min: retentionMinDays.requestMetadataDays,
  },
  {
    key: "activityDays",
    label: "Activity Feed and Notices (days)",
    hint: "Activity Feed events, sign-ins, and Notices since they were dismissed or acted on; 365 by default, and at least 30. A Notice still on the board stays.",
    min: retentionMinDays.activityDays,
  },
  {
    key: "connectionDeliveriesDays",
    label: "Connection deliveries (days)",
    hint: "Each Connection's log of what it sent; 90 by default, and at least 1. A delivery still waiting to go stays.",
    min: retentionMinDays.connectionDeliveriesDays,
  },
];

const numberOrUndefined = (value: string): number | undefined =>
  value.trim() === "" ? undefined : Number(value);

function RetentionForm({ settings }: { settings: RetentionSettings }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: formValues(settings) });

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const parsed = retentionSettingsSchema.safeParse({
      requestBodiesDays: numberOrUndefined(values.requestBodiesDays),
      requestMetadataDays: numberOrUndefined(values.requestMetadataDays),
      activityDays: numberOrUndefined(values.activityDays),
      connectionDeliveriesDays: numberOrUndefined(
        values.connectionDeliveriesDays,
      ),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/retention",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "Retention was not saved."],
      );
      return;
    }
    const updated = retentionSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(retentionQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Retention"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ key, label, hint, min }) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`retention-${key}`}>{label}</Label>
            <Input
              id={`retention-${key}`}
              type="number"
              inputMode="numeric"
              min={min}
              max={maxRetentionDays}
              aria-describedby={`retention-${key}-hint`}
              {...register(key)}
            />
            <p
              id={`retention-${key}-hint`}
              className="text-xs text-muted-foreground"
            >
              {hint}
            </p>
          </div>
        ))}
      </div>
      {problems.length > 0 && (
        <div role="alert">
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {saved && !isDirty && (
        <p role="status" className="text-sm">
          Saved. Anything older is deleted now.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save retention"}
      </Button>
    </form>
  );
}

/** How long records are kept before they are deleted (PRD §7). */
export function RetentionCard() {
  const { data: settings, isError } = useQuery(retentionQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Retention</h2>
        </CardTitle>
        <CardDescription>
          AI Office deletes what it has recorded once it is older than these
          periods, checking every hour. Bodies are kept no longer than their
          requests. To keep no bodies at all, turn off Keep request and response
          bodies in AI Settings&apos; Request history card.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Retention could not be loaded.
          </p>
        )}
        {settings !== undefined && <RetentionForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
