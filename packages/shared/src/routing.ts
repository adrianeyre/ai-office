import type { PipelineLabel } from "./pipeline.ts";
import type { RoleDefinition } from "./roles.ts";

// Routing between work Roles (PRD FR-23, ADR 0003): when a Floor has more
// than one work-Stage Role, the Manager's triage picks the Role for each
// issue from the Roles' routing descriptions. A `role:<name>` label on the
// issue forces one, and when the Manager cannot tell, it asks the Owner
// with an action Notice offering each candidate Role. A Floor with one
// work Role never asks.

/** What a label that forces a work Role starts with. */
export const roleLabelPrefix = "role:";

/** The label that forces `role`: `role:` and its name, such as `role:copywriter`. */
export const roleLabelName = (role: Pick<RoleDefinition, "name">): string =>
  `${roleLabelPrefix}${role.name}`;

/** The `role:<name>` label each work Role gets on its Floor's repository. */
export const roleLabel = (
  role: Pick<RoleDefinition, "name">,
): PipelineLabel => ({
  name: roleLabelName(role),
  color: "bfdadc",
  description: `AI Office: work this issue as the ${role.name}`.slice(0, 100),
});

/**
 * The Roles of `roles` that `labels` force, in `roles`' order: a
 * `role:<name>` label names a Role by its name or its id, in any case.
 */
export const rolesLabelled = <Role extends Pick<RoleDefinition, "id" | "name">>(
  labels: readonly string[],
  roles: readonly Role[],
): Role[] => {
  const named = new Set(
    labels
      .filter((label) =>
        label.toLowerCase().startsWith(roleLabelPrefix.toLowerCase()),
      )
      .map((label) => label.slice(roleLabelPrefix.length).trim().toLowerCase()),
  );
  return roles.filter(
    ({ id, name }) => named.has(name.toLowerCase()) || named.has(id),
  );
};

/**
 * How a work Role was chosen for an issue: by the Manager's Model at
 * triage, a `role:` label, the Owner on a Notice, or its Batch's Plan,
 * which may give it several in turn (FR-25 (1)).
 */
export const routeJudges = ["model", "label", "owner", "plan"] as const;
export type RouteJudge = (typeof routeJudges)[number];

/**
 * The actions on a Notice asking the Owner which Role should work an
 * issue, one per candidate Role, in the order the Notice offers them. A
 * Notice offers at most four actions, so at most four candidates.
 */
export const routingActions = [
  "route_issue_to_role_1",
  "route_issue_to_role_2",
  "route_issue_to_role_3",
  "route_issue_to_role_4",
] as const;

/** The most candidate Roles one Notice offers the Owner. */
export const maxRoleCandidates = routingActions.length;
