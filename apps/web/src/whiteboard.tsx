import type { EventType } from "@ai-office/events/schema";
import {
  batchDetailSchema,
  batchListSchema,
  batchStatusLabels,
  maxPlanAnnotationLength,
  wrapUpOutcomeLabels,
  type Acknowledgement,
  type Batch,
  type BatchDetail,
  type Floor,
  type Plan,
  type PlanItem,
  type WrapUp,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { LoadingMessage, Spinner } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { AgentLink } from "./agent-link.tsx";
import { getJson, postJson, readApiError } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { floorQuery } from "./floors.ts";
import { GrillingWhiteboard } from "./grilling.tsx";
import { rolesQuery } from "./role-library.tsx";
import { sessionQuery } from "./session.ts";

// A Floor's whiteboard (PRD FR-25.3, FR-58): the Plans of its Batches,
// current and past, each with every version. The latest version of a Plan
// awaiting approval can be edited here (move its issues up and down, drop
// some, write a note on any) and saved, and the Manager replans it as the
// next version; or approved, and its work starts in its order. An issue
// the Plan gives several work Roles shows them in the order they take
// turns on its branch, and they can be reordered or removed too (FR-25
// (1)). The Kickoff's acknowledgements fill it in as each assigned Agent
// gives one, "OK" or a concern (FR-25.2), and a finished Batch shows its
// Wrap-up's results: each issue's outcome and pull request, rounds, tokens
// and estimated cost (FR-25.6). Batches change live, as their events
// arrive. While a Grilling Session runs, it also shows the session's live
// outline and the decisions settled so far (FR-80). This 2D page holds the
// panel; the meeting-room whiteboard in the 3D office opens the same one.

const batchesUrl = (floorId: string) =>
  `/api/floors/${encodeURIComponent(floorId)}/batches`;

/** A Floor's Batches, newest first (`GET /api/floors/:floorId/batches`). */
export const batchesQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "batches"],
    queryFn: () => getJson(batchesUrl(floorId), batchListSchema),
  });

/** One Batch, with every version of its Plan. */
export const batchQuery = (floorId: string, batchId: number) =>
  queryOptions({
    queryKey: ["floors", floorId, "batches", batchId],
    queryFn: () =>
      getJson(`${batchesUrl(floorId)}/${String(batchId)}`, batchDetailSchema),
  });

/** The events that change a Floor's Batches. */
const batchEventTypes: readonly EventType[] = [
  "batch.planned",
  "batch.approved",
  "batch.started",
  "batch.kickoff_started",
  "batch.acknowledged",
  "batch.kickoff_ended",
  "batch.finished",
];

/** The Batch the whiteboard opens on: the newest awaiting approval, or else the newest. */
export const currentBatch = (batches: readonly Batch[]): Batch | undefined =>
  batches.find(({ status }) => status === "awaiting_approval") ?? batches[0];

const issueList = (issues: readonly number[]): string => {
  const named = issues.map((issue) => `#${String(issue)}`);
  return named.length <= 1
    ? (named[0] ?? "")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
};

const when = (at: string): string =>
  new Date(at).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** What a version of a Plan is, such as "replanned after your edits to version 1". */
function versionText(plan: Plan): string {
  const by = plan.draftedBy === "rules" ? " by AI Office's rules" : "";
  return plan.editedFrom === null
    ? `drafted${by}`
    : `replanned${by} after your edits to version ${String(plan.editedFrom)}`;
}

function IssueLink({
  floor,
  issue,
}: {
  floor: Floor | undefined;
  issue: number;
}) {
  return floor === undefined ? (
    <>#{issue}</>
  ) : (
    <a
      href={`https://github.com/${floor.repository}/issues/${String(issue)}`}
      target="_blank"
      rel="noreferrer"
      className="font-medium hover:underline"
    >
      #{issue}
    </a>
  );
}

/** A work Role's name from the Role library; its id until that is read. */
function useRoleName(): (id: string) => string {
  const { data: roles } = useQuery(rolesQuery);
  return (id) => roles?.find((role) => role.id === id)?.name ?? id;
}

/** What a Plan says about one issue, after its number and title. */
function ItemDetails({
  floorId,
  item,
  showRoles = true,
}: {
  floorId: string;
  item: Pick<PlanItem, "agentId" | "dependsOn" | "files" | "note" | "roles">;
  /** Whether to list its work Roles, unless the editor does. */
  showRoles?: boolean;
}) {
  const roleName = useRoleName();
  const roles = item.roles ?? [];
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {showRoles && roles.length > 0 && (
        <p>
          {roles.length === 1
            ? `Work Role: ${roleName(roles[0] ?? "")}`
            : `Work Roles, in turn: ${roles.map(roleName).join(", then ")}`}
        </p>
      )}
      <p>
        {item.agentId === null ? (
          "No coder yet"
        ) : (
          <AgentLink floorId={floorId} agentId={item.agentId} />
        )}
        {item.dependsOn.length > 0 && <>, after {issueList(item.dependsOn)}</>}
      </p>
      {item.files.length > 0 && (
        <p>
          Likely files:{" "}
          <span className="font-mono break-all">{item.files.join(", ")}</span>
        </p>
      )}
      {item.note !== "" && <p>{item.note}</p>}
    </div>
  );
}

/** A version of a Plan, to read. */
function PlanView({
  floor,
  floorId,
  plan,
  started,
}: {
  floor: Floor | undefined;
  floorId: string;
  plan: Plan;
  started: readonly number[];
}) {
  return (
    <div className="space-y-3">
      <p>{plan.summary}</p>
      <ol aria-label="The Plan's issues, in order" className="space-y-2">
        {plan.items.map((item, index) => (
          <li key={item.issue} className="rounded-md border p-2">
            <p>
              {index + 1}. <IssueLink floor={floor} issue={item.issue} />{" "}
              {item.title}
              {started.includes(item.issue) && (
                <>
                  {" "}
                  <span className="text-xs text-muted-foreground">
                    (started)
                  </span>
                </>
              )}
            </p>
            <ItemDetails floorId={floorId} item={item} />
            {item.annotation !== undefined && item.annotation !== "" && (
              <p className="text-xs">Your note: {item.annotation}</p>
            )}
          </li>
        ))}
      </ol>
      <PlanFooter plan={plan} />
    </div>
  );
}

/** A Plan's parallel groups, overlaps and what it leaves out. */
function PlanFooter({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {plan.parallel.length > 0 && (
        <p>
          In parallel:{" "}
          {plan.parallel.map((group) => issueList(group)).join("; then ")}.
        </p>
      )}
      {plan.overlaps.map(({ issues: [earlier, later], files }) => (
        <p key={`${String(earlier)}-${String(later)}`}>
          #{later} runs after #{earlier}: both are likely to change{" "}
          <span className="font-mono break-all">{files.join(", ")}</span>.
        </p>
      ))}
      {plan.leftOut.length > 0 && (
        <ul aria-label="Left out">
          {plan.leftOut.map(({ issue, reason }) => (
            <li key={issue}>
              #{issue} is left out: {reason}.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Kickoff's acknowledgements: each assigned Agent's "OK" or concern. */
function Kickoff({
  floorId,
  acknowledgements,
  Heading,
}: {
  floorId: string;
  acknowledgements: readonly Acknowledgement[];
  Heading: "h3" | "h4";
}) {
  const concerns = acknowledgements.filter(
    ({ response }) => response === "concern",
  ).length;
  return (
    <section aria-label="Kickoff" className="space-y-1">
      <Heading className="text-sm font-semibold">
        Kickoff:{" "}
        {concerns === 0
          ? "no concerns"
          : `${String(concerns)} concern${concerns === 1 ? "" : "s"}`}
      </Heading>
      <ul aria-label="Acknowledgements" className="space-y-1 text-sm">
        {acknowledgements.map((acknowledgement) => (
          <li
            key={acknowledgement.agentId}
            data-response={acknowledgement.response}
            className={cn(
              "rounded-md border px-2 py-1",
              acknowledgement.response === "concern" &&
                "border-l-4 border-l-office-state-warning",
            )}
          >
            <AgentLink floorId={floorId} agentId={acknowledgement.agentId} />
            {acknowledgement.response === "ok" ? (
              <>
                : OK
                {acknowledgement.by === "rules" && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    (by AI Office&apos;s rules)
                  </span>
                )}
              </>
            ) : (
              <>: {acknowledgement.concern}</>
            )}
            {acknowledgement.planVersion > 1 && (
              <span className="text-xs text-muted-foreground">
                {" "}
                (on version {acknowledgement.planVersion})
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** An estimated cost, in US dollars. */
const usd = (amount: number): string => `$${amount.toFixed(2)}`;

const tokens = (count: number): string => count.toLocaleString("en-GB");

/** A finished Batch's Wrap-up: each issue's outcome, and the totals. */
function WrapUpView({
  floor,
  floorId,
  wrapUp,
  finishedAt,
  Heading,
}: {
  floor: Floor | undefined;
  floorId: string;
  wrapUp: WrapUp;
  finishedAt: string;
  Heading: "h3" | "h4";
}) {
  const { totals } = wrapUp;
  const blocked = wrapUp.issues.filter(
    ({ outcome }) => outcome === "blocked" || outcome === "not_started",
  );
  return (
    <section aria-label="Wrap-up" className="space-y-2">
      <Heading className="text-sm font-semibold">
        Wrap-up: {totals.merged} of {wrapUp.issues.length} merged
      </Heading>
      <p className="text-xs text-muted-foreground">
        Finished {when(finishedAt)}, on version {wrapUp.planVersion} of the
        Plan. {tokens(totals.tokens)} tokens, about{" "}
        {usd(totals.estimatedCostUsd)} (estimated).
        {totals.closed > 0 && <> {totals.closed} closed without merging.</>}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Each issue&apos;s results</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-1 pr-2 font-medium">
                Issue
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Outcome
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Pull request
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Rounds
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Tokens
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Est. cost
              </th>
            </tr>
          </thead>
          <tbody>
            {wrapUp.issues.map((issue) => (
              <tr
                key={issue.issue}
                data-outcome={issue.outcome}
                className="border-b last:border-0"
              >
                <th scope="row" className="py-1 pr-2 font-normal">
                  <IssueLink floor={floor} issue={issue.issue} /> {issue.title}
                  {issue.agentId !== null && (
                    <span className="block text-muted-foreground">
                      <AgentLink floorId={floorId} agentId={issue.agentId} />
                    </span>
                  )}
                </th>
                <td className="py-1 pr-2">
                  {wrapUpOutcomeLabels[issue.outcome]}
                </td>
                <td className="py-1 pr-2">
                  {issue.pullRequest === null ? (
                    "None"
                  ) : (
                    <a
                      href={issue.pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      PR #{issue.pullRequest.number}
                    </a>
                  )}
                </td>
                <td className="py-1 pr-2">
                  {issue.rounds.review} review, {issue.rounds.qa} QA
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {tokens(issue.tokens)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {usd(issue.estimatedCostUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {blocked.length > 0 && (
        <ul aria-label="Blocked" className="space-y-0.5 text-xs">
          {blocked.map(({ issue, outcome }) => (
            <li key={issue}>
              #{issue}{" "}
              {outcome === "blocked"
                ? "is blocked: it waits for you at needs-human."
                : "did not start: an issue it depends on is blocked."}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Row {
  readonly item: PlanItem;
  readonly annotation: string;
  readonly dropped: boolean;
  /** Its work Roles, in their order now, each removed or not. */
  readonly roles: readonly { readonly id: string; readonly dropped: boolean }[];
}

const rowsOf = (plan: Plan): Row[] =>
  plan.items.map((item) => ({
    item,
    annotation: item.annotation ?? "",
    dropped: false,
    roles: (item.roles ?? []).map((id) => ({ id, dropped: false })),
  }));

/** The work Roles a row keeps, in their order. */
const keptRoles = (row: Row): string[] =>
  row.roles.filter(({ dropped }) => !dropped).map(({ id }) => id);

/** Whether a row's work Roles are as its Plan gave them. */
const rolesAsPlanned = (row: Row): boolean => {
  const kept = keptRoles(row);
  const planned = row.item.roles ?? [];
  return (
    kept.length === planned.length &&
    kept.every((role, at) => role === planned[at])
  );
};

/**
 * An issue's work Roles, in the order they take turns: each can be moved
 * up or down, or removed (all but the last kept).
 */
function RolesEditor({
  name,
  roles,
  disabled,
  onChange,
}: {
  /** The issue, as "#N". */
  name: string;
  roles: Row["roles"];
  disabled: boolean;
  onChange: (roles: Row["roles"]) => void;
}) {
  const roleName = useRoleName();
  const keptCount = roles.filter(({ dropped }) => !dropped).length;
  const move = (index: number, by: -1 | 1) => {
    const next = [...roles];
    const [role] = next.splice(index, 1);
    if (role !== undefined) {
      next.splice(index + by, 0, role);
      onChange(next);
    }
  };
  return (
    <div className="space-y-1">
      <p className="text-xs">
        Work Roles on {name}, in turn on its branch, then review
      </p>
      <ol
        aria-label={`Work Roles on ${name}, in turn`}
        className="space-y-1 text-xs"
      >
        {roles.map((role, index) => {
          const roleText = `the ${roleName(role.id)}`;
          return (
            <li
              key={role.id}
              data-dropped={role.dropped ? "" : undefined}
              className={cn(
                "flex items-center justify-between gap-2",
                role.dropped && "opacity-60",
              )}
            >
              <span className={cn(role.dropped && "line-through")}>
                {roleName(role.id)}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Move ${roleText} up on ${name}`}
                  disabled={disabled || index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Move ${roleText} down on ${name}`}
                  disabled={disabled || index === roles.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`${role.dropped ? "Keep" : "Remove"} ${roleText} on ${name}`}
                  aria-pressed={role.dropped}
                  disabled={disabled || (!role.dropped && keptCount === 1)}
                  onClick={() => {
                    onChange(
                      roles.map((other, at) =>
                        at === index
                          ? { ...other, dropped: !other.dropped }
                          : other,
                      ),
                    );
                  }}
                >
                  {role.dropped ? (
                    <Undo2 aria-hidden />
                  ) : (
                    <Trash2 aria-hidden />
                  )}
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The latest version of a Plan awaiting approval: its issues can be moved,
 * dropped and annotated, then saved for the Manager to replan; or the Plan
 * approved as it is.
 */
function PlanEditor({
  floor,
  floorId,
  detail,
  plan,
  onProblem,
}: {
  floor: Floor | undefined;
  floorId: string;
  detail: BatchDetail;
  plan: Plan;
  /** Says why an edit or approval was refused; null clears it. */
  onProblem: (problem: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(plan));
  const [busy, setBusy] = useState<"replanning" | "approving" | null>(null);
  const hintId = useId();
  const { batch } = detail;
  const archived = floor?.archivedAt != null;

  const kept = rows.filter(({ dropped }) => !dropped);
  const edited =
    kept.length !== plan.items.length ||
    kept.some((row, index) => {
      const before = plan.items[index];
      return (
        before?.issue !== row.item.issue ||
        (before.annotation ?? "") !== row.annotation.trim() ||
        !rolesAsPlanned(row)
      );
    });

  const update = (index: number, change: Partial<Row>) => {
    setRows(
      rows.map((row, at) => (at === index ? { ...row, ...change } : row)),
    );
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row !== undefined) {
      next.splice(index + by, 0, row);
      setRows(next);
    }
  };

  const send = async (path: "plan" | "approve", body: unknown) => {
    setBusy(path === "plan" ? "replanning" : "approving");
    onProblem(null);
    const response = await postJson(
      `${batchesUrl(floorId)}/${String(batch.id)}/${path}`,
      body,
      session?.csrfToken,
    );
    setBusy(null);
    if (response.ok) {
      queryClient.setQueryData(
        batchQuery(floorId, batch.id).queryKey,
        batchDetailSchema.parse(await response.json()),
      );
    } else {
      const refused = await readApiError(response);
      // Said by the Batch's view, so it outlasts a newer version read now.
      onProblem(
        refused.message ??
          refused.problems?.join(" ") ??
          (path === "plan"
            ? "Your edits were not saved."
            : "The Plan was not approved."),
      );
      await queryClient.invalidateQueries(batchQuery(floorId, batch.id));
    }
    await queryClient.invalidateQueries(batchesQuery(floorId));
  };

  const disabled = busy !== null || session === undefined || archived;
  return (
    <div className="space-y-3">
      <p>{plan.summary}</p>
      <p className="text-xs text-muted-foreground">
        Move, drop or write a note on any issue, and reorder or remove the work
        Roles that take turns on one, then save your edits: the Manager replans
        them as the next version, for you to approve.
      </p>
      <ol aria-label="The Plan's issues, in order" className="space-y-2">
        {rows.map((row, index) => {
          const { item } = row;
          const name = `#${String(item.issue)}`;
          return (
            <li
              key={item.issue}
              data-dropped={row.dropped ? "" : undefined}
              className={cn(
                "space-y-2 rounded-md border p-2",
                row.dropped && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={cn(row.dropped && "line-through")}>
                  <IssueLink floor={floor} issue={item.issue} /> {item.title}
                </p>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${name} up`}
                    disabled={disabled || index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${name} down`}
                    disabled={disabled || index === rows.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`${row.dropped ? "Keep" : "Drop"} ${name}`}
                    aria-pressed={row.dropped}
                    disabled={disabled}
                    onClick={() => {
                      update(index, { dropped: !row.dropped });
                    }}
                  >
                    {row.dropped ? (
                      <Undo2 aria-hidden />
                    ) : (
                      <Trash2 aria-hidden />
                    )}
                  </Button>
                </div>
              </div>
              {row.dropped ? (
                <p className="text-xs text-muted-foreground">
                  Dropped: it leaves the Batch when you save.
                </p>
              ) : (
                <>
                  <ItemDetails
                    floorId={floorId}
                    item={item}
                    showRoles={row.roles.length < 2}
                  />
                  {row.roles.length > 1 && (
                    <RolesEditor
                      name={name}
                      roles={row.roles}
                      disabled={disabled}
                      onChange={(roles) => {
                        update(index, { roles });
                      }}
                    />
                  )}
                  <div className="space-y-1">
                    <Label
                      htmlFor={`annotation-${String(batch.id)}-${String(item.issue)}`}
                      className="text-xs"
                    >
                      Your note on {name}
                    </Label>
                    <textarea
                      id={`annotation-${String(batch.id)}-${String(item.issue)}`}
                      value={row.annotation}
                      maxLength={maxPlanAnnotationLength}
                      rows={1}
                      disabled={disabled}
                      onChange={(event) => {
                        update(index, { annotation: event.target.value });
                      }}
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs"
                    />
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
      <PlanFooter plan={plan} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled || !edited || kept.length === 0}
          onClick={() =>
            void send("plan", {
              version: plan.version,
              items: kept.map((row) => ({
                issue: row.item.issue,
                annotation: row.annotation.trim(),
                ...((row.item.roles ?? []).length === 0
                  ? {}
                  : { roles: keptRoles(row) }),
              })),
            })
          }
        >
          <RotateCcw aria-hidden />
          Save edits and replan
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !edited}
          onClick={() => {
            setRows(rowsOf(plan));
          }}
        >
          <Undo2 aria-hidden />
          Undo edits
        </Button>
        <Button
          type="button"
          size="sm"
          variant={edited ? "outline" : "default"}
          aria-describedby={hintId}
          disabled={disabled || edited}
          onClick={() => void send("approve", { version: plan.version })}
        >
          <Check aria-hidden />
          Approve Plan
        </Button>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {edited
          ? "Save or undo your edits before approving."
          : `Approving starts work on ${issueList(plan.parallel[0] ?? [])}${
              plan.parallel.length > 1
                ? "; the rest follow as the issues they depend on are done"
                : ""
            }.`}
      </p>
      <p
        role="status"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        {busy !== null && <Spinner className="size-3" />}
        {busy === "replanning"
          ? "The Manager is replanning…"
          : busy === "approving"
            ? "Approving…"
            : ""}
      </p>
      {kept.length === 0 && (
        <p role="alert" className="text-sm text-destructive">
          Keep at least one issue: a Plan cannot drop every issue.
        </p>
      )}
    </div>
  );
}

/** One Batch on the whiteboard: its Plan, any version of it. */
function BatchPlans({
  floor,
  floorId,
  batchId,
  headingLevel,
}: {
  floor: Floor | undefined;
  floorId: string;
  batchId: number;
  headingLevel: 2 | 3;
}) {
  const { data: detail, error } = useQuery(batchQuery(floorId, batchId));
  const [chosen, setChosen] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const versionId = useId();
  if (error !== null) {
    return (
      <p role="alert" className="text-destructive">
        {error.message}
      </p>
    );
  }
  if (detail === undefined) {
    return <LoadingMessage>Loading the Plan…</LoadingMessage>;
  }
  const { batch, plans } = detail;
  const latest = batch.plan;
  const plan = plans.find(({ version }) => version === chosen) ?? latest;
  const awaiting = batch.status === "awaiting_approval";
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const subheading = headingLevel === 2 ? "h3" : "h4";
  return (
    <section aria-labelledby={`${versionId}-heading`} className="space-y-3">
      <header className="space-y-1">
        <Heading id={`${versionId}-heading`} className="font-semibold">
          Batch {batch.id}: {batchStatusLabels[batch.status]}
        </Heading>
        <p className="text-xs text-muted-foreground">
          {issueList(batch.issues)}, handed to the Manager{" "}
          {when(batch.createdAt)}
          {batch.startedAt !== null && <>; approved {when(batch.startedAt)}</>}
          {batch.finishedAt !== null && (
            <>; finished {when(batch.finishedAt)}</>
          )}
          .
        </p>
        {batch.onePullRequest && (
          <p className="text-xs">
            <Badge tone="info">One pull request</Badge> Its issues are worked
            one after another on one branch, ai-office/batch-{batch.id}, and
            merge together once every one is ready to merge.
          </p>
        )}
        {plans.length > 1 ? (
          <div className="flex items-center gap-2 text-xs">
            <Label htmlFor={versionId} className="text-xs">
              Version
            </Label>
            <select
              id={versionId}
              value={plan.version}
              onChange={(event) => {
                setChosen(Number(event.target.value));
              }}
              className={cn(selectClass, "w-auto min-w-0 flex-1")}
            >
              {[...plans].reverse().map((version) => (
                <option key={version.version} value={version.version}>
                  {version.version}
                  {version.version === latest.version ? " (latest)" : ""}:{" "}
                  {versionText(version)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Version {plan.version}, {versionText(plan)}, {when(plan.createdAt)}.
        </p>
      </header>
      {batch.wrapUp !== null && batch.finishedAt !== null && (
        <WrapUpView
          floor={floor}
          floorId={floorId}
          wrapUp={batch.wrapUp}
          finishedAt={batch.finishedAt}
          Heading={subheading}
        />
      )}
      {batch.acknowledgements.length > 0 && (
        <Kickoff
          floorId={floorId}
          acknowledgements={batch.acknowledgements}
          Heading={subheading}
        />
      )}
      {awaiting && plan.version === latest.version ? (
        <PlanEditor
          key={plan.version}
          floor={floor}
          floorId={floorId}
          detail={detail}
          plan={plan}
          onProblem={setProblem}
        />
      ) : (
        <>
          {awaiting && (
            <p role="note" className="text-xs">
              An earlier version: the latest, version {latest.version}, is the
              one to approve.
            </p>
          )}
          <PlanView
            floor={floor}
            floorId={floorId}
            plan={plan}
            started={plan.version === latest.version ? batch.started : []}
          />
        </>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}

/**
 * A Floor's whiteboard: the running Grilling Session, if one runs, then
 * its Batches' Plans, opening on `batchId` (or the one awaiting approval).
 * `onBatchChange` follows the Batch picked, for the page's address.
 */
export function Whiteboard(props: {
  floorId: string;
  batchId?: number | undefined;
  onBatchChange?: ((batchId: number) => void) | undefined;
  headingLevel?: 2 | 3;
}) {
  return (
    <div className="space-y-4">
      <GrillingWhiteboard
        floorId={props.floorId}
        headingLevel={props.headingLevel ?? 3}
      />
      <Plans {...props} />
    </div>
  );
}

/** The Batches' Plans on the whiteboard. */
function Plans({
  floorId,
  batchId,
  onBatchChange,
  headingLevel = 3,
}: {
  floorId: string;
  batchId?: number | undefined;
  onBatchChange?: ((batchId: number) => void) | undefined;
  /**
   * The Batch's heading: under the 3D panel's own heading (a level 2) by
   * default, or straight under the page's level 1 on its own page.
   */
  headingLevel?: 2 | 3;
}) {
  const queryClient = useQueryClient();
  useEventStream(
    { floorId, types: batchEventTypes },
    {
      onEvent: () => {
        void queryClient.invalidateQueries({
          queryKey: ["floors", floorId, "batches"],
        });
      },
    },
  );
  const { data: list, error } = useQuery(batchesQuery(floorId));
  const { data: floor } = useQuery(floorQuery(floorId));
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const batches = list?.batches ?? [];
  const shown =
    batches.find(({ id }) => id === (picked ?? batchId)) ??
    currentBatch(batches);

  if (error !== null) {
    return (
      <p role="alert" className="text-destructive">
        {error.message}
      </p>
    );
  }
  if (list === undefined) {
    return <LoadingMessage>Loading the Plans…</LoadingMessage>;
  }
  if (shown === undefined) {
    return (
      <p className="text-muted-foreground">
        No Plans yet. Tell the Manager <q>complete issues 1 to 5</q> in{" "}
        <Link
          to="/floors/$floorId/manager"
          params={{ floorId }}
          className="font-medium hover:underline"
        >
          the Manager chat
        </Link>{" "}
        and its Plan appears here.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {batches.length > 1 && (
        <nav aria-label="Batches on this whiteboard">
          <ul className="flex flex-wrap gap-1">
            {batches.map((batch) => (
              <li key={batch.id}>
                <Button
                  type="button"
                  size="sm"
                  variant={batch.id === shown.id ? "secondary" : "ghost"}
                  aria-current={batch.id === shown.id ? "true" : undefined}
                  onClick={() => {
                    setPicked(batch.id);
                    onBatchChange?.(batch.id);
                  }}
                >
                  Batch {batch.id}: {batchStatusLabels[batch.status]}
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <BatchPlans
        key={shown.id}
        floor={floor}
        floorId={floorId}
        batchId={shown.id}
        headingLevel={headingLevel}
      />
    </div>
  );
}

/** The whiteboard's page: the Floor, then its whiteboard. */
export function WhiteboardPage({
  floorId,
  batchId,
  onBatchChange,
}: {
  floorId: string;
  batchId?: number | undefined;
  onBatchChange?: ((batchId: number) => void) | undefined;
}) {
  const { data: floor } = useQuery(floorQuery(floorId));
  return (
    <section className="max-w-3xl space-y-4">
      <PageHeader
        title="Whiteboard"
        eyebrow={
          <Link to="/floor-settings/$floorId" params={{ floorId }}>
            {floor?.name ?? floorId}
          </Link>
        }
        description={
          <>
            The Plans of {floor?.name ?? floorId}&apos;s Batches, current and
            past. A Plan awaiting approval can be edited here before you approve
            it.
          </>
        }
      />
      <Whiteboard
        floorId={floorId}
        batchId={batchId}
        onBatchChange={onBatchChange}
        headingLevel={2}
      />
    </section>
  );
}
