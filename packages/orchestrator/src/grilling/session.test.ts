import { grillingTurnSchema } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  applyAnswers,
  applyTurn,
  openInRound,
  openQuestions,
  recordFacts,
  type GrillingSessionRecord,
} from "./session.ts";

// A Grilling Session's plain-code rules (PRD FR-78, FR-79, FR-80):
// numbering, which questions a round asks, answers, decisions, the facts
// found, and the documents' parts.

const at = new Date("2026-10-10T12:00:00.000Z");

const empty: GrillingSessionRecord = {
  id: 1,
  floorId: "web-shop",
  topic: "exports",
  skill: "grilling",
  status: "active",
  round: 0,
  awaitingConfirmation: false,
  questions: [],
  decisions: [],
  terms: [],
  facts: [],
  outline: [],
  adrs: [],
  processes: [],
  documents: null,
  issues: null,
  sources: [],
  startedAt: at,
  updatedAt: at,
  pausedAt: null,
  endedAt: null,
};

const turn = (value: unknown) => grillingTurnSchema.parse(value);
const ask = (text: string, dependsOn: number[] = []) => ({
  text,
  recommended: `${text} Yes.`,
  dependsOn,
});

describe("applyTurn", () => {
  it("numbers questions on, and asks those whose prerequisites are settled", () => {
    const { session, asked } = applyTurn(
      empty,
      turn({
        questions: [ask("A?"), ask("B?", [1]), ask("C?", [3, 9]), ask("D?")],
      }),
      at,
    );
    expect(asked.map(({ number }) => number)).toEqual([1, 3, 4]);
    // A question depends only on earlier ones: 3 on itself, 9 not yet.
    expect(session.questions.map(({ dependsOn }) => dependsOn)).toEqual([
      [],
      [1],
      [],
      [],
    ]);
    expect(session.round).toBe(1);
    expect(openQuestions(session)).toHaveLength(4);
    expect(openInRound(session)).toHaveLength(3);
  });

  it("withdraws moot questions, and asks a waiting one once its prerequisite is withdrawn", () => {
    let { session } = applyTurn(
      empty,
      turn({ questions: [ask("A?"), ask("B?", [1]), ask("C?", [1])] }),
      at,
    );
    session = applyAnswers(
      session,
      {
        answers: [{ number: 1, answer: "No" }],
        restRecommended: false,
        bare: false,
      },
      at,
    ).session;
    const next = applyTurn(session, turn({ withdraw: [2, 1] }), at);
    expect(next.session.questions.map(({ status }) => status)).toEqual([
      "answered",
      "withdrawn",
      "open",
    ]);
    expect(next.asked.map(({ number }) => number)).toEqual([3]);
  });

  it("asks every waiting question when none can ever be ready", () => {
    // 2 waits on 1, which is never answered here, so 1 is asked.
    const { session } = applyTurn(
      { ...empty, round: 1, questions: [] },
      turn({ questions: [ask("A?"), ask("B?", [1])] }),
      at,
    );
    expect(openInRound(session).map(({ number }) => number)).toEqual([1]);
    // Were waiting questions ever to wait on each other, all are asked.
    const stuck = applyTurn(
      {
        ...session,
        questions: session.questions.map((question) =>
          question.number === 1
            ? { ...question, round: null, dependsOn: [2] }
            : question,
        ),
      },
      turn({}),
      at,
    );
    expect(stuck.asked.map(({ number }) => number)).toEqual([1, 2]);
  });

  it("settles every answer as a decision, and replaces a term defined again", () => {
    let { session } = applyTurn(
      empty,
      turn({
        questions: [ask("Format?"), ask("Who?")],
        terms: [{ term: "Export", definition: "A file." }],
      }),
      at,
    );
    session = applyAnswers(
      session,
      {
        answers: [{ number: 1, answer: "CSV" }],
        restRecommended: true,
        bare: false,
      },
      at,
    ).session;
    const next = applyTurn(
      session,
      turn({
        decisions: [{ text: "Exports are CSV.", questions: [1, 7] }],
        terms: [{ term: "export", definition: "A CSV file.", avoid: ["dump"] }],
      }),
      at,
    );
    expect(next.session.decisions).toEqual([
      {
        number: 1,
        text: "Exports are CSV.",
        questions: [1],
        round: 1,
        settledAt: at.toISOString(),
      },
      {
        number: 2,
        text: "Who? Who? Yes.",
        questions: [2],
        round: 1,
        settledAt: at.toISOString(),
      },
    ]);
    expect(next.session.terms).toEqual([
      { term: "export", definition: "A CSV file.", avoid: ["dump"] },
    ]);
    expect(next.asked).toEqual([]);
    expect(next.session.awaitingConfirmation).toBe(true);
  });
});

describe("applyTurn and the documents", () => {
  const adr = (title: string, reasons: boolean) => ({
    title,
    decision: `${title}.`,
    ...(reasons
      ? {
          hardToReverse: "Data would have to move.",
          surprising: "Most shops do otherwise.",
          tradeOff: "Speed over cost.",
        }
      : { hardToReverse: "Data would have to move.", tradeOff: "Speed." }),
  });

  it("replaces outline sections, ADRs and process docs of the same heading or title in place, and adds the rest", () => {
    let { session } = applyTurn(
      empty,
      turn({
        outline: [
          { heading: "Problem", text: "Copying by hand." },
          { heading: "Scope", text: "Orders." },
        ],
        adrs: [adr("Exports run at once", true)],
        processes: [{ title: "Releasing", text: "Tag it." }],
        questions: [ask("A?")],
      }),
      at,
    );
    ({ session } = applyTurn(
      session,
      turn({
        outline: [
          { heading: "problem", text: "Copying by hand, weekly." },
          { heading: "Out of scope", text: "Refunds." },
        ],
        adrs: [
          { ...adr("Exports run at once", true), decision: "At once, always." },
        ],
        processes: [{ title: "Running an export", text: "Open Orders." }],
      }),
      at,
    ));
    expect(session.outline).toEqual([
      { heading: "problem", text: "Copying by hand, weekly." },
      { heading: "Scope", text: "Orders." },
      { heading: "Out of scope", text: "Refunds." },
    ]);
    expect(session.adrs).toEqual([
      {
        title: "Exports run at once",
        decision: "At once, always.",
        options: [],
        consequences: [],
        hardToReverse: "Data would have to move.",
        surprising: "Most shops do otherwise.",
        tradeOff: "Speed over cost.",
      },
    ]);
    expect(session.processes.map(({ title }) => title)).toEqual([
      "Releasing",
      "Running an export",
    ]);
  });

  it("leaves out an ADR that does not say why it is hard to reverse, surprising and a real trade-off", () => {
    const applied = applyTurn(
      empty,
      turn({
        adrs: [
          adr("Orders live in Postgres", true),
          adr("Columns are in English", false),
          { ...adr("Prices in pence", true), surprising: "  " },
        ],
      }),
      at,
    );
    expect(applied.session.adrs.map(({ title }) => title)).toEqual([
      "Orders live in Postgres",
    ]);
    expect(applied.leftOut).toEqual([
      "Columns are in English",
      "Prices in pence",
    ]);
  });
});

describe("applyAnswers", () => {
  const { session } = applyTurn(
    empty,
    turn({ questions: [ask("A?"), ask("B?"), ask("C?", [1])] }),
    at,
  );

  it("records answers in the Owner's words or the recommended ones", () => {
    const applied = applyAnswers(
      session,
      {
        answers: [
          { number: 2, answer: null },
          { number: 3, answer: "Later" },
        ],
        restRecommended: false,
        bare: false,
      },
      at,
    );
    expect(applied.answered).toEqual([2]);
    expect(applied.notInRound).toEqual([3]);
    expect(applied.session.questions[1]).toMatchObject({
      status: "answered",
      answer: "B? Yes.",
      acceptedRecommended: true,
      answeredAt: at.toISOString(),
    });
  });

  it("takes a bare 'recommended' only when one question is open", () => {
    expect(
      applyAnswers(
        session,
        { answers: [], restRecommended: true, bare: true },
        at,
      ).unclear,
    ).toBe(true);
    const one = applyAnswers(
      session,
      {
        answers: [{ number: 1, answer: "Yes" }],
        restRecommended: false,
        bare: false,
      },
      at,
    ).session;
    expect(
      applyAnswers(one, { answers: [], restRecommended: true, bare: true }, at)
        .answered,
    ).toEqual([2]);
  });
});

describe("recordFacts", () => {
  it("numbers facts on across the session, at the latest round asked", () => {
    const later = new Date("2026-10-10T12:05:00.000Z");
    const first = recordFacts(
      empty,
      [
        {
          question: "Which database?",
          answer: "Postgres 18.",
          status: "found",
          agentId: "mo",
        },
      ],
      at,
    );
    const second = recordFacts(
      { ...first, round: 2 },
      [
        {
          question: "Is there an export?",
          answer: "Ada finished without an answer.",
          status: "failed",
          agentId: "ada",
        },
      ],
      later,
    );
    expect(second.facts).toEqual([
      {
        number: 1,
        question: "Which database?",
        answer: "Postgres 18.",
        status: "found",
        agentId: "mo",
        round: 0,
        foundAt: at.toISOString(),
      },
      {
        number: 2,
        question: "Is there an export?",
        answer: "Ada finished without an answer.",
        status: "failed",
        agentId: "ada",
        round: 2,
        foundAt: later.toISOString(),
      },
    ]);
    expect(second.updatedAt).toBe(later);
    expect(recordFacts(second, [], later)).toBe(second);
  });

  it("reads a turn's facts, at most five, each with an optional Agent", () => {
    expect(
      grillingTurnSchema.parse({
        facts: [
          { question: "Which database?" },
          { question: "CSV?", agent: " Ada " },
        ],
      }).facts,
    ).toEqual([
      { question: "Which database?" },
      { question: "CSV?", agent: "Ada" },
    ]);
    expect(grillingTurnSchema.parse({}).facts).toEqual([]);
    expect(
      grillingTurnSchema.safeParse({
        facts: Array.from({ length: 6 }, () => ({ question: "Which?" })),
      }).success,
    ).toBe(false);
    expect(
      grillingTurnSchema.safeParse({ facts: [{ question: " " }] }).success,
    ).toBe(false);
  });
});
