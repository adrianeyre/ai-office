# Pen-testing: triage runbook

How a pen-testing finding goes from an assessment to a fix, a waiver or an
accepted risk. The brief is the
[pen-testing PRD](../product-requirements-document/pen-testing.md); this
runbook carries out its [Findings workflow](../product-requirements-document/pen-testing.md#findings-workflow)
and restates none of its decisions but the numbers it has to work to. Where
the two disagree, the PRD wins and this runbook is corrected.

The Owner triages. Nobody else confirms a finding, re-rates it or accepts it.

## Labels

Both families already exist on the repository. Nothing else is created for
the round.

| Label | Goes on | Meaning |
| --- | --- | --- |
| `prd:pen-testing` | every probe, finding and remediation issue | Part of the pen-testing round. The finding and remediation templates apply it. |
| `severity:critical` | a finding and its remediation | Fixed within 2 calendar days of triage. Blocks the exposure gate. |
| `severity:high` | a finding and its remediation | Fixed within 10 calendar days of triage. Blocks the public-release gate unless waived. |
| `severity:medium` | a finding and its remediation | Fixed within 30 calendar days of triage. Blocks the public-release gate unless waived. |
| `severity:low` | a finding and its remediation | Best effort. Blocks neither gate. |
| `wontfix` | a finding the Owner has accepted | Only after the Owner's written rationale in the issue (below). |

A finding carries exactly one `severity:*` label at a time.

## From assessment to finding

A probe issue never remediates. It produces an assessment under
[`assessments/`](assessments/) and committed probe tests named
`*.pen-test.test.ts` or `*.pen-test.integration.test.ts`. For each property
that should hold but doesn't, the probe commits an `it.fails` asserting the
property and, beside it, a passing test that pins what happens today.

1. **Within one day of the assessment**, each finding in it is filed as its
   own issue from the
   [finding template](../../.github/ISSUE_TEMPLATE/pen-test-finding.md):
   titled `[finding] <ID> — <one-line statement>`, where the ID is
   `<probe ID>-<n>`, such as `S1-1`.
2. The issue carries `prd:pen-testing` and the one `severity:*` label the
   assessment claims. Severity is carried over without re-judging.
3. Its body states the commit it was found at, the probe issue, the
   attacker position it needs, the probe test that reproduces it, and the
   hypothesis it confirms (`H1`–`H17`) or that it is new.
4. The assessment links every probe test file that holds an `it.fails`.
   `pnpm test` fails until it does (see [the index](README.md#the-cross-reference-test)).

No credential, cookie or Gateway Key goes in an issue, an assessment or a
test, even a pen-test stack's: write `<redacted>` and say where it came
from.

## Triage, within one day

Within one day of a finding being filed, the Owner triages it:

1. **Reproduce.** Check out the commit it names and run its probe test
   (`pnpm test <path>`). The `it.fails` must be reported as an expected
   failure and the pin must pass. For what a test cannot show, follow the
   issue's numbered list against the pen-test stack, never the Owner's own
   Office.
2. **Check the issue is complete**: the title, the ID, both labels, and
   every field of the template filled in.
3. **Decide**, and write the decision in a comment:
   - **Confirmed.** Write the triage date and the target date (below). The
     clock starts now. File the remediation issue from the
     [remediation template](../../.github/ISSUE_TEMPLATE/pen-test-remediation.md):
     one fix per finding, with the same severity label.
   - **Duplicate.** Link the finding it repeats and close this one. The
     assessment's ID still points here.
   - **Not reproduced.** Say what was run and what happened, and ask the
     probe for what is missing. Triage is finished when the probe answers
     and the Owner decides again; the one day restarts then.

A critical is also reported to the Owner out of band, as the
[rules of engagement](rules-of-engagement.md#a-critical-the-out-of-band-channel-and-stop)
say, the moment it is found. Its clock still starts at triage.

## Severities and their targets

Targets are in **calendar days** after triage confirms the finding,
weekends included, as in the PRD.

| Severity | Target | What it means here |
| --- | --- | --- |
| critical | 2 | The Owner's session, an AI Account, the GitHub App's write access, or the host can be taken or used without the Owner's authority. |
| high | 10 | A control holds in one layer only, or a sandbox, Gateway Key or Token Cap boundary can be crossed. |
| medium | 30 | A control is weaker than the documentation claims, or a boundary is undefended in depth. |
| low | best effort | Hygiene, disclosure, or a documented decision with no recorded control. |

The target is met when the remediation's fix is merged to the round's
branch and its retest passes. A missed target is written in the finding
with the reason and a new date; it is never left to lapse silently.

The gates follow from the labels:

- **Exposure:** no open `severity:critical` finding. A critical cannot be
  waived for this gate; it is remediated.
- **Public release:** no open finding above `severity:low` that is neither
  remediated nor waived in writing by the Owner.

## Re-rating when a premise changes

Severity is re-assessed only when a premise it was rated against changes,
never because a fix is hard. A finding rated against a loopback-only
deployment, for example, is re-rated before the exposure gate.

- **Before each gate**, the Owner reads every open finding's claimed
  severity and its premise against how AI Office will be run after the
  gate, and re-rates each one whose premise no longer holds.
- **When anything else changes a premise** (a deployment document, the
  compose file, a decision in an ADR, another finding's fix), the findings
  rated against it are re-rated then.

To re-rate, the Owner comments in the finding with the old and new
severity, the premise that changed and the date, then swaps the
`severity:*` label on the finding and on its remediation. The target is
recalculated:

- **Raised:** the new severity's days from the re-rating, or the old target
  if that is sooner.
- **Lowered:** the new severity's days from the original triage.

The assessment keeps the severity it claimed; the finding issue records
the change.

## `wontfix`: accepting a finding

Accepting a finding is a legitimate outcome; leaving it undecided is not.
`wontfix` goes on a finding only **after** the Owner has written, in the
issue:

- what is accepted, and against which deployment;
- why: the control that makes it safe, or the reason the risk is accepted
  without one;
- whether it is a waiver for the public-release gate;
- when it is revisited, such as before the next round or a named gate.

Then the Owner applies `wontfix` and closes the issue as not planned, and
its remediation issue too, if one was filed. A rationale written by anyone
but the Owner, or after the label, does not count. A `severity:critical`
finding cannot be accepted for the exposure gate.

The probe's tests stay as they are: the `it.fails` keeps recording the
property that does not hold, and the assessment keeps linking it.

## Retest

Each fix turns its probe's tests: the `it.fails` becomes an `it`, and the
pin becomes a regression test that asserts what happened at the pinned
commit no longer can. Neither test is ever deleted, skipped or weakened.

When a remediation is merged:

1. Run the probe test at the merge commit. The former `it.fails` passes as
   an `it`, the regression test passes, and so does `pnpm test`.
2. Fill in the remediation issue's **Retest** section (fixed by, retested
   at, register updated) and close it and its finding.
3. **Update the register in the PRD**, in the same commit as the retest
   or the next one:
   - Under the hypothesis the finding confirmed (`### H<n>` in
     [the opening register](../product-requirements-document/pen-testing.md#the-testers-opening-register)),
     add one line per finding:
     `**Retest:** <finding ID> (#<finding>) fixed by <commit SHA> (#<remediation>), retested <YYYY-MM-DD>.`
     An accepted finding gets
     `**Accepted:** <finding ID> (#<finding>), wontfix on <YYYY-MM-DD>; <one-line rationale>.`
   - A hypothesis an assessment disproved gets
     `**Disproved:** by <probe ID>, <YYYY-MM-DD>; see <assessment>.`
   - A new finding, one that confirms no hypothesis, is added as a row of
     a **Findings beyond the register** table after H17, with its ID,
     issue, severity, and how it was fixed or accepted.
   - The opening estimates stay as written. The register records what the
     round found, not a rewrite of what it expected.
4. Add the retest to [the index](README.md)'s row for the assessment.
