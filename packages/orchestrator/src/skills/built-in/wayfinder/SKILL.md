---
name: wayfinder
description: "Chart a loose idea too big for one session: name its destination first, then ask breadth-first across the whole space, recording what is not yet specified and what is out of scope, until the way is clear and the issues that take it can be drafted. Run it as /wayfinder followed by the idea; it starts a Grilling Session."
license: MIT
metadata:
  author: Matt Pocock
  source: https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder
---

# Wayfinder

Adapted from Matt Pocock's skills, MIT (https://github.com/mattpocock/skills). In AI Office it runs as a Grilling Session: AI Office keeps the rounds, questions, decisions, glossary terms and documents, and writes the documents on the session's branch. Follow the Grilling Session's instructions for the form of each turn; these say how to chart the way.

A loose idea has arrived, too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination.

## What AI Office does, and does not

- **The map is the PRD.** There is no map issue and no `wayfinder:` labels. The PRD's outline is the map: `docs/product-requirements-document/<topic>.md`, written on the session's branch as you settle it. ADRs go in `docs/architectural-decision-record/`, and glossary terms in `GLOSSARY.md`. Nothing goes in `.scratch/` or a local tracker, and there is no setup Skill to run first.
- **The tickets are the drafted issues.** When the session ends, AI Office opens one pull request with its documents, and you draft the issues that take the way: decision tickets (research, a prototype, a grilling, a task that unblocks a decision) and build tickets alike, each blocked only by earlier ones. The Owner edits and approves them, and the GitHub App files them.
- **AI Office does not claim or assign tickets, label them by type, or work through them in later sessions.** Say so if the Owner expects it. A filed issue becomes work when the Owner hands it to the Manager as a Batch, or grills it in a session of its own.
- **Research is fact-finding.** Where a question waits on a fact from the repository, ask for it to be found (in a turn's `facts`) rather than asking the Owner, or making it a ticket.

## Plan, don't do

Wayfinding is **planning**: each question resolves a decision, and the map is done when the way is clear, with nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map.

## How the session runs

1. **Name the destination first.** The first round settles what this map is finding its way to: a spec to hand off, a decision to lock before planning starts, or a change made in place, such as a data migration. The destination fixes the scope, so settle it before anything else, and write it as the outline's first section, **Destination**, in one or two lines.
2. **Map the frontier, breadth-first.** Then fan out across the whole space rather than deep on any one thread: every round asks the open decisions across every area the destination touches, and the first steps that can be taken now. If this surfaces no fog (the way is already clear, the whole journey small enough for one session), say so in the turn's message and leave `questions` empty, so the Owner can confirm and go straight to the issues.
3. **Keep the outline as the map.** Besides the sections that say what to build, keep these sections current in the outline:
   - **Destination:** what reaching the end looks like.
   - **Notes:** the domain, and standing preferences for this effort.
   - **Not yet specified:** the fog of war (see below).
   - **Out of scope:** work ruled beyond the destination (see below).
   The settled decisions are added after the outline word for word: they are the Decisions so far.
4. **Refer by name.** In everything the Owner reads, refer to a decision, a section or a ticket by its name, never by a bare number.

## Grilling

Interview the Owner relentlessly until the way is clear. Map it as a **design tree**: every decision branches into the decisions that hang off it. Each round asks the **frontier**: every decision whose prerequisites are already settled, each with your recommended answer, worded so accepting it as recommended accepts your answer. A question whose answer depends on another still open belongs to a later round: give it in `dependsOn`. Finding _facts_ is your job, never the Owner's: ask for them to be found. The _decisions_ are the Owner's: put each to them and wait.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the questions you can ask lies the **fog of war**: decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open.

The outline's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. Everything there is in scope, just not sharp enough to ask yet. Write as loosely or as fully as the view allows.

**Fog or question?** The test is whether you can state the question precisely now, _not_ whether it can be answered now.

- **Ask it** (or hold it, with `dependsOn`) when the question is already sharp, even if it is blocked.
- **Not yet specified** when you can't yet phrase it that sharply. Don't pre-slice the fog into question-sized pieces: one patch may become several questions, or none, once the frontier reaches it. As answers clear the fog, graduate what is now specifiable into questions, and take it out of **Not yet specified**.

## Out of scope

Fog only ever gathers _toward_ the destination. Work beyond it is **out of scope**: it isn't fog, and it doesn't belong in **Not yet specified**. Write it in the outline's **Out of scope** section, one line each: the gist, and why it is out of scope. It never graduates; it returns only if the destination is redrawn, as a fresh effort.

## The tickets

When you draft the issues, they are the way to the destination:

- **Decision tickets** for what is still in the fog and must be decided before building: say in "What to build" which kind each is (research, a prototype, a grilling, or a task that unblocks a decision) and the question it resolves.
- **Build tickets** for what is decided: vertical slices, as every drafted issue is.
- Each blocked only by the earlier tickets that genuinely gate it.
