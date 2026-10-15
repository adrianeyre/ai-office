import {
  managerRole,
  maxMostAgents,
  roleName,
  sandboxStages,
  teamChangeSchema,
  type Agent,
  type Floor,
  type LibraryRole,
  type Role,
  type TeamChange,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

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

import { roleLabel } from "./agents-card.tsx";
import { readApiError, sendJson } from "./api.ts";
import { agentsQuery, floorQuery } from "./floors.ts";
import { rolesQuery } from "./role-library.tsx";
import { sandboxesQuery } from "./sandboxes-card.tsx";
import { sessionQuery } from "./session.ts";
import { wallBoardQuery } from "./wall-board.ts";

// A Floor's team size (PRD FR-10): how many Agents of each Role work it.
// Raising a count adds Agents copied from the Role's first Agent, each
// with its own name, Avatar and Gateway Key; lowering it removes idle
// Agents first, and a busy one finishes its task before it leaves. The
// Manager is fixed at 1. The whole team besides the Manager stays within
// the Floor's "most Agents", the Owner's and Contractors alike (FR-10,
// ADR 0004); there is no other cap on one Role. A warning says when the Floor has more sandbox
// Agents than the concurrency limits let run at once (FR-22).

/** The Roles the team card counts: the Manager's, then the Role library's. */
const rolesOf = (library: readonly LibraryRole[]): Role[] => [
  managerRole,
  ...library.map(({ id }) => id),
];

/** How many Agents of each Role stay on the Floor: leaving ones aside. */
export function teamSizes(
  agents: readonly Agent[],
  roles: readonly Role[],
): Record<Role, number> {
  const sizes: Record<Role, number> = Object.fromEntries(
    roles.map((role) => [role, 0]),
  );
  for (const agent of agents) {
    if (agent.leavingAt === null) {
      sizes[agent.role] = (sizes[agent.role] ?? 0) + 1;
    }
  }
  return sizes;
}

/**
 * How many sandboxes the Floor may run at once: the office's limit, or
 * its own when lower; undefined until the office's is known.
 */
export function sandboxLimit(
  floor: Pick<Floor, "concurrencyLimit">,
  officeLimit: number | undefined,
): { readonly limit: number; readonly floors: boolean } | undefined {
  if (officeLimit === undefined) {
    return undefined;
  }
  return floor.concurrencyLimit !== null && floor.concurrencyLimit < officeLimit
    ? { limit: floor.concurrencyLimit, floors: true }
    : { limit: officeLimit, floors: false };
}

/** A list of names in words: "Ada", "Ada and Alan", "Ada, Alan and Grace". */
const names = (agents: readonly Agent[]): string => {
  const all = agents.map(({ name }) => name);
  return all.length <= 1
    ? (all[0] ?? "")
    : `${all.slice(0, -1).join(", ")} and ${all.at(-1) ?? ""}`;
};

/** What a change of team size did, in words. */
export function teamChangeText(
  role: Role,
  change: TeamChange,
  library?: readonly LibraryRole[],
): string[] {
  const said: string[] = [];
  if (change.added.length > 0) {
    said.push(
      `Added ${names(change.added)}, copied from the first ${roleName(role, library)}.`,
    );
  }
  if (change.removed.length > 0) {
    said.push(`Removed ${names(change.removed)}.`);
  }
  if (change.leaving.length > 0) {
    said.push(
      `${names(change.leaving)} ${change.leaving.length === 1 ? "is" : "are"} in the middle of a task, and ${change.leaving.length === 1 ? "leaves" : "leave"} once it ends.`,
    );
  }
  return said;
}

/** The counts as typed: text until saved. */
type Counts = Record<Role, string>;

const countsOf = (agents: readonly Agent[], roles: readonly Role[]): Counts =>
  Object.fromEntries(
    Object.entries(teamSizes(agents, roles)).map(([role, size]) => [
      role,
      String(size),
    ]),
  );

/** A count as a number, or undefined when it is not a whole number. */
const countOf = (text: string): number | undefined => {
  const count = Number(text);
  return text.trim() !== "" && Number.isInteger(count) ? count : undefined;
};

/** What the last save did, and what was refused. */
interface Report {
  readonly said: readonly string[];
  readonly problems: readonly string[];
}

function TeamForm({
  floor,
  agents,
  library,
  onSaved,
}: {
  floor: Floor;
  agents: readonly Agent[];
  /** The office Role library: every Role the Floor may have Agents in. */
  library: readonly LibraryRole[];
  onSaved: (report: Report) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: office } = useQuery(sandboxesQuery);
  const roles = rolesOf(library);
  const name = (role: Role) => roleName(role, library);
  const saved = countsOf(agents, roles);
  const [counts, setCounts] = useState<Counts>(saved);
  const [busy, setBusy] = useState(false);
  const archived = floor.archivedAt !== null;
  const leaving = (role: Role) =>
    agents.filter((agent) => agent.role === role && agent.leavingAt !== null)
      .length;
  const changed = roles.filter(
    (role) => role !== "manager" && counts[role] !== saved[role],
  );

  // Agents whose Role's Stage works in sandboxes (FR-19).
  const sandboxAgents = library
    .filter(({ stage }) => sandboxStages.includes(stage))
    .map(({ id }) => id)
    .reduce((sum, role) => sum + (countOf(counts[role] ?? "") ?? 0), 0);
  const limit = sandboxLimit(floor, office?.concurrencyLimit);

  // Staying Agents in no library Role: Contractors in one-off Roles (ADR
  // 0004), which count towards "most Agents" too.
  const others = agents.filter(
    (agent) =>
      agent.leavingAt === null &&
      agent.role !== managerRole &&
      !roles.includes(agent.role),
  ).length;
  const typed = (role: Role) => countOf(counts[role] ?? "") ?? 0;
  const team =
    others +
    roles
      .filter((role) => role !== managerRole)
      .reduce((sum, role) => sum + typed(role), 0);
  /** The most Agents `role` may have, the rest of the team as typed. */
  const mostFor = (role: Role): number =>
    Math.min(
      maxMostAgents,
      floor.mostAgents === null
        ? maxMostAgents
        : Math.max(0, floor.mostAgents - (team - typed(role))),
    );

  const save = async () => {
    setBusy(true);
    onSaved({ said: [], problems: [] });
    const done: string[] = [];
    const refused: string[] = [];
    if (floor.mostAgents !== null && team > floor.mostAgents) {
      onSaved({
        said: [],
        problems: [
          `${floor.name} may have at most ${String(floor.mostAgents)} ${floor.mostAgents === 1 ? "Agent" : "Agents"} besides its Manager, and these numbers make ${String(team)}: lower one, or raise "Most Agents" in the Floor's settings.`,
        ],
      });
      setBusy(false);
      return;
    }
    for (const role of changed) {
      const count = countOf(counts[role] ?? "");
      if (count === undefined || count < 0 || count > maxMostAgents) {
        refused.push(
          `The number of ${name(role)} Agents is a whole number from 0 to ${String(mostFor(role))}.`,
        );
        continue;
      }
      const response = await sendJson(
        "PUT",
        `/api/floors/${encodeURIComponent(floor.id)}/team/${role}`,
        { count },
        session?.csrfToken,
      );
      if (response.ok) {
        done.push(
          ...teamChangeText(
            role,
            teamChangeSchema.parse(await response.json()),
            library,
          ),
        );
      } else {
        const error = await readApiError(response);
        refused.push(
          ...(error.problems ?? [
            error.message ?? `The ${name(role)} team was not changed.`,
          ]),
        );
      }
    }
    onSaved({ said: done, problems: refused });
    setBusy(false);
    // The form starts again from the new team.
    await Promise.all([
      queryClient.invalidateQueries(agentsQuery(floor.id)),
      // Removing a reviewer may change who is required.
      queryClient.invalidateQueries(floorQuery(floor.id)),
      queryClient.invalidateQueries(wallBoardQuery(floor.id)),
    ]);
  };

  return (
    <form
      noValidate
      aria-label="Team size"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset
        disabled={archived}
        className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6"
      >
        {roles.map((role) => (
          <div key={role} className="space-y-2">
            <Label htmlFor={`team-${role}`}>{roleLabel(role, library)}</Label>
            {role === "manager" ? (
              <>
                <Input
                  id="team-manager"
                  value="1"
                  readOnly
                  aria-describedby="team-manager-hint"
                />
                <p
                  id="team-manager-hint"
                  className="text-xs text-muted-foreground"
                >
                  Fixed: every Floor has exactly one.
                </p>
              </>
            ) : (
              <>
                <Input
                  id={`team-${role}`}
                  type="number"
                  min={0}
                  max={mostFor(role)}
                  value={counts[role]}
                  aria-describedby={
                    leaving(role) > 0 ? `team-${role}-hint` : undefined
                  }
                  onChange={(event) => {
                    setCounts({ ...counts, [role]: event.target.value });
                  }}
                />
                {leaving(role) > 0 && (
                  <p
                    id={`team-${role}-hint`}
                    className="text-xs text-muted-foreground"
                  >
                    And {leaving(role)} leaving once{" "}
                    {leaving(role) === 1 ? "its task ends" : "their tasks end"}.
                  </p>
                )}
              </>
            )}
          </div>
        ))}
      </fieldset>
      {limit !== undefined && sandboxAgents > limit.limit && (
        <p
          role="status"
          className="flex gap-2 rounded-md border border-office-state-warning p-3 text-sm"
        >
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-office-state-warning"
          />
          <span>
            <strong className="font-medium">
              Not every sandbox Agent can work at once.
            </strong>{" "}
            {floor.name} would have {sandboxAgents} sandbox Agents (in the work,
            QA and docs Stages), but at most {limit.limit}{" "}
            {limit.limit === 1 ? "sandbox runs" : "sandboxes run"} at once
            {limit.floors
              ? " under this Floor's concurrency limit"
              : " under the office's concurrency limit"}
            . The rest wait their turn.
          </span>
        </p>
      )}
      {!archived && (
        <Button
          pending={busy}
          type="submit"
          disabled={
            changed.length === 0 || busy || session?.csrfToken === undefined
          }
        >
          {busy ? "Saving…" : "Save team"}
        </Button>
      )}
    </form>
  );
}

/**
 * The Floor admin's Team card (FR-10): the number of Agents in each Role,
 * and a warning when they outnumber the sandboxes that may run at once.
 */
export function TeamCard({ floor }: { floor: Floor }) {
  const { data: agents, isError } = useQuery(agentsQuery(floor.id));
  const { data: library, isError: libraryError } = useQuery(rolesQuery);
  const [report, setReport] = useState<Report>({ said: [], problems: [] });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Team</h2>
        </CardTitle>
        <CardDescription>
          How many Agents of each Role work this Floor. A new Agent is copied
          from its Role&apos;s first Agent (AI Provider, Model, effort, extra
          instructions and Token Caps), with a name, an Avatar and a Gateway Key
          of its own. Lowering a number removes idle Agents first; one in the
          middle of a task finishes it, then leaves.{" "}
          {floor.mostAgents === null
            ? "This Floor has no limit on its Agents."
            : `At most ${String(floor.mostAgents)} Agents besides the Manager, Contractors included.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {(isError || libraryError) && (
          <p role="alert" className="text-sm text-destructive">
            The team could not be loaded.
          </p>
        )}
        {agents !== undefined && library !== undefined && (
          // Starts again from the team, or the library, whenever either
          // changes elsewhere.
          <TeamForm
            key={[
              ...agents.map(({ id, leavingAt }) => `${id}:${leavingAt ?? ""}`),
              ...library.map(({ id }) => id),
            ].join(",")}
            floor={floor}
            agents={agents}
            library={library}
            onSaved={setReport}
          />
        )}
        {report.said.length > 0 && (
          <ul role="status" className="mt-4 space-y-1 text-sm">
            {report.said.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {report.problems.length > 0 && (
          <ul role="alert" className="mt-4 space-y-1 text-sm text-destructive">
            {report.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
