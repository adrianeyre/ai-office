import {
  maxCommandIssues,
  maxIssueNumber,
  type ManagerCommand,
} from "@ai-office/shared";

// The Manager chat's commands (PRD FR-24), read in plain code before
// anything reaches a model: "complete issues 1 to 5", "skip 4", "move 5
// up", "pause", "resume" and "status" (or "report", "status report": the
// Manager's status report, FR-23). Issue lists take ranges ("1 to 5", "1-5",
// "1 through 5") and lists ("1, 3 and 4", "1 3 4", "#1 & #3"). "complete"
// may end "in one PR" ("in one pull request", "as one PR", "in a single
// PR"): the Batch's issues then go in one pull request (ADR 0010). A message
// made only of a command's words and numbers is a command: read, it says
// what it understood; misspelt ("compleet issues 1 to 5"), or with a list
// it cannot read ("complete issues 5 to 1"), it is refused with a hint,
// and no model sees it. Anything else is a message for the Manager's
// Model.

/** How the chat reads one of the Owner's messages. */
export type CommandReading =
  /** A command, and what was understood, in words. */
  | {
      readonly kind: "command";
      readonly command: ManagerCommand;
      readonly understood: string;
    }
  /** Shaped like a command, but not one it can carry out: what to type. */
  | { readonly kind: "refused"; readonly hint: string }
  /** Not a command: for the Manager's Model. */
  | { readonly kind: "message" };

const verbs = [
  "complete",
  "skip",
  "move",
  "pause",
  "resume",
  "status",
  "report",
] as const;
type Verb = (typeof verbs)[number];

/** Words a command may hold besides its verb and issue numbers. */
const commandWords = new Set([
  "issue",
  "issues",
  "to",
  "through",
  "thru",
  "and",
  "up",
  "down",
  "status",
  "report",
]);

/** Words a typo is corrected to: long enough to tell apart. */
const correctable = [...verbs, "issue", "issues", "through", "down"];

const rangeWords = new Set(["to", "through", "thru", "-"]);
const listSeparators = new Set([",", "and", "&"]);

const usage: Record<Verb, string> = {
  complete:
    'Say which issues, such as "complete issues 1 to 5" or "complete issues 1, 3 and 4"; end it "in one PR" to have them all in one pull request.',
  skip: 'Say which issues to skip, such as "skip 4" or "skip 4 and 6".',
  move: 'Say which issue and which way, such as "move 5 up" or "move 5 down".',
  pause:
    '"pause" pauses the whole Floor, so it takes nothing after it: type "pause" on its own.',
  resume:
    '"resume" resumes the whole Floor, so it takes nothing after it: type "resume" on its own.',
  status:
    '"status" reports on the whole Floor, so it takes nothing after it: type "status" on its own.',
  report:
    '"report" reports on the whole Floor, so it takes nothing after it: type "report" on its own.',
};

interface Token {
  readonly text: string;
  readonly index: number;
}

const isVerb = (word: string): word is Verb =>
  (verbs as readonly string[]).includes(word);

const issueToken = /^#?\d+$/;
const wordToken = /^[a-z]+$/;

/** "in one PR" and its kin, ending a "complete" command (ADR 0010). */
const onePullRequestEnding =
  /\s+(?:in|as)\s+(?:one|a\s+single)\s+(?:pr|pull\s+request)$/;

/** Where "in one PR" goes, for a command it does not end. */
const onePullRequestHint =
  '"in one PR" goes only with "complete", such as "complete issues 1 to 5 in one PR".';

/** Lower case, dashes as `-`, without trailing full stops or "please". */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[‐-―−]/g, "-")
    .trim()
    .replace(/[.!]+$/, "")
    .trim()
    .replace(/^please\s+/, "")
    .replace(/[\s,]+please$/, "")
    .trim();
}

const tokenise = (text: string): Token[] =>
  [...text.matchAll(/#?\d+|[a-z]+|[,&-]|\S/g)].map((match) => ({
    text: match[0],
    index: match.index,
  }));

/** Whether every token could belong to a command. */
const commandShaped = (tokens: readonly string[]): boolean =>
  tokens.every(
    (token) =>
      issueToken.test(token) ||
      commandWords.has(token) ||
      listSeparators.has(token) ||
      token === "-",
  );

/** `#1, #2 and #3`. */
export function issueList(issues: readonly number[]): string {
  const named = issues.map((issue) => `#${String(issue)}`);
  return named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
}

type Parsed =
  | { readonly kind: "issues"; readonly issues: number[] }
  | { readonly kind: "invalid"; readonly hint: string };

/** An issue number, or why it is not one. */
function issueNumber(token: string): number | string {
  const issue = Number(token.replace(/^#/, ""));
  if (issue === 0) {
    return "Issue numbers start at 1.";
  }
  if (!Number.isSafeInteger(issue) || issue > maxIssueNumber) {
    return `${token} is not an issue number.`;
  }
  return issue;
}

/** "1 to 5, 7 and #9": the issues, in the order given, each once. */
function parseIssues(tokens: readonly string[], verb: Verb): Parsed {
  const issues: number[] = [];
  const invalid = (hint: string): Parsed => ({ kind: "invalid", hint });
  let index = 0;
  const next = (): string | undefined => tokens[index];
  while (index < tokens.length) {
    const first = next() ?? "";
    if (!issueToken.test(first)) {
      return invalid(usage[verb]);
    }
    const from = issueNumber(first);
    if (typeof from === "string") {
      return invalid(from);
    }
    index += 1;
    let to = from;
    if (rangeWords.has(next() ?? "")) {
      index += 1;
      const last = next() ?? "";
      if (!issueToken.test(last)) {
        return invalid(usage[verb]);
      }
      const end = issueNumber(last);
      if (typeof end === "string") {
        return invalid(end);
      }
      if (end < from) {
        return invalid(
          `A range goes from the lower number to the higher, such as "${verb} issues ${String(end)} to ${String(from)}".`,
        );
      }
      if (end - from + 1 > maxCommandIssues) {
        return invalid(
          `One command can name at most ${String(maxCommandIssues)} issues; ${String(from)} to ${String(end)} is ${String(end - from + 1)}.`,
        );
      }
      index += 1;
      to = end;
    }
    for (let issue = from; issue <= to; issue += 1) {
      if (!issues.includes(issue)) {
        issues.push(issue);
      }
    }
    if (issues.length > maxCommandIssues) {
      return invalid(
        `One command can name at most ${String(maxCommandIssues)} issues.`,
      );
    }
    // Separators between items: ",", "and", "&", ", and", or none.
    while (listSeparators.has(next() ?? "")) {
      index += 1;
      if (index === tokens.length) {
        return invalid(usage[verb]);
      }
    }
  }
  return issues.length === 0
    ? invalid(usage[verb])
    : { kind: "issues", issues };
}

/** Reads `tokens` as a command, or says why the command is refused. */
function parse(tokens: readonly string[]): CommandReading {
  const [verb, ...rest] = tokens;
  if (verb === undefined || !isVerb(verb) || !commandShaped(rest)) {
    return { kind: "message" };
  }
  const refused = (hint: string): CommandReading => ({
    kind: "refused",
    hint,
  });
  const command = (command: ManagerCommand): CommandReading => ({
    kind: "command",
    command,
    understood: describeCommand(command),
  });
  const args =
    rest[0] === "issue" || rest[0] === "issues" ? rest.slice(1) : rest;
  switch (verb) {
    case "pause":
    case "resume":
      return rest.length === 0 ? command({ kind: verb }) : refused(usage[verb]);
    // "status", "report" and "status report" are one command.
    case "status":
    case "report":
      return rest.length === 0 ||
        (verb === "status" && rest.length === 1 && rest[0] === "report")
        ? command({ kind: "report" })
        : refused(usage[verb]);
    case "complete":
    case "skip": {
      const parsed = parseIssues(args, verb);
      return parsed.kind === "invalid"
        ? refused(parsed.hint)
        : command({ kind: verb, issues: parsed.issues });
    }
    case "move": {
      const [issue, direction, ...extra] = args;
      if (
        issue === undefined ||
        !issueToken.test(issue) ||
        (direction !== "up" && direction !== "down") ||
        extra.length > 0
      ) {
        return refused(usage.move);
      }
      const number = issueNumber(issue);
      return typeof number === "string"
        ? refused(number)
        : command({ kind: "move", issue: number, direction });
    }
  }
}

/**
 * The edit distance between two words, counting a swap of neighbouring
 * letters as one edit (optimal string alignment).
 */
export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  const at = (i: number, j: number): number => rows[i]?.[j] ?? 0;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      const row = rows[i];
      if (row !== undefined) {
        row[j] = best;
      }
    }
  }
  return at(a.length, b.length);
}

/** The command word `word` is likely a typo of, if any. */
function correction(word: string): string | undefined {
  if (
    !wordToken.test(word) ||
    word.length < 3 ||
    isVerb(word) ||
    commandWords.has(word)
  ) {
    return undefined;
  }
  const allowed = word.length >= 6 ? 2 : 1;
  let best: { word: string; distance: number } | undefined;
  for (const candidate of correctable) {
    const distance = editDistance(word, candidate);
    if (
      distance <= allowed &&
      (best === undefined || distance < best.distance)
    ) {
      best = { word: candidate, distance };
    }
  }
  return best?.word;
}

/** What a command says it understood. */
export function describeCommand(command: ManagerCommand): string {
  const issues = (verb: string, list: readonly number[]): string =>
    list.length === 1
      ? `${verb} issue ${issueList(list)}`
      : `${verb} ${String(list.length)} issues: ${issueList(list)}`;
  switch (command.kind) {
    case "complete":
      return `Understood: ${issues("complete", command.issues)}${
        command.onePullRequest === true ? ", in one pull request" : ""
      }.`;
    case "skip":
      return `Understood: ${issues("skip", command.issues)}.`;
    case "move":
      return `Understood: move issue #${String(command.issue)} ${command.direction} one place.`;
    case "pause":
      return "Understood: pause this Floor's work.";
    case "resume":
      return "Understood: resume this Floor's work.";
    case "report":
      return "Understood: a status report on this Floor.";
  }
}

/**
 * Reads normalised text as a command: one ending "in one PR" is read
 * without it, and must then be "complete".
 */
function read(text: string): CommandReading {
  const words = (from: string) =>
    tokenise(from).map(({ text: token }) => token);
  const ending = onePullRequestEnding.exec(text);
  if (ending === null) {
    return parse(words(text));
  }
  const before = words(text.slice(0, ending.index));
  const reading = parse(before);
  if (reading.kind === "message") {
    return reading;
  }
  // "complete" with a list it cannot read says what is wrong with that.
  if (reading.kind === "refused" && before[0] === "complete") {
    return reading;
  }
  if (reading.kind === "command" && reading.command.kind === "complete") {
    const command: ManagerCommand = {
      ...reading.command,
      onePullRequest: true,
    };
    return { kind: "command", command, understood: describeCommand(command) };
  }
  return { kind: "refused", hint: onePullRequestHint };
}

/** Reads one of the Owner's messages: a command, a refused one, or neither. */
export function readManagerCommand(text: string): CommandReading {
  const normalised = normalise(text);
  const tokens = tokenise(normalised);
  const reading = read(normalised);
  if (reading.kind !== "message") {
    return reading;
  }
  // A typo: corrected, would it be a command?
  let corrected = "";
  let from = 0;
  let changed = false;
  for (const token of tokens) {
    const fixed = correction(token.text);
    corrected += normalised.slice(from, token.index) + (fixed ?? token.text);
    from = token.index + token.text.length;
    changed ||= fixed !== undefined;
  }
  corrected += normalised.slice(from);
  if (!changed) {
    return reading;
  }
  const guess = read(corrected);
  switch (guess.kind) {
    case "message":
      return reading;
    case "command":
      return {
        kind: "refused",
        hint: `I did not understand that. Did you mean "${corrected}"?`,
      };
    case "refused":
      return {
        kind: "refused",
        hint: `I did not understand that. Did you mean "${corrected}"? ${guess.hint}`,
      };
  }
}
