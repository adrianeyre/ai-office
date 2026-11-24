---
name: spec
description: "Agree a feature's Spec with the Owner one step at a time: requirements with numbered Acceptance Criteria, then a design, then ordered tasks that become the issues. Run it as /spec followed by the feature; it starts a Grilling Session that writes the Spec in .agents/specs/."
---

# Spec

AI Office's own Skill. It runs as a Grilling Session in three phases: requirements, then design, then tasks. AI Office keeps the session, the phase it is in, your draft of the phase's document and every document the Owner approved, and gives them back to you word for word. Follow the Grilling Session's instructions for the form of each turn; these say what to find, what to ask and what to write.

A Spec is how a Goal becomes issues the Owner approved first. Only the Owner moves it from one phase to the next, in their own words; you never do. Each document they confirm is committed in `.agents/specs/<slug>/` on the session's branch, and one pull request with all of them is opened when they confirm the tasks.

## The phases

1. **Requirements** (`requirements.md`). User stories, each "As a …, I want …, so that …", each with its Acceptance Criteria: numbered, testable statements of what the system shall do in a given situation, such as "R2.3 WHEN a shopper removes a saved card THE SYSTEM SHALL stop offering it at checkout" (R2.3 is requirement 2's third criterion). Use the "IF <condition> THEN THE SYSTEM SHALL <response>", "WHILE <state> THE SYSTEM SHALL <response>" or "WHERE <option> THE SYSTEM SHALL <response>" forms when a condition, a state or an option fits better. The Owner ends it with "confirm requirements", which AI Office refuses, naming each criterion that fails and why, until every one:
   - starts with its id: a capital R, its own requirement's number, a dot and a number from 1 (R2.1, R2.2 and on, under requirement 2);
   - has an id no other criterion has;
   - is in one of those four forms, its keywords (WHEN, IF, THEN, WHILE, WHERE, THE SYSTEM SHALL) in capitals;
   - says SHALL once: one behaviour per criterion, so "keep the token and email the shopper" is two criteria.

   Anything that is not such a statement (context, notes, examples) goes in the user story or the introduction, never among the criteria. When the Owner is refused, fix every criterion named in your next draft.
2. **Design** (`design.md`). How it is built: its architecture (the parts, and how they fit the system as it is), its data, its error handling (what can go wrong, and what then happens), and its testing approach (how each criterion is tested). Build on the approved requirements; design nothing they do not ask for. The Owner ends it with "confirm design", or skips it with "skip design" on any Floor: a small change may need no design.
3. **Tasks** (`tasks.md`). The work, in the order it should be built: each task a vertical slice that can be built, reviewed and merged on its own, naming the Acceptance Criteria it meets by id and the earlier tasks it depends on. Every criterion is met by some task. The Owner ends it with "confirm tasks": each task becomes one of the session's issue drafts, and the session ends.

The Owner may reopen an earlier phase ("reopen requirements"). Its approved copy is then yours to redraft, and every later phase is drafted again from nothing once it is confirmed.

## Process

1. **Find facts first.** Ask for what the repository can answer (a turn's `facts`) rather than asking the Owner: how the code works today, what the docs and glossary say, which issues exist. Use the glossary's words throughout. The Agents' read-only clone never shows `.agents/`: any Spec the Floor has already reaches you only as AI Office gives it.
2. **Draft early.** Give your draft of the current phase's document in your first turn of it, with questions only for the decisions it needs from the Owner, each with your recommended answer. Give the draft again, whole, whenever their answers change it.
3. **Leave the moving on to the Owner.** Once the draft is complete and nothing is left to ask, leave `questions` empty: AI Office asks the Owner to confirm the phase. Never write the next phase's document before they do.

## What it writes

Only the Spec: no PRD, ADRs, glossary or process docs. `tasks.md` holds no status: progress is read from the issues. Never a credential, a token, a password or a private address in any of it.
