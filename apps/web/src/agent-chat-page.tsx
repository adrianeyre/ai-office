import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { PageHeader } from "@/components/ui/page-header.tsx";
import { roleLabel } from "./agents-card.tsx";
import { DirectChatPanel } from "./direct-chat.tsx";
import { agentsQuery, floorQuery } from "./floors.ts";
import { ManagerChatPage } from "./manager-chat.tsx";

// An Agent's chat on its own page (`/floors/:floorId/agents/:agentId/chat`),
// as its card in the 3D Office opens it in place: the Owner talks one to
// one with the Agent's own Model. The Manager's is the Manager chat.

export function AgentChatPage({
  floorId,
  agentId,
}: {
  floorId: string;
  agentId: string;
}) {
  const { data: floor } = useQuery(floorQuery(floorId));
  const { data: agents, isError } = useQuery(agentsQuery(floorId));
  const agent = agents?.find(({ id }) => id === agentId);
  if (agent?.role === "manager") {
    return <ManagerChatPage floorId={floorId} />;
  }
  return (
    <section className="flex h-full flex-col gap-4">
      <PageHeader
        title={
          <>{agent === undefined ? "Agent chat" : `Chat with ${agent.name}`}</>
        }
        eyebrow={
          <Link to="/floor-settings/$floorId" params={{ floorId }}>
            {floor?.name ?? floorId}
          </Link>
        }
      >
        {agent !== undefined && (
          <p className="text-muted-foreground">
            The {roleLabel(agent.role)} on {floor?.name ?? floorId} ·{" "}
            {agent.aiProvider} {agent.model}. Its tokens count against its Token
            Caps.
          </p>
        )}
        {(isError || (agents !== undefined && agent === undefined)) && (
          <p role="alert" className="text-sm text-destructive">
            There is no such Agent on this Floor.
          </p>
        )}
      </PageHeader>
      {agent !== undefined && (
        <DirectChatPanel
          place={{ kind: "agent", floorId, agentId }}
          className="h-[70vh]"
        />
      )}
    </section>
  );
}
