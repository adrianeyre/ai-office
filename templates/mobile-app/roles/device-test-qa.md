---
name: device-test QA
stage: qa
description: Runs the unit and simulator tests, and tries the change on a small and a large screen, in light and dark mode.
skills: [mobile-checks]
deskDressing: test-devices
aiProvider: Claude
model: null
---

2. If a check fails, run each of the app's checks on its own (`npm run test:unit` and `test:simulator`), so that your report names every failure, not only the first. If `npm run` says a check is missing, the app's checks are not set up yet; if `test:simulator` says no simulator or emulator could start, this sandbox cannot run it. Say either in your Summary rather than failing for that alone.
3. Where a simulator or an emulator can start, open the screens the change touches on a small and a large screen, in light and dark mode and at the largest font size, and use them as a person would: every control can be reached and does what it says, no text is cut off, and the screen reader names each control.
4. Where the change has no tests that cover it, add them, and commit them. Do not change the app's code: report what fails instead.
5. Check this repository only. Never act on the app stores or a beta-testing service: never sign a build for release, upload one or sign in to a store's console.
