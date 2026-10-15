import {
  autoRefreshBufferMs,
  autoRefreshSettingsSchema,
  type AutoRefreshSettings,
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

/** Whether the AI Gateway auto-refreshes (`GET /api/office/auto-refresh`). */
export const autoRefreshQuery = queryOptions({
  queryKey: ["office", "auto-refresh"],
  queryFn: () => getJson("/api/office/auto-refresh", autoRefreshSettingsSchema),
});

function AutoRefreshForm({ settings }: { settings: AutoRefreshSettings }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<AutoRefreshSettings>({ defaultValues: settings });

  const onSubmit = async (values: AutoRefreshSettings) => {
    setSaved(false);
    const response = await sendJson(
      "PUT",
      "/api/office/auto-refresh",
      values,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "Auto-refresh was not saved."],
      );
      return;
    }
    const updated = autoRefreshSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(updated);
    queryClient.setQueryData(autoRefreshQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Auto-refresh"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div
        role="note"
        aria-label="Auto-refresh and the AI Providers' terms"
        className="rounded-md border border-tone-warning-foreground/40 bg-tone-warning p-3 text-sm text-tone-warning-foreground"
      >
        <p className="font-medium">About the AI Providers&apos; terms</p>
        <p>
          The request is the AI Gateway&apos;s own, not Claude Code&apos;s. So
          far only Claude subscriptions report usage windows, and
          Anthropic&apos;s terms allow a subscription only through Claude Code.
          Turn this on only if you accept that for your subscriptions.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="auto-refresh-hint"
          {...register("enabled")}
        />
        <span>
          <span className="font-medium">
            Start each usage window as soon as it resets
          </span>
          <span id="auto-refresh-hint" className="block text-muted-foreground">
            {autoRefreshBufferMs / 1000} seconds after an AI Account&apos;s
            usage window resets, the AI Gateway sends it one minimal request,
            once per window.
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
          Saved. It applies from the next minute&apos;s check.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save auto-refresh"}
      </Button>
    </form>
  );
}

/**
 * Auto-refresh (PRD FR-39): whether the AI Gateway starts each AI
 * Account's usage window anew as soon as it resets, with one minimal
 * request. Off until the Owner turns it on.
 */
export function AutoRefreshCard() {
  const { data: settings, isError } = useQuery(autoRefreshQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Auto-refresh</h2>
        </CardTitle>
        <CardDescription>
          A usage window starts with the first request after the last one reset,
          so one that resets while nothing is asked of its account starts late.
          With auto-refresh on, it starts at once. Accounts that report no usage
          windows, such as API keys, are never sent a request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Auto-refresh could not be loaded.
          </p>
        )}
        {settings !== undefined && <AutoRefreshForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
