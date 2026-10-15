import {
  gatewayRetrySettingsSchema,
  maxCircuitBreakerCooldownSeconds,
  maxCircuitBreakerThreshold,
  maxRetryAttempts,
  maxRetryDelayMs,
  maxRetryMultiplier,
  minRetryAttempts,
  type GatewayRetrySettings,
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

// Retries and the circuit breaker (PRD FR-39): how the AI Gateway tries a
// request again when an AI Account is rate-limited, overloaded or failing,
// and when it gives a failing account a rest. Changes apply from the next
// request.

/** The Gateway's retry settings (`GET /api/office/retries`). */
export const retriesQuery = queryOptions({
  queryKey: ["office", "retries"],
  queryFn: () => getJson("/api/office/retries", gatewayRetrySettingsSchema),
});

type FormValues = Record<keyof GatewayRetrySettings, string>;

const formValues = (settings: GatewayRetrySettings): FormValues => ({
  attempts: String(settings.attempts),
  delayMs: String(settings.delayMs),
  multiplier: String(settings.multiplier),
  circuitBreakerThreshold: String(settings.circuitBreakerThreshold),
  circuitBreakerCooldownSeconds: String(settings.circuitBreakerCooldownSeconds),
});

/** Each field: its label, what it does, and its bounds. */
const fields: readonly {
  readonly key: keyof GatewayRetrySettings;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}[] = [
  {
    key: "attempts",
    label: "Attempts",
    hint: "How many times a request is sent at most, the first included; 3 by default. A request goes to another account at once when there is one.",
    min: minRetryAttempts,
    max: maxRetryAttempts,
  },
  {
    key: "delayMs",
    label: "First wait (milliseconds)",
    hint: "How long to wait before trying an account that failed again; 500 by default.",
    min: 0,
    max: maxRetryDelayMs,
  },
  {
    key: "multiplier",
    label: "Multiplier",
    hint: "Each wait is the one before times this; 2 by default.",
    min: 1,
    max: maxRetryMultiplier,
    step: 0.1,
  },
  {
    key: "circuitBreakerThreshold",
    label: "Failures before the circuit opens",
    hint: "An account that fails this many times in a row is given a rest; 5 by default.",
    min: 1,
    max: maxCircuitBreakerThreshold,
  },
  {
    key: "circuitBreakerCooldownSeconds",
    label: "Rest (seconds)",
    hint: "How long it rests before one request tries it again; 60 by default.",
    min: 1,
    max: maxCircuitBreakerCooldownSeconds,
  },
];

const numberOrUndefined = (value: string): number | undefined =>
  value.trim() === "" ? undefined : Number(value);

function RetriesForm({ settings }: { settings: GatewayRetrySettings }) {
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
    const parsed = gatewayRetrySettingsSchema.safeParse({
      attempts: numberOrUndefined(values.attempts),
      delayMs: numberOrUndefined(values.delayMs),
      multiplier: numberOrUndefined(values.multiplier),
      circuitBreakerThreshold: numberOrUndefined(
        values.circuitBreakerThreshold,
      ),
      circuitBreakerCooldownSeconds: numberOrUndefined(
        values.circuitBreakerCooldownSeconds,
      ),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/retries",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "Retries were not saved."],
      );
      return;
    }
    const updated = gatewayRetrySettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(retriesQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Retries"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ key, label, hint, min, max, step }) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`retries-${key}`}>{label}</Label>
            <Input
              id={`retries-${key}`}
              type="number"
              inputMode="decimal"
              min={min}
              max={max}
              step={step ?? 1}
              aria-describedby={`retries-${key}-hint`}
              {...register(key)}
            />
            <p
              id={`retries-${key}-hint`}
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
          Saved. It applies from the next request.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save retries"}
      </Button>
    </form>
  );
}

/**
 * How the AI Gateway retries requests, and when it rests a failing AI
 * Account (PRD FR-39).
 */
export function RetriesCard() {
  const { data: settings, isError } = useQuery(retriesQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Retries</h2>
        </CardTitle>
        <CardDescription>
          When an AI Account is rate-limited or overloaded, the AI Gateway
          leaves it alone until its AI Provider&apos;s reset and sends the
          request to the next account. When one fails, it tries again, waiting
          longer each time it goes back to an account it already tried; an
          account that keeps failing is rested. With nothing left it answers 429
          (rate-limited), 529 (overloaded) or 503 (no account).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Retries could not be loaded.
          </p>
        )}
        {settings !== undefined && <RetriesForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
