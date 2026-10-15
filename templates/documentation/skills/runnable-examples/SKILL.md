---
name: runnable-examples
description: How a page marks a code example as runnable, with the output it prints, and how the examples check runs them. Use it when writing an example, or when the examples check fails.
---

# Runnable examples

A runnable example is a fenced code block a reader can copy and run as it is. The docs mark one with `run` after its language, and put what it prints in a block marked `output` straight after it:

~~~md
```js run
console.log([1, 2, 3].map((n) => n * 2));
```

```text output
[ 2, 4, 6 ]
```
~~~

`npm run check:examples` finds every block marked `run`, runs it in a new folder with the repository's own package installed, and compares what it prints with the `output` block after it, if there is one. It fails, naming the file and the line, for an example that exits with an error or prints something else.

## Writing one

- Make it complete: every import, every file it reads and every value it needs is in the block or on the page.
- Keep it short, and make it do one thing the page explains.
- Give it no network and no credential. Where it would call an API, show a stand-in (a local file, a fake client) and say on the page how a reader swaps in their own.
- Leave `run` off a block that cannot run as it is (a fragment, or a shell session that needs an account), so that the check leaves it out.

## The check's script

A short Node script does it: for each Markdown file, find each fenced block whose info string ends in ` run`, write it to a file in a new temporary folder, run it with its language's runtime (`node` for `js`, `sh` for `sh`), and compare what it prints, trimmed, with the next `output` block. Print one line per problem, such as `docs/guide/start.md:42: the example printed [ 2, 4 ], not [ 2, 4, 6 ]`, and exit with 1 if it found any.
