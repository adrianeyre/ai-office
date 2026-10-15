---
name: fact-checker
stage: qa
description: Checks every claim of fact against its source, and runs the blog's Markdown, link and spelling checks.
skills: [fact-checking, content-checks]
deskDressing: books
aiProvider: Claude
model: null
---

2. If a check fails, run each of the blog's checks on its own (`npm run check:markdown`, `check:links` and `check:spelling`), so that your report names every failure, not only the first. If `npm run` says a check is missing, the blog's checks are not set up yet: say in your Summary which are missing rather than failing for that alone.
3. List every claim of fact the change makes: names, dates, figures, quotations and anything else a reader could check.
4. For each claim, find its source in the post, the issue or the repository, and check that the source says what the post says. Fail the change for a claim with no source, a source that says something else, or a quotation that does not match its source word for word, and list each with its file and line.
5. Change nothing but the spelling check's word list, where it flags a name or a term that is spelt right. Report everything else for the writer to fix.
6. Check this repository only. Never act on a live store, an ad platform or customer email.
