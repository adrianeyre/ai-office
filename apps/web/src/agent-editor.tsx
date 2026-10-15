import {
  agentSchema,
  aiProviders,
  anyAiProvider,
  effortsOf,
  floorSchema,
  floorSettingsUpdateSchema,
  pronounsOf,
  updateAgentRequestSchema,
  type Agent,
  type Floor,
  type UpdateAgentRequest,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { selectClass } from "@/lib/utils.ts";

import { aiProvidersQuery, optionLabel } from "./ai-providers-card.tsx";
import { readApiError, sendJson } from "./api.ts";
import { agentsQuery, floorQuery, floorsQuery } from "./floors.ts";
import { sessionQuery } from "./session.ts";
import {
  capOf,
  capUseText,
  capValue,
  floorTokenUsageQuery,
  levelLabels,
} from "./token-caps.tsx";

// The Agent editor in Agent Settings (PRD FR-11, FR-12): an Agent's name,
// AI Provider (one, or any AI Provider: whichever is available when a task
// starts), Model (from the catalogue, or its AI Provider's default),
// effort where the agent tool takes one, extra instructions, its Token
// Caps and Fresh Start threshold, whether it is enabled or paused, and,
// for a reviewer, whether its Floor requires its approval (FR-27). Changes
// apply from the Agent's next task. The UI's pronouns for it follow its
// Avatar's presentation (FR-14).

interface FormValues {
  name: string;
  /** One of `aiProviders`, or `anyAiProvider`. */
  aiProvider: string;
  /** Empty for the AI Provider's default Model. */
  modelOverride: string;
  /** Empty for the agent tool's default. */
  effort: string;
  extraInstructions: string;
  status: "enabled" | "paused";
  /** Empty for its Floor's or the office's cap. */
  dailyTokenCap: string;
  monthlyTokenCap: string;
  /** Empty for its Floor's. */
  freshStartThreshold: string;
  /** Whether every Review Loop round needs its approval; reviewers only. */
  requiredReviewer: boolean;
}

/** Whether `floor` requires `agent`'s approval in every review round. */
const requires = (floor: Floor | undefined, agent: Agent): boolean =>
  floor?.requiredReviewerAgentIds.includes(agent.id) ?? false;

const formValues = (agent: Agent, floor: Floor | undefined): FormValues => ({
  name: agent.name,
  aiProvider: agent.aiProvider,
  modelOverride: agent.modelOverride ?? "",
  effort: agent.effort ?? "",
  extraInstructions: agent.extraInstructions,
  status: agent.enabled ? "enabled" : "paused",
  dailyTokenCap: capValue(agent.tokenCaps.daily),
  monthlyTokenCap: capValue(agent.tokenCaps.monthly),
  freshStartThreshold: capValue(agent.freshStartThreshold),
  requiredReviewer: requires(floor, agent),
});

/** The Floor's required reviewers with `agent` added or taken away. */
const requiredReviewersOf = (
  floor: Floor,
  agent: Agent,
  required: boolean,
): string[] => {
  const others = floor.requiredReviewerAgentIds.filter((id) => id !== agent.id);
  return required ? [...others, agent.id] : others;
};

/** What the form changes in `agent`, as the API takes it. */
function changesOf(agent: Agent, values: FormValues): Record<string, unknown> {
  const next = {
    name: values.name,
    aiProvider: values.aiProvider,
    modelOverride: values.modelOverride === "" ? null : values.modelOverride,
    effort: values.effort === "" ? null : values.effort,
    extraInstructions: values.extraInstructions,
    enabled: values.status === "enabled",
    freshStartThreshold: capOf(values.freshStartThreshold),
  };
  const tokenCaps = {
    daily: capOf(values.dailyTokenCap),
    monthly: capOf(values.monthlyTokenCap),
  };
  return {
    ...Object.fromEntries(
      Object.entries(next).filter(
        ([key, value]) => agent[key as keyof typeof next] !== value,
      ),
    ),
    ...(tokenCaps.daily === agent.tokenCaps.daily &&
    tokenCaps.monthly === agent.tokenCaps.monthly
      ? {}
      : { tokenCaps }),
  };
}

/**
 * Edits one Agent's config; `onClose`, when given, offers a Close button
 * that puts the editor away.
 */
export function AgentEditor({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose?: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: providers } = useQuery(aiProvidersQuery);
  const { data: floor } = useQuery(floorQuery(agent.floorId));
  const { data: tokenUsage } = useQuery(floorTokenUsageQuery(agent.floorId));
  const capUse = tokenUsage?.agents.find(
    ({ agentId }) => agentId === agent.id,
  )?.caps;
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    resetField,
    getFieldState,
    control,
    setValue,
    formState: { isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: formValues(agent, floor) });
  const pronouns = pronounsOf(agent.avatar);
  // Unique to this editor: Agent Settings may show two for one Agent, its
  // tab's and the Agents table's.
  const editor = useId();
  const id = (field: string) => `agent-${agent.id}-${editor}-${field}`;
  // Only a reviewer can be a required reviewer (FR-27).
  const reviewer = agent.stage === "review" && agent.leavingAt === null;
  // The Floor may load after the form, or change while it is open.
  const required = requires(floor, agent);
  useEffect(() => {
    if (!getFieldState("requiredReviewer").isDirty) {
      resetField("requiredReviewer", { defaultValue: required });
    }
  }, [required, getFieldState, resetField]);

  const aiProvider = useWatch({ control, name: "aiProvider" });
  const modelOverride = useWatch({ control, name: "modelOverride" });
  // On any AI Provider it takes whichever one's default Model and effort.
  const anyOne = aiProvider === anyAiProvider;
  const provider = providers?.find((entry) => entry.aiProvider === aiProvider);
  /** The AI Providers not offered yet: they have no default Model. */
  const withoutDefault = aiProviders.filter(
    (name) =>
      name !== agent.aiProvider &&
      providers?.find((entry) => entry.aiProvider === name)?.defaultModel ==
        null,
  );
  const models = provider?.models ?? [];
  const efforts = effortsOf(aiProvider);
  // A Model chosen before it left the catalogue stays until changed.
  const unlisted =
    modelOverride !== "" &&
    !models.some(({ model }) => model === modelOverride);
  const providerField = register("aiProvider");

  /** Saves the Agent's own settings; false, with the problems, if not. */
  const saveAgent = async (values: FormValues): Promise<Agent | false> => {
    const changes = changesOf(agent, values);
    if (Object.keys(changes).length === 0) {
      return agent;
    }
    const parsed = updateAgentRequestSchema.safeParse(changes);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return false;
    }
    const request: UpdateAgentRequest = parsed.data;
    const response = await sendJson(
      "PATCH",
      `/api/floors/${encodeURIComponent(agent.floorId)}/agents/${encodeURIComponent(agent.id)}`,
      request,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The changes were not saved."],
      );
      return false;
    }
    return agentSchema.parse(await response.json());
  };

  /** Saves whether the Floor requires its approval; the Floor, or false. */
  const saveRequired = async (
    values: FormValues,
  ): Promise<Floor | undefined | false> => {
    if (floor === undefined || values.requiredReviewer === required) {
      return floor;
    }
    const parsed = floorSettingsUpdateSchema.safeParse({
      requiredReviewerAgentIds: requiredReviewersOf(
        floor,
        agent,
        values.requiredReviewer,
      ),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return false;
    }
    const response = await sendJson(
      "PATCH",
      `/api/floors/${encodeURIComponent(floor.id)}`,
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "The required reviewers were not saved.",
        ],
      );
      return false;
    }
    return floorSchema.parse(await response.json());
  };

  const onSubmit = async (values: FormValues) => {
    setSaved(undefined);
    const updated = await saveAgent(values);
    if (updated === false) {
      return;
    }
    const floorNow = await saveRequired(values);
    if (floorNow !== false) {
      setProblems([]);
      setSaved(
        `Saved. ${updated.name} uses the changes from ${pronouns.possessive} next task.`,
      );
    }
    reset(formValues(updated, floorNow === false ? floor : floorNow));
    if (floorNow === false) {
      // Its own settings were saved; the change that was not stays to retry.
      setValue("requiredReviewer", values.requiredReviewer, {
        shouldDirty: true,
      });
    }
    await Promise.all([
      queryClient.invalidateQueries(agentsQuery(agent.floorId)),
      queryClient.invalidateQueries(floorTokenUsageQuery(agent.floorId)),
      ...(floorNow === false || floorNow === floor
        ? []
        : [
            queryClient.invalidateQueries(floorQuery(agent.floorId)),
            queryClient.invalidateQueries(floorsQuery),
          ]),
    ]);
  };

  return (
    <form
      noValidate
      aria-label={`Edit ${agent.name}`}
      className="mt-4 space-y-4 rounded-md border p-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="space-y-1">
        <h3 className="font-medium">Edit {agent.name}</h3>
        <p className="text-sm text-muted-foreground">
          Changes apply from {pronouns.possessive} next task; work{" "}
          {pronouns.subject} has started carries on as it began.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("name")}>Name</Label>
          <Input id={id("name")} autoComplete="off" {...register("name")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("status")}>Status</Label>
          <select
            id={id("status")}
            className={selectClass}
            aria-describedby={id("status-hint")}
            {...register("status")}
          >
            <option value="enabled">Enabled</option>
            <option value="paused">Paused</option>
          </select>
          <p id={id("status-hint")} className="text-xs text-muted-foreground">
            While paused, no new work goes to {pronouns.object}.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("ai-provider")}>AI Provider</Label>
          <select
            id={id("ai-provider")}
            className={selectClass}
            aria-describedby={id("ai-provider-hint")}
            {...providerField}
            onChange={(event) => {
              void providerField.onChange(event);
              // Another AI Provider's Model and effort mean nothing here.
              setValue("modelOverride", "", { shouldDirty: true });
              setValue("effort", "", { shouldDirty: true });
            }}
          >
            <option value={anyAiProvider}>{anyAiProvider}</option>
            {aiProviders.map((name) => {
              const entry = providers?.find(
                (candidate) => candidate.aiProvider === name,
              );
              const usable =
                name === agent.aiProvider || entry?.defaultModel != null;
              return (
                <option key={name} value={name} disabled={!usable}>
                  {usable ? name : `${name} (no default Model yet)`}
                </option>
              );
            })}
          </select>
          <p
            id={id("ai-provider-hint")}
            className="text-xs text-muted-foreground"
          >
            {anyOne
              ? `${agent.name} uses whichever is available when a task starts: the AI Provider of the first AI Account, by priority, that is not paused or held back and whose AI Provider has a default Model, with that default Model and effort.`
              : `${agent.name} uses this AI Provider for every task. ${anyAiProvider} lets ${pronouns.object} use whichever is available.`}
            {withoutDefault.length > 0 && (
              <>
                {" "}
                An AI Provider is offered once it has a default Model. One with
                an AI Account gets the first Model its account lists; choose
                another, or one for the rest, in{" "}
                <Link
                  to="/ai-settings"
                  className="underline underline-offset-4"
                >
                  AI Settings
                </Link>
                .
              </>
            )}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("model")}>Model</Label>
          <select
            id={id("model")}
            className={selectClass}
            disabled={anyOne}
            {...register("modelOverride")}
          >
            <option value="">
              {anyOne
                ? "The default of whichever AI Provider it is given"
                : provider?.defaultModel == null
                  ? "Its AI Provider's default"
                  : `Default (${provider.defaultModel})`}
            </option>
            {unlisted && (
              <option value={modelOverride}>
                {modelOverride} (not in the catalogue)
              </option>
            )}
            {models.map((model) => (
              <option key={model.model} value={model.model}>
                {optionLabel(model)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("effort")}>Effort</Label>
          <select
            id={id("effort")}
            className={selectClass}
            disabled={efforts.length === 0}
            aria-describedby={id("effort-hint")}
            {...register("effort")}
          >
            <option value="">Default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
          <p id={id("effort-hint")} className="text-xs text-muted-foreground">
            {anyOne
              ? "The agent tool's default, whichever AI Provider it is given."
              : efforts.length === 0
                ? `${aiProvider}'s agent tool takes no effort level.`
                : "How hard the agent tool thinks, where it lets you choose."}
          </p>
        </div>
        {reviewer && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                id={id("required-reviewer")}
                type="checkbox"
                className="size-4"
                aria-describedby={id("required-reviewer-hint")}
                disabled={floor === undefined}
                {...register("requiredReviewer")}
              />
              <Label htmlFor={id("required-reviewer")}>Required reviewer</Label>
            </div>
            <p
              id={id("required-reviewer-hint")}
              className="text-xs text-muted-foreground"
            >
              Every round of the Review Loop needs {pronouns.possessive}{" "}
              approval. The Floor always has at least one.
            </p>
          </div>
        )}
        {(["daily", "monthly"] as const).map((period) => {
          const use = capUse?.[period];
          const field =
            period === "daily" ? "dailyTokenCap" : "monthlyTokenCap";
          return (
            <div key={period} className="space-y-2">
              <Label htmlFor={id(`${period}-token-cap`)}>
                {period === "daily" ? "Daily Token Cap" : "Monthly Token Cap"}
              </Label>
              <Input
                id={id(`${period}-token-cap`)}
                type="number"
                inputMode="numeric"
                min={1}
                aria-describedby={id(`${period}-token-cap-hint`)}
                {...register(field)}
              />
              <p
                id={id(`${period}-token-cap-hint`)}
                className="text-xs text-muted-foreground"
              >
                {use === undefined
                  ? "Empty uses the Floor's or the office's."
                  : `Used ${period === "daily" ? "today" : "this month"}: ${capUseText(use)}, ${levelLabels[use.level]} cap. Empty uses the Floor's or the office's.`}
              </p>
            </div>
          );
        })}
        <div className="space-y-2">
          <Label htmlFor={id("fresh-start-threshold")}>
            Fresh Start threshold (%)
          </Label>
          <Input
            id={id("fresh-start-threshold")}
            type="number"
            inputMode="numeric"
            min={10}
            max={100}
            aria-describedby={id("fresh-start-threshold-hint")}
            {...register("freshStartThreshold")}
          />
          <p
            id={id("fresh-start-threshold-hint")}
            className="text-xs text-muted-foreground"
          >
            The Context Usage at which a Fresh Start ends the session and begins
            a new one from a summary. Empty uses the Floor&apos;s.
          </p>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={id("extra-instructions")}>Extra instructions</Label>
          <textarea
            id={id("extra-instructions")}
            rows={4}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            aria-describedby={id("extra-instructions-hint")}
            {...register("extraInstructions")}
          />
          <p
            id={id("extra-instructions-hint")}
            className="text-xs text-muted-foreground"
          >
            Added to {pronouns.possessive} prompt for every task. Never put a
            credential here.
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
      {saved !== undefined && !isDirty && (
        <p role="status" className="text-sm">
          {saved}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          pending={isSubmitting}
          type="submit"
          disabled={!isDirty || isSubmitting || session === undefined}
        >
          {isSubmitting ? "Saving…" : `Save ${agent.name}`}
        </Button>
        {onClose !== undefined && (
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </form>
  );
}
