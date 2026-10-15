import { z } from "zod";

// A Grilling Session's issues (PRD FR-81). Once the session's documents
// are proposed, the Manager drafts GitHub issues from them: vertical
// slices, each with "What to build", acceptance criteria, the drafts it is
// blocked by, and the PRD sections and ADRs it cites. The Owner edits,
// reorders, merges and drops the drafts, then approves them, and the
// GitHub App files them in dependency order, labelled `ai-office`, each
// one's "Blocked by" naming the issues filed for the drafts it waits on.
// The rules for editing the drafts and the order they are filed in are
// plain code, shared by the server, the web app and the orchestrator.

/** The most issues one session drafts. */
export const maxGrillingIssues = 30;
/** The longest issue title. */
export const maxGrillingIssueTitleLength = 200;
/** The longest "What to build". */
export const maxGrillingIssueTextLength = 8000;
/** The longest acceptance criterion. */
export const maxGrillingCriterionLength = 2000;
/** The most acceptance criteria one issue has. */
export const maxGrillingCriteria = 30;

const timestampSchema = z.iso.datetime({ offset: true });
const numberSchema = z.number().int().positive();

const text = (what: string, max: number) =>
  z
    .string({ error: `${what} is text.` })
    .trim()
    .min(1, { error: `${what} is not empty.` })
    .max(max, { error: `${what} is at most ${String(max)} characters.` });

/** What the Owner can change of a draft: everything but whether it was filed. */
const draftShape = {
  /** The draft's own number, kept through edits; never an issue number. */
  id: numberSchema,
  title: text("A title", maxGrillingIssueTitleLength),
  whatToBuild: text("What to build", maxGrillingIssueTextLength),
  acceptanceCriteria: z
    .array(text("An acceptance criterion", maxGrillingCriterionLength))
    .min(1, { error: "An issue has at least one acceptance criterion." })
    .max(maxGrillingCriteria),
  /** The drafts it is blocked by, by `id`. */
  blockedBy: z.array(numberSchema).max(maxGrillingIssues),
  /** The headings of the PRD's outline it cites. */
  prdSections: z.array(text("A PRD section", 200)).max(30),
  /** The titles of the session's ADRs it cites. */
  adrs: z.array(text("An ADR", 200)).max(10),
};

/** An issue filed on GitHub for a draft. */
export const grillingFiledIssueSchema = z.object({
  number: numberSchema,
  url: z.string(),
});
export type GrillingFiledIssue = z.infer<typeof grillingFiledIssueSchema>;

/** One of the session's draft issues, and the issue filed for it, once it is. */
export const grillingIssueDraftSchema = z.object({
  ...draftShape,
  filed: grillingFiledIssueSchema.nullable(),
});
export type GrillingIssueDraft = z.infer<typeof grillingIssueDraftSchema>;

/**
 * A session's issues: the drafts, in the Owner's order, and how filing
 * them went. Null until the Manager drafts them.
 */
export const grillingIssuesSchema = z.object({
  drafts: z.array(grillingIssueDraftSchema),
  draftedAt: timestampSchema,
  /** When the Owner approved them; null until then. */
  approvedAt: timestampSchema.nullable(),
  /** Why the last filing stopped short, if it did. */
  problem: z.string().nullable(),
});
export type GrillingIssues = z.infer<typeof grillingIssuesSchema>;

/**
 * `PUT /api/floors/:floorId/grilling-sessions/:sessionId/issues`: the
 * drafts as the Owner edited them, in their order.
 */
export const grillingIssueDraftsRequestSchema = z.object({
  drafts: z
    .array(z.object(draftShape))
    .min(1, { error: "Keep at least one issue: drop none to file none." })
    .max(maxGrillingIssues),
});
export type GrillingIssueDraftsRequest = z.infer<
  typeof grillingIssueDraftsRequestSchema
>;
/** A draft as the Owner edits it. */
export type GrillingIssueDraftEdit =
  GrillingIssueDraftsRequest["drafts"][number];

// The Manager's draft, as its Model writes it as JSON. Each issue is
// blocked only by issues listed before it, by their position (1 for the
// first), so the drafts can always be filed in order.
export const grillingIssuesTurnSchema = z.object({
  /** A few words to the Owner before the drafts; may be empty. */
  message: z.string().max(2000).default(""),
  issues: z
    .array(
      z.object({
        title: text("A title", maxGrillingIssueTitleLength),
        whatToBuild: text("What to build", maxGrillingIssueTextLength),
        acceptanceCriteria: z
          .array(text("An acceptance criterion", maxGrillingCriterionLength))
          .min(1, { error: "An issue has at least one acceptance criterion." })
          .max(maxGrillingCriteria),
        blockedBy: z.array(numberSchema).max(maxGrillingIssues).default([]),
        prdSections: z.array(text("A PRD section", 200)).max(30).default([]),
        adrs: z.array(text("An ADR", 200)).max(10).default([]),
      }),
    )
    .min(1, { error: "Draft at least one issue." })
    .max(maxGrillingIssues),
});
export type GrillingIssuesTurn = z.infer<typeof grillingIssuesTurnSchema>;

/** "a, b and c". */
const inWords = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

const unique = <Item>(items: readonly Item[]): Item[] => [...new Set(items)];

/** Text items without repeats, case aside, the first kept. */
const uniqueText = (items: readonly string[]): string[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.trim().toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * The order the drafts are filed in: each after every draft it is blocked
 * by, otherwise in the Owner's order. Undefined when some are blocked by
 * each other in a cycle, which can never be filed.
 */
export function issueFilingOrder<
  Draft extends Pick<GrillingIssueDraft, "id" | "blockedBy">,
>(drafts: readonly Draft[]): Draft[] | undefined {
  const ids = new Set(drafts.map(({ id }) => id));
  const placed = new Set<number>();
  const order: Draft[] = [];
  while (order.length < drafts.length) {
    const next = drafts.find(
      (draft) =>
        !placed.has(draft.id) &&
        draft.blockedBy.every((other) => !ids.has(other) || placed.has(other)),
    );
    if (next === undefined) {
      return undefined;
    }
    placed.add(next.id);
    order.push(next);
  }
  return order;
}

/**
 * Why the drafts cannot be filed as they are, if they cannot: a repeated
 * id, a draft blocked by itself or by one that is not in the list, or
 * drafts blocked by each other in a cycle.
 */
export function issueDraftsProblem(
  drafts: readonly Pick<GrillingIssueDraft, "id" | "title" | "blockedBy">[],
): string | undefined {
  if (drafts.length === 0) {
    return "There are no issues to file.";
  }
  const ids = new Set(drafts.map(({ id }) => id));
  if (ids.size !== drafts.length) {
    return "Two issues have the same number.";
  }
  for (const { id, title, blockedBy } of drafts) {
    if (blockedBy.includes(id)) {
      return `"${title}" is blocked by itself.`;
    }
    const unknown = blockedBy.filter((other) => !ids.has(other));
    if (unknown.length > 0) {
      return `"${title}" is blocked by ${unknown.length === 1 ? "an issue" : "issues"} not in the list (${inWords(unknown.map((other) => `#${String(other)}`))}).`;
    }
  }
  if (issueFilingOrder(drafts) === undefined) {
    return "Some issues are blocked by each other in a cycle, so none could be filed first.";
  }
  return undefined;
}

/**
 * The drafts with `id` dropped: no other is blocked by it any more, but by
 * what it was blocked by, so the order the rest wait in is kept.
 */
export function dropIssueDraft<
  Draft extends Pick<GrillingIssueDraft, "id" | "blockedBy">,
>(drafts: readonly Draft[], id: number): Draft[] {
  const dropped = drafts.find((draft) => draft.id === id);
  if (dropped === undefined) {
    return [...drafts];
  }
  return drafts
    .filter((draft) => draft.id !== id)
    .map((draft) =>
      draft.blockedBy.includes(id)
        ? {
            ...draft,
            blockedBy: unique(
              draft.blockedBy.flatMap((other) =>
                other === id ? dropped.blockedBy : [other],
              ),
            ).filter((other) => other !== draft.id),
          }
        : draft,
    );
}

/**
 * The drafts with `from` merged into `into`, in `into`'s place: its title,
 * both "What to build"s, every acceptance criterion and citation once, and
 * everything either was blocked by. A draft blocked by `from` is blocked
 * by `into` instead.
 */
export function mergeIssueDrafts<Draft extends GrillingIssueDraftEdit>(
  drafts: readonly Draft[],
  into: number,
  from: number,
): Draft[] {
  const kept = drafts.find(({ id }) => id === into);
  const merged = drafts.find(({ id }) => id === from);
  if (kept === undefined || merged === undefined || into === from) {
    return [...drafts];
  }
  const both = (ids: readonly number[]) =>
    unique(ids.map((other) => (other === from ? into : other)));
  return drafts
    .filter(({ id }) => id !== from)
    .map((draft) =>
      draft.id === into
        ? {
            ...draft,
            whatToBuild: `${kept.whatToBuild.trim()}\n\n${merged.whatToBuild.trim()}`,
            acceptanceCriteria: uniqueText([
              ...kept.acceptanceCriteria,
              ...merged.acceptanceCriteria,
            ]),
            blockedBy: both([...kept.blockedBy, ...merged.blockedBy]).filter(
              (other) => other !== into,
            ),
            prdSections: uniqueText([
              ...kept.prdSections,
              ...merged.prdSections,
            ]),
            adrs: uniqueText([...kept.adrs, ...merged.adrs]),
          }
        : draft.blockedBy.includes(from)
          ? { ...draft, blockedBy: both(draft.blockedBy) }
          : draft,
    );
}

/** The drafts with `id` moved `by` places (up when negative), within the list. */
export function moveIssueDraft<Draft extends Pick<GrillingIssueDraft, "id">>(
  drafts: readonly Draft[],
  id: number,
  by: number,
): Draft[] {
  const from = drafts.findIndex((draft) => draft.id === id);
  const moved = drafts[from];
  if (moved === undefined) {
    return [...drafts];
  }
  const to = Math.min(drafts.length - 1, Math.max(0, from + by));
  const rest = drafts.filter((draft) => draft.id !== id);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}
