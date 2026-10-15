import { reviewVerdictSchema, type ReviewVerdict } from "@ai-office/shared";

// Reading a reviewer's answer as a verdict (PRD FR-20): one JSON object
// that `reviewVerdictSchema` accepts (and, with `parseAnswer`, any other
// answer asked for as JSON, such as the Manager's triage). A model may wrap it in a code fence,
// so the object is found within the text; anything else is a problem the
// reviewer is told of, in a sentence it can act on.

export type ParsedVerdict =
  | { readonly ok: true; readonly verdict: ReviewVerdict }
  | { readonly ok: false; readonly problem: string };

/** The JSON object in `text`: inside a code fence, or from `{` to `}`. */
const objectText = (text: string): string | undefined => {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start === -1 || end < start
    ? undefined
    : candidate.slice(start, end + 1);
};

/** At most this many problems are named. */
const maxProblems = 5;

/** A schema to check an answer with, such as `reviewVerdictSchema`. */
interface AnswerSchema<Value> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: Value }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly path: readonly PropertyKey[];
            readonly message: string;
          }[];
        };
      };
}

export type ParsedAnswer<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a model's answer as the one JSON object `schema` accepts, or says
 * what is wrong with it in a sentence the model can act on.
 */
export function parseAnswer<Value>(
  text: string,
  schema: AnswerSchema<Value>,
): ParsedAnswer<Value> {
  const json = objectText(text);
  if (json === undefined) {
    return { ok: false, problem: "It has no JSON object." };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      problem: `It is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const problems = parsed.error.issues.map(({ path, message }) =>
    path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`,
  );
  return {
    ok: false,
    problem: `${problems.slice(0, maxProblems).join(" ")}${
      problems.length > maxProblems
        ? ` (and ${String(problems.length - maxProblems)} more)`
        : ""
    }`,
  };
}

export function parseVerdict(text: string): ParsedVerdict {
  const parsed = parseAnswer(text, reviewVerdictSchema);
  return parsed.ok ? { ok: true, verdict: parsed.value } : parsed;
}
