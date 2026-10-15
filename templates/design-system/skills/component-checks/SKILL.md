---
name: component-checks
description: How to set up and run a design system's checks (component tests, visual snapshots and contrast) as npm scripts in its repository, and what each one checks. Use it when the checks fail, are missing, or need changing.
---

# The design system's checks

A Design system Floor checks every change with three scripts in the repository's `package.json`, run by the Floor's check command:

```sh
npm run test:components && npm run test:visual && npm run check:contrast
```

Each one exits with an error, naming the component or the file and the problem, when its check fails. Run one on its own with `npm run <name>`.

## What each one checks

| Script | What it checks | A tool that does it |
| --- | --- | --- |
| `test:components` | Each component renders, behaves as its props say, and has no accessibility violation in any of its stories | Vitest or Jest with Testing Library, and `axe` (`vitest-axe` or `jest-axe`) |
| `test:visual` | A screenshot of every story, in each of its states and themes, matches the baseline committed in the repository | Playwright's `toHaveScreenshot` over the built stories, or Storybook's test runner |
| `check:contrast` | Every pair of text and background colours the design tokens define meets WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text and controls | a short Node script over the design tokens |

## Setting them up

When a script is missing, add it to `package.json`, with the tool it needs in `devDependencies`, so that `npm install` brings it. For example:

```json
{
  "scripts": {
    "test:components": "vitest run",
    "test:visual": "playwright test --config playwright.visual.config.ts",
    "check:contrast": "node scripts/check-contrast.mjs tokens/colours.json"
  }
}
```

The contrast check reads the pairs the design tokens name (such as `text.default` on `surface.default`), works out each pair's contrast ratio, prints one line for each pair below its minimum, such as `tokens/colours.json: text.muted on surface.raised is 3.9:1, below 4.5:1`, and exits with 1 if it found any.

## Visual snapshots

- A screenshot depends on the fonts and the browser that draw it, so the baseline is made and checked in one container image, the same in the sandbox and in CI.
- A change that means to alter how a component looks updates its baseline with `npx playwright test --config playwright.visual.config.ts --update-snapshots`, and its pull request shows each screenshot it changed. Any other difference is a failure.
- Screenshots are compared in the repository only: none of the checks sends them to a hosted service.
