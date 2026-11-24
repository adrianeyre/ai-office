---
name: guidelines
description: "Draft the Floor's Guidelines with the Owner from what the repository already does: product, tech and structure for every task, and any for particular files. Run it as /guidelines; it starts a Grilling Session whose pull request the Owner merges to approve them."
---

# Guidelines

AI Office's own Skill. It runs as a Grilling Session: AI Office keeps the session, writes each Guideline you settle on the session's branch as `.agents/guidelines/<name>.md`, with its front matter, and opens one pull request with them when the Owner confirms. Follow the Grilling Session's instructions for the form of each turn; these say what to find, what to ask and what to write.

Guidelines are the Owner's written rules for this repository. Agents follow a Guideline only in a version the Owner approved, and the Owner's merge of this session's pull request is that approval. So write only what the Owner confirmed, never what you merely guessed.

## What it writes

- **`product`** (`always`): what the product is, who it is for, and the words it uses for its things.
- **`tech`** (`always`): the languages, frameworks and tools, the commands that install, build, lint and test it, and what not to use instead.
- **`structure`** (`always`): how the repository is laid out, where new code, tests and docs go, and how files and things are named.
- **`fileMatch` Guidelines**, only those the Owner agrees to: rules for some files alone, such as how migrations are written (`packages/db/**`) or how components are tested (`apps/web/**/*.tsx`), each with the globs of the files it applies to, from the top of the repository.

It writes no PRD, ADRs, glossary or process docs, and drafts no issues.

## Process

1. **Find the conventions first.** Before the first round, ask for facts (a turn's `facts`) rather than asking the Owner anything the repository can answer: the README and docs, the package manifests and lock files, the build, lint and test configuration, CI, the top-level folders, and a few files of each kind for how they are written. The Agents' read-only clone never shows `.agents/`: any Guidelines the Floor has already reach you only as AI Office gives them.
2. **Ask the Owner to confirm what you found.** In the first round, put each convention you found as a question with your recommended answer: "Tests sit beside the code they test, as `*.test.ts`: is that a rule?", recommended "Yes, a rule." Ask, too, which areas deserve a `fileMatch` Guideline of their own, recommending those whose files clearly follow rules the rest do not. The Owner confirms, corrects or drops each; a convention they drop is written nowhere.
3. **Write as they settle.** Once a round's answers settle a Guideline, give it in the turn's `guidelines` with its whole text; give it again, whole, whenever later answers change it. Write `product`, `tech` and `structure` first.
4. **End.** Once `product`, `tech` and `structure` and the agreed `fileMatch` Guidelines are written, leave `questions` empty: AI Office asks the Owner to confirm, then opens the pull request.

## How to write a Guideline

- Rules an Agent can follow, in the imperative: "Use pnpm, never npm." Not a description of the code, and nothing the code makes obvious on its own.
- Short. Every task carries the `always` Guidelines, and one prompt's Guidelines share a budget of 12,000 characters, so keep the three together well under it; a `fileMatch` Guideline is carried only for its files.
- A one-line `description` for each, which the Floor admin shows and Agents see in the list of Guidelines they were not given.
- Never a credential, a token, a password or a private address: a Guideline with a line that looks like one is never approved.
