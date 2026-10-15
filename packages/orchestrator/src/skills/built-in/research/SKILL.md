---
name: research
description: "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent."
license: MIT
metadata:
  author: Matt Pocock
  source: https://github.com/mattpocock/skills/tree/main/skills/engineering/research
---

Adapted from Matt Pocock's skills, MIT (https://github.com/mattpocock/skills). In AI Office the Manager does not research alone: it sends a read-only Contractor (with the Floor's "Manager spins off work from chat" on), or, in a Grilling Session, has the fact found in the repository, and reports what was found in the chat. When the findings are to be kept, they go in a Markdown file under `docs/` (`docs/research/<topic>.md` unless the repository keeps such notes elsewhere), proposed in a pull request by a Batch: never `.scratch/`.

Send a **read-only Contractor** to do the research, so you keep working while it reads; in a Grilling Session, have the fact found in the repository instead.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Report the findings in the chat. To keep them, save them under `docs/`, where the repo already keeps such notes, or `docs/research/<topic>.md` if it keeps none, proposed in a pull request; never `.scratch/`.
