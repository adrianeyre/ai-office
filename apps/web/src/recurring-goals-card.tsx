import {
  recurringGoalFailuresToTurnOff,
  recurringGoalInputSchema,
  recurringGoalListSchema,
  recurringGoalsCardId,
  scheduleText,
  weekdayNames,
  type Floor,
  type RecurringGoal,
  type RecurringGoalFrequency,
  type RecurringGoalRun,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useId, useState, type SyntheticEvent } from "react";
import type { z } from "zod";

import { Badge } from "@/components/ui/badge.tsx";
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
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { selectClass } from "@/lib/utils.ts";

import { useAnchor } from "./anchor.ts";
import { getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// A Floor's Recurring Goals in its admin (Scorecards PRD, FR-136 to FR-141;
// ADR 0018): Goals the Owner saved with a schedule, daily or weekly on
// chosen days at a time in the Office's time zone, which the Floor's
// Manager works each time they come round. A run may send one research
// Contractor and files issues; its Plan waits on the whiteboard for the
// Owner's approval. The Owner adds, changes, turns off and on, deletes and
// runs one now here, and sees each one's last and next run. One that
// turned itself off after three failed runs says so, and the action Notice
// it raised links here, by `#recurring-goals`.

/** `GET /api/floors/:floorId/recurring-goals`. */
export const recurringGoalsQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "recurring-goals"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/recurring-goals`,
        recurringGoalListSchema,
      ),
  });

type GoalList = z.infer<typeof recurringGoalListSchema>;

const goalsUrl = (floorId: string): string =>
  `/api/floors/${encodeURIComponent(floorId)}/recurring-goals`;

/** The form's fields, as typed. */
interface Draft {
  name: string;
  words: string;
  frequency: RecurringGoalFrequency;
  days: number[];
  time: string;
  /** Empty for the office's daily Token Cap. */
  tokenCap: string;
}

const draftOf = (goal: RecurringGoal | undefined): Draft => ({
  name: goal?.name ?? "",
  words: goal?.words ?? "",
  frequency: goal?.schedule.frequency ?? "weekly",
  days: [...(goal?.schedule.days ?? [1])],
  time: goal?.schedule.time ?? "09:00",
  tokenCap: goal?.tokenCap == null ? "" : String(goal.tokenCap),
});

/** What the form sends, as `recurringGoalInputSchema` takes it. */
const inputOf = (draft: Draft, enabled: boolean) => ({
  name: draft.name,
  words: draft.words,
  schedule: {
    frequency: draft.frequency,
    days: draft.frequency === "weekly" ? draft.days : [],
    time: draft.time,
  },
  tokenCap: draft.tokenCap.trim() === "" ? null : Number(draft.tokenCap),
  enabled,
});

const when = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** A time, as the card says it, in the Office's time zone. */
const timeIn = (iso: string, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return when.format(new Date(iso));
  }
};

function Problems({ problems }: { problems: readonly string[] }) {
  return problems.length === 0 ? null : (
    <div role="alert">
      <ul className="space-y-1 text-sm text-destructive">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

/** Adds a Recurring Goal, or changes one. */
function GoalForm({
  floor,
  goal,
  onSaved,
  onCancel,
}: {
  floor: Floor;
  goal?: RecurringGoal;
  onSaved: (next: GoalList) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const { data: session } = useQuery(sessionQuery);
  const [draft, setDraft] = useState<Draft>(() => draftOf(goal));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = recurringGoalInputSchema.safeParse(
      inputOf(draft, goal?.enabled ?? true),
    );
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setBusy(true);
    try {
      const response =
        goal === undefined
          ? await sendJson(
              "POST",
              goalsUrl(floor.id),
              parsed.data,
              session?.csrfToken,
            )
          : await sendJson(
              "PATCH",
              `${goalsUrl(floor.id)}/${String(goal.id)}`,
              {
                name: parsed.data.name,
                words: parsed.data.words,
                schedule: parsed.data.schedule,
                tokenCap: parsed.data.tokenCap,
              },
              session?.csrfToken,
            );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblems(
          error.problems ?? [
            error.message ?? "The Recurring Goal was not saved.",
          ],
        );
        return;
      }
      setProblems([]);
      onSaved(recurringGoalListSchema.parse(await response.json()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      aria-label={
        goal === undefined ? "Add a Recurring Goal" : `Edit ${goal.name}`
      }
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(event) => void submit(event)}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={100}
          onChange={(event) => {
            set("name", event.target.value);
          }}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-words`}>Goal</Label>
        <textarea
          id={`${id}-words`}
          rows={3}
          value={draft.words}
          maxLength={2000}
          placeholder="Find modules without tests and file an issue for each."
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          aria-describedby={`${id}-words-hint`}
          onChange={(event) => {
            set("words", event.target.value);
          }}
        />
        <p id={`${id}-words-hint`} className="text-xs text-muted-foreground">
          What you would type after /goal. The Manager works it as your Goal
          each time it comes round, and its Plan waits for your approval.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-frequency`}>Comes round</Label>
          <select
            id={`${id}-frequency`}
            className={selectClass}
            value={draft.frequency}
            onChange={(event) => {
              set("frequency", event.target.value as RecurringGoalFrequency);
            }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-time`}>At</Label>
          <Input
            id={`${id}-time`}
            type="time"
            value={draft.time}
            onChange={(event) => {
              set("time", event.target.value);
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-token-cap`}>Token Cap a run</Label>
          <Input
            id={`${id}-token-cap`}
            type="number"
            min={1}
            inputMode="numeric"
            value={draft.tokenCap}
            aria-describedby={`${id}-token-cap-hint`}
            onChange={(event) => {
              set("tokenCap", event.target.value);
            }}
          />
          <p
            id={`${id}-token-cap-hint`}
            className="text-xs text-muted-foreground"
          >
            The Manager&apos;s and its research Contractor&apos;s tokens
            together. Empty for the office&apos;s daily Token Cap.
          </p>
        </div>
      </div>
      {draft.frequency === "weekly" && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">On</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <div key={day} className="flex items-center gap-2">
                <input
                  id={`${id}-day-${String(day)}`}
                  type="checkbox"
                  className="size-4"
                  checked={draft.days.includes(day)}
                  onChange={(event) => {
                    set(
                      "days",
                      event.target.checked
                        ? [...draft.days, day]
                        : draft.days.filter((other) => other !== day),
                    );
                  }}
                />
                <Label htmlFor={`${id}-day-${String(day)}`}>
                  {weekdayNames[day]}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <Problems problems={problems} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          pending={busy}
          disabled={busy || session === undefined}
        >
          {goal === undefined ? "Add Recurring Goal" : `Save ${goal.name}`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** How a run went, in a phrase. */
const runText = (run: RecurringGoalRun, timeZone: string): string => {
  const at = timeIn(run.startedAt, timeZone);
  switch (run.outcome) {
    case "running":
      return `Running since ${at}.`;
    case "planned":
      return `${at}: filed ${run.issues.length === 0 ? "no issues" : run.issues.map((issue) => `#${String(issue)}`).join(", ")}, and proposed a Plan.`;
    case "skipped":
      return `${at}: skipped, as ${run.reason}.`;
    case "failed":
      return `${at}: failed, as ${run.reason}.`;
  }
};

function GoalItem({
  floor,
  goal,
  timeZone,
  onEdit,
  onChanged,
}: {
  floor: Floor;
  goal: RecurringGoal;
  timeZone: string;
  onEdit: () => void;
  onChanged: (next: GoalList) => void;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const url = `${goalsUrl(floor.id)}/${String(goal.id)}`;
  const archived = floor.archivedAt !== null;

  const act = async (
    send: () => Promise<Response>,
    failure: string,
    done?: string,
  ) => {
    setBusy(true);
    setSaid(null);
    try {
      const response = await send();
      if (!response.ok) {
        const error = await readApiError(response);
        setProblems(error.problems ?? [error.message ?? failure]);
        return;
      }
      setProblems([]);
      onChanged(recurringGoalListSchema.parse(await response.json()));
      if (done !== undefined) {
        setSaid(done);
      }
    } finally {
      setBusy(false);
    }
  };

  const turnedOff =
    !goal.enabled && goal.failures >= recurringGoalFailuresToTurnOff;
  const last = goal.lastRun;
  return (
    <li
      aria-label={goal.name}
      className="grid gap-2 border-b pb-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{goal.name}</h3>
        {goal.enabled ? (
          <Badge tone="success">On</Badge>
        ) : (
          <Badge tone="neutral">Off</Badge>
        )}
      </div>
      <p className="text-sm">{goal.words}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">When</dt>
        <dd>
          {scheduleText(goal.schedule)} ({timeZone})
        </dd>
        <dt className="text-muted-foreground">Next run</dt>
        <dd>
          {goal.nextRunAt === null
            ? "None while it is off"
            : timeIn(goal.nextRunAt, timeZone)}
        </dd>
        <dt className="text-muted-foreground">Last run</dt>
        <dd>
          {last === null ? (
            "It has not run yet."
          ) : (
            <>
              {runText(last, timeZone)}
              {last.batchId !== null && (
                <>
                  {" "}
                  <a
                    href={`/floors/${encodeURIComponent(floor.id)}/whiteboard?batch=${String(last.batchId)}`}
                    className="underline-offset-2 hover:underline"
                  >
                    Open its Plan
                  </a>
                </>
              )}
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">Token Cap</dt>
        <dd>
          {goal.tokenCap === null
            ? "The office's daily Token Cap, a run"
            : `${goal.tokenCap.toLocaleString("en-GB")} tokens a run`}
        </dd>
      </dl>
      {turnedOff ? (
        <p role="status" className="text-sm text-destructive">
          It turned itself off after {recurringGoalFailuresToTurnOff} failed
          runs in a row: see why above, then turn it on again.
        </p>
      ) : (
        goal.failures > 0 && (
          <p className="text-sm text-muted-foreground">
            {goal.failures} failed {goal.failures === 1 ? "run" : "runs"} in a
            row: at {recurringGoalFailuresToTurnOff} it turns itself off.
          </p>
        )
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete {goal.name}? It comes round no more, and its runs are
            forgotten. The issues it filed stay.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void act(
                () => sendDelete(url, session?.csrfToken),
                `${goal.name} was not deleted.`,
              )
            }
          >
            Yes, delete {goal.name}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        !archived && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label={`Edit ${goal.name}`}
              onClick={onEdit}
            >
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Turn ${goal.enabled ? "off" : "on"} ${goal.name}`}
              disabled={busy || session === undefined}
              onClick={() =>
                void act(
                  () =>
                    sendJson(
                      "PATCH",
                      url,
                      { enabled: !goal.enabled },
                      session?.csrfToken,
                    ),
                  `${goal.name} was not turned ${goal.enabled ? "off" : "on"}.`,
                )
              }
            >
              {goal.enabled ? "Turn off" : "Turn on"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Run ${goal.name} now`}
              disabled={busy || session === undefined}
              onClick={() =>
                void act(
                  () => sendJson("POST", `${url}/run`, {}, session?.csrfToken),
                  `${goal.name} did not run.`,
                  `${goal.name} is running: the Manager chat follows it, and its Plan waits on the whiteboard.`,
                )
              }
            >
              <Play aria-hidden />
              Run now
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Delete ${goal.name}`}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          </div>
        )
      )}
      {said !== null && (
        <p role="status" className="text-sm">
          {said}
        </p>
      )}
      <Problems problems={problems} />
    </li>
  );
}

export function RecurringGoalsCard({ floor }: { floor: Floor }) {
  const anchor = useAnchor<HTMLDivElement>(recurringGoalsCardId);
  const queryClient = useQueryClient();
  const query = recurringGoalsQuery(floor.id);
  const { data: list, error } = useQuery(query);
  /** The Recurring Goal being edited, "new" while one is added, or none. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const archived = floor.archivedAt !== null;

  const changed = (next: GoalList) => {
    queryClient.setQueryData(query.queryKey, next);
  };

  return (
    <Card id={recurringGoalsCardId} ref={anchor} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Recurring Goals</h2>
        </CardTitle>
        <CardDescription>
          Goals you save with a schedule, such as &quot;every Monday, find
          modules without tests and file issues&quot;. Each time one comes
          round, the Manager works it as your Goal: it may send one research
          Contractor, which changes nothing, files issues (never one it filed
          before that is still open), and proposes a Plan, which waits for your
          approval on the whiteboard. A run is skipped while the last one&apos;s
          Plan waits or its Batch runs, and stops at its Token Cap. Three failed
          runs in a row turn one off.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            The Recurring Goals could not be read: {error.message}
          </p>
        )}
        {list === undefined ? (
          error === null && (
            <LoadingMessage>Reading the Recurring Goals…</LoadingMessage>
          )
        ) : (
          <>
            {list.recurringGoals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Recurring Goals yet.
              </p>
            ) : (
              <ul aria-label="Recurring Goals" className="grid gap-3">
                {list.recurringGoals.map((goal) =>
                  editing === goal.id ? (
                    <li key={goal.id} aria-label={goal.name}>
                      <GoalForm
                        floor={floor}
                        goal={goal}
                        onSaved={(next) => {
                          changed(next);
                          setEditing(null);
                        }}
                        onCancel={() => {
                          setEditing(null);
                        }}
                      />
                    </li>
                  ) : (
                    <GoalItem
                      key={goal.id}
                      floor={floor}
                      goal={goal}
                      timeZone={list.timeZone}
                      onEdit={() => {
                        setEditing(goal.id);
                      }}
                      onChanged={changed}
                    />
                  ),
                )}
              </ul>
            )}
            {editing === "new" ? (
              <GoalForm
                floor={floor}
                onSaved={(next) => {
                  changed(next);
                  setEditing(null);
                }}
                onCancel={() => {
                  setEditing(null);
                }}
              />
            ) : (
              !archived && (
                <div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditing("new");
                    }}
                  >
                    <Plus aria-hidden />
                    Add a Recurring Goal
                  </Button>
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
