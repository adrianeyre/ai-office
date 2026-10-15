// Each Agent's live view in AI Office (PRD FR-58), linked from GitHub.

/** The Agent's live view, at AI Office's address. */
export const liveViewUrl = (
  publicUrl: string,
  floorId: string,
  agentId: string,
): string =>
  new URL(
    `/floors/${encodeURIComponent(floorId)}/agents/${encodeURIComponent(agentId)}`,
    publicUrl,
  ).toString();
