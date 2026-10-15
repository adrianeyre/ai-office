# Issue #309: [fix] I1-5 — The Claude sandbox image installs Claude Code by curl | bash, and all three install gh, pnpm, Codex and opencode at a moving version — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
npm 11.19.1, git 2.39.5; no Docker and no Postgres; the npm registry,
Docker Hub and GitHub were reachable). The fix is commit `f973b4f`,
`fix(security): I1-5 the sandbox images install their agent tools and CLIs from pinned, checked artifacts, never a fetched script or a moving version`,
on top of `41f2fd7` (I1-4's fix, #307), whose digest-pinned base images
it builds on. Its blocker, the I1 probe (#197), is in the tree:
`docs/pen-testing/assessments/I1.md` and
`docker/supply-chain.pen-test.test.ts`.

This is the remediation of finding **I1-5** (`severity:low`, H15). The
full output of the checks, run once on the finished tree for all four
fixes, is in [#307's note](issue-307.md#real-output-of-the-checks).

## What was fixed

Every sandbox image installed something whose content nobody had pinned:

- the Claude image piped `https://claude.ai/install.sh` into `bash`, at
  `CLAUDE_CODE_VERSION=stable`;
- all three fetched the GitHub CLI's apt key at build time and installed
  `gh` from its `stable` channel;
- all three ran `npm install --global` for pnpm, and the Codex and
  opencode images for their tool, at `latest`.

Now:

- **`gh`** is one release, 2.102.0, downloaded from GitHub's release
  page and checked against the SHA-256 GitHub publishes for it, per
  architecture (amd64, arm64), before it is unpacked; any other
  architecture fails the build.
- **pnpm and each image's agent tool** are installed with `npm ci` from a
  `package.json` and `package-lock.json` beside the Dockerfile: Claude
  Code 2.1.287 (`@anthropic-ai/claude-code`, the version `stable` named
  that day), Codex 0.162.1 and opencode 1.19.0, each with pnpm 12.10.0.
  The lockfile records every package's SHA-512, the per-platform binary
  packages included, and `npm ci` refuses a tarball that does not match.
  `package.json`'s `allowScripts` names the only install scripts that may
  run, each for one version (Claude Code's and opencode's, which only
  choose the platform binary npm already checked; pnpm's are denied).
- The tools are installed as root in `/opt/agent-tools`, which the
  `agent` user cannot change, and each runs `--version` as `agent` once
  installed.
- `pnpm sandbox:build` no longer passes `CLAUDE_CODE_VERSION`,
  `CODEX_VERSION` or `OPENCODE_VERSION`: a version is changed in the
  lockfile, never picked at build time. The guide's sandbox images
  section and the EC2 upgrade step say how.

### Sibling paths

- **The app image's pnpm** (`Dockerfile`) was `npm install --global
  pnpm@12.10.0`: exact, but checked against nothing. It is now `npm ci`
  from `docker/pnpm/package.json` and its lockfile, the same way.
- **The tools updating themselves**, a moving version at run time:
  Claude Code's native install updates itself in the background, and
  opencode's does too. The images set `DISABLE_AUTOUPDATER=1` and
  `OPENCODE_DISABLE_AUTOUPDATE=1` (both names read from the binaries the
  lockfiles pin). Codex only checks for updates; it never installs one.
- **The image version** now hashes `package.json` and
  `package-lock.json` with the Dockerfile, so a lockfile change also
  needs a new tag. The sandbox images are version 4.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the
      sandbox images install nothing by piping a fetched script into a
      shell" is an `it`; its assertion and pattern are unchanged. It
      lists `docker/sandbox-*` and read each entry's `Dockerfile`, but
      `sandbox-build.ts` and the tests beside the image directories match
      that name too, so it threw `ENOTDIR` and "failed as expected" on a
      setup error, not its assertion. It now reads only directories.
- [x] **The "pins today" tests become regression tests; neither is
      deleted.**
      - "regression (I1-5): the Claude sandbox no longer installs Claude
        Code by `curl | bash`, but from npm at the version its lockfile
        pins";
      - "regression (I1-5): no sandbox image installs gh, pnpm or an
        agent tool at a moving version any more" (no apt source for gh,
        no `npm install --global`, no `@${…_VERSION}`, no `latest` or
        `stable`; a SHA-256 check and `npm ci` in each).
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "the app image installs pnpm from a lockfile too, not from the
        registry at whatever it answers";
      - "every package any image installs from npm is pinned to an exact
        version and its SHA-512" (all four lockfiles; every entry
        resolved from the registry with an integrity);
      - "no Dockerfile pipes anything fetched into a shell, nor installs
        from npm outside a lockfile" (all four Dockerfiles' instructions);
      - "Claude Code and opencode never update themselves in a sandbox";
      - `docker/sandbox-images.test.ts`: gh's checksum before `tar`, the
        lockfile install, exact versions, `allowScripts` per version, each
        tool run as `agent`, the hash over all three files, and
        `sandbox:build` passing no version.
      Mutation check: see [below](#mutation-check).
- [x] **The assessment's findings table marks `I1-5` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #309) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on the five tests that failed
      before this work and the same after (see
      [#307's note](issue-307.md#noticed-out-of-scope)); every other test
      passes.

### The probe tests, verbose (I1-5)

```
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 (H15): the sandbox images install over the network at build time > regression (I1-5): the Claude sandbox no longer installs Claude Code by `curl | bash`, but from npm at the version its lockfile pins
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 (H15): the sandbox images install over the network at build time > regression (I1-5): no sandbox image installs gh, pnpm or an agent tool at a moving version any more
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 (H15): the sandbox images install over the network at build time > the sandbox images install nothing by piping a fetched script into a shell
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 siblings: every npm install in an image is from a lockfile, and nothing updates itself > the app image installs pnpm from a lockfile too, not from the registry at whatever it answers
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 siblings: every npm install in an image is from a lockfile, and nothing updates itself > every package any image installs from npm is pinned to an exact version and its SHA-512
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 siblings: every npm install in an image is from a lockfile, and nothing updates itself > no Dockerfile pipes anything fetched into a shell, nor installs from npm outside a lockfile
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-5 siblings: every npm install in an image is from a lockfile, and nothing updates itself > Claude Code and opencode never update themselves in a sandbox
```

`docker/sandbox-images.test.ts` and `docker/deployment.test.ts` together:
`Tests  53 passed | 10 skipped (63)` (the skips need Docker or hadolint).

### What was run here, outside Docker

- **Each lockfile, installed as the Dockerfile installs it** (`npm ci
  --prefix <copy> --omit=dev`), then each tool run:

  ```
  claude 24 packages, without integrity: []
  added 4 packages in 4s
    claude: 2.1.287 (Claude Code)
    pnpm: 12.10.0
  codex 22 packages, without integrity: []
  added 4 packages in 6s
    codex: codex-cli 0.162.1
    pnpm: 12.10.0
  opencode 28 packages, without integrity: []
  added 5 packages in 3s
    opencode: 1.19.0
    pnpm: 12.10.0
  ```

  The app image's `docker/pnpm` lockfile likewise: `12.10.0`.
- **A tampered lockfile is refused:** with `@openai/codex`'s integrity
  changed, `npm ci` stops with `npm error code EINTEGRITY … integrity
  checksum failed when using sha512` and exit 1.
- **Without install scripts**, Claude Code ("claude native binary not
  installed") and opencode ("postinstall script was not run") do not
  run, which is why `allowScripts` allows theirs. Both scripts were read:
  they pick the platform binary from the package npm installed and fetch
  nothing.
- **The gh step's shell, as written** (its destination moved to a
  scratch directory): `/tmp/gh.tar.gz: OK` and `gh version 2.102.0
  (2026-09-30)`; with a wrong checksum, `/tmp/gh.tar.gz: FAILED` and exit
  1, before anything is unpacked.

### Mutation check

With the Claude Dockerfile and the app's Dockerfile put back as they were
after I1-4 (`curl | bash`, the gh apt source, `npm install --global`),
twelve tests fail: every I1-5 test in the probe file (the former
`it.fails` included) and six in `sandbox-images.test.ts`. Put back, all
pass.

## Decisions

For the Owner to review.

1. **Claude Code from npm, not its native installer.** Anthropic
   recommends the native installer, but it is a script that fetches a
   binary and checks it against a manifest fetched from the same place,
   so nothing in this repository pins what it installs. The npm package
   (`@anthropic-ai/claude-code`) ships the same native binary as
   per-platform packages, which a lockfile pins by SHA-512. If Anthropic
   stops publishing it to npm, the next move is the release binary with
   a SHA-256 per architecture, as gh is done.
2. **The versions are the ones the old defaults resolved to on
   2026-10-11:** Claude Code's `stable` (2.1.287, not `latest` 2.1.296),
   and Codex's and opencode's `latest`. An Owner who set
   `CLAUDE_CODE_VERSION` and the like now changes `package.json` and the
   lockfile instead; the variables are ignored.
3. **Install scripts run, but only those named.** Claude Code and
   opencode need theirs; they are pinned by the lockfile like the rest,
   and allowed for one version each, so a version bump must allow its
   script again. pnpm's are denied (it runs without them). Older npm
   versions ignore `allowScripts` and run every script, which is still
   only lockfile-checked code.
4. **gh from a release tarball with a checksum in the Dockerfile**, not
   its apt repository with a pinned key and version. The tarball is one
   artifact with one hash, where apt would trust whatever the key signs.
   Only amd64 and arm64 have checksums; other architectures fail the
   build, as no Owner runs AI Office on them today.
5. **Self-updates are turned off** for Claude Code and opencode, so a
   sandbox runs the version the image pins for as long as it lives.

## Noticed, out of scope

- **`docs/guide/running.md` and `docs/processes/deploying-to-ec2.md`**
  still tell the Owner to install pnpm and Tailscale on their own host
  with `curl … | sh`. That is the Owner's machine, not an image AI Office
  builds, and the installers are each vendor's documented way.
- **Debian packages** in the images: see
  [#307's note](issue-307.md#noticed-out-of-scope).
- The five tests that fail before and after: see
  [#307's note](issue-307.md#noticed-out-of-scope).

## What could not be verified here

- **Building the images:** no Docker. On a host, `AGENT_UID=1000
  AGENT_GID=1000 pnpm sandbox:build` and
  `AI_OFFICE_SANDBOX_IMAGE_E2E=1 pnpm test docker/sandbox-images.test.ts`
  build all three and check `whoami`, each tool's `--version`, `git`,
  `gh`, pnpm 12.10.0 and Node 26.10.0 as `agent`; `docker compose up
  --build` builds the app image with the lockfile's pnpm.
- **hadolint** on the new Dockerfiles (it is neither installed here nor
  runnable without Docker). The here-string `<<<` is bash, which each
  Dockerfile's `SHELL` sets.
- **Agents working in the new images:** that Claude Code, Codex and
  opencode installed under `/opt/agent-tools` behave in a sandbox as they
  did from `~/.local/bin` and the global prefix (a real Sandcastle run,
  and the Manager chat's read-only session).
- **arm64:** the arm64 gh checksum and the arm64 binary packages were not
  installed here (the sandbox is x64); both are pinned.
