import {
  maxSandboxConcurrencyLimit,
  sandboxSettingsSchema,
  type SandboxSettings,
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

/** The office-wide sandbox limit (`GET /api/office/sandboxes`). */
export const sandboxesQuery = queryOptions({
  queryKey: ["office", "sandboxes"],
  queryFn: () => getJson("/api/office/sandboxes", sandboxSettingsSchema),
});

interface FormValues {
  concurrencyLimit: string;
}

const formValues = (settings: SandboxSettings): FormValues => ({
  concurrencyLimit: String(settings.concurrencyLimit),
});

function SandboxesForm({ settings }: { settings: SandboxSettings }) {
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
    const parsed = sandboxSettingsSchema.safeParse({
      concurrencyLimit:
        values.concurrencyLimit.trim() === ""
          ? undefined
          : Number(values.concurrencyLimit),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/sandboxes",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The sandbox limit was not saved."],
      );
      return;
    }
    const updated = sandboxSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(sandboxesQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Sandboxes"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="space-y-2 sm:max-w-xs">
        <Label htmlFor="sandboxes-limit">Sandboxes at once</Label>
        <Input
          id="sandboxes-limit"
          type="number"
          inputMode="numeric"
          min={1}
          max={maxSandboxConcurrencyLimit}
          {...register("concurrencyLimit")}
        />
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
          Saved.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save sandbox limit"}
      </Button>
    </form>
  );
}

/**
 * How many sandboxes may run at once, office-wide (PRD FR-22). Work beyond
 * the limit waits in the queue.
 */
export function SandboxesCard() {
  const { data: settings, isError } = useQuery(sandboxesQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Sandboxes</h2>
        </CardTitle>
        <CardDescription>
          Coder, QA and docs Agents each work in a sandbox. When this many are
          running, further work waits in the queue and starts as one frees up,
          higher-priority Floors first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The sandbox limit could not be loaded.
          </p>
        )}
        {settings !== undefined && <SandboxesForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
