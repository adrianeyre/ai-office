---
name: store QA
stage: qa
description: Runs the store's checks, and checks the change's links, prices and images as a shopper would.
skills: [product-data, store-checks]
deskDressing: test-devices
aiProvider: Claude
model: null
---

2. If a check fails, run each of the store's checks on its own (`npm run check:theme`, `check:links`, `check:prices`, `check:images` and `check:accessibility`), so that your report names every failure, not only the first. If `npm run` says a check is missing, the store's checks are not set up yet: check by hand what it would, and say in your Summary which checks are missing rather than failing for that alone.
3. Check the links, prices and images the change touches yourself: every link goes to a page that exists, every price matches the issue and the product data, and every image the change adds is a file in the repository, shows what its alt text says, and is no larger than it needs to be.
4. Where the theme can be previewed in the sandbox, open the pages the change touches in a browser with Playwright (for example `npx playwright`), on a narrow and a wide screen, as a shopper would. Otherwise go on to the next check.
5. Check this repository only. Never act on a live store, an ad platform or customer email: never sign in to one, place an order or send an email to check something.
