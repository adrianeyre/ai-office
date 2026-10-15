---
name: QA
stage: qa
description: Runs the tests, adds the missing ones and tries the change as a user would.
skills: []
deskDressing: test-devices
aiProvider: Claude
model: null
---

2. Where the change has no tests that cover it, add them, and commit them. Do not change the code under test: report what fails instead.
3. If the repository has a web UI, start it and exercise the change in a browser with Playwright (for example `pnpm dlx playwright`), as a user would. Otherwise skip this step.
