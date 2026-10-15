import {
  roleMemoryListSchema,
  inLibraryOrder,
  roleName,
  type Floor,
  type RoleMemoryEntry,
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
import { LoadingMessage } from "@/components/ui/spinner.tsx";

import { useAnchor } from "./anchor.ts";
import { getJson, postJson, readApiError, sendDelete } from "./api.ts";
import { agentsQuery } from "./floors.ts";
import { sessionQuery } from "./session.ts";

// A Floor's Role memory in its admin (PRD FR-55, FR-56): for each Role,
// the entries its Agents read, and those its Agents proposed in their
// Handoffs, waiting for the Manager or the Owner. Only the Owner accepts
// one (ADR 0005): a proposal the Manager recommends waits for them too,
// with the Manager's reason. The Owner accepts or rejects a proposal, and
// removes an accepted entry.

/** `GET /api/floors/:floorId/role-memory`. */
export const roleMemoryQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "role-memory"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/role-memory`,
        roleMemoryListSchema,
      ),
  });

type Action = "accept" | "reject" | "remove";

const actionLabels: Record<Action, string> = {
  accept: "Accept",
  reject: "Reject",
  remove: "Remove",
};

export function RoleMemoryCard({ floor }: { floor: Floor }) {
  const queryClient = useQueryClient();
  const anchor = useAnchor<HTMLDivElement>("role-memory");
  const { data: session } = useQuery(sessionQuery);
  const query = roleMemoryQuery(floor.id);
  const { data: list, error } = useQuery(query);
  const { data: agents } = useQuery(agentsQuery(floor.id));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const archived = floor.archivedAt !== null;

  const nameOf = (agentId: string): string =>
    agents?.find(({ id }) => id === agentId)?.name ?? "An Agent";

  const act = async (entry: RoleMemoryEntry, action: Action) => {
    setBusy(entry.id);
    setProblem(null);
    const url = `/api/floors/${encodeURIComponent(floor.id)}/role-memory/${String(entry.id)}`;
    const response =
      action === "remove"
        ? await sendDelete(url, session?.csrfToken)
        : await postJson(`${url}/${action}`, {}, session?.csrfToken);
    setBusy(null);
    if (!response.ok) {
      const refused = await readApiError(response);
      setProblem(refused.message ?? "The Role memory was not changed.");
    }
    await queryClient.invalidateQueries({ queryKey: query.queryKey });
  };

  const button = (entry: RoleMemoryEntry, action: Action) => (
    <Button
      type="button"
      size="sm"
      variant={action === "accept" ? "default" : "outline"}
      aria-label={`${actionLabels[action]} "${entry.text}"`}
      disabled={archived || busy === entry.id || session === undefined}
      onClick={() => void act(entry, action)}
    >
      {actionLabels[action]}
    </Button>
  );

  const roles = inLibraryOrder(list?.entries.map(({ role }) => role) ?? []);

  return (
    <Card id="role-memory" ref={anchor} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Role memory</h2>
        </CardTitle>
        <CardDescription>
          What Agents of each Role on this Floor have learned. Agents propose
          entries in their Handoffs; the Manager recommends or rejects each, and
          only you accept one. Accepted entries are mounted read-only into the
          sandboxes of that Role&apos;s Agents, and quoted in reviewers&apos;
          prompts. Entries that look like a credential are refused.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error !== null && (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        )}
        {list === undefined && error === null && (
          <LoadingMessage>Loading the Role memory…</LoadingMessage>
        )}
        {list?.entries.length === 0 && (
          <p className="text-muted-foreground">
            No Role memory yet. Agents propose entries in their Handoffs.
          </p>
        )}
        {roles.map((role) => {
          const entries = list?.entries.filter((entry) => entry.role === role);
          const accepted =
            entries?.filter(({ status }) => status === "accepted") ?? [];
          const proposed =
            entries?.filter(
              ({ status }) => status === "proposed" || status === "recommended",
            ) ?? [];
          return (
            <section key={role} aria-labelledby={`role-memory-${role}`}>
              <h3 id={`role-memory-${role}`} className="font-medium">
                {roleName(role)}
              </h3>
              {accepted.length > 0 && (
                <ul
                  aria-label={`Accepted ${roleName(role)} memory`}
                  className="mt-1 space-y-1"
                >
                  {accepted.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <span>{entry.text}</span>
                      {button(entry, "remove")}
                    </li>
                  ))}
                </ul>
              )}
              {proposed.length > 0 && (
                <>
                  <h4 className="mt-2 text-sm text-muted-foreground">
                    Proposed, waiting for a decision
                  </h4>
                  <ul
                    aria-label={`Proposed ${roleName(role)} memory`}
                    className="mt-1 space-y-1"
                  >
                    {proposed.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-start justify-between gap-3 text-sm"
                      >
                        <span>
                          {entry.text}{" "}
                          <span className="text-muted-foreground">
                            ({nameOf(entry.agentId)}, on #{entry.issue}
                            {entry.status === "recommended" &&
                              `; the Manager recommends it${
                                entry.reason === null
                                  ? ""
                                  : `: ${entry.reason.replace(/[.!?]+$/, "")}`
                              }`}
                            )
                          </span>
                        </span>
                        <span className="flex shrink-0 gap-2">
                          {button(entry, "accept")}
                          {button(entry, "reject")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          );
        })}
        {problem !== null && (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
