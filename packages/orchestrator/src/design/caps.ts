// The designer's Round Cap (as QA's, PRD FR-28): a designer has its own cap
// on the rounds of design review on one pull request, so UI changes that
// bounce between the designer and the coder cannot loop without bound
// (Goal 3). Reaching it hands the pull request to the Owner.

/** The most rounds of design review on one pull request. */
export const designRoundCap = 3;
