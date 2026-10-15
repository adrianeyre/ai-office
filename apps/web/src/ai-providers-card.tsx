import {
  aiProviderListSchema,
  catalogueRefreshSchema,
  setDefaultModelRequestSchema,
  type AiProviderEntry,
  type CatalogueRefresh,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

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

import { getJson, postJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// The AI Providers (PRD FR-15, FR-41): Claude, ChatGPT, Grok and Gemini,
// each with the agent tool it runs and its default Model, chosen from the
// AI Gateway's live model catalogue. The catalogue is each kind of AI
// Account's model list, fetched once a day and whenever the Owner asks.
// An AI Provider with no default Model cannot be used by any Agent. A
// Model the catalogue does not list (yet) can be typed in instead.

/** The AI Providers and their catalogues (`GET /api/ai-providers`). */
export const aiProvidersQuery = queryOptions({
  queryKey: ["ai-providers"],
  queryFn: async () =>
    (await getJson("/api/ai-providers", aiProviderListSchema)).aiProviders,
});

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** How a Model is offered: its name, and the AI Provider's for it. */
export const optionLabel = (model: AiProviderEntry["models"][number]): string =>
  [
    model.model,
    model.displayName !== null && model.displayName !== model.model
      ? model.displayName
      : undefined,
    model.contextWindow === null
      ? undefined
      : `${model.contextWindow.toLocaleString("en-US")} tokens`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/** The picker's choice that types a Model the catalogue does not list. */
const anotherModel = "__another__";

interface DefaultModelValues {
  /** A Model the catalogue lists, or `anotherModel`. */
  defaultModel: string;
  /** The Model typed in, when it is not one the catalogue lists. */
  typedModel: string;
}

/** One AI Provider: its agent tool, and its default Model to choose. */
function AiProviderForm({ provider }: { provider: AiProviderEntry }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const { aiProvider } = provider;
  const id = `ai-provider-${aiProvider.toLowerCase()}`;
  const listed = provider.models.some(
    ({ model }) => model === provider.defaultModel,
  );
  const picking = provider.models.length > 0;
  const initial: DefaultModelValues = {
    defaultModel:
      provider.defaultModel === null
        ? ""
        : listed || !picking
          ? provider.defaultModel
          : anotherModel,
    typedModel: listed ? "" : (provider.defaultModel ?? ""),
  };
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isDirty, isSubmitting },
  } = useForm<DefaultModelValues>({ defaultValues: initial });
  const picked = useWatch({ control, name: "defaultModel" });
  const typing = !picking || picked === anotherModel;

  const onSubmit = async (values: DefaultModelValues) => {
    setSaved(false);
    const parsed = setDefaultModelRequestSchema.safeParse({
      defaultModel: typing ? values.typedModel.trim() : values.defaultModel,
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      `/api/ai-providers/${encodeURIComponent(aiProvider)}`,
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The default Model was not saved."],
      );
      return;
    }
    setProblems([]);
    setSaved(true);
    reset(values);
    await queryClient.invalidateQueries(aiProvidersQuery);
  };

  return (
    <form
      noValidate
      aria-label={aiProvider}
      className="space-y-2 py-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{aiProvider}</h3>
        <p className="text-sm text-muted-foreground">
          Runs {provider.agentTool} in sandboxes ·{" "}
          {provider.catalogueFetchedAt === null
            ? "No Models fetched yet"
            : `${String(provider.models.length)} Models, fetched ${formatter.format(new Date(provider.catalogueFetchedAt))}`}
        </p>
      </div>
      {provider.defaultModel === null && (
        <p className="text-sm text-tone-warning-foreground">
          No default Model: no Agent can use {aiProvider} until you choose one.
        </p>
      )}
      {!picking && (
        <p className="text-sm text-muted-foreground">
          {provider.hasAccount !== true ? (
            <>
              The catalogue has no {aiProvider} Models yet. Add an AI Account
              for {aiProvider} and refresh the catalogue, or type the
              Model&apos;s name.
            </>
          ) : (provider.catalogueError ?? null) === null ? (
            <>
              The catalogue has no {aiProvider} Models yet: refresh the model
              catalogue to fetch them from your AI Account, or type the
              Model&apos;s name.
            </>
          ) : (
            <>
              Your {aiProvider} AI Account&apos;s Models could not be fetched (
              {provider.catalogueError}). Type the Model&apos;s name, or refresh
              the model catalogue to try again; if it still fails, sign in to
              the account again in AI Accounts.
            </>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {picking && (
          <div className="min-w-64 flex-1 space-y-1">
            <Label htmlFor={id}>Default Model</Label>
            <select
              id={id}
              className={selectClass}
              {...register("defaultModel")}
            >
              {provider.defaultModel === null && (
                <option value="">Choose a Model</option>
              )}
              {provider.models.map((model) => (
                <option key={model.model} value={model.model}>
                  {optionLabel(model)}
                </option>
              ))}
              <option value={anotherModel}>
                {provider.defaultModel !== null && !listed
                  ? `${provider.defaultModel} (not in the catalogue)`
                  : "Another Model, typed in"}
              </option>
            </select>
          </div>
        )}
        {typing && (
          <div className="min-w-64 flex-1 space-y-1">
            <Label htmlFor={`${id}-typed`}>
              {picking ? "Model name" : "Default Model"}
            </Label>
            <Input
              id={`${id}-typed`}
              autoComplete="off"
              spellCheck={false}
              placeholder="Its name, as the AI Provider gives it"
              {...register("typedModel")}
            />
          </div>
        )}
        <Button
          pending={isSubmitting}
          type="submit"
          size="sm"
          disabled={!isDirty || isSubmitting || session === undefined}
        >
          {isSubmitting ? "Saving…" : `Save ${aiProvider}'s default`}
        </Button>
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
          Saved. {aiProvider}&apos;s Agents use it from their next task, unless
          they choose their own.
        </p>
      )}
    </form>
  );
}

/** What a refresh did, as the Owner reads it. */
const refreshSummary = (report: CatalogueRefresh): string[] => [
  ...report.refreshed.map(
    ({ aiProvider, accountType, models }) =>
      `${aiProvider} (${accountType === "oauth" ? "subscription" : "API key"}): ${String(models)} Models.`,
  ),
  ...report.failed.map(
    ({ aiProvider, accountType, message }) =>
      `${aiProvider} (${accountType === "oauth" ? "subscription" : "API key"}) kept its last list: ${message}`,
  ),
];

/**
 * The AI Providers in the office admin (PRD FR-15), with the model
 * catalogue they choose their default Models from (FR-41).
 */
export function AiProvidersCard() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: providers, isError } = useQuery(aiProvidersQuery);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<string[]>();
  const [problem, setProblem] = useState<string>();

  const refresh = async () => {
    setRefreshing(true);
    setReport(undefined);
    setProblem(undefined);
    try {
      const response = await postJson(
        "/api/model-catalogue/refresh",
        {},
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblem(error.message ?? "The catalogue was not refreshed.");
        return;
      }
      const summary = refreshSummary(
        catalogueRefreshSchema.parse(await response.json()),
      );
      setReport(
        summary.length > 0
          ? summary
          : ["There is no AI Account to fetch Models with yet."],
      );
      await queryClient.invalidateQueries(aiProvidersQuery);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>AI Providers</h2>
        </CardTitle>
        <CardDescription>
          Each Agent uses one of these, through its agent tool, and its default
          Model unless the Agent chooses its own. Defaults are chosen from the
          model catalogue (the Models each kind of AI Account lists, fetched
          once a day and when you refresh it), or typed in when it does not list
          them. An AI Provider without a default Model cannot be used by any
          Agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            pending={refreshing}
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing || session === undefined}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden className="size-4" />
            {refreshing ? "Refreshing…" : "Refresh the model catalogue"}
          </Button>
        </div>
        {report !== undefined && (
          <ul
            role="status"
            aria-label="Catalogue refreshed"
            className="text-sm"
          >
            {report.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The AI Providers could not be loaded.
          </p>
        )}
        {providers !== undefined && (
          <div className="divide-y">
            {providers.map((provider) => (
              <AiProviderForm
                // A new default or catalogue starts the form afresh.
                key={`${provider.aiProvider}:${provider.defaultModel ?? ""}:${provider.catalogueFetchedAt ?? ""}`}
                provider={provider}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
