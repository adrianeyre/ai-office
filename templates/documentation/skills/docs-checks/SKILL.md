---
name: docs-checks
description: How to set up and run a docs site's checks (the docs build, links and runnable examples) as npm scripts in its repository, and what each one checks. Use it when the checks fail, are missing, or need changing.
---

# The docs' checks

A Documentation Floor checks every change with three scripts in the repository's `package.json`, run by the Floor's check command:

```sh
npm run docs:build && npm run check:links && npm run check:examples
```

Each one exits with an error, naming the file and the problem, when its check fails. Run one on its own with `npm run <name>`.

## What each one checks

| Script | What it checks | A tool that does it |
| --- | --- | --- |
| `docs:build` | The site builds from its sources, with no broken reference, missing page or warning | the docs' own generator, with warnings as errors: `vitepress build docs`, `docusaurus build` or `mkdocs build --strict` |
| `check:links` | Every link in the docs goes to a page, an anchor or a file that exists | `lychee` or `linkinator`, on the built site |
| `check:examples` | Every example marked as runnable runs, and prints what the page says it prints | a short Node script over the Markdown (see the `runnable-examples` Skill) |

## Setting them up

When a script is missing, add it to `package.json`, with the tool it needs in `devDependencies`, so that `npm install` brings it. For example, for VitePress docs in `docs/`:

```json
{
  "scripts": {
    "docs:build": "vitepress build docs",
    "check:links": "linkinator docs/.vitepress/dist --recurse --skip '^https?://'",
    "check:examples": "node scripts/check-examples.mjs docs"
  }
}
```

with the built site's folder in `.gitignore`. A generator that is not an npm package, such as MkDocs, still runs from the script (`"docs:build": "mkdocs build --strict"`), with what it needs in a `requirements.txt`.

## Fixing what they find

- **Build**: fix the page, not the generator's settings. Change them only when the issue asks.
- **Links**: fix the link to where it should go; for a page that moved, link to its new address and keep a redirect from the old one.
- **Examples**: fix the example or the page so that they agree with the code. Never change the code the docs describe to fit an example.

Every check runs on the repository only: none of them publishes the site.
