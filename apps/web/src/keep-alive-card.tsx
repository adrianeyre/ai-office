import {
  keepAliveLeadMs,
  maxKeepAliveIdleMinutes,
  maxKeepAlivesPerAccountPerHour,
  minKeepAliveIdleMinutes,
  promptCacheKeepAliveSettingsSchema,
  type PromptCacheKeepAliveSettings,
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

// Prompt-cache keep-alive (PRD FR-39): whether the AI Gateway keeps each
// Agent's prompt cache warm through its pauses, for how long after the
// Agent's last request, and how many keep-alives each AI Account may be
// sent an hour. Changes apply from the next round.

/** Keep-alive's settings (`GET /api/office/prompt-cache-keep-alive`). */
export const keepAliveQuery = queryOptions({
  queryKey: ["office", "prompt-cache-keep-alive"],
  queryFn: () =>
    getJson(
      "/api/office/prompt-cache-keep-alive",
      promptCacheKeepAliveSettingsSchema,
    ),
});

interface FormValues {
  readonly enabled: boolean;
  readonly idleMinutes: string;
  readonly maxPerAccountPerHour: string;
}

const formValues = (settings: PromptCacheKeepAliveSettings): FormValues => ({
  enabled: settings.enabled,
  idleMinutes: String(settings.idleMinutes),
  maxPerAccountPerHour: String(settings.maxPerAccountPerHour),
});

const numberOrUndefined = (value: string): number | undefined =>
  value.trim() === "" ? undefined : Number(value);

function KeepAliveForm({
  settings,
}: {
  settings: PromptCacheKeepAliveSettings;
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
  } = useForm<FormValues>({ defaultValues: formValues(settings) });

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const parsed = promptCacheKeepAliveSettingsSchema.safeParse({
      enabled: values.enabled,
      idleMinutes: numberOrUndefined(values.idleMinutes),
      maxPerAccountPerHour: numberOrUndefined(values.maxPerAccountPerHour),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/prompt-cache-keep-alive",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "Keep-alive was not saved."],
      );
      return;
    }
    const updated = promptCacheKeepAliveSettingsSchema.parse(
      await response.json(),
    );
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(keepAliveQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Prompt-cache keep-alive"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div
        role="note"
        aria-label="Keep-alive and the AI Providers' terms"
        className="rounded-md border border-tone-warning-foreground/40 bg-tone-warning p-3 text-sm text-tone-warning-foreground"
      >
        <p className="font-medium">About the AI Providers&apos; terms</p>
        <p>
          A keep-alive repeats the Agent&apos;s own request, but the AI Gateway
          sends it, not Claude Code. Anthropic&apos;s terms allow a subscription
          only through Claude Code. Turn this on only if you accept that for
          your subscriptions.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="keep-alive-hint"
          {...register("enabled")}
        />
        <span>
          <span className="font-medium">
            Keep Agents&apos; prompt caches warm
          </span>
          <span id="keep-alive-hint" className="block text-muted-foreground">
            {keepAliveLeadMs / 1000} seconds before an Agent&apos;s prompt cache
            would expire, the AI Gateway sends its latest request again with
            nothing to generate, to the AI Account that served it.
          </span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="keep-alive-idle-minutes">Idle time (minutes)</Label>
          <Input
            id="keep-alive-idle-minutes"
            type="number"
            inputMode="numeric"
            min={minKeepAliveIdleMinutes}
            max={maxKeepAliveIdleMinutes}
            step={1}
            aria-describedby="keep-alive-idle-minutes-hint"
            {...register("idleMinutes")}
          />
          <p
            id="keep-alive-idle-minutes-hint"
            className="text-xs text-muted-foreground"
          >
            A session whose Agent has asked nothing for this long is let go; 30
            by default.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="keep-alive-max-per-account">
            Keep-alives per AI Account an hour
          </Label>
          <Input
            id="keep-alive-max-per-account"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxKeepAlivesPerAccountPerHour}
            step={1}
            aria-describedby="keep-alive-max-per-account-hint"
            {...register("maxPerAccountPerHour")}
          />
          <p
            id="keep-alive-max-per-account-hint"
            className="text-xs text-muted-foreground"
          >
            The most each account is sent in any hour; 60 by default, enough for
            four sessions on the five-minute TTL.
          </p>
        </div>
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
          Saved. It applies from the next round, within 15 seconds.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save keep-alive"}
      </Button>
    </form>
  );
}

/**
 * Prompt-cache keep-alive (PRD FR-39): off until the Owner turns it on.
 * Each keep-alive shows in Gateway requests and Analytics.
 */
export function KeepAliveCard() {
  const { data: settings, isError } = useQuery(keepAliveQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Prompt-cache keep-alive</h2>
        </CardTitle>
        <CardDescription>
          Anthropic drops a prompt cache that is not read within its TTL, so an
          Agent that pauses longer, for a long test run, pays to write its whole
          conversation again. With keep-alive on, the cache is read just before
          it expires, for a fraction of the price, while the Agent is active.
          Each keep-alive shows in Gateway requests and Analytics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Keep-alive could not be loaded.
          </p>
        )}
        {settings !== undefined && <KeepAliveForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
