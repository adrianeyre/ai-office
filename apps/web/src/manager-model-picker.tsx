import {
  agentSchema,
  anyAiProvider,
  effortsOf,
  type ManagerChat,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Label } from "@/components/ui/label.tsx";
import { selectClass } from "@/lib/utils.ts";

import { aiProvidersQuery, optionLabel } from "./ai-providers-card.tsx";
import { readApiError, sendJson } from "./api.ts";
import { agentsQuery } from "./floors.ts";
import { sessionQuery } from "./session.ts";

// The Manager's Model and effort, chosen in its chat's header (PRD FR-24,
// ADR 0004), as Claude Code lets a session choose its own: from its AI
// Provider's catalogue and the efforts its agent tool takes, as the Agent
// editor offers them (FR-11). Each change is saved at once, as the
// Manager's own setting; it is never a Token Cap change.

export function ManagerModelPicker({
  floorId,
  managerId,
  chatQueryKey,
}: {
  floorId: string;
  managerId: string;
  /** The chat's query, whose header names the Manager's Model. */
  chatQueryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: agents } = useQuery(agentsQuery(floorId));
  const { data: providers } = useQuery(aiProvidersQuery);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const modelId = useId();
  const effortId = useId();
  const hintId = useId();
  const manager = agents?.find(({ id }) => id === managerId);
  if (manager === undefined) {
    return null;
  }
  // On any AI Provider it takes whichever one's default Model and effort.
  if (manager.aiProvider === anyAiProvider) {
    return (
      <p className="text-xs text-muted-foreground">
        {manager.name} is on {anyAiProvider}: each message uses the default
        Model of whichever is available. Choose one AI Provider in Agent
        Settings to choose {manager.name}&apos;s Model.
      </p>
    );
  }
  const provider = providers?.find(
    ({ aiProvider }) => aiProvider === manager.aiProvider,
  );
  const models = provider?.models ?? [];
  const efforts = effortsOf(manager.aiProvider);
  const modelOverride = manager.modelOverride ?? "";
  const unlisted =
    modelOverride !== "" &&
    !models.some(({ model }) => model === modelOverride);

  const save = async (change: {
    modelOverride?: string | null;
    effort?: string | null;
  }) => {
    setSaving(true);
    setSaid(undefined);
    try {
      const response = await sendJson(
        "PATCH",
        `/api/floors/${encodeURIComponent(floorId)}/agents/${encodeURIComponent(managerId)}`,
        change,
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setSaid({
          ok: false,
          text:
            error.problems?.join(" ") ??
            error.message ??
            "The change was not saved.",
        });
        return;
      }
      const updated = agentSchema.parse(await response.json());
      queryClient.setQueryData(agentsQuery(floorId).queryKey, (now) =>
        now?.map((agent) => (agent.id === updated.id ? updated : agent)),
      );
      queryClient.setQueryData<ManagerChat>(chatQueryKey, (chat) =>
        chat === undefined
          ? chat
          : { ...chat, manager: { ...chat.manager, model: updated.model } },
      );
      setSaid({
        ok: true,
        text: `Saved. ${updated.name} answers with ${updated.model}${updated.effort === null ? "" : ` at ${updated.effort} effort`} from the next message.`,
      });
    } catch {
      setSaid({
        ok: false,
        text: "AI Office could not be reached. Try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={`${manager.name}'s Model and effort`}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="space-y-1">
        <Label htmlFor={modelId} className="text-xs">
          Model
        </Label>
        <select
          id={modelId}
          className={selectClass}
          value={modelOverride}
          disabled={saving || session === undefined}
          aria-describedby={hintId}
          onChange={(event) => {
            const value = event.target.value;
            void save({ modelOverride: value === "" ? null : value });
          }}
        >
          <option value="">
            {provider?.defaultModel == null
              ? `${manager.aiProvider}'s default`
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
      <div className="space-y-1">
        <Label htmlFor={effortId} className="text-xs">
          Effort
        </Label>
        <select
          id={effortId}
          className={selectClass}
          value={manager.effort ?? ""}
          disabled={saving || session === undefined || efforts.length === 0}
          aria-describedby={hintId}
          onChange={(event) => {
            const value = event.target.value;
            void save({ effort: value === "" ? null : value });
          }}
        >
          <option value="">Default</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </div>
      <p id={hintId} className="basis-full text-xs text-muted-foreground">
        {manager.name}&apos;s own setting, as in the Agent editor: it applies
        from the next message and changes no Token Cap.
        {efforts.length === 0 &&
          ` ${manager.aiProvider}'s agent tool takes no effort level.`}
      </p>
      {said !== undefined && (
        <p
          role={said.ok ? "status" : "alert"}
          className={
            said.ok
              ? "basis-full text-xs text-muted-foreground"
              : "basis-full text-sm text-destructive"
          }
        >
          {said.text}
        </p>
      )}
    </div>
  );
}
