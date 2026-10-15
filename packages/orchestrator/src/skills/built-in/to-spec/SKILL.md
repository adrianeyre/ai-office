---
name: to-spec
description: "Turn the conversation so far into a PRD, without an interview, asking only whether the seams to test at are right. Run it as /to-spec, optionally followed by the feature's name; it starts a Grilling Session that writes the PRD."
license: MIT
metadata:
  author: Matt Pocock
  source: https://github.com/mattpocock/skills/tree/main/skills/engineering/to-spec
---

# To spec

Adapted from Matt Pocock's skills, MIT (https://github.com/mattpocock/skills). In AI Office it runs as a Grilling Session: AI Office keeps the session, writes the PRD on the session's branch from the outline you write, opens one pull request with it when the Owner confirms, and then asks you to draft the issues that build it. Follow the Grilling Session's instructions for the form of each turn; these say what to write.

This takes the conversation so far and your understanding of the codebase and writes a spec, as the PRD. Do NOT interview the Owner: synthesise what you already know.

## Where the spec goes

- **The PRD:** `docs/product-requirements-document/<topic>.md`, from the outline you write. Never an issue, `.scratch/` or a local tracker, and there is no setup Skill to run first.
- **ADRs**, if a decision qualifies: `docs/architectural-decision-record/`.
- **Glossary terms:** `GLOSSARY.md`.

## Process

1. Find out what you need about the current state of the code, if you don't know it yet: ask for it to be found (in a turn's `facts`) rather than asking the Owner. Use the project's glossary vocabulary throughout the spec, and respect any ADRs in the area being touched.
2. Sketch the seams at which the feature will be tested. Prefer existing seams to new ones, and the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better: the ideal number is one.
3. In your first turn, write the whole spec as the PRD's outline, in the sections below, and ask one round: whether the seams match what the Owner expects, each seam a question with your recommended answer. Ask nothing else, unless the conversation left a decision genuinely unmade.
4. Once the Owner has answered, rewrite the sections the answers change, and leave `questions` empty: AI Office asks the Owner to confirm.

## The outline's sections

- **Problem Statement:** the problem the user is facing, from the user's perspective.
- **Solution:** the solution, from the user's perspective.
- **User Stories:** a LONG, numbered list, each in the form "As an <actor>, I want a <feature>, so that <benefit>", covering every aspect of the feature.
- **Implementation Decisions:** the modules to build or change and their interfaces, technical clarifications, architectural decisions, schema changes, API contracts and specific interactions. No specific file paths or code snippets: they go stale fast. The exception is a snippet from a prototype that encodes a decision more precisely than prose can; trim it to its decision-rich parts, and say it came from a prototype.
- **Testing Decisions:** what makes a good test (only external behaviour, not implementation details), which modules will be tested, at which seams, and prior art for the tests in the codebase.
- **Out of Scope:** what this spec leaves out.
- **Further Notes:** anything else about the feature.
