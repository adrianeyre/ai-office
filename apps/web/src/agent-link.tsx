import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { agentsQuery } from "./floors.ts";
import { inspectSearch } from "./scene/inspectable.ts";

/** An Agent's name, once its Floor's Agents are known. */
export function useAgentName(
  floorId: string,
  agentId: string,
): string | undefined {
  const { data: agents } = useQuery(agentsQuery(floorId));
  return agents?.find(({ id }) => id === agentId)?.name;
}

/**
 * A link to an Agent (PRD FR-63): the Office, which rides the lift to its
 * Floor, flies the camera to it where it sits and opens its card.
 * `children` replaces the text, which is otherwise the Agent's name.
 */
export function AgentLink({
  floorId,
  agentId,
  children,
}: {
  floorId: string;
  agentId: string;
  children?: (name: string | undefined) => ReactNode;
}) {
  const name = useAgentName(floorId, agentId);
  return (
    <Link
      to="/"
      search={inspectSearch({
        kind: "agent",
        id: agentId,
        location: { kind: "floor", floorId },
      })}
      title={`Show ${name ?? "this Agent"} in the Office`}
      className="hover:underline"
    >
      {children === undefined ? (name ?? "Agent") : children(name)}
    </Link>
  );
}
