import type { PipelineStage } from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";

// The palette's colours in the Office's HTML: each stage's, as on the wall
// board's badges and the tickets carried at a Handoff (FR-59), and the
// states'. Spelt out, so Tailwind finds each class.

/** The palette's colour for each stage that has work (ADR 0003). */
export const stageTokens: Partial<Record<PipelineStage, PaletteToken>> = {
  "needs-work": "stage-work",
  "needs-review": "stage-review",
  "needs-qa": "stage-qa",
  "needs-docs": "stage-docs",
};

const backgrounds: Partial<Record<PaletteToken, string>> = {
  "stage-work": "bg-office-stage-work text-office-paper",
  "stage-review": "bg-office-stage-review text-office-paper",
  "stage-qa": "bg-office-stage-qa text-office-paper",
  "stage-docs": "bg-office-stage-docs text-office-paper",
  "state-neutral": "bg-office-state-neutral",
  "state-ok": "bg-office-state-ok",
  "state-warning": "bg-office-state-warning",
  "state-critical": "bg-office-state-critical",
};

/** A token's background (and its foreground, where it has one); muted for none. */
export const backgroundOf = (token: PaletteToken | undefined) =>
  (token === undefined ? undefined : backgrounds[token]) ?? "bg-muted";
