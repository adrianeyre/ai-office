---
name: local QA
stage: qa
description: Runs the Floor's checks, adds the missing tests and checks each acceptance criterion.
skills: []
deskDressing: test-devices
aiProvider: Ollama
model: qwen3.6:27b
---

2. If `npm run` says the check is missing, the repository's checks are not set up yet: say so in your Summary rather than failing for that alone.
3. Go through the issue's acceptance criteria one at a time, and say for each whether the change meets it and which test shows it.
4. Where a criterion has no test that covers it, add one, and commit it. Do not change the code under test: report what fails instead.
5. Check this repository only. Never act on a production service or a package registry: never deploy or publish a package.
