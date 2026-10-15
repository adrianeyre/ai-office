---
name: site-checks
description: How to set up and run a website's checks (the build, links and Lighthouse) as npm scripts in its repository, and what each one checks. Use it when the checks fail, are missing, or need changing.
---

# The site's checks

A Website & marketing Floor checks every change with three scripts in the repository's `package.json`, run by the Floor's check command:

```sh
npm run build && npm run check:links && npm run check:lighthouse
```

Each one exits with an error, naming the page and the problem, when its check fails. Run one on its own with `npm run <name>`.

## What each one checks

| Script | What it checks | A tool that does it |
| --- | --- | --- |
| `build` | The site builds, with no errors from its framework | the site's own build, such as `astro build`, `next build` or `vite build` |
| `check:links` | Every link on the built site goes to a page or a file that exists | `linkinator` or `lychee`, on the built site |
| `check:lighthouse` | The main pages' performance, accessibility, best practices and SEO scores | Lighthouse CI (`@lhci/cli autorun`), with the scores it expects in `lighthouserc.json` |

## Setting them up

When a script is missing, add it to `package.json`, with the tool it needs in `devDependencies`, so that `npm install` brings it. For example, for a site that builds to `dist/`:

```json
{
  "scripts": {
    "build": "astro build",
    "check:links": "linkinator dist --recurse --skip '^https?://'",
    "check:lighthouse": "lhci autorun"
  }
}
```

with a `lighthouserc.json` such as:

```json
{
  "ci": {
    "collect": { "staticDistDir": "dist", "url": ["/", "/pricing/"] },
    "assert": {
      "assertions": {
        "categories:performance": ["error", { "minScore": 0.9 }],
        "categories:accessibility": ["error", { "minScore": 0.95 }],
        "categories:best-practices": ["error", { "minScore": 0.9 }],
        "categories:seo": ["error", { "minScore": 0.95 }]
      }
    },
    "upload": { "target": "filesystem", "outputDir": ".lighthouseci" }
  }
}
```

Lighthouse CI needs a browser: it uses the sandbox's Chrome if there is one. Every check runs on the built site in the sandbox only: none of them uploads results to a third party's service.
