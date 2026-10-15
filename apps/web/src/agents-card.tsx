import {
  addAgentRequestSchema,
  agentSchema,
  anyAiProvider,
  gatewayKeySchema,
  roleName,
  teamChangeSchema,
  type Agent,
  type CapUse,
  type Floor,
  type FloorWallBoard,
  type GatewayKey,
  type Role,
  type RoleDefinition,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Pencil,
  RotateCw,
  Shirt,
  UserCheck,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { selectClass } from "@/lib/utils.ts";

import { AgentEditor } from "./agent-editor.tsx";
import { agentStateText, IssueSummary } from "./agent-status.tsx";
import { AvatarEditor } from "./avatar-editor.tsx";
import { AgentLink } from "./agent-link.tsx";
import { postJson, readApiError, sendDelete } from "./api.ts";
import { rolesQuery } from "./role-library.tsx";
import { ContextUsageGauge, useContextUsage } from "./context-usage.tsx";
import { agentsQuery, floorQuery } from "./floors.ts";
import { gatewayKeysQuery, lastUsed } from "./gateway-keys-card.tsx";
import { sessionQuery } from "./session.ts";
import {
  capUseText,
  floorTokenUsageQuery,
  levelLabels,
} from "./token-caps.tsx";
import {
  currentIssueOf,
  useLiveWallBoard,
  wallBoardQuery,
} from "./wall-board.ts";

/**
 * A Role as a label: `Coder`, `QA`, `Copywriter`, by its name in `library`
 * (the built-in Roles' when none is given).
 */
export const roleLabel = (
  role: Role,
  library?: readonly Pick<RoleDefinition, "id" | "name">[],
): string => {
  const name = roleName(role, library);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

/**
 * An Agent's Role as a label: a Contractor's one-off Role by its own name,
 * as it is in no library (ADR 0004); any other by `roleLabel`.
 */
export const agentRoleLabel = (
  agent: Pick<Agent, "role" | "contractor">,
  library?: readonly Pick<RoleDefinition, "id" | "name">[],
): string =>
  agent.contractor?.oneOffRole == null
    ? roleLabel(agent.role, library)
    : agent.contractor.oneOffRole.name;

/**
 * Marks a Contractor (FR-10, ADR 0004): an Agent the Manager added for a
 * Batch, or to research a chat request; with its one-off Role, if any.
 */
export function ContractorBadge({
  agent,
}: {
  agent: Pick<Agent, "contractor">;
}) {
  const { contractor } = agent;
  if (contractor === null) {
    return null;
  }
  return (
    <Badge
      tone="warning"
      className="ml-2"
      title={
        contractor.oneOffRole === null
          ? undefined
          : `One-off Role: ${contractor.oneOffRole.description}`
      }
    >
      {contractor.kind === "research" ? "Research Contractor" : "Contractor"}
      {contractor.batchId === null
        ? ""
        : `, Batch ${String(contractor.batchId)}`}
    </Badge>
  );
}

/**
 * "Keep on the team" (ADR 0004): the Contractor becomes an ordinary Agent
 * that never leaves on its own, its one-off Role joining the library.
 * Shown only for a Contractor that is not leaving.
 */
export function KeepOnTeam({
  agent,
  onKept,
}: {
  agent: Agent;
  onKept?: (said: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (agent.contractor === null || agent.leavingAt !== null) {
    return null;
  }
  const keep = async () => {
    setBusy(true);
    setProblem(undefined);
    const response = await postJson(
      `/api/floors/${encodeURIComponent(agent.floorId)}/agents/${encodeURIComponent(agent.id)}/keep`,
      {},
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      setProblem(
        (await readApiError(response)).message ??
          `${agent.name} was not kept on the team.`,
      );
      return;
    }
    agentSchema.parse(await response.json());
    onKept?.(`${agent.name} is on the team now, and stays.`);
    await Promise.all([
      queryClient.invalidateQueries(agentsQuery(agent.floorId)),
      queryClient.invalidateQueries(rolesQuery),
    ]);
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || session === undefined}
        aria-label={`Keep ${agent.name} on the team`}
        onClick={() => void keep()}
      >
        <UserCheck aria-hidden />
        Keep on the team
      </Button>
      {problem !== undefined && (
        <span role="alert" className="text-destructive">
          {problem}
        </span>
      )}
    </>
  );
}

/**
 * An Agent's Gateway Key (FR-46): its first characters, when it was last
 * used, and Rotate, which gives the Agent a new one at once.
 */
function AgentGatewayKey({
  agent,
  gatewayKey,
}: {
  agent: Agent;
  gatewayKey: GatewayKey | undefined;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const rotate = async () => {
    setBusy(true);
    setFailed(false);
    const response = await postJson(
      `/api/floors/${encodeURIComponent(agent.floorId)}/agents/${encodeURIComponent(agent.id)}/gateway-key/rotate`,
      {},
      session?.csrfToken,
    );
    if (response.ok) {
      gatewayKeySchema.parse(await response.json());
      await queryClient.invalidateQueries(gatewayKeysQuery);
    } else {
      setFailed(true);
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">
        {gatewayKey === undefined ? (
          "None yet"
        ) : (
          <>
            <span className="font-mono">{gatewayKey.hint}…</span> ·{" "}
            {lastUsed(gatewayKey)}
          </>
        )}
      </span>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Rotate ${agent.name}'s Gateway Key`}
        disabled={busy || session === undefined}
        onClick={() => void rotate()}
      >
        <RotateCw aria-hidden />
        Rotate
      </Button>
      {failed && (
        <span role="alert" className="text-destructive">
          The key was not rotated.
        </span>
      )}
    </div>
  );
}

/** An Agent's tokens in a period against its cap, and where the cap is set. */
function CapUseCell({ use }: { use: CapUse | undefined }) {
  return (
    <td className="py-2 pr-4 tabular-nums">
      {use === undefined ? (
        "—"
      ) : (
        <>
          {capUseText(use)}
          <span className="block text-xs text-muted-foreground">
            {levelLabels[use.level]} cap
          </span>
        </>
      )}
    </td>
  );
}

/**
 * Removes an Agent, once the Owner confirms (FR-10): at once when it is
 * idle, or once the task it is in the middle of ends. The Manager stays.
 */
export function RemoveAgent({
  agent,
  onRemoved,
}: {
  agent: Agent;
  onRemoved: (said: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const hintId = `remove-${agent.id}-hint`;

  if (agent.role === "manager") {
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled
          aria-label={`Remove ${agent.name}`}
          aria-describedby={hintId}
        >
          <UserMinus aria-hidden />
          Remove
        </Button>
        <span id={hintId} className="sr-only">
          The Manager cannot be removed: every Floor has exactly one.
        </span>
      </>
    );
  }
  if (agent.leavingAt !== null) {
    return null;
  }

  const remove = async () => {
    setBusy(true);
    setProblem(undefined);
    const response = await sendDelete(
      `/api/floors/${encodeURIComponent(agent.floorId)}/agents/${encodeURIComponent(agent.id)}`,
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      setProblem(
        (await readApiError(response)).message ??
          `${agent.name} was not removed.`,
      );
      return;
    }
    const change = teamChangeSchema.parse(await response.json());
    setConfirming(false);
    onRemoved(
      change.removed.length > 0
        ? `${agent.name} was removed.`
        : `${agent.name} is in the middle of a task, and leaves once it ends.`,
    );
    await Promise.all([
      queryClient.invalidateQueries(agentsQuery(agent.floorId)),
      // A removed reviewer is no longer required.
      queryClient.invalidateQueries(floorQuery(agent.floorId)),
      queryClient.invalidateQueries(wallBoardQuery(agent.floorId)),
      queryClient.invalidateQueries(gatewayKeysQuery),
    ]);
  };

  return confirming ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={busy || session === undefined}
        onClick={() => void remove()}
      >
        Remove {agent.name}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
          setProblem(undefined);
        }}
      >
        Cancel
      </Button>
      {problem !== undefined && (
        <span role="alert" className="text-destructive">
          {problem}
        </span>
      )}
    </div>
  ) : (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Remove ${agent.name}`}
      onClick={() => {
        setConfirming(true);
      }}
    >
      <UserMinus aria-hidden />
      Remove
    </Button>
  );
}

/**
 * Adds an Agent in any Role in the office Role library, never the
 * Manager's (FR-10, FR-98, §5 scenario 7), copied from the Role's first
 * Agent, named by the Owner or at random. Its editor then opens, to choose
 * its AI Provider and Model.
 */
function AddAgentForm({
  floor,
  onAdded,
}: {
  floor: Floor;
  onAdded: (agent: Agent) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: library } = useQuery(rolesQuery);
  const [chosen, setRole] = useState<Role>("coder");
  // The coder, or the library's first Role once the coder is gone.
  const role = library?.some(({ id }) => id === chosen)
    ? chosen
    : (library?.[0]?.id ?? chosen);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const add = async () => {
    const parsed = addAgentRequestSchema.safeParse({
      role,
      ...(name.trim() === "" ? {} : { name }),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setBusy(true);
    setProblems([]);
    const response = await postJson(
      `/api/floors/${encodeURIComponent(floor.id)}/agents`,
      parsed.data,
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(error.problems ?? [error.message ?? "No Agent was added."]);
      return;
    }
    const agent = agentSchema.parse(await response.json());
    setName("");
    await Promise.all([
      queryClient.invalidateQueries(agentsQuery(floor.id)),
      // A first reviewer becomes the required one.
      queryClient.invalidateQueries(floorQuery(floor.id)),
      queryClient.invalidateQueries(gatewayKeysQuery),
    ]);
    onAdded(agent);
  };

  return (
    <form
      noValidate
      aria-label="Add an Agent"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="add-agent-role">Role</Label>
        <select
          id="add-agent-role"
          className={selectClass}
          value={role}
          onChange={(event) => {
            setRole(event.target.value);
          }}
        >
          {library?.map((each) => (
            <option key={each.id} value={each.id}>
              {roleLabel(each.id, library)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="add-agent-name">Name</Label>
        <Input
          id="add-agent-name"
          autoComplete="off"
          placeholder="Random"
          aria-describedby="add-agent-name-hint"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <Button
        pending={busy}
        type="submit"
        disabled={busy || session === undefined || library === undefined}
      >
        <UserPlus aria-hidden />
        {busy ? "Adding…" : "Add Agent"}
      </Button>
      <p
        id="add-agent-name-hint"
        className="w-full text-xs text-muted-foreground"
      >
        Copied from the Role&apos;s first {roleName(role, library)} Agent; leave
        the name empty for a random one. Its editor opens next.
      </p>
      {problems.length > 0 && (
        <ul role="alert" className="w-full space-y-1 text-sm text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** The issue an Agent is on, from its Floor's wall board (FR-12). */
function CurrentIssue({
  agent,
  board,
}: {
  agent: Agent;
  board: FloorWallBoard | undefined;
}) {
  if (board === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  const current = currentIssueOf(board, agent.id);
  return current === undefined ? (
    <span className="text-muted-foreground">None</span>
  ) : (
    <IssueSummary issue={current} />
  );
}

/** Which editor is open below the table, and for which Agent. */
interface Editing {
  readonly agentId: string;
  readonly editor: "config" | "avatar";
}

/**
 * The Floor's Agents (PRD FR-12), each with its status and current issue
 * (from the Floor's wall board, kept live by its events), today's and
 * this month's tokens against its caps, its Context Usage (FR-85), kept
 * live by its events, its Gateway Key, an Edit action
 * opening the Agent editor below the table, an Avatar action opening the
 * Avatar Editor there (FR-13), and Remove (FR-10). Below them, a new Agent
 * is added in any Role but the Manager's. `editAgentId` opens that
 * Agent's editor at once, brought into view, as an Agent's card links to
 * its config (FR-63).
 */
export function AgentsCard({
  floor,
  editAgentId,
}: {
  floor: Floor;
  editAgentId?: string | undefined;
}) {
  const { data: agents, isError } = useQuery(agentsQuery(floor.id));
  const { data: board } = useQuery(wallBoardQuery(floor.id));
  const { data: library } = useQuery(rolesQuery);
  // Agents join, leave and change as they work: the table follows them.
  useLiveWallBoard(floor.id, {
    onEvent: ({ event }, client) => {
      if (
        event.type === "agent.created" ||
        event.type === "agent.removed" ||
        event.type === "config.changed"
      ) {
        void client.invalidateQueries(agentsQuery(floor.id));
        void client.invalidateQueries(floorQuery(floor.id));
      }
    },
  });
  const [said, setSaid] = useState<string>();
  const [editing, setEditing] = useState<Editing | undefined>(
    editAgentId === undefined
      ? undefined
      : { agentId: editAgentId, editor: "config" },
  );
  const editor = useRef<HTMLDivElement>(null);
  const archived = floor.archivedAt !== null;
  const edited = agents?.find(({ id }) => id === editing?.agentId);
  // The editor the address asked for, once its Agent is known.
  const asked = editAgentId !== undefined && edited?.id === editAgentId;
  useEffect(() => {
    if (asked) {
      editor.current?.scrollIntoView({ block: "start" });
    }
  }, [asked]);
  const opened = (agentId: string, editor: Editing["editor"]) =>
    editing?.agentId === agentId && editing.editor === editor;
  const { data: gatewayKeys } = useQuery(gatewayKeysQuery);
  const { data: tokenUsage } = useQuery(floorTokenUsageQuery(floor.id));
  const contextUsage = useContextUsage(floor.id);
  const capsOf = (agentId: string) =>
    tokenUsage?.agents.find((entry) => entry.agentId === agentId)?.caps;
  const required = new Set(floor.requiredReviewerAgentIds);
  const keyOf = (agentId: string) =>
    gatewayKeys?.find((key) => key.agentId === agentId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Agents</h2>
        </CardTitle>
        <CardDescription>
          The Agents that work this Floor. Every Floor has exactly one Manager,
          which cannot be removed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The Agents could not be loaded.
          </p>
        )}
        {agents !== undefined && (
          <TableFrame label={`Agents on ${floor.name}, scrollable`}>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Agents on {floor.name}</caption>
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Role
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    AI Provider
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Model
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Context Usage
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Current issue
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Tokens today
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Tokens this month
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Gateway Key
                  </th>
                  {!archived && (
                    <th scope="col" className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      <AgentLink floorId={agent.floorId} agentId={agent.id}>
                        {() => agent.name}
                      </AgentLink>
                    </th>
                    <td className="py-2 pr-4">
                      {agentRoleLabel(agent, library)}
                      <ContractorBadge agent={agent} />
                      {required.has(agent.id) && (
                        <Badge className="ml-2">required reviewer</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">{agent.aiProvider}</td>
                    <td className="py-2 pr-4 font-mono">
                      {agent.model}
                      {agent.modelOverride === null && (
                        <span className="ml-1 font-sans text-muted-foreground">
                          {agent.aiProvider === anyAiProvider
                            ? "(the default of whichever it is given)"
                            : "(default)"}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4" data-testid="agent-status">
                      {agentStateText(agent, board)}
                    </td>
                    <td className="py-2 pr-4" data-testid="context-usage">
                      <ContextUsageGauge
                        usage={contextUsage.usageOf(agent.id)}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <CurrentIssue agent={agent} board={board} />
                    </td>
                    <CapUseCell use={capsOf(agent.id)?.daily} />
                    <CapUseCell use={capsOf(agent.id)?.monthly} />
                    <td className="py-2 pr-4">
                      <AgentGatewayKey
                        agent={agent}
                        gatewayKey={keyOf(agent.id)}
                      />
                    </td>
                    {!archived && (
                      <td className="py-2">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Edit ${agent.name}`}
                            aria-expanded={opened(agent.id, "config")}
                            onClick={() => {
                              setEditing({
                                agentId: agent.id,
                                editor: "config",
                              });
                            }}
                          >
                            <Pencil aria-hidden />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Open ${agent.name}'s Avatar Editor`}
                            aria-expanded={opened(agent.id, "avatar")}
                            onClick={() => {
                              setEditing({
                                agentId: agent.id,
                                editor: "avatar",
                              });
                            }}
                          >
                            <Shirt aria-hidden />
                            Avatar
                          </Button>
                          <KeepOnTeam agent={agent} onKept={setSaid} />
                          <RemoveAgent
                            agent={agent}
                            onRemoved={(text) => {
                              setSaid(text);
                              if (editing?.agentId === agent.id) {
                                setEditing(undefined);
                              }
                            }}
                          />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
        {said !== undefined && (
          <p role="status" className="mt-3 text-sm">
            {said}
          </p>
        )}
        {!archived && (
          <div className="mt-4 border-t pt-4">
            <h3 className="mb-3 text-sm font-medium">Add an Agent</h3>
            <AddAgentForm
              floor={floor}
              onAdded={(agent) => {
                setSaid(
                  `Added ${agent.name}, a ${roleName(agent.role, library)} Agent. Choose its AI Provider and Model below.`,
                );
                setEditing({ agentId: agent.id, editor: "config" });
                editor.current?.scrollIntoView({ block: "start" });
              }}
            />
          </div>
        )}
        <div ref={editor}>
          {edited !== undefined &&
            !archived &&
            (editing?.editor === "avatar" ? (
              <AvatarEditor
                key={`avatar:${edited.id}`}
                agent={edited}
                onClose={() => {
                  setEditing(undefined);
                }}
              />
            ) : (
              <AgentEditor
                key={edited.id}
                agent={edited}
                onClose={() => {
                  setEditing(undefined);
                }}
              />
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
