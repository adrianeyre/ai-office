import {
  grillingSkillName,
  skillFileName,
  type SkillFile,
} from "@ai-office/shared";

// The built-in `/grilling` Skill (PRD FR-77): AI Office's own, in the Agent
// Skills format like every other Skill, so the Available Skills list shows
// and opens it. Running it starts a Grilling Session: AI Office keeps the
// session's rounds, questions, decisions, glossary terms and documents,
// and the Manager's Model follows these instructions while it runs, as it
// does for every built-in Skill that starts a session (`/grill-with-docs`
// and the rest, `skills/built-in.ts`), beside theirs. No office or
// repository Skill of its name overrides it.

export const grillingSkillDescription =
  "Interview the Owner about a feature or product in rounds of numbered questions, each with a recommended answer, until you share an understanding of it. Run it as /grilling followed by what to grill.";

export const grillingSkillInstructions = `# Grilling Session

You are running a Grilling Session: an interview of the Owner about a feature or a product, in rounds, until the two of you share an understanding of it. AI Office keeps the session (its rounds, every question and answer, the decisions settled and the glossary terms) and gives it back to you in full each time.

## How it works

1. Each round asks every question whose prerequisites are settled: none it depends on is still open. Number questions across the whole session; AI Office numbers them for you in the order you give them.
2. Give every question your recommended answer: the one you would choose, stated as an answer the Owner can accept as it is.
3. The Owner answers each question, replies "recommended" to accept one, or "recommended to all" to accept the rest of the round.
4. Once every question in a round is answered, record what was settled and ask the next round. Answers reshape it: ask the questions they raise, and withdraw the ones they made moot.
5. When no open questions remain, AI Office asks the Owner to confirm, and the session ends when they do.

## What to ask

- Ask the Owner only for decisions: what they want, what matters more, what to leave out. Do not ask for facts you could find yourself.
- Find facts yourself: how the code works today, what the docs say, which issues exist. AI Office can have them found in the Floor's repository, in a read-only sandbox, by you or by one of the Floor's Agents you send, and gives you what was found.
- One decision per question. Keep each question and its recommended answer short and concrete.
- Prefer few rounds with the questions that unblock the most others.
- Settle the words too: when a name for a thing is decided, record it as a glossary term with its definition and the words to avoid.

## Decisions

Record each settled decision as one sentence that stands on its own, without the question: "Exports are CSV only; JSON is out of scope." Decisions are kept word for word for the rest of the session, so write them as you want them read later.

## Documents

Keep the Floor's documents current as decisions settle. AI Office writes them on the session's own branch after every turn, and opens one pull request with all of them when the session ends:

- **The PRD:** its outline, section by section. Rewrite a section whenever the answers change it; the settled decisions are added after it word for word.
- **The glossary:** every term you settle is written to GLOSSARY.md at once, with its definition and the words to avoid.
- **ADRs:** only for a decision that is hard to reverse, surprising without its context, and the result of a real trade-off. Say why it is each; most decisions need no ADR.
- **Process docs:** how some work gets done, when the session settles one.
`;

/** The built-in Skill's `SKILL.md`, frontmatter and all. */
export const grillingSkillDocument = `---
name: ${grillingSkillName}
description: ${grillingSkillDescription}
---

${grillingSkillInstructions}`;

/** The built-in Skill as a Floor's Skills list it. */
export const grillingSkill = {
  name: grillingSkillName,
  description: grillingSkillDescription,
  files: [
    { path: skillFileName, content: grillingSkillDocument },
  ] satisfies SkillFile[],
} as const;
