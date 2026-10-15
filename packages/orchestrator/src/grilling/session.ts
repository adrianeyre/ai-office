import {
  grillingWritesDocuments,
  type GrillingAdr,
  type GrillingAnswers,
  type GrillingDecision,
  type GrillingDocuments,
  type GrillingFact,
  type GrillingFactStatus,
  type GrillingIssues,
  type GrillingProcess,
  type GrillingQuestion,
  type GrillingSection,
  type GrillingSessionStatus,
  type GrillingSessionSummary,
  type GrillingSkillName,
  type GrillingSource,
  type GrillingTerm,
  type GrillingTurn,
} from "@ai-office/shared";

// A Grilling Session's rules, in plain code (PRD FR-78, FR-79, FR-80): the
// Manager's Model writes questions, recommended answers, decisions, terms
// and the documents' parts (the PRD's outline, ADRs and process docs), and
// AI Office numbers the questions, works out which can be asked (those
// whose prerequisites are settled), records the Owner's answers and the
// facts found in the repository, keeps only the ADRs that say why they are
// hard to reverse, surprising and a real trade-off, and says when no open
// questions remain. Every change makes a new record; the store keeps it.

/** A Grilling Session, as it is kept. */
export interface GrillingSessionRecord {
  readonly id: number;
  readonly floorId: string;
  readonly topic: string;
  /** The built-in Skill that started it: `/grilling`, `/wayfinder` and the rest. */
  readonly skill: GrillingSkillName;
  readonly status: GrillingSessionStatus;
  /** The latest round asked; 0 before the first. */
  readonly round: number;
  /** No open questions remain, and the Owner is asked to confirm. */
  readonly awaitingConfirmation: boolean;
  readonly questions: readonly GrillingQuestion[];
  readonly decisions: readonly GrillingDecision[];
  readonly terms: readonly GrillingTerm[];
  /** Facts found in the Floor's repository rather than asked (FR-79). */
  readonly facts: readonly GrillingFact[];
  /** The PRD's live outline, section by section (FR-80). */
  readonly outline: readonly GrillingSection[];
  /** ADRs: only decisions hard to reverse, surprising and a real trade-off. */
  readonly adrs: readonly GrillingAdr[];
  readonly processes: readonly GrillingProcess[];
  /** Where the documents stand on GitHub; null until first written. */
  readonly documents: GrillingDocuments | null;
  /** The issues drafted once it ended, and those filed (FR-81); null until drafted. */
  readonly issues: GrillingIssues | null;
  /** The documents `/to-tickets` read when it started; none for the others. */
  readonly sources: readonly GrillingSource[];
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly pausedAt: Date | null;
  readonly endedAt: Date | null;
}

/** The questions asked in `round`. */
export const questionsOfRound = (
  session: Pick<GrillingSessionRecord, "questions">,
  round: number,
): GrillingQuestion[] =>
  session.questions.filter((question) => question.round === round);

/** The current round's questions still waiting for an answer. */
export const openInRound = (
  session: Pick<GrillingSessionRecord, "questions" | "round">,
): GrillingQuestion[] =>
  questionsOfRound(session, session.round).filter(
    ({ status }) => status === "open",
  );

/** Every open question: asked and unanswered, or waiting to be asked. */
export const openQuestions = (
  session: Pick<GrillingSessionRecord, "questions">,
): GrillingQuestion[] =>
  session.questions.filter(({ status }) => status === "open");

/** A session as the list shows it. */
export const summaryOf = (
  session: GrillingSessionRecord,
): GrillingSessionSummary => ({
  id: session.id,
  floorId: session.floorId,
  topic: session.topic,
  skill: session.skill,
  status: session.status,
  round: session.round,
  awaitingConfirmation: session.awaitingConfirmation,
  openQuestions: openQuestions(session).length,
  decisionCount: session.decisions.length,
  startedAt: session.startedAt.toISOString(),
  updatedAt: session.updatedAt.toISOString(),
  pausedAt: session.pausedAt?.toISOString() ?? null,
  endedAt: session.endedAt?.toISOString() ?? null,
});

/** "1, 2 and 3". */
export const numbersInWords = (numbers: readonly number[]): string => {
  const words = numbers.map(String);
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
};

/** What `applyAnswers` did with the Owner's answers. */
export interface AppliedAnswers {
  readonly session: GrillingSessionRecord;
  /** The questions answered, in number order. */
  readonly answered: readonly number[];
  /** Numbers answered that are not questions of the current round. */
  readonly notInRound: readonly number[];
  /** A bare "recommended" with more than one question open. */
  readonly unclear: boolean;
}

/**
 * Records the Owner's answers to the current round's questions: an answer
 * in their words, or the recommended one ("3: recommended", "recommended
 * to all" for every question left open). A question of the round may be
 * answered again until the round is complete.
 */
export function applyAnswers(
  session: GrillingSessionRecord,
  given: GrillingAnswers,
  at: Date,
): AppliedAnswers {
  const inRound = new Set(
    questionsOfRound(session, session.round)
      .filter(({ status }) => status !== "withdrawn")
      .map(({ number }) => number),
  );
  const open = openInRound(session);
  if (given.bare && open.length !== 1) {
    return { session, answered: [], notInRound: [], unclear: open.length > 1 };
  }
  const answers = new Map<number, string | null>();
  const notInRound: number[] = [];
  for (const { number, answer } of given.answers) {
    if (inRound.has(number)) {
      answers.set(number, answer);
    } else {
      notInRound.push(number);
    }
  }
  if (given.restRecommended) {
    for (const { number } of open) {
      if (!answers.has(number)) {
        answers.set(number, null);
      }
    }
  }
  const answeredAt = at.toISOString();
  return {
    session: {
      ...session,
      updatedAt: answers.size === 0 ? session.updatedAt : at,
      questions: session.questions.map((question) => {
        if (!answers.has(question.number)) {
          return question;
        }
        const answer = answers.get(question.number) ?? null;
        return {
          ...question,
          status: "answered",
          answer: answer ?? question.recommended,
          acceptedRecommended: answer === null,
          answeredAt,
        };
      }),
    },
    answered: [...answers.keys()].sort((a, b) => a - b),
    notInRound,
    unclear: false,
  };
}

/** The text of a decision AI Office records for an answer the Manager left unrecorded. */
export const answerDecision = (question: GrillingQuestion): string =>
  `${question.text.trim()} ${question.answer?.trim() ?? ""}`.trim();

/** What `applyTurn` did with the Manager's turn. */
export interface AppliedTurn {
  readonly session: GrillingSessionRecord;
  /** The new round's questions; none when no open questions remain. */
  readonly asked: readonly GrillingQuestion[];
  /**
   * The ADRs it left out, by title: each failed to say why it is hard to
   * reverse, surprising or the result of a real trade-off (FR-80).
   */
  readonly leftOut: readonly string[];
}

/** Whether an ADR says why it is hard to reverse, surprising and a trade-off. */
export const adrWarranted = (
  adr: Pick<GrillingAdr, "hardToReverse" | "surprising" | "tradeOff">,
): boolean =>
  [adr.hardToReverse, adr.surprising, adr.tradeOff].every(
    (reason) => reason.trim() !== "",
  );

/** `items` with each of `given` replacing the one of its key, or added last. */
function replaced<Item>(
  items: readonly Item[],
  given: readonly Item[],
  key: (item: Item) => string,
): Item[] {
  const merged = [...items];
  for (const item of given) {
    const at = merged.findIndex(
      (other) => key(other).toLowerCase() === key(item).toLowerCase(),
    );
    if (at === -1) {
      merged.push(item);
    } else {
      merged[at] = item;
    }
  }
  return merged;
}

/** A prerequisite is settled once answered or withdrawn, or if it is no question. */
const settled = (question: GrillingQuestion | undefined): boolean =>
  question?.status !== "open";

/**
 * Applies one of the Manager's turns, once every question asked so far is
 * answered (or at the start):
 * 1. its decisions, numbered on from the last; then, for each answered
 *    question no decision names, its question and answer as a decision,
 *    so every answer is settled as a decision;
 * 2. its glossary terms, a term defined again replacing the earlier;
 * 3. the documents' parts: sections of the PRD's outline, ADRs and process
 *    docs, each replacing the one of its heading or title, in place. An
 *    ADR that does not say why it is hard to reverse, surprising and a
 *    real trade-off is left out (FR-80);
 * 4. the open questions it withdraws;
 * 5. its new questions, numbered on from the last, each depending only on
 *    earlier ones;
 * 6. the next round: every open question waiting to be asked whose
 *    prerequisites are settled (or, when none is but some wait, all of
 *    them, as they can never be). With none, no open questions remain,
 *    and the Owner is asked to confirm.
 *
 * A session that writes no documents (`/to-tickets`) keeps no glossary
 * terms and no documents' parts, whatever the turn gives.
 */
export function applyTurn(
  session: GrillingSessionRecord,
  given: GrillingTurn,
  at: Date,
): AppliedTurn {
  const turn: GrillingTurn = grillingWritesDocuments(session.skill)
    ? given
    : { ...given, terms: [], outline: [], adrs: [], processes: [] };
  const when = at.toISOString();
  const known = new Set(session.questions.map(({ number }) => number));
  const decisionRound = Math.max(1, session.round);
  const decisions: GrillingDecision[] = [...session.decisions];
  const decide = (text: string, questions: readonly number[]): void => {
    decisions.push({
      number: decisions.length + 1,
      text,
      questions: [...new Set(questions)].sort((a, b) => a - b),
      round: decisionRound,
      settledAt: when,
    });
  };
  for (const decision of turn.decisions) {
    decide(
      decision.text,
      decision.questions.filter((number) => known.has(number)),
    );
  }
  const decided = new Set(decisions.flatMap(({ questions }) => questions));
  for (const question of session.questions) {
    if (question.status === "answered" && !decided.has(question.number)) {
      decide(answerDecision(question), [question.number]);
    }
  }

  const terms = new Map(
    session.terms.map((term) => [term.term.toLowerCase(), term]),
  );
  for (const { term, definition, avoid } of turn.terms) {
    const key = term.toLowerCase();
    terms.delete(key);
    terms.set(key, { term, definition, avoid: [...avoid] });
  }

  const warranted = turn.adrs.filter(adrWarranted);
  const leftOut = turn.adrs
    .filter((adr) => !adrWarranted(adr))
    .map(({ title }) => title);

  const withdrawn = new Set(turn.withdraw);
  const questions: GrillingQuestion[] = session.questions.map((question) =>
    question.status === "open" && withdrawn.has(question.number)
      ? { ...question, status: "withdrawn" }
      : question,
  );
  let next = Math.max(0, ...questions.map(({ number }) => number)) + 1;
  for (const question of turn.questions) {
    const number = next++;
    questions.push({
      number,
      round: null,
      text: question.text,
      recommended: question.recommended,
      dependsOn: [...new Set(question.dependsOn)]
        .filter((other) => other < number && other >= 1)
        .sort((a, b) => a - b),
      status: "open",
      answer: null,
      acceptedRecommended: false,
      answeredAt: null,
    });
  }

  const byNumber = new Map(
    questions.map((question) => [question.number, question]),
  );
  const waiting = questions.filter(
    ({ status, round }) => status === "open" && round === null,
  );
  const ready = waiting.filter(({ dependsOn }) =>
    dependsOn.every((other) => settled(byNumber.get(other))),
  );
  const asking = new Set(
    (ready.length > 0 ? ready : waiting).map(({ number }) => number),
  );
  const round = asking.size > 0 ? session.round + 1 : session.round;
  const asked: GrillingQuestion[] = [];
  const updated = questions.map((question) => {
    if (!asking.has(question.number)) {
      return question;
    }
    const now: GrillingQuestion = { ...question, round };
    asked.push(now);
    return now;
  });
  return {
    session: {
      ...session,
      round,
      awaitingConfirmation: asked.length === 0,
      questions: updated,
      decisions,
      terms: [...terms.values()],
      outline: replaced(
        session.outline,
        turn.outline.map(({ heading, text }) => ({ heading, text })),
        ({ heading }) => heading,
      ),
      adrs: replaced(
        session.adrs,
        warranted.map((adr) => ({
          ...adr,
          options: [...adr.options],
          consequences: [...adr.consequences],
        })),
        ({ title }) => title,
      ),
      processes: replaced(
        session.processes,
        turn.processes.map(({ title, text }) => ({ title, text })),
        ({ title }) => title,
      ),
      updatedAt: at,
    },
    asked,
    leftOut,
  };
}

/** A fact as the Agent sent to find it answered. */
export interface FoundFact {
  readonly question: string;
  readonly answer: string;
  readonly status: GrillingFactStatus;
  /** The Agent that found it. */
  readonly agentId: string;
}

/** Records facts found in the repository, numbered on from the last (FR-79). */
export function recordFacts(
  session: GrillingSessionRecord,
  found: readonly FoundFact[],
  at: Date,
): GrillingSessionRecord {
  if (found.length === 0) {
    return session;
  }
  const foundAt = at.toISOString();
  return {
    ...session,
    facts: [
      ...session.facts,
      ...found.map((fact, index): GrillingFact => ({
        number: session.facts.length + index + 1,
        question: fact.question,
        answer: fact.answer,
        status: fact.status,
        agentId: fact.agentId,
        round: session.round,
        foundAt,
      })),
    ],
    updatedAt: at,
  };
}
