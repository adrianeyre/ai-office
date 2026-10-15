import { floorSchema } from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Label } from "@/components/ui/label.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { readApiError, sendJson } from "./api.ts";
import { floorQuery, floorsQuery } from "./floors.ts";
import { sessionQuery } from "./session.ts";

// A Floor's hourly Status updates (PRD FR-23a): while its Agents work, it
// gives a Status update each hour, unless the Owner turns it off. The Floor
// admin edits it with the Floor's other settings; this switch saves it on
// its own, wherever else the Office offers it.

/** The setting's label, wherever it is edited. */
export const hourlyStatusUpdatesLabel =
  "Hourly Status updates while Agents work";

/** What the setting does, wherever it is edited. */
export const hourlyStatusUpdatesHint =
  "Each hour that this Floor's Agents are working, the Floor gathers and each says what it did in the last hour. Off, only yours and the day's own.";

/**
 * The Floor's hourly Status updates, on or off: a labelled switch that
 * saves the setting as soon as it is changed, saying while it saves and
 * when it could not.
 */
export function HourlyStatusUpdatesSwitch({
  floorId,
  className,
}: {
  floorId: string;
  className?: string;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: floor } = useQuery(floorQuery(floorId));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();

  const save = async (on: boolean) => {
    setSaving(true);
    setProblem(undefined);
    try {
      const response = await sendJson(
        "PATCH",
        `/api/floors/${encodeURIComponent(floorId)}`,
        { hourlyStatusUpdates: on },
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblem(
          error.problems?.join(" ") ??
            error.message ??
            "The setting was not saved.",
        );
        return;
      }
      const updated = floorSchema.parse(await response.json());
      queryClient.setQueryData(floorQuery(floorId).queryKey, updated);
      await queryClient.invalidateQueries(floorsQuery);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="size-4"
          checked={floor?.hourlyStatusUpdates ?? false}
          disabled={floor?.archivedAt !== null || saving}
          aria-busy={saving}
          aria-describedby={`${id}-hint`}
          onChange={(event) => void save(event.target.checked)}
        />
        <Label htmlFor={id}>{hourlyStatusUpdatesLabel}</Label>
        {saving && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Saving…
          </span>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hourlyStatusUpdatesHint}
      </p>
      {problem !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
