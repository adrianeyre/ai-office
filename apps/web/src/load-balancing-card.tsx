import {
  loadBalancingSettingsSchema,
  loadBalancingStrategies,
  loadBalancingStrategyLabels,
  maxSessionWindowMinutes,
  minSessionWindowMinutes,
  type LoadBalancingSettings,
  type LoadBalancingStrategy,
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

// Load balancing (PRD FR-37): how the AI Gateway spreads requests across
// the AI Accounts, chosen at runtime. Changes apply from the next request.

/** The Gateway's strategy and session window (`GET /api/office/load-balancing`). */
export const loadBalancingQuery = queryOptions({
  queryKey: ["office", "load-balancing"],
  queryFn: () =>
    getJson("/api/office/load-balancing", loadBalancingSettingsSchema),
});

/** What each strategy does, as the Owner reads it. */
const strategyHints: Record<LoadBalancingStrategy, string> = {
  session:
    "Each Agent session (a sandbox run), or each of your tools, stays on one account for the session window. New sessions go to the account with the fewest.",
  session_affinity:
    "Each session stays on its account for as long as it is in use; it lets go after the session window without a call. New sessions go to the least-used account.",
  drain_soonest:
    "New sessions go to the account whose usage window resets first, so what is left of it is used before it resets. Sessions stay on their accounts while in use.",
  drain_soonest_strict:
    "Every request goes to the account whose usage window resets first, moving sessions as soon as another account's resets sooner.",
  least_used:
    "Each request goes to the account that has used the fewest tokens in the last five hours.",
};

interface FormValues {
  strategy: LoadBalancingStrategy;
  sessionWindowMinutes: string;
}

const formValues = (settings: LoadBalancingSettings): FormValues => ({
  strategy: settings.strategy,
  sessionWindowMinutes: String(settings.sessionWindowMinutes),
});

function LoadBalancingForm({ settings }: { settings: LoadBalancingSettings }) {
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
    const parsed = loadBalancingSettingsSchema.safeParse({
      strategy: values.strategy,
      sessionWindowMinutes:
        values.sessionWindowMinutes.trim() === ""
          ? undefined
          : Number(values.sessionWindowMinutes),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/load-balancing",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "Load balancing was not saved."],
      );
      return;
    }
    const updated = loadBalancingSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(loadBalancingQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Load balancing"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Strategy</legend>
        {loadBalancingStrategies.map((strategy) => (
          <label key={strategy} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              value={strategy}
              className="mt-1"
              aria-describedby={`strategy-${strategy}-hint`}
              {...register("strategy")}
            />
            <span>
              <span className="font-medium">
                {loadBalancingStrategyLabels[strategy]}
              </span>
              <span
                id={`strategy-${strategy}-hint`}
                className="block text-muted-foreground"
              >
                {strategyHints[strategy]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-2 sm:max-w-xs">
        <Label htmlFor="session-window">Session window (minutes)</Label>
        <Input
          id="session-window"
          type="number"
          inputMode="numeric"
          min={minSessionWindowMinutes}
          max={maxSessionWindowMinutes}
          aria-describedby="session-window-hint"
          {...register("sessionWindowMinutes")}
        />
        <p id="session-window-hint" className="text-xs text-muted-foreground">
          How long a session stays on its account: from its start (session), or
          since its last call (session affinity, drain soonest); 300 (five
          hours) by default.
        </p>
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
          Saved. It applies from the next request.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save load balancing"}
      </Button>
    </form>
  );
}

/**
 * How the AI Gateway chooses each request's AI Account (PRD FR-37). Every
 * strategy keeps to the best priority that can serve, and skips paused
 * accounts.
 */
export function LoadBalancingCard() {
  const { data: settings, isError } = useQuery(loadBalancingQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Load balancing</h2>
        </CardTitle>
        <CardDescription>
          How the AI Gateway spreads requests across the AI Accounts. Whichever
          it is, it uses only the active accounts with the lowest priority
          number that can serve a request, and others only when none of those
          can. Your own tools can send <code>x-ai-office-account</code> with an
          account&apos;s name to use that account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Load balancing could not be loaded.
          </p>
        )}
        {settings !== undefined && <LoadBalancingForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
