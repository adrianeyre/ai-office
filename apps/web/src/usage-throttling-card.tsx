import {
  pacingHeadroomPercent,
  usageThrottlingSettingsSchema,
  type UsageThrottlingSettings,
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

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

/** The AI Gateway's pacing gates (`GET /api/office/usage-throttling`). */
export const usageThrottlingQuery = queryOptions({
  queryKey: ["office", "usage-throttling"],
  queryFn: () =>
    getJson("/api/office/usage-throttling", usageThrottlingSettingsSchema),
});

function UsageThrottlingForm({
  settings,
}: {
  settings: UsageThrottlingSettings;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<UsageThrottlingSettings>({ defaultValues: settings });

  const onSubmit = async (values: UsageThrottlingSettings) => {
    setSaved(false);
    const response = await sendJson(
      "PUT",
      "/api/office/usage-throttling",
      values,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "Usage throttling was not saved."],
      );
      return;
    }
    const updated = usageThrottlingSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(updated);
    queryClient.setQueryData(usageThrottlingQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Usage throttling"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="five-hour-pacing-hint"
          {...register("fiveHourPacing")}
        />
        <span>
          <span className="font-medium">Pace each five-hour window</span>
          <span
            id="five-hour-pacing-hint"
            className="block text-muted-foreground"
          >
            An account that has used more of its five-hour window than the share
            of it gone by (plus {pacingHeadroomPercent} points) waits until the
            window catches up.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="weekly-pacing-hint"
          {...register("weeklyPacing")}
        />
        <span>
          <span className="font-medium">Pace each weekly window</span>
          <span id="weekly-pacing-hint" className="block text-muted-foreground">
            The same for the weekly window, so a week&apos;s usage is not spent
            in its first days.
          </span>
        </span>
      </label>
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
          Saved. It applies from the next request.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save usage throttling"}
      </Button>
    </form>
  );
}

/**
 * Usage throttling (PRD FR-38): optional pacing gates on each AI
 * Account's five-hour and weekly usage windows, checked after the
 * load-balancing strategy chose.
 */
export function UsageThrottlingCard() {
  const { data: settings, isError } = useQuery(usageThrottlingQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Usage throttling</h2>
        </CardTitle>
        <CardDescription>
          Spreads each AI Account&apos;s usage windows over their length. An
          account ahead of its pace serves only when no other can; with none
          left, the AI Gateway answers 529. Accounts that report no usage
          windows, such as API keys, are never paced.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Usage throttling could not be loaded.
          </p>
        )}
        {settings !== undefined && <UsageThrottlingForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
