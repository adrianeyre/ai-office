import {
  decisionModelSettingsSchema,
  defaultDecisionModel,
  type DecisionModelSettings,
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

// The Decision Model (PRD FR-17, FR-89): whether the Managers and safety
// checks ask Jev for their quick judgements, which of Jev's Models, and
// whether it writes Fresh Start and compaction summaries. Jev is reached
// through the AI Gateway from an OpenRouter AI Account. Changes apply at
// once.

/** The Decision Model's settings (`GET /api/office/decision-model`). */
export const decisionModelQuery = queryOptions({
  queryKey: ["office", "decision-model"],
  queryFn: () =>
    getJson("/api/office/decision-model", decisionModelSettingsSchema),
});

function DecisionModelForm({ settings }: { settings: DecisionModelSettings }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<DecisionModelSettings>({ defaultValues: settings });

  const onSubmit = async (values: DecisionModelSettings) => {
    setSaved(false);
    const parsed = decisionModelSettingsSchema.safeParse(values);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/decision-model",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "The Decision Model was not saved.",
        ],
      );
      return;
    }
    const updated = decisionModelSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(updated);
    queryClient.setQueryData(decisionModelQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Decision Model"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="decision-model-enabled-hint"
          {...register("enabled")}
        />
        <span>
          <span className="font-medium">Use Jev as the Decision Model</span>
          <span
            id="decision-model-enabled-hint"
            className="block text-muted-foreground"
          >
            Managers ask it whether an issue is clear enough to work and whether
            a Review Loop is stalled or repeating, and it screens every tool
            call an Agent makes in its sandbox, stopping the Agent at one it
            judges unsafe. Off, the Manager&apos;s own Model and AI
            Office&apos;s rules judge, and tool calls are not screened.
          </span>
        </span>
      </label>
      <div className="space-y-2">
        <Label htmlFor="decision-model-model">Jev&apos;s Model</Label>
        <Input
          id="decision-model-model"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="decision-model-model-hint"
          {...register("model")}
        />
        <p
          id="decision-model-model-hint"
          className="text-xs text-muted-foreground"
        >
          As OpenRouter names it: {defaultDecisionModel} by default, or
          ~typesafe/jev-latest for the newest. It needs an OpenRouter AI
          Account; its calls are the Manager&apos;s, and count against its Token
          Caps.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="decision-model-summaries-hint"
          {...register("summaries")}
        />
        <span>
          <span className="font-medium">Have it write summaries</span>
          <span
            id="decision-model-summaries-hint"
            className="block text-muted-foreground"
          >
            While it is on, the Decision Model writes Fresh Start and Manager
            chat compaction summaries in place of each Agent&apos;s own Model.
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
          Saved. It applies at once.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save Decision Model"}
      </Button>
    </form>
  );
}

/**
 * The Decision Model (PRD FR-17): off until the Owner turns it on. It is
 * never an Agent's AI Provider.
 */
export function DecisionModelCard() {
  const { data: settings, isError } = useQuery(decisionModelQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Decision Model</h2>
        </CardTitle>
        <CardDescription>
          Jev, TypeSafe&apos;s fast decision model, answers typed questions in
          well under a second for a fraction of a chat model&apos;s price. It is
          used only for Managers&apos; and safety checks&apos; quick judgements,
          and is never an Agent&apos;s AI Provider. Its calls show in Gateway
          requests and Analytics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The Decision Model could not be loaded.
          </p>
        )}
        {settings !== undefined && <DecisionModelForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
