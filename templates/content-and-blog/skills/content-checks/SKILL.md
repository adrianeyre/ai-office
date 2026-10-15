---
name: content-checks
description: How to set up and run a blog's checks (Markdown lint, links and spelling) as npm scripts in its repository, and what each one checks. Use it when the checks fail, are missing, or need changing.
---

# The blog's checks

A Content & blog Floor checks every change with three scripts in the repository's `package.json`, run by the Floor's check command:

```sh
npm run check:markdown && npm run check:links && npm run check:spelling
```

Each one exits with an error, naming the file and the line, when its check fails. Run one on its own with `npm run check:<name>`.

## What each one checks

| Script | What it checks | A tool that does it |
| --- | --- | --- |
| `check:markdown` | Every post and page follows the blog's Markdown rules: headings in order, lists and code blocks well formed | `markdownlint-cli2`, with its rules in `.markdownlint.jsonc` |
| `check:links` | Every link in the posts goes to a page or a file that exists | `lychee` or `linkinator` |
| `check:spelling` | Every post and page is spelt right in the blog's language | `cspell`, with the blog's language and its word list in `cspell.json` |

## Setting them up

When a script is missing, add it to `package.json`, with the tool it needs in `devDependencies`, so that `npm install` brings it. For example, for a blog whose posts are in `content/`:

```json
{
  "scripts": {
    "check:markdown": "markdownlint-cli2 \"content/**/*.md\"",
    "check:links": "linkinator content --recurse --markdown --skip '^https?://'",
    "check:spelling": "cspell --no-progress \"content/**/*.md\""
  }
}
```

with a `cspell.json` such as:

```json
{
  "language": "en-GB",
  "words": ["Kubernetes", "Eyre"]
}
```

## Fixing what they find

- **Markdown**: fix the post, not the rules. Change `.markdownlint.jsonc` only when the issue asks.
- **Links**: fix the link to where it should go; for a post that moved, link to its new address.
- **Spelling**: fix the word. When the word is a name or a term that is spelt right, add it to the word list in `cspell.json`, keeping the list in order.
