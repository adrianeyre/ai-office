import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  communicationsAgentQuery,
  connectionsQuery,
} from "../connections-page.tsx";
import { PageLink } from "./page-link.tsx";
import { failingConnections } from "./reception-desk.ts";

import { LoadingMessage, Spinner } from "@/components/ui/spinner.tsx";

// The Communications Agent's card (PRD FR-63, FR-96), what clicking it at
// the lobby's reception desk opens: who it is (its name is the panel's
// heading), its Role, AI Provider and Model for Digests and reports,
// whether it is sending or paused, its Connections and which of them are
// failing (the red marker on its desk), with the way to the Connections
// admin, where all of it is set.

/** The Connections admin: the Communications Agent's config and its Connections. */
export const connectionsAdminHref = "/general-settings/connections";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Its Connections: how many, and the failing ones by name. */
function Connections() {
  const { data: connections, isError } = useQuery(connectionsQuery);
  if (isError) {
    return <span className="text-muted-foreground">Could not be read</span>;
  }
  if (connections === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3" />
        Reading…
      </span>
    );
  }
  const failing = failingConnections(connections);
  return (
    <div className="space-y-1">
      <p>
        {connections.length === 0
          ? "None yet"
          : connections.length === 1
            ? "1 Connection"
            : `${String(connections.length)} Connections`}
      </p>
      {failing.length > 0 && (
        <p className="font-medium text-destructive">
          Failing: {failing.join(", ")}
        </p>
      )}
    </div>
  );
}

export function CommunicationsAgentCard({
  navigate,
}: {
  /** Opens a page of AI Office without a reload. */
  navigate?: ((href: string) => void) | undefined;
}) {
  const { data: agent, isError } = useQuery(communicationsAgentQuery);
  if (isError) {
    return <p role="alert">The Communications Agent could not be loaded.</p>;
  }
  if (agent === undefined) {
    return <LoadingMessage>Loading…</LoadingMessage>;
  }
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        At the lobby&apos;s reception desk, {agent.name} tells you outside AI
        Office about Notices and finished work, through your Connections.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <Fact term="Role">Communications</Fact>
        <Fact term="AI Provider">{agent.aiProvider}</Fact>
        <Fact term="Model">
          {agent.model === null ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="font-mono break-all">{agent.model}</span>
          )}
          {agent.model !== null && agent.modelOverride === null && (
            <span className="text-muted-foreground"> (default)</span>
          )}
        </Fact>
        <Fact term="Status">
          {agent.enabled ? "Sending" : "Paused: deliveries wait"}
        </Fact>
        <Fact term="Connections">
          <Connections />
        </Fact>
      </dl>
      <PageLink href={connectionsAdminHref} navigate={navigate}>
        Open the Connections admin
      </PageLink>
    </div>
  );
}
