import {
  maxPromptBudget,
  promptBudgetSettingsSchema,
  type PromptBudgetSettings,
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

// Prompt budgets: the most characters of each memory and of the Skills
// listing an Agent's prompt carries, so that on a small context window
// they do not crowd out the issue and the diff. Changes apply from the
// next task.

/** The prompt budgets (`GET /api/office/prompt-budget`). */
export const promptBudgetQuery = queryOptions({
  queryKey: ["office", "prompt-budget"],
  queryFn: () =>
    getJson("/api/office/prompt-budget", promptBudgetSettingsSchema),
});

type FormValues = Record<keyof PromptBudgetSettings, string>;

const formValues = (settings: PromptBudgetSettings): FormValues => ({
  repositoryMemory: String(settings.repositoryMemory),
  officeMemory: String(settings.officeMemory),
  roleMemory: String(settings.roleMemory),
  skills: String(settings.skills),
});

/** Each field: its label and what it does. */
const fields: readonly {
  readonly key: keyof PromptBudgetSettings;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    key: "repositoryMemory",
    label: "Repository memory (characters)",
    hint: "The most of the repository's .agents/MEMORY.md a prompt quotes, from its start; 12,000 by default.",
  },
  {
    key: "officeMemory",
    label: "Office-wide memory (characters)",
    hint: "The most of the office-wide memory an Agent is given, from its start; 12,000 by default.",
  },
  {
    key: "roleMemory",
    label: "Role memory (characters)",
    hint: "The most of a Role's memory an Agent is given, its newest entries first; 12,000 by default.",
  },
  {
    key: "skills",
    label: "Skills listing (characters)",
    hint: "The most of the Floor's Skills, by name and description, an Agent is given, in order; 40,000 by default.",
  },
];

const numberOrUndefined = (value: string): number | undefined =>
  value.trim() === "" ? undefined : Number(value);

function PromptBudgetForm({ settings }: { settings: PromptBudgetSettings }) {
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
    const parsed = promptBudgetSettingsSchema.safeParse({
      repositoryMemory: numberOrUndefined(values.repositoryMemory),
      officeMemory: numberOrUndefined(values.officeMemory),
      roleMemory: numberOrUndefined(values.roleMemory),
      skills: numberOrUndefined(values.skills),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/prompt-budget",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "The prompt budgets were not saved.",
        ],
      );
      return;
    }
    const updated = promptBudgetSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(promptBudgetQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Prompt budgets"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ key, label, hint }) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`prompt-budget-${key}`}>{label}</Label>
            <Input
              id={`prompt-budget-${key}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={maxPromptBudget}
              step={1}
              aria-describedby={`prompt-budget-${key}-hint`}
              {...register(key)}
            />
            <p
              id={`prompt-budget-${key}-hint`}
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
          Saved. It applies from the next task.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save prompt budgets"}
      </Button>
    </form>
  );
}

/**
 * How much of each memory and of the Skills listing an Agent's prompt
 * carries at most.
 */
export function PromptBudgetCard() {
  const { data: settings, isError } = useQuery(promptBudgetQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Prompt budgets</h2>
        </CardTitle>
        <CardDescription>
          The most of the repository&apos;s memory, the office-wide memory, a
          Role&apos;s memory and the Floor&apos;s Skills an Agent&apos;s prompt
          carries. What is over its budget is left out, and the prompt says so.
          On a Model with a small context window each budget is lower still: a
          twentieth of the window for each memory, a tenth for the Skills.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The prompt budgets could not be loaded.
          </p>
        )}
        {settings !== undefined && <PromptBudgetForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
