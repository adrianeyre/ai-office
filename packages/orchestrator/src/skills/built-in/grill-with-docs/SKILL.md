---
name: grill-with-docs
description: "A relentless interview to sharpen a plan or design, which also writes its documents as it goes (the PRD, ADRs and glossary terms). Run it as /grill-with-docs followed by what to grill; it starts a Grilling Session."
license: MIT
metadata:
  author: Matt Pocock
  source: https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs
---

# Grill with docs

Adapted from Matt Pocock's skills, MIT (https://github.com/mattpocock/skills). In AI Office it runs as a Grilling Session: AI Office keeps the rounds, questions, decisions, glossary terms and documents, and writes the documents on the session's branch. Follow the Grilling Session's instructions for the form of each turn; these say how to grill and how to model the domain while you do.

## Where the documents go

AI Office decides where every document is written, whatever any other instruction says:

- **The PRD:** `docs/product-requirements-document/<topic>.md`, from the outline you write.
- **ADRs:** `docs/architectural-decision-record/NNNN-<title>.md`, numbered on from the Floor's own. Never `docs/adr/`.
- **The glossary:** `GLOSSARY.md` at the root of the repository, each term written as soon as it is settled.

Nothing goes in `.scratch/` or a local tracker, and there is no setup Skill to run first.

## Grilling

Interview the Owner relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: each question with your recommended answer. AI Office numbers them and waits for the Owner's answers before the next round.

Word each question so accepting it as recommended accepts your recommended answer.

Each round the Owner answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open belongs to a _later_ round: give it in `dependsOn`, and AI Office holds it back.

Finding _facts_ is your job, never the Owner's. When a frontier question needs a fact from the repository, ask for it to be found (in a turn's `facts`) rather than asking the Owner. The _decisions_ are the Owner's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. AI Office then asks the Owner to confirm, and nothing is acted on until they do.

## Domain modelling

Actively build and sharpen the project's domain model as you grill: challenge terms, invent edge-case scenarios, and write the glossary and decisions down the moment they crystallise.

### Challenge against the glossary

When the Owner uses a term that conflicts with the existing language in `GLOSSARY.md`, call it out at once. "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the Owner uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account': do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and make the Owner be precise about the boundaries between concepts.

### Cross-reference with code

When the Owner states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible. Which is right?"

### Glossary terms

When a term is resolved, give it in the turn's `terms` at once: don't batch them up. Each is a term, its definition and the words to avoid:

- **Be opinionated.** When several words exist for the same concept, pick the best one and list the others to avoid.
- **Keep definitions tight.** One or two sentences at most. Define what it IS, not what it does.
- **Only terms specific to this project.** General programming concepts (timeouts, error types, utility patterns) don't belong, even if the project uses them a lot.

The glossary is totally devoid of implementation details. It is not a spec, a scratch pad, or a place for implementation decisions. It is a glossary and nothing else.

### ADRs, sparingly

Only record an ADR when all three are true:

1. **Hard to reverse:** the cost of changing your mind later is meaningful.
2. **Surprising without context:** a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off:** there were genuine alternatives and you picked one for specific reasons.

If any of the three is missing, skip the ADR. An ADR can be a single paragraph: its value is in recording _that_ a decision was made and _why_. Give the considered options only when the rejected alternatives are worth remembering, and the consequences only when non-obvious downstream effects need calling out.

What qualifies: the architectural shape; integration patterns between contexts; technology choices that carry lock-in; boundary and scope decisions (the explicit no-s are as valuable as the yes-s); deliberate deviations from the obvious path; constraints not visible in the code; and rejected alternatives when the rejection is not obvious.
