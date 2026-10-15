import type {
  PlanDraft,
  PlanItem,
  PlanLeftOut,
  PlanOverlap,
} from "@ai-office/shared";

import type { AgentRecord } from "../agents/store.ts";
import { issueList } from "../manager/commands.ts";
import { chooseAgentByLoad, loads } from "../manager/dispatch.ts";
import type { WorkRole } from "../manager/triage.ts";
import type { ParsedAnswer } from "../review/verdict.ts";
import type { WorkItem } from "../work/store.ts";
import type { PlanContent } from "./store.ts";

// A Batch's Plan, in plain code (PRD FR-25). The Manager's Model drafts
// the order, the dependencies, the likely files and the assignments; AI
// Office checks the draft against the Batch (every issue once, each
// depending only on issues before it, each given to one of the Floor's
// coders or to none), and completes it:
//
// - **Overlaps.** Two issues likely to change the same file are an
//   overlap, and are run one after another (FR-25.5): the later depends on
//   the earlier, unless it already does through others.
// - **Assignments.** An issue given to no coder goes to the one with the
//   least work, counting the work queued or running and what the Plan has
//   given out so far, as the Manager's dispatch rules choose (FR-23).
// - **Parallel groups.** Issues with no dependency between them run in
//   parallel: each group starts once every issue it depends on is done.
//
// - **Work Roles.** On a Floor with several work Roles, the draft may give
//   an issue an ordered list of them (FR-25 (1)): each one of the Floor's,
//   once. They take turns on the issue's one branch, so its coder is one
//   of its first Role's. An issue given none gets its one Role from the
//   Manager's triage as it starts. On a Floor with one work Role, a Plan
//   gives none: that Role works every issue.
//
// When the Manager's Model gives no Plan, AI Office's own rules draft one
// (FR-17): the issues in the order named, all at once, shared out across
// the coders.
//
// The Owner can edit a Plan awaiting approval on the whiteboard (FR-25.3):
// reorder its issues, drop some and annotate others, and reorder or remove
// an issue's work Roles. The Manager then replans, keeping the Owner's
// order and Roles exactly; plain code checks that, and completes the
// replan as it does a draft. Without the Model, the rules replan: the
// Owner's order and Roles, keeping what the Plan said about each issue.
//
// From the Manager chat the Owner can also skip issues ("skip 4") or move
// one ("move 5 up") while the Batch's work is under way (FR-24, FR-25.4).
// Work that has started is never restarted or dropped: those issues come
// first, exactly as they were, and only the issues still to start are
// skipped or reordered among themselves. The rules replan the rest as they
// replan the Owner's edits, sequencing overlaps again in the new order
// without giving a started issue anything new to wait for.

/** One of a Batch's issues, as the Plan names it. */
export interface PlanIssue {
  readonly number: number;
  /** Its title, redacted. */
  readonly title: string;
}

/** One of the issues the Owner kept, in their order, with their annotation. */
export interface EditedIssue extends PlanIssue {
  /** The Owner's annotation (redacted); empty for none. */
  readonly annotation: string;
  /**
   * The work Roles (ids) the Owner kept for it, in their order; undefined
   * when the Plan gave it none.
   */
  readonly roles?: readonly string[];
}

/** Who a Plan can give work to, and their work so far. */
export interface PlanTeam {
  /** The Floor's Agents, oldest first. */
  readonly agents: readonly AgentRecord[];
  /** The work queued or running, everywhere. */
  readonly active: readonly WorkItem[];
  /** The Agents paused at a Token Cap. */
  readonly paused: readonly string[];
  /**
   * The Floor's work Roles, which a Plan may give an issue several of in
   * turn (FR-25 (1)); none when it cannot.
   */
  readonly roles?: readonly WorkRole[];
}

/** The stage a Batch's issues start at: the work Stage's. */
const workStage = "needs-work";

/**
 * The Floor's Agents that a Plan may give an issue to: those enabled in a
 * work-Stage Role, such as its coders.
 */
export const plannableCoders = (
  agents: readonly AgentRecord[],
): AgentRecord[] =>
  agents.filter(({ stage, enabled }) => stage === "work" && enabled);

/** A file path as a Plan keeps it: `/`-separated, from the repository's root. */
const normalisePath = (path: string): string =>
  path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/|\/)+/, "");

const unique = <Value>(values: readonly Value[]): Value[] => [
  ...new Set(values),
];

/**
 * The work Roles a Plan may give issues: the Floor's, when it has more
 * than one. With one, that Role works every issue, and none is named.
 */
const plannableRoles = (team: PlanTeam): readonly WorkRole[] =>
  (team.roles ?? []).length > 1 ? (team.roles ?? []) : [];

/** Roles' names as the Plan's checks name them: "the a, then the b". */
const inTurn = (roles: readonly string[], names: readonly WorkRole[]): string =>
  roles
    .map((id) => `the ${names.find((role) => role.id === id)?.name ?? id}`)
    .join(", then ");

/** `coder` may work an issue whose first work Role is `role`, if any. */
const fitsRole = (
  coder: Pick<AgentRecord, "role">,
  role: string | undefined,
): boolean => role === undefined || coder.role === role;

/** `item` with its work Roles, when it has any. */
const withRoles = (
  item: PlanItem,
  roles: readonly string[] | undefined,
): PlanItem => {
  const rest: PlanItem = { ...item };
  delete rest.roles;
  return roles === undefined || roles.length === 0
    ? rest
    : { ...rest, roles: [...roles] };
};

/**
 * Gives each issue without a coder the one with the least work: in its
 * first work Role, when it has `roles`.
 */
function assign(
  wanted: readonly (string | null)[],
  team: PlanTeam,
  roles: readonly (readonly string[] | undefined)[] = [],
): (string | null)[] {
  const load = loads(team.active);
  for (const agentId of wanted) {
    if (agentId !== null) {
      load.set(agentId, (load.get(agentId) ?? 0) + 1);
    }
  }
  return wanted.map((agentId, index) => {
    if (agentId !== null) {
      return agentId;
    }
    const chosen = chooseAgentByLoad(
      workStage,
      team.agents,
      load,
      team.paused,
      roles[index]?.[0] ?? null,
    );
    if (chosen !== null) {
      load.set(chosen, (load.get(chosen) ?? 0) + 1);
    }
    return chosen;
  });
}

/**
 * The overlaps between `items` (in the Plan's order), each made a
 * dependency of the later issue on the earlier unless it is one already
 * (or the later is `pinned`: its work has started), and the items with
 * those dependencies, in the Plan's order.
 */
function sequenceOverlaps(
  items: readonly PlanItem[],
  pinned: ReadonlySet<number>,
): {
  items: PlanItem[];
  overlaps: PlanOverlap[];
} {
  const overlaps: PlanOverlap[] = [];
  const done: PlanItem[] = [];
  /** Every issue each one depends on, directly or through others. */
  const reach = new Map<number, Set<number>>();
  for (const item of items) {
    const dependsOn = [...item.dependsOn];
    const reached = new Set<number>();
    const add = (issue: number) => {
      reached.add(issue);
      for (const further of reach.get(issue) ?? []) {
        reached.add(further);
      }
    };
    dependsOn.forEach(add);
    for (const earlier of done) {
      const shared = item.files.filter((file) => earlier.files.includes(file));
      if (shared.length === 0) {
        continue;
      }
      overlaps.push({ issues: [earlier.issue, item.issue], files: shared });
      if (!reached.has(earlier.issue) && !pinned.has(item.issue)) {
        dependsOn.push(earlier.issue);
        add(earlier.issue);
      }
    }
    reach.set(item.issue, reached);
    const position = (issue: number) =>
      items.findIndex((candidate) => candidate.issue === issue);
    done.push({
      ...item,
      dependsOn: unique(dependsOn).sort((a, b) => position(a) - position(b)),
    });
  }
  return { items: done, overlaps };
}

/**
 * Which issues run at once: each group follows every group holding an
 * issue it depends on, and keeps the Plan's order within it.
 */
export function parallelGroups(items: readonly PlanItem[]): number[][] {
  const group = new Map<number, number>();
  for (const item of items) {
    group.set(
      item.issue,
      item.dependsOn.reduce(
        (latest, issue) => Math.max(latest, (group.get(issue) ?? 0) + 1),
        0,
      ),
    );
  }
  const groups: number[][] = [];
  for (const item of items) {
    const index = group.get(item.issue) ?? 0;
    (groups[index] ??= []).push(item.issue);
  }
  return groups.filter((issues) => issues.length > 0);
}

/** The Plan from items in order: overlaps sequenced, groups worked out. */
function complete(
  draftedBy: PlanContent["draftedBy"],
  summary: string,
  items: readonly PlanItem[],
  leftOut: readonly PlanLeftOut[],
  pinned: ReadonlySet<number> = new Set(),
): PlanContent {
  const sequenced = sequenceOverlaps(items, pinned);
  return {
    draftedBy,
    summary,
    items: sequenced.items,
    overlaps: sequenced.overlaps,
    parallel: parallelGroups(sequenced.items),
    leftOut: [...leftOut],
  };
}

/**
 * Checks the Manager's draft against the Batch's `issues` and the Floor's
 * coders, and completes it as a Plan; or says what is wrong with it, in
 * sentences the Model can act on.
 */
export function planFromDraft(
  draft: PlanDraft,
  issues: readonly PlanIssue[],
  team: PlanTeam,
  leftOut: readonly PlanLeftOut[],
): ParsedAnswer<PlanContent> {
  const problems: string[] = [];
  const inBatch = new Map(issues.map((issue) => [issue.number, issue]));
  const all = issueList(issues.map(({ number }) => number));
  const coders = plannableCoders(team.agents);
  const workRoles = plannableRoles(team);
  const order = draft.issues.map(({ issue }) => issue);
  const named = (role: WorkRole, given: string): boolean =>
    role.id === given || role.name.toLowerCase() === given.toLowerCase();
  /** Each issue's work Roles, by id, as far as they are the Floor's. */
  const rolesOf = draft.issues.map(({ roles }) =>
    workRoles.length === 0
      ? []
      : (roles ?? []).flatMap((given) =>
          workRoles.filter((role) => named(role, given)).map(({ id }) => id),
        ),
  );

  for (const [index, planned] of draft.issues.entries()) {
    const name = `#${String(planned.issue)}`;
    if (!inBatch.has(planned.issue)) {
      problems.push(`${name} is not in the Batch: plan only ${all}.`);
      continue;
    }
    if (order.indexOf(planned.issue) !== index) {
      problems.push(`${name} is planned twice: plan each issue once.`);
      continue;
    }
    for (const dependency of planned.dependsOn) {
      const at = order.indexOf(dependency);
      if (dependency === planned.issue) {
        problems.push(`${name} depends on itself.`);
      } else if (!inBatch.has(dependency)) {
        problems.push(
          `${name} depends on #${String(dependency)}, which is not in the Batch: depend only on ${all}.`,
        );
      } else if (at > index) {
        problems.push(
          `${name} depends on #${String(dependency)}, which comes after it: an issue may depend only on issues before it, so put #${String(dependency)} first.`,
        );
      }
    }
    const roles = rolesOf[index] ?? [];
    if (workRoles.length > 0) {
      for (const given of planned.roles ?? []) {
        if (!workRoles.some((role) => named(role, given))) {
          problems.push(
            `${name} names "${given}" in roles, which is not one of the Floor's work Roles: name only ${workRoles.map((role) => role.name).join(" or ")}.`,
          );
        }
      }
      if (new Set(roles).size !== roles.length) {
        problems.push(
          `${name} names a work Role twice in roles: each Role takes one turn.`,
        );
      }
    }
    const firstRole = workRoles.find(({ id }) => id === roles[0]);
    const coder = coders.find(
      (candidate) =>
        candidate.name.toLowerCase() === planned.agent?.toLowerCase(),
    );
    if (
      coder !== undefined &&
      firstRole !== undefined &&
      !fitsRole(coder, firstRole.id)
    ) {
      const fitting = coders.filter((candidate) =>
        fitsRole(candidate, firstRole.id),
      );
      problems.push(
        `${name} is given to "${coder.name}", who is not a ${firstRole.name}, its first work Role: ${
          fitting.length === 0
            ? "make agent null"
            : `give it to ${fitting.map(({ name: fits }) => fits).join(" or ")}, or make agent null`
        }.`,
      );
    }
    if (
      planned.agent !== null &&
      !coders.some(
        (coder) => coder.name.toLowerCase() === planned.agent?.toLowerCase(),
      )
    ) {
      problems.push(
        coders.length === 0
          ? `${name} is given to "${planned.agent}", but the Floor has no coder to give it to: make agent null.`
          : `${name} is given to "${planned.agent}", who is not one of the Floor's coders: give it to ${coders
              .map(({ name: coder }) => coder)
              .join(" or ")}, or make agent null.`,
      );
    }
  }
  const missing = issues.filter(({ number }) => !order.includes(number));
  if (missing.length > 0) {
    problems.push(
      `${issueList(missing.map(({ number }) => number))} ${missing.length === 1 ? "is" : "are"} missing: plan every issue in the Batch once.`,
    );
  }
  if (problems.length > 0) {
    return { ok: false, problem: problems.join(" ") };
  }

  const assignments = assign(
    draft.issues.map(
      ({ agent }) =>
        coders.find(
          (coder) => coder.name.toLowerCase() === agent?.toLowerCase(),
        )?.id ?? null,
    ),
    team,
    rolesOf,
  );
  const items = draft.issues.map((planned, index): PlanItem =>
    withRoles(
      {
        issue: planned.issue,
        title: inBatch.get(planned.issue)?.title ?? "",
        dependsOn: unique(planned.dependsOn),
        files: unique(planned.files.map(normalisePath).filter(Boolean)),
        agentId: assignments[index] ?? null,
        note: planned.note,
      },
      rolesOf[index],
    ),
  );
  return {
    ok: true,
    value: complete("model", draft.summary, items, leftOut),
  };
}

/**
 * AI Office's own Plan, for when the Manager's Model gives none (FR-17):
 * the issues in the order named, all at once, shared out across the
 * coders. `reason` says why the Model did not plan.
 */
export function planByRules(
  issues: readonly PlanIssue[],
  team: PlanTeam,
  leftOut: readonly PlanLeftOut[],
  reason: string,
): PlanContent {
  const assignments = assign(
    issues.map(() => null),
    team,
  );
  return complete(
    "rules",
    `AI Office's rules drafted this Plan, as ${reason}: the issues in the order you named them, with no dependencies between them, so they run in parallel as the Floor's coders and sandboxes are free.`,
    issues.map((issue, index) => ({
      issue: issue.number,
      title: issue.title,
      dependsOn: [],
      files: [],
      agentId: assignments[index] ?? null,
      note: "",
    })),
    leftOut,
  );
}

/**
 * The coder an issue keeps when it is replanned: `agentId` while it is
 * still one of the Floor's enabled coders, in its first work Role if it
 * has `roles`; otherwise null, to be shared out again.
 */
const keptCoder = (
  agentId: string | null,
  roles: readonly string[] | undefined,
  team: PlanTeam,
): string | null => {
  const coder = plannableCoders(team.agents).find(({ id }) => id === agentId);
  return coder !== undefined && fitsRole(coder, roles?.[0]) ? coder.id : null;
};

/** `items` with each issue's annotation from the Owner, where they wrote one. */
const annotated = (
  items: readonly PlanItem[],
  edited: readonly EditedIssue[],
): PlanItem[] =>
  items.map((item) => {
    const annotation = edited.find(
      ({ number }) => number === item.issue,
    )?.annotation;
    return annotation === undefined || annotation === ""
      ? item
      : { ...item, annotation };
  });

/**
 * Checks the Manager's replan of the Owner's edits: every issue the Owner
 * kept once, in exactly their order, then as `planFromDraft` checks a
 * draft. Completes it with the Owner's annotations; or says what is wrong.
 */
export function replanFromDraft(
  draft: PlanDraft,
  edited: readonly EditedIssue[],
  team: PlanTeam,
  leftOut: readonly PlanLeftOut[],
): ParsedAnswer<PlanContent> {
  const order = edited.map(({ number }) => number);
  const planned = draft.issues.map(({ issue }) => issue);
  if (
    planned.length === order.length &&
    planned.every((issue, index) => issue === order[index])
  ) {
    const checked = planFromDraft(draft, edited, team, leftOut);
    if (!checked.ok) {
      return checked;
    }
    const roleProblems = edited.flatMap((issue, index) => {
      const replanned = checked.value.items[index]?.roles ?? [];
      const wanted = issue.roles ?? [];
      return replanned.length === wanted.length &&
        replanned.every((role, at) => role === wanted[at])
        ? []
        : [
            wanted.length === 0
              ? `#${String(issue.number)} has no work Roles in the Owner's Plan: leave its roles out.`
              : `Keep the Owner's work Roles for #${String(issue.number)} exactly, in turn: ${inTurn(wanted, team.roles ?? [])}.`,
          ];
    });
    return roleProblems.length > 0
      ? { ok: false, problem: roleProblems.join(" ") }
      : {
          ok: true,
          value: {
            ...checked.value,
            items: annotated(checked.value.items, edited),
          },
        };
  }
  return {
    ok: false,
    problem: `Keep the Owner's order exactly: ${order
      .map((issue) => `#${String(issue)}`)
      .join(", ")}, each once, and no other issue.`,
  };
}

/**
 * AI Office's own replan of the Owner's edits to `previous`, for when the
 * Manager's Model gives none (FR-17): the issues the Owner kept, in their
 * order, each keeping its likely files, coder (while still one of the
 * Floor's) and note, and the dependencies that still come before it. Issues
 * that share a likely file are sequenced again in the new order. `reason`
 * says why the Model did not replan.
 */
export function replanByRules(
  previous: Pick<PlanContent, "items">,
  edited: readonly EditedIssue[],
  team: PlanTeam,
  leftOut: readonly PlanLeftOut[],
  reason: string,
): PlanContent {
  const order = edited.map(({ number }) => number);
  const before = edited.map((issue) =>
    previous.items.find((item) => item.issue === issue.number),
  );
  const roles = edited.map(
    (issue, index) => issue.roles ?? before[index]?.roles,
  );
  const assignments = assign(
    before.map((item, index) =>
      keptCoder(item?.agentId ?? null, roles[index], team),
    ),
    team,
    roles,
  );
  const items = edited.map((issue, index): PlanItem =>
    withRoles(
      {
        issue: issue.number,
        title: issue.title,
        dependsOn: (before[index]?.dependsOn ?? []).filter((dependency) => {
          const at = order.indexOf(dependency);
          return at !== -1 && at < index;
        }),
        files: [...(before[index]?.files ?? [])],
        agentId: assignments[index] ?? null,
        note: before[index]?.note ?? "",
      },
      roles[index],
    ),
  );
  const plan = complete(
    "rules",
    `AI Office's rules replanned your edits, as ${reason}: the issues in your order, each keeping its likely files, ${
      roles.some((given) => (given ?? []).length > 0)
        ? "its work Roles as you left them, "
        : ""
    }its coder and the issues it depends on that still come before it. Issues that share a likely file run one after another.`,
    items,
    leftOut,
  );
  return { ...plan, items: annotated(plan.items, edited) };
}

/** A change to a Batch from the Manager chat: "skip 4" or "move 5 up". */
export type BatchChange =
  | { readonly kind: "skip"; readonly issues: readonly number[] }
  | {
      readonly kind: "move";
      readonly issue: number;
      readonly direction: "up" | "down";
    };

/**
 * The Plan's order after `change`: the issues in `order` whose work has
 * `started` first, as they were, then the issues still to start, skipped
 * or reordered as the change says; and the issues it skips. Or why it does
 * not fit the Plan, in a sentence for the Owner.
 */
export function changedOrder(
  order: readonly number[],
  started: ReadonlySet<number>,
  change: BatchChange,
): ParsedAnswer<{ order: number[]; skipped: number[] }> {
  const name = (issue: number) => `#${String(issue)}`;
  const kept = order.filter((issue) => started.has(issue));
  const toStart = order.filter((issue) => !started.has(issue));
  const named = change.kind === "skip" ? change.issues : [change.issue];
  const problems: string[] = [];
  for (const issue of named) {
    if (!order.includes(issue)) {
      problems.push(`${name(issue)} is not in the Plan.`);
    } else if (started.has(issue)) {
      problems.push(
        change.kind === "skip"
          ? `${name(issue)}'s work has started, so it is not skipped: work that has started carries on.`
          : `${name(issue)}'s work has started, so moving it would change nothing.`,
      );
    }
  }
  if (problems.length > 0) {
    return { ok: false, problem: problems.join(" ") };
  }
  if (change.kind === "skip") {
    const rest = toStart.filter((issue) => !change.issues.includes(issue));
    if (kept.length + rest.length === 0) {
      return {
        ok: false,
        problem: "Keep at least one issue: a Plan cannot drop every issue.",
      };
    }
    return {
      ok: true,
      value: {
        order: [...kept, ...rest],
        skipped: toStart.filter((issue) => change.issues.includes(issue)),
      },
    };
  }
  const at = toStart.indexOf(change.issue);
  const to = change.direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= toStart.length) {
    return {
      ok: false,
      problem: `${name(change.issue)} is already the ${change.direction === "up" ? "first" : "last"} issue still to start, so it cannot move ${change.direction}.`,
    };
  }
  const moved = [...toStart];
  moved[at] = toStart[to] ?? change.issue;
  moved[to] = change.issue;
  return { ok: true, value: { order: [...kept, ...moved], skipped: [] } };
}

/**
 * AI Office's replan of a Batch whose work is under way, after the Owner
 * changed it from the chat (FR-25.4): `previous`'s issues in `order`, each
 * that has `started` exactly as it was; the rest keeping their likely
 * files, coder (while still one of the Floor's) and note, and the
 * dependencies that still come before them. Issues that share a likely
 * file are sequenced again in the new order, giving none that has started
 * anything new to wait for.
 */
export function replanMidBatch(
  previous: Pick<PlanContent, "items">,
  order: readonly number[],
  started: ReadonlySet<number>,
  team: PlanTeam,
  leftOut: readonly PlanLeftOut[],
  summary: string,
): PlanContent {
  const before = order.flatMap((issue) => {
    const item = previous.items.find((candidate) => candidate.issue === issue);
    return item === undefined ? [] : [item];
  });
  const toStart = before.filter(({ issue }) => !started.has(issue));
  const assignments = assign(
    toStart.map(({ agentId, roles }) => keptCoder(agentId, roles, team)),
    team,
    toStart.map(({ roles }) => roles),
  );
  const items = before.map((item, index): PlanItem => {
    const dependsOn = item.dependsOn.filter((dependency) => {
      const at = before.findIndex(({ issue }) => issue === dependency);
      return at !== -1 && at < index;
    });
    if (started.has(item.issue)) {
      return { ...item, dependsOn };
    }
    const assigned = assignments[toStart.indexOf(item)];
    return { ...item, dependsOn, agentId: assigned ?? null };
  });
  return complete(
    "rules",
    summary,
    items,
    leftOut,
    new Set(order.filter((issue) => started.has(issue))),
  );
}
