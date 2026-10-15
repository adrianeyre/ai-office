import {
  floorActivitiesSchema,
  setFloorActivitiesRequestSchema,
  type Floor,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { selectClass } from "@/lib/utils.ts";

import { getJson, readApiError, sendJson } from "./api.ts";
import { floorsQuery } from "./floors.ts";
import {
  idleActivities,
  type IdleActivity,
  type IdleLocation,
  type IdleWhen,
} from "./scene/idle-behaviours.ts";
import { sessionQuery } from "./session.ts";

// Agent activities in Agent Settings: every idle activity an Agent may do in
// the 3D Office when it has no work (PRD FR-61), where, what it looks like
// and when, and which a Floor has turned off. An Agent never does one that
// its Floor has turned off; work always comes first.

/** The idle activities turned off, by Floor id (`GET /api/office/activities`). */
export const floorActivitiesQuery = queryOptions({
  queryKey: ["office", "activities"],
  queryFn: async () =>
    (await getJson("/api/office/activities", floorActivitiesSchema)).disabled,
});

const placeNames: Partial<Record<IdleLocation, string>> = {
  chair: "In their chair",
  "beside the desk": "Beside their desk",
  "cafe-table": "At the café table",
  "canteen-plant": "At the canteen's plant",
  "lounge-sofa": "On the lounge sofa",
  "wall-board": "At the wall board",
  "weight-bench": "On the weight bench",
  "table-tennis": "At the table tennis table",
  "vending-machine": "At the vending machine",
  "fish-tank": "At the fish tank",
  darts: "At the dartboard",
  treadmill: "On the treadmill",
  basketball: "At the basketball hoop",
  "pool-table": "At the pool table",
  foosball: "At the foosball table",
  "chess-table": "At the chess table",
  "bean-bags": "On the bean bags",
  "yoga-mats": "On the yoga mats",
  dumbbells: "At the weights rack",
  "exercise-bike": "On the exercise bike",
  "rowing-machine": "On the rowing machine",
};

/** Where an activity happens, for people: `At the water cooler`. */
export const placeOf = ({ location }: Pick<IdleActivity, "location">): string =>
  placeNames[location] ?? `At the ${location.replaceAll("-", " ")}`;

const whenNames: Record<IdleWhen, string> = {
  finished: "Just after finishing work",
  idle: "Whenever idle",
  "long idle": "After a long idle",
};

/** An activity's name, for people: `Water-cooler chat`. */
const titleOf = (name: string) =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * Every activity, and a Floor's switches for them: `fixed`'s, as Agent
 * Settings shows a Floor's, or the one chosen in the card.
 */
export function ActivitiesCard({
  floor: fixed,
}: { floor?: Pick<Floor, "id" | "name"> } = {}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: floors } = useQuery({
    ...floorsQuery,
    enabled: fixed === undefined,
  });
  const { data: disabledByFloor } = useQuery(floorActivitiesQuery);
  const [floorId, setFloorId] = useState<string>();
  const floor =
    fixed ?? floors?.find(({ id }) => id === floorId) ?? floors?.[0];
  const saved = floor === undefined ? [] : (disabledByFloor?.[floor.id] ?? []);
  const [draft, setDraft] = useState<{ floorId: string; off: string[] }>();
  const off =
    draft !== undefined && draft.floorId === floor?.id ? draft.off : saved;
  const dirty =
    off.length !== saved.length || off.some((name) => !saved.includes(name));
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);

  const toggle = (name: string, on: boolean) => {
    if (floor === undefined) {
      return;
    }
    setStatus(undefined);
    setDraft({
      floorId: floor.id,
      off: on ? off.filter((each) => each !== name) : [...off, name],
    });
  };

  const save = async () => {
    if (floor === undefined) {
      return;
    }
    const parsed = setFloorActivitiesRequestSchema.safeParse({ disabled: off });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setSaving(true);
    const response = await sendJson(
      "PUT",
      `/api/floors/${encodeURIComponent(floor.id)}/activities`,
      parsed.data,
      session?.csrfToken,
    );
    setSaving(false);
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The activities were not saved."],
      );
      return;
    }
    const { disabled } = floorActivitiesSchema.parse(await response.json());
    queryClient.setQueryData(floorActivitiesQuery.queryKey, disabled);
    setDraft(undefined);
    setProblems([]);
    setStatus(
      `Saved. ${floor.name}'s Agents do ${String(idleActivities.length - off.length)} of the ${String(idleActivities.length)} activities.`,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Agent activities</h2>
        </CardTitle>
        <CardDescription>
          What an Agent&apos;s Avatar may do in the 3D Office when it has no
          work: all {idleActivities.length} of them, where, and when. Work
          always comes first: a new task brings an Agent straight back to its
          desk. Turn any off for{" "}
          {`${fixed === undefined ? "a Floor" : fixed.name}; its Agents never do those.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fixed === undefined && floors !== undefined && floors.length > 0 && (
          <div className="max-w-sm space-y-2">
            <Label htmlFor="activities-floor">Floor</Label>
            <select
              id="activities-floor"
              className={selectClass}
              value={floor?.id ?? ""}
              onChange={(event) => {
                setFloorId(event.target.value);
                setStatus(undefined);
                setProblems([]);
              }}
            >
              {floors.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}
        {fixed === undefined && floors?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Add a Floor in Floor Settings to turn activities on and off for it.
          </p>
        )}
        <TableFrame label="Agent activities, scrollable">
          <table
            className="w-full text-left text-sm"
            aria-label="Agent activities"
          >
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Activity
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Where
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  When
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Bubble
                </th>
                {floor !== undefined && (
                  <th scope="col" className="py-2 font-medium">
                    On {floor.name}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {idleActivities.map((activity) => {
                const on = !off.includes(activity.name);
                return (
                  <tr key={activity.name} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {titleOf(activity.name)}
                    </th>
                    <td className="py-2 pr-4">{placeOf(activity)}</td>
                    <td className="py-2 pr-4">{whenNames[activity.when]}</td>
                    <td className="py-2 pr-4" aria-label="Bubble">
                      {activity.bubble ?? "–"}
                    </td>
                    {floor !== undefined && (
                      <td className="py-2">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={on}
                            aria-label={`${titleOf(activity.name)} on ${floor.name}`}
                            onChange={(event) => {
                              toggle(activity.name, event.target.checked);
                            }}
                          />
                          {on ? "On" : "Off"}
                        </label>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableFrame>
        {problems.length > 0 && (
          <ul role="alert" className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {status !== undefined && !dirty && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
        {floor !== undefined && (
          <div className="flex flex-wrap gap-2">
            <Button
              pending={saving}
              type="button"
              disabled={!dirty || saving || session === undefined}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : `Save ${floor.name}'s activities`}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={off.length === 0}
              onClick={() => {
                setStatus(undefined);
                setDraft({ floorId: floor.id, off: [] });
              }}
            >
              Turn them all on
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
