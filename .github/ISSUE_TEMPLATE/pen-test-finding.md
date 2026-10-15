---
name: Pen-test finding
about: One finding from a pen-testing probe, filed within one day of the assessment that found it.
title: "[finding] <ID> — <one-line statement>"
labels: ["prd:pen-testing"]
assignees: []
---

<!--
One finding per issue (docs/product-requirements-document/pen-testing.md,
"Findings workflow"; docs/pen-testing/triage-runbook.md).

- The ID is <probe ID>-<n>, such as S1-1, as the assessment numbers it.
- Add exactly one severity label, the one the assessment claims:
  severity:critical, severity:high, severity:medium or severity:low.
  It is carried over without re-judging.
- Never paste a credential, a session cookie, a Gateway Key or anything
  that looks like a real one. Write <redacted> and say where it came from.
- This issue reports. The fix is a separate remediation issue
  (.github/ISSUE_TEMPLATE/pen-test-remediation.md).
-->

## Found at

- **Commit:** <!-- the full SHA of the pinned commit the probe ran against -->
- **Probe issue:** #<!-- the probe issue it was found under -->
- **Assessment:** <!-- docs/pen-testing/assessments/<file>.md, and its section -->

## Attacker position

<!-- One or more of the PRD's positions, by number and name:
1 Network, unauthenticated · 2 Hostile content · 3 Code in a sandbox
(assume breach) · 4 Stolen credential · 5 Spoofed GitHub.
Say what the attacker holds in that position for this finding. -->

## How to reproduce

<!-- The probe test that shows it, by path and test name. The property that
should hold is an `it.fails`; the passing test beside it pins what happens
today. -->

- **Probe test:** `<path>.pen-test.test.ts` <!-- or .pen-test.integration.test.ts -->
- **`it.fails` (the property that should hold):** <!-- test name -->
- **Pin (what happens today):** <!-- test name -->
- **Run it:**

```sh
pnpm test <path>
```

<!-- Anything the test cannot show (a pen-test stack, a sandbox, a real
deployment) as a numbered list, against the pen-test stack only. -->

## Hypothesis

<!-- The register entry it confirms, such as "Confirms H3", or "New: not in
the opening register". -->

## What it contradicts

<!-- The FR, ADR or documented control it breaks, cited, not restated. -->

## Claimed severity

<!-- critical | high | medium | low, as the assessment claims it, and the
row of the PRD's severity table it meets. Name the premise it was rated
against (for example, "a loopback-only deployment"), so it can be re-rated
when that premise changes. -->
