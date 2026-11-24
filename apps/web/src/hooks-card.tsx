import {
  defaultHookRunsPerHour,
  hookActionText,
  hookFailuresToTurnOff,
  hookListSchema,
  hookStages,
  hookTriggerFilters,
  hookTriggerLabels,
  hookTriggers,
  hookTriggerText,
  hooksCardId,
  managerRole,
  maxHookRunsPerHour,
  startedHookRunSchema,
  type Agent,
  type Floor,
  type Hook,
  type HookInputRequest,
  type HookList,
  type HookRun,
  type HookStage,
  type HookTrigger,
  type LibraryRole,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";

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
import { agentsQuery } from "./floors.ts";
import { rolesQuery } from "./role-library.tsx";
import { sessionQuery } from "./session.ts";

// A Floor's Hooks in its admin (Guidelines, Specs and Hooks PRD, FR-118 to
// FR-121; ADR 0016): the Owner's own rules for the Floor. Each says when it
// runs (an issue moving to a Stage, a pull request opened, a push to the
// default branch touching matching files, a Batch's Wrap-up, a Spec's
// issues filed, or Run now), what narrows that (labels, file patterns),
// who runs it (a named Agent, or any Agent in a Role) and which of the
// Floor's Skills, at most how many times an hour. The Owner adds, edits,
// turns off and on, deletes and runs one now here, and sees each one's
// latest runs: who ran it, on what, and what came of it. A Hook that
// turned itself off after three failed runs says so, and the action
// Notice it raised links here, by `#hooks`.

/** `GET /api/floors/:floorId/hooks`. */
export const floorHooksQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "hooks"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/hooks`,
        hookListSchema,
      ),
  });

const hooksUrl = (floorId: string): string =>
  `/api/floors/${encodeURIComponent(floorId)}/hooks`;

/** The form's fields, as typed: lists are text, one item a line. */
interface Draft {
  name: string;
  trigger: HookTrigger;
  stage: HookStage;
  labels: string;
  filePatterns: string;
  who: "agent" | "role";
  agentId: string;
  role: string;
  skillName: string;
  runsPerHour: string;
  enabled: boolean;
}

const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

const draftOf = (hook: Hook | undefined): Draft => ({
  name: hook?.name ?? "",
  trigger: hook?.trigger ?? "pull_request_opened",
  stage: hook?.stage ?? "needs-review",
  labels: hook?.labels.join("\n") ?? "",
  filePatterns: hook?.filePatterns.join("\n") ?? "",
  who: hook?.agentId === null || hook === undefined ? "role" : "agent",
  agentId: hook?.agentId ?? "",
  role: hook?.role ?? "",
  skillName: hook?.skillName ?? "",
  runsPerHour: String(hook?.runsPerHour ?? defaultHookRunsPerHour),
  enabled: hook?.enabled ?? true,
});

/** What the form sends: only the filters its trigger takes. */
const inputOf = (draft: Draft): HookInputRequest => {
  const filters = hookTriggerFilters[draft.trigger];
  return {
    name: draft.name,
    trigger: draft.trigger,
    stage: draft.trigger === "stage" ? draft.stage : null,
    labels: filters.labels ? lines(draft.labels) : [],
    filePatterns: filters.files ? lines(draft.filePatterns) : [],
    agentId: draft.who === "agent" ? draft.agentId : null,
    role: draft.who === "role" ? draft.role : null,
    skillName: draft.skillName,
    runsPerHour: Number(draft.runsPerHour),
    enabled: draft.enabled,
  };
};

/** A listed Hook as `PUT` takes it, with `changes`. */
const sameAs = (
  hook: Hook,
  changes: Partial<HookInputRequest> = {},
): HookInputRequest => ({
  name: hook.name,
  trigger: hook.trigger,
  stage: hook.stage,
  labels: hook.labels,
  filePatterns: hook.filePatterns,
  agentId: hook.agentId,
  role: hook.role,
  skillName: hook.skillName,
  runsPerHour: hook.runsPerHour,
  enabled: hook.enabled,
  ...changes,
});

/** What the API said was wrong: its problems, or its message. */
async function problemsOf(
  response: Response,
  fallback: string,
): Promise<string[]> {
  const refused = await readApiError(response);
  return refused.problems ?? [refused.message ?? fallback];
}

function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

function HookForm({
  floor,
  hook,
  skills,
  agents,
  roles,
  onSaved,
  onCancel,
}: {
  floor: Floor;
  hook?: Hook;
  skills: HookList["skills"];
  agents: readonly Agent[];
  roles: readonly LibraryRole[];
  onSaved: (list: HookList) => void;
  onCancel: () => void;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [draft, setDraft] = useState<Draft>(() => draftOf(hook));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <Field extends keyof Draft>(
    field: Field,
    value: Draft[Field],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const filters = hookTriggerFilters[draft.trigger];
  const id = (field: string) => `hook-${String(hook?.id ?? "new")}-${field}`;
  const team = agents.filter(({ role }) => role !== managerRole);

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblems([]);
    const response = await sendJson(
      hook === undefined ? "POST" : "PUT",
      hook === undefined
        ? hooksUrl(floor.id)
        : `${hooksUrl(floor.id)}/${String(hook.id)}`,
      inputOf(draft),
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, "The Hook was not saved."));
      return;
    }
    onSaved(hookListSchema.parse(await response.json()));
  };

  return (
    <form
      aria-label={hook === undefined ? "New Hook" : `Edit ${hook.name}`}
      className="grid gap-3 rounded-lg border p-3"
      onSubmit={(event) => void save(event)}
    >
      <div className="grid gap-1">
        <Label htmlFor={id("name")}>Name</Label>
        <Input
          id={id("name")}
          value={draft.name}
          maxLength={60}
          onChange={(event) => {
            set("name", event.target.value);
          }}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={id("trigger")}>When</Label>
        <select
          id={id("trigger")}
          className={selectClass}
          value={draft.trigger}
          onChange={(event) => {
            set("trigger", event.target.value as HookTrigger);
          }}
        >
          {hookTriggers.map((trigger) => (
            <option key={trigger} value={trigger}>
              {hookTriggerLabels[trigger]}
            </option>
          ))}
        </select>
      </div>
      {draft.trigger === "stage" && (
        <div className="grid gap-1">
          <Label htmlFor={id("stage")}>Stage</Label>
          <select
            id={id("stage")}
            className={selectClass}
            value={draft.stage}
            onChange={(event) => {
              set("stage", event.target.value as HookStage);
            }}
          >
            {hookStages.map((stage) => (
              <option key={stage} value={stage}>
                {stage}
              </option>
            ))}
          </select>
        </div>
      )}
      {filters.labels && (
        <div className="grid gap-1">
          <Label htmlFor={id("labels")}>Only for issues labelled</Label>
          <textarea
            id={id("labels")}
            className="min-h-16 rounded-lg border bg-transparent p-2 text-sm"
            placeholder="One label a line; none for any issue"
            value={draft.labels}
            onChange={(event) => {
              set("labels", event.target.value);
            }}
          />
        </div>
      )}
      {filters.files && (
        <div className="grid gap-1">
          <Label htmlFor={id("files")}>
            {draft.trigger === "push"
              ? "Files it watches"
              : "Only when a changed file matches"}
          </Label>
          <textarea
            id={id("files")}
            className="min-h-16 rounded-lg border bg-transparent p-2 font-mono text-sm"
            placeholder={
              draft.trigger === "push"
                ? "One pattern a line, such as **/*.sql"
                : "One pattern a line, such as **/*.sql; none for any file"
            }
            value={draft.filePatterns}
            onChange={(event) => {
              set("filePatterns", event.target.value);
            }}
          />
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Who runs it</legend>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={id("who")}
              checked={draft.who === "role"}
              onChange={() => {
                set("who", "role");
              }}
            />
            Any Agent in the Role
          </label>
          <select
            aria-label="Role"
            className={selectClass}
            value={draft.role}
            disabled={draft.who !== "role"}
            onChange={(event) => {
              set("role", event.target.value);
            }}
          >
            <option value="">Choose a Role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={id("who")}
              checked={draft.who === "agent"}
              onChange={() => {
                set("who", "agent");
              }}
            />
            The Agent
          </label>
          <select
            aria-label="Agent"
            className={selectClass}
            value={draft.agentId}
            disabled={draft.who !== "agent"}
            onChange={(event) => {
              set("agentId", event.target.value);
            }}
          >
            <option value="">Choose an Agent</option>
            {team.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <div className="grid gap-1">
        <Label htmlFor={id("skill")}>Skill it runs</Label>
        <select
          id={id("skill")}
          className={selectClass}
          value={draft.skillName}
          onChange={(event) => {
            set("skillName", event.target.value);
          }}
        >
          <option value="">Choose a Skill</option>
          {skills.map((skill) => (
            <option key={skill.name} value={skill.name}>
              /{skill.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={id("runs")}>At most this many runs an hour</Label>
        <Input
          id={id("runs")}
          type="number"
          min={1}
          max={maxHookRunsPerHour}
          value={draft.runsPerHour}
          onChange={(event) => {
            set("runsPerHour", event.target.value);
          }}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => {
            set("enabled", event.target.checked);
          }}
        />
        On
      </label>
      <Problems problems={problems} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || session === undefined}>
          {hook === undefined ? "Add Hook" : "Save Hook"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const runStatus: Record<
  HookRun["status"],
  { label: string; tone: "info" | "success" | "danger" }
> = {
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

function Run({ run }: { run: HookRun }) {
  const status = runStatus[run.status];
  const on =
    run.pullRequest !== null
      ? ` on PR #${String(run.pullRequest)}`
      : run.issue !== null
        ? ` on #${String(run.issue)}`
        : "";
  return (
    <li className="grid gap-1 text-sm">
      <p>
        <Badge tone={status.tone}>{status.label}</Badge>{" "}
        {run.agentName ??
          (run.agentId === null
            ? "No Agent"
            : "An Agent no longer on the Floor")}
        {on} · {new Date(run.startedAt).toLocaleString()}
        {run.commentUrl !== null && (
          <>
            {" "}
            ·{" "}
            <a
              className="underline"
              href={run.commentUrl}
              target="_blank"
              rel="noreferrer"
            >
              Answer on GitHub
            </a>
          </>
        )}
      </p>
      {run.error !== null && <p className="text-destructive">{run.error}</p>}
      {run.result !== null && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            Its answer
          </summary>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
            {run.result}
          </pre>
        </details>
      )}
    </li>
  );
}

function HookItem({
  floor,
  hook,
  agents,
  roles,
  onEdit,
  onChanged,
}: {
  floor: Floor;
  hook: Hook;
  agents: readonly Agent[];
  roles: readonly LibraryRole[];
  onEdit: () => void;
  onChanged: (list: HookList) => void;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const archived = floor.archivedAt !== null;
  const url = `${hooksUrl(floor.id)}/${String(hook.id)}`;
  const action = hookActionText(hook, {
    agent: agents.find(({ id }) => id === hook.agentId)?.name,
    role: roles.find(({ id }) => id === hook.role)?.name,
  });

  const act = async (
    request: () => Promise<Response>,
    failed: string,
    answer: (body: unknown) => HookList,
    done?: string,
  ) => {
    setBusy(true);
    setProblems([]);
    setSaid(null);
    const response = await request();
    setBusy(false);
    setConfirming(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, failed));
      return;
    }
    onChanged(answer(await response.json()));
    if (done !== undefined) {
      setSaid(done);
    }
  };

  const toggle = () =>
    act(
      () =>
        sendJson(
          "PUT",
          url,
          sameAs(hook, { enabled: !hook.enabled }),
          session?.csrfToken,
        ),
      `${hook.name} was not turned ${hook.enabled ? "off" : "on"}.`,
      (body) => hookListSchema.parse(body),
    );
  const remove = () =>
    act(
      () => sendDelete(url, session?.csrfToken),
      `${hook.name} was not deleted.`,
      (body) => hookListSchema.parse(body),
    );
  const runNow = () =>
    act(
      () => sendJson("POST", `${url}/run`, {}, session?.csrfToken),
      `${hook.name} did not run.`,
      (body) => startedHookRunSchema.parse(body).hooks,
      `${hook.name} is running: its run shows below.`,
    );

  const turnedOff = !hook.enabled && hook.failures >= hookFailuresToTurnOff;
  return (
    <li
      aria-label={hook.name}
      className="grid gap-2 border-b pb-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{hook.name}</h3>
        {hook.enabled ? (
          <Badge tone="success">On</Badge>
        ) : (
          <Badge tone="neutral">Off</Badge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">When</dt>
        <dd>{hookTriggerText(hook)}</dd>
        <dt className="text-muted-foreground">Then</dt>
        <dd>{action}</dd>
        <dt className="text-muted-foreground">Limit</dt>
        <dd>
          At most {hook.runsPerHour} {hook.runsPerHour === 1 ? "run" : "runs"}{" "}
          an hour
        </dd>
      </dl>
      {turnedOff ? (
        <p role="status" className="text-sm text-destructive">
          It turned itself off after {hookFailuresToTurnOff} failed runs in a
          row: see why below, then turn it on again.
        </p>
      ) : (
        hook.failures > 0 && (
          <p className="text-sm text-muted-foreground">
            {hook.failures} failed {hook.failures === 1 ? "run" : "runs"} in a
            row: at {hookFailuresToTurnOff} it turns itself off.
          </p>
        )
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete {hook.name}? It runs no more, and its runs are forgotten.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            Yes, delete {hook.name}
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
              aria-label={`Edit ${hook.name}`}
              onClick={onEdit}
            >
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Turn ${hook.enabled ? "off" : "on"} ${hook.name}`}
              disabled={busy || session === undefined}
              onClick={() => void toggle()}
            >
              {hook.enabled ? "Turn off" : "Turn on"}
            </Button>
            {hook.trigger === "run_now" && (
              <Button
                size="sm"
                variant="outline"
                aria-label={`Run ${hook.name} now`}
                disabled={busy || !hook.enabled || session === undefined}
                onClick={() => void runNow()}
              >
                <Play aria-hidden />
                Run now
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              aria-label={`Delete ${hook.name}`}
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
      {hook.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">It has not run yet.</p>
      ) : (
        <ul aria-label={`Latest runs of ${hook.name}`} className="grid gap-2">
          {hook.runs.map((run) => (
            <Run key={run.id} run={run} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function HooksCard({ floor }: { floor: Floor }) {
  const anchor = useAnchor<HTMLDivElement>(hooksCardId);
  const queryClient = useQueryClient();
  const query = floorHooksQuery(floor.id);
  const { data: list, error } = useQuery(query);
  const { data: agents = [] } = useQuery(agentsQuery(floor.id));
  const { data: roles = [] } = useQuery(rolesQuery);
  /** The Hook being edited, "new" while one is added, or none. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const archived = floor.archivedAt !== null;

  const changed = (next: HookList) => {
    queryClient.setQueryData(query.queryKey, next);
  };

  const refused = error === null ? null : error.message;

  return (
    <Card id={hooksCardId} ref={anchor} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Hooks</h2>
        </CardTitle>
        <CardDescription>
          Your own rules for this Floor: when an event happens, an Agent follows
          one of the Floor&apos;s Skills. Each run is one model call as that
          Agent, which counts against its Token Caps, given the event&apos;s
          details as data it does not obey. Its answer is posted on the issue or
          pull request; nothing is run, and nothing in it is acted on. Three
          failed runs in a row turn a Hook off.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {refused !== null && (
          <p role="alert" className="text-sm text-destructive">
            The Hooks could not be read: {refused}
          </p>
        )}
        {list === undefined ? (
          refused === null && (
            <LoadingMessage>Reading the Hooks…</LoadingMessage>
          )
        ) : (
          <>
            {list.skillsError !== null && (
              <p className="text-sm text-muted-foreground">
                {list.skillsError}
              </p>
            )}
            {list.hooks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Hooks yet. Add one to have an Agent run a Skill when an event
                happens, such as a reviewer running /migration-check on each
                pull request that touches **/*.sql.
              </p>
            ) : (
              <ul aria-label="Hooks" className="grid gap-3">
                {list.hooks.map((hook) =>
                  editing === hook.id ? (
                    <li key={hook.id} aria-label={hook.name}>
                      <HookForm
                        floor={floor}
                        hook={hook}
                        skills={list.skills}
                        agents={agents}
                        roles={roles}
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
                    <HookItem
                      key={hook.id}
                      floor={floor}
                      hook={hook}
                      agents={agents}
                      roles={roles}
                      onEdit={() => {
                        setEditing(hook.id);
                      }}
                      onChanged={changed}
                    />
                  ),
                )}
              </ul>
            )}
            {editing === "new" ? (
              <HookForm
                floor={floor}
                skills={list.skills}
                agents={agents}
                roles={roles}
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
                    Add a Hook
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
