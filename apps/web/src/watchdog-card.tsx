import {
  aiProviders,
  defaultSandboxTimeLimitMinutes,
  defaultStallTimeoutMinutes,
  maxSandboxTimeLimitMinutes,
  maxStallTimeoutMinutes,
  minSandboxTimeLimitMinutes,
  minStallTimeoutMinutes,
  watchdogSettingsSchema,
  type WatchdogOverride,
  type WatchdogSettings,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";

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
import { selectClass } from "@/lib/utils.ts";

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// The watchdog's time limits (PRD FR-23, FR-22): how long work
// may show no progress before the Manager's watchdog stops it, and how
// long a sandbox may run in all, office-wide and for any AI Provider whose
// Agents need longer, such as a local one. Changes apply from the next
// watchdog check or sandbox start.

/** The watchdog's time limits (`GET /api/office/watchdog`). */
export const watchdogQuery = queryOptions({
  queryKey: ["office", "watchdog"],
  queryFn: () => getJson("/api/office/watchdog", watchdogSettingsSchema),
});

interface OverrideValues {
  aiProvider: string;
  stallTimeoutMinutes: string;
  sandboxTimeLimitMinutes: string;
}

interface FormValues {
  stallTimeoutMinutes: string;
  sandboxTimeLimitMinutes: string;
  providers: OverrideValues[];
}

const text = (value: number | undefined): string =>
  value === undefined ? "" : String(value);

const formValues = (settings: WatchdogSettings): FormValues => ({
  stallTimeoutMinutes: String(settings.stallTimeoutMinutes),
  sandboxTimeLimitMinutes: String(settings.sandboxTimeLimitMinutes),
  providers: Object.entries(settings.providers).map(([aiProvider, own]) => ({
    aiProvider,
    stallTimeoutMinutes: text(own.stallTimeoutMinutes),
    sandboxTimeLimitMinutes: text(own.sandboxTimeLimitMinutes),
  })),
});

const numberOrUndefined = (value: string): number | undefined =>
  value.trim() === "" ? undefined : Number(value);

/** The form's name for a field of the `index`th AI Provider's limits. */
const overrideField = <Field extends keyof OverrideValues>(
  index: number,
  field: Field,
) => `providers.${String(index)}.${field}` as `providers.${number}.${Field}`;

function WatchdogForm({ settings }: { settings: WatchdogSettings }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    control,
    register,
    handleSubmit,
    getValues,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: formValues(settings) });
  const overrides = useFieldArray({ control, name: "providers" });

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const chosen = values.providers.map(({ aiProvider }) => aiProvider);
    if (new Set(chosen).size !== chosen.length) {
      setProblems(["Give each AI Provider its own limits once."]);
      return;
    }
    // An AI Provider with neither limit of its own has the office's.
    const providers: Record<string, WatchdogOverride> = {};
    for (const row of values.providers) {
      const stall = numberOrUndefined(row.stallTimeoutMinutes);
      const sandbox = numberOrUndefined(row.sandboxTimeLimitMinutes);
      if (stall !== undefined || sandbox !== undefined) {
        providers[row.aiProvider] = {
          ...(stall === undefined ? {} : { stallTimeoutMinutes: stall }),
          ...(sandbox === undefined
            ? {}
            : { sandboxTimeLimitMinutes: sandbox }),
        };
      }
    }
    const parsed = watchdogSettingsSchema.safeParse({
      stallTimeoutMinutes: numberOrUndefined(values.stallTimeoutMinutes),
      sandboxTimeLimitMinutes: numberOrUndefined(
        values.sandboxTimeLimitMinutes,
      ),
      providers,
    });
    if (!parsed.success) {
      setProblems([
        ...new Set(parsed.error.issues.map(({ message }) => message)),
      ]);
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/watchdog",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "The watchdog's time limits were not saved.",
        ],
      );
      return;
    }
    const updated = watchdogSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(watchdogQuery.queryKey, updated);
  };

  /** The first AI Provider without limits of its own yet. */
  const unused = (): string | undefined => {
    const taken = new Set(
      getValues("providers").map(({ aiProvider }) => aiProvider),
    );
    return aiProviders.find((provider) => !taken.has(provider));
  };

  return (
    <form
      noValidate
      aria-label="Watchdog"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="watchdog-stall">Stall timeout (minutes)</Label>
          <Input
            id="watchdog-stall"
            type="number"
            inputMode="numeric"
            min={minStallTimeoutMinutes}
            max={maxStallTimeoutMinutes}
            aria-describedby="watchdog-stall-hint"
            {...register("stallTimeoutMinutes")}
          />
          <p id="watchdog-stall-hint" className="text-xs text-muted-foreground">
            How long work may show no progress before it is stopped and retried;
            the third stall hands the issue to you.{" "}
            {String(defaultStallTimeoutMinutes)} by default, from{" "}
            {String(minStallTimeoutMinutes)} to {String(maxStallTimeoutMinutes)}
            .
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="watchdog-sandbox">Sandbox time limit (minutes)</Label>
          <Input
            id="watchdog-sandbox"
            type="number"
            inputMode="numeric"
            min={minSandboxTimeLimitMinutes}
            max={maxSandboxTimeLimitMinutes}
            aria-describedby="watchdog-sandbox-hint"
            {...register("sandboxTimeLimitMinutes")}
          />
          <p
            id="watchdog-sandbox-hint"
            className="text-xs text-muted-foreground"
          >
            How long a sandbox may run in all before it is killed.{" "}
            {String(defaultSandboxTimeLimitMinutes)} by default, from{" "}
            {String(minSandboxTimeLimitMinutes)} to{" "}
            {String(maxSandboxTimeLimitMinutes)}.
          </p>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          AI Providers&apos; own limits
        </legend>
        <p className="text-xs text-muted-foreground">
          For the Agents of a slower AI Provider, such as a local Ollama. A
          limit left empty is the office&apos;s.
        </p>
        <ul className="space-y-2">
          {overrides.fields.map((field, index) => {
            const number = String(index + 1);
            return (
              <li
                key={field.id}
                aria-label={`AI Provider limits ${number}`}
                className="flex flex-wrap items-end gap-2 rounded-md border p-2"
              >
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor={`watchdog-${number}-provider`}>
                    AI Provider {number}
                  </Label>
                  <select
                    id={`watchdog-${number}-provider`}
                    className={selectClass}
                    {...register(overrideField(index, "aiProvider"))}
                  >
                    {aiProviders.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-32 flex-1 space-y-1">
                  <Label htmlFor={`watchdog-${number}-stall`}>
                    Stall timeout {number} (minutes)
                  </Label>
                  <Input
                    id={`watchdog-${number}-stall`}
                    type="number"
                    inputMode="numeric"
                    min={minStallTimeoutMinutes}
                    max={maxStallTimeoutMinutes}
                    placeholder="The office's"
                    {...register(overrideField(index, "stallTimeoutMinutes"))}
                  />
                </div>
                <div className="min-w-32 flex-1 space-y-1">
                  <Label htmlFor={`watchdog-${number}-sandbox`}>
                    Sandbox time limit {number} (minutes)
                  </Label>
                  <Input
                    id={`watchdog-${number}-sandbox`}
                    type="number"
                    inputMode="numeric"
                    min={minSandboxTimeLimitMinutes}
                    max={maxSandboxTimeLimitMinutes}
                    placeholder="The office's"
                    {...register(
                      overrideField(index, "sandboxTimeLimitMinutes"),
                    )}
                  />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={`Remove AI Provider limits ${number}`}
                  onClick={() => {
                    overrides.remove(index);
                  }}
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={overrides.fields.length >= aiProviders.length}
          onClick={() => {
            overrides.append({
              aiProvider: unused() ?? aiProviders[0],
              stallTimeoutMinutes: "",
              sandboxTimeLimitMinutes: "",
            });
          }}
        >
          <Plus aria-hidden />
          Add an AI Provider&apos;s limits
        </Button>
      </fieldset>
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
          Saved. It applies from the next watchdog check or sandbox start.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save watchdog"}
      </Button>
    </form>
  );
}

/**
 * The watchdog's time limits (PRD FR-23, FR-22): the stall timeout and the
 * sandbox time limit, office-wide and per AI Provider.
 */
export function WatchdogCard() {
  const { data: settings, isError } = useQuery(watchdogQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Watchdog</h2>
        </CardTitle>
        <CardDescription>
          Each Floor&apos;s Manager stops work that shows no progress for the
          stall timeout and gives it to another Agent, or queues it again; the
          third stall at a stage labels the issue needs-human. A sandbox still
          running at its time limit is killed. Give a slower AI Provider longer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The watchdog&apos;s time limits could not be loaded.
          </p>
        )}
        {settings !== undefined && <WatchdogForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
