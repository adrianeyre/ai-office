---
name: Pen-test remediation
about: The fix for one pen-test finding. One remediation per finding; the probe's tests are turned, never deleted.
title: "[remediation] <finding ID> — <what the fix makes true>"
labels: ["prd:pen-testing"]
assignees: []
---

<!--
One fix per finding (docs/product-requirements-document/pen-testing.md,
"Sequence" and "Findings workflow"; docs/pen-testing/triage-runbook.md).

- Add the same severity label as the finding: severity:critical,
  severity:high, severity:medium or severity:low. If the finding was
  re-rated, use its current one.
- File it once triage has confirmed the finding. The target date runs
  from triage, not from this issue.
-->

## Finding

- **Finding issue:** #<!-- the [finding] issue; this issue fixes that one only -->
- **Severity:** <!-- critical | high | medium | low -->
- **Triage confirmed:** <!-- YYYY-MM-DD -->
- **Target:** <!-- YYYY-MM-DD: 2 calendar days after triage for critical,
  10 for high, 30 for medium; "best effort" for low -->

## Decisions it depends on

<!-- A decision this fix needs is taken first, in an issue or an ADR. Link
it, or write "None". The fix does not take the decision itself. -->

## The probe's tests

- **Probe test:** `<path>.pen-test.test.ts` <!-- or .pen-test.integration.test.ts -->
- **`it.fails`:** <!-- test name; the property that should hold -->
- **Pin:** <!-- test name; what happened at the pinned commit -->

## What to build

<!-- The fix, in the smallest change that makes the property hold. -->

## Acceptance criteria

- [ ] The `it.fails` is now an `it`, unchanged otherwise, and passes: the property holds.
- [ ] The pin is now a regression test: it asserts that what happened at the pinned commit no longer can.
- [ ] Neither test is deleted, skipped or weakened.
- [ ] The assessment still links the probe test file.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.

## Retest

<!-- Filled in when the fix is merged (triage runbook, "Retest"). -->

- **Fixed by:** <!-- commit SHA -->
- **Retested:** <!-- YYYY-MM-DD, at commit SHA -->
- **Register updated:** <!-- the commit that updated the PRD's register -->
