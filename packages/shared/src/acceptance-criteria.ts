import type { SpecRequirements } from "./spec.ts";

// The Acceptance Criteria checker (Guidelines, Specs and Hooks PRD,
// FR-114), in plain code: a Spec's requirements can be confirmed only
// once every criterion is one testable statement with an id of its own.
// Each criterion:
// - starts with its id, `R<requirement>.<criterion>`, such as R2.3 for
//   requirement 2's third criterion: its requirement's number, then a
//   number from 1 (it may be in bold, and followed by a colon or dash);
// - has an id no other criterion of the Spec has;
// - is in one of four forms, its keywords in capitals:
//   `WHEN <trigger> THE SYSTEM SHALL <response>`,
//   `IF <condition> THEN <subject> SHALL <response>`,
//   `WHILE <state> <subject> SHALL <response>` or
//   `WHERE <option> <subject> SHALL <response>`;
// - says SHALL once: one behaviour per criterion.
// Every failing criterion is reported, with every reason it fails, so the
// Owner's refusal names them all at once, not just the first.

/** The forms a criterion may take, for the Owner and the Manager to read. */
export const acceptanceCriterionForms =
  '"WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF … THEN … SHALL", "WHILE … SHALL" or "WHERE … SHALL" forms';

/** One criterion that fails the check, and every reason it fails. */
export interface AcceptanceCriterionProblem {
  /** Its user story's number, from 1. */
  readonly requirement: number;
  /** Its place in the user story's criteria, from 1. */
  readonly criterion: number;
  /** Its id as written, such as "R2.3"; undefined when it has none. */
  readonly id: string | undefined;
  /** The criterion as written. */
  readonly text: string;
  /** Why it fails, each a clause: "it has no id, such as R2.3". */
  readonly reasons: readonly string[];
}

/** A criterion's id and the statement after it: "R2.3", "WHEN …". */
const idPattern =
  /^\s*(?:\*\*)?\s*(R\d+\.\d+)\b\s*(?:\*\*)?\s*[:.–—-]?\s*(.*)$/is;

/** The four forms, each with every part not empty. */
const formPatterns: readonly RegExp[] = [
  /^WHEN\s+\S.*?\s+THE SYSTEM SHALL\s+\S/s,
  /^IF\s+\S.*?\s+THEN\s+\S.*?\s+SHALL\s+\S/s,
  /^WHILE\s+\S.*?\s+SHALL\s+\S/s,
  /^WHERE\s+\S.*?\s+SHALL\s+\S/s,
];

/** A criterion's id and statement; no id when it does not start with one. */
function parsed(criterion: string): {
  id: string | undefined;
  statement: string;
} {
  const match = idPattern.exec(criterion);
  return match === null
    ? { id: undefined, statement: criterion.trim() }
    : { id: match[1], statement: (match[2] ?? "").trim() };
}

/** "requirement 2's criterion 1". */
const placeOf = (requirement: number, criterion: number): string =>
  `requirement ${String(requirement)}'s criterion ${String(criterion)}`;

/**
 * Every criterion of `requirements` that fails the check, in their order,
 * each with every reason it fails; none when all pass.
 */
export function acceptanceCriteriaProblems(
  requirements: SpecRequirements,
): AcceptanceCriterionProblem[] {
  const all = requirements.requirements.flatMap(({ criteria }, story) =>
    criteria.map((text, place) => ({
      requirement: story + 1,
      criterion: place + 1,
      text,
      ...parsed(text),
    })),
  );
  // Where each id is used, by its normal spelling ("r1.1" is R1.1).
  const uses = new Map<string, (typeof all)[number][]>();
  for (const each of all) {
    if (each.id !== undefined) {
      const key = each.id.toUpperCase();
      uses.set(key, [...(uses.get(key) ?? []), each]);
    }
  }
  return all.flatMap((each): AcceptanceCriterionProblem[] => {
    const { requirement, criterion, id, statement } = each;
    const own = `R${String(requirement)}.`;
    const reasons: string[] = [];
    if (id === undefined) {
      reasons.push(
        `it has no id: start it with one, such as ${own}${String(criterion)}`,
      );
    } else {
      if (!id.startsWith("R")) {
        reasons.push(`its id is written "${id}": write it with a capital R`);
      }
      const upper = id.toUpperCase();
      if (!upper.startsWith(own) || !/^R\d+\.[1-9]\d*$/.test(upper)) {
        reasons.push(
          `its id ${upper} is not one of requirement ${String(requirement)}'s: they are ${own}1, ${own}2 and on`,
        );
      }
      const others = (uses.get(upper) ?? []).filter((other) => other !== each);
      if (others.length > 0) {
        reasons.push(
          `its id ${upper} is also ${others
            .map((other) => placeOf(other.requirement, other.criterion))
            .join(" and ")}'s: each id is used once`,
        );
      }
    }
    if (!formPatterns.some((form) => form.test(statement))) {
      reasons.push(
        `it is not in a criterion's form: ${acceptanceCriterionForms}, its keywords in capitals`,
      );
    } else if ((statement.match(/\bSHALL\b/g) ?? []).length > 1) {
      reasons.push(
        "it says SHALL more than once: give each behaviour a criterion of its own",
      );
    }
    return reasons.length === 0
      ? []
      : [{ requirement, criterion, id, text: each.text.trim(), reasons }];
  });
}

/** The longest stretch of a criterion quoted in a refusal. */
const quoted = 120;

/**
 * One failing criterion, as a line of the refusal: where it is, what it
 * says (cut short when long), and every reason it fails.
 */
export function acceptanceCriterionProblemLine(
  problem: AcceptanceCriterionProblem,
): string {
  const text =
    problem.text.length > quoted
      ? `${problem.text.slice(0, quoted - 1).trimEnd()}…`
      : problem.text;
  return `- Requirement ${String(problem.requirement)}, criterion ${String(problem.criterion)}${problem.id === undefined ? "" : ` (${problem.id})`}, "${text}": ${problem.reasons.join("; ")}.`;
}
