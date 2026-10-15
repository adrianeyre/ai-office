import {
  communicationsAgentSchema,
  lobbyCastSchema,
  pronounsOf,
  type Agent,
  floorSchema,
  type Avatar,
  type Floor,
  type LobbyCharacter,
  type LobbyRole,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

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
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { Tabs } from "@/components/ui/tabs.tsx";
import { selectClass } from "@/lib/utils.ts";

import { AgentEditor } from "./agent-editor.tsx";
import { ActivitiesCard } from "./activities-card.tsx";
import {
  AgentsCard,
  ContractorBadge,
  KeepOnTeam,
  RemoveAgent,
  roleLabel,
} from "./agents-card.tsx";
import { readApiError, sendJson } from "./api.ts";
import {
  AvatarEditor,
  AvatarForm,
  type AvatarSaveResult,
} from "./avatar-editor.tsx";
import { communicationsAgentQuery } from "./connections-page.tsx";
import { agentsQuery, floorsQuery } from "./floors.ts";
import { lobbyCastQuery } from "./people.ts";
import { rolesQuery } from "./role-library.tsx";
import { RoleMemoryCard } from "./role-memory-card.tsx";
import { sessionQuery } from "./session.ts";
import { TeamCard } from "./team-card.tsx";
import { FloorTokenUsageCard } from "./token-caps.tsx";

// Agent Settings: everyone where the lift is, or anywhere else it goes. On
// a Floor, every one of each of its Agents' settings: its name, status, AI
// Provider (one, or any AI Provider), Model, effort, Token Caps, Fresh
// Start threshold, extra instructions, whether a reviewer is required
// (FR-27), its Avatar, sex included, keeping a Contractor on the team, and
// removing it; then its team, the Agents table (with Gateway Keys), its
// Role memory and its Token usage. In the lobby, the names and Avatars of
// the receptionist, who is the Communications Agent (FR-96), and the
// visitor.

/** Where the page shows: the lobby, or a Floor by its id. */
export const lobbyPlace = "lobby";

const roleAbout: Record<LobbyRole, string> = {
  receptionist:
    "Sits behind the reception desk, greets you as you come in, and now and then types, fetches water or stretches.",
  visitor:
    "Now and then waits on the sofa, reading, dozing, on their phone or fetching a drink.",
};

/** Saves someone in the lobby: what was saved, or why it was not. */
type SaveCharacter = (
  character: LobbyCharacter,
) => Promise<{ saved: LobbyCharacter } | { problems: string[] }>;

/** Saves one of the lobby's cast; the answer is the whole cast. */
function useSaveLobbyCharacter(role: LobbyRole): SaveCharacter {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  return async (character) => {
    const response = await sendJson(
      "PUT",
      `/api/office/lobby-cast/${role}`,
      character,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      return {
        problems: error.problems ?? [
          error.message ?? `The ${role} was not saved.`,
        ],
      };
    }
    const cast = lobbyCastSchema.parse(await response.json());
    queryClient.setQueryData(lobbyCastQuery.queryKey, cast);
    return { saved: cast[role] };
  };
}

/**
 * Saves the Communications Agent's name or Avatar (`PATCH
 * /api/communications-agent`), sending only what changed.
 */
function useSaveCommunicationsAgent(before: LobbyCharacter): SaveCharacter {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  return async (character) => {
    const response = await sendJson(
      "PATCH",
      "/api/communications-agent",
      character.name === before.name
        ? { avatar: character.avatar }
        : { name: character.name },
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      return {
        problems: error.problems ?? [
          error.message ?? "The Communications Agent was not saved.",
        ],
      };
    }
    const agent = communicationsAgentSchema.parse(await response.json());
    queryClient.setQueryData(communicationsAgentQuery.queryKey, agent);
    return { saved: { name: agent.name, avatar: agent.avatar } };
  };
}

/** Someone in the lobby: their name, and their Avatar. */
function LobbyCharacterCard({
  id,
  what,
  about,
  character,
  others,
  save,
}: {
  id: string;
  /** What they are, such as "the visitor". */
  what: string;
  about: ReactNode;
  character: LobbyCharacter;
  others: readonly Avatar[];
  save: SaveCharacter;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [name, setName] = useState(character.name);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== character.name;

  const saveName = async () => {
    setSaving(true);
    setSaved(false);
    const result = await save({ ...character, name });
    setSaving(false);
    if ("problems" in result) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    setSaved(true);
    setName(result.saved.name);
  };

  const saveAvatar = async (avatar: Avatar): Promise<AvatarSaveResult> => {
    const result = await save({ ...character, avatar });
    if ("problems" in result) {
      return result;
    }
    const now = result.saved;
    return {
      saved: { id, ...now },
      message: `Saved. The lobby shows ${now.name}'s new look.`,
    };
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            {character.name}, {what}
          </h2>
        </CardTitle>
        <CardDescription>{about}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          noValidate
          aria-label={`The ${what.replace(/^the /, "")}'s name`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              autoComplete="off"
              value={name}
              onChange={(event) => {
                setSaved(false);
                setName(event.target.value);
              }}
            />
          </div>
          <Button
            pending={saving}
            type="submit"
            disabled={!dirty || saving || session === undefined}
          >
            {saving ? "Saving…" : "Save name"}
          </Button>
          {saved && !dirty && (
            <p role="status" className="text-sm">
              Saved.
            </p>
          )}
          {problems.length > 0 && (
            <ul role="alert" className="w-full text-sm text-destructive">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </form>
        <AvatarForm
          subject={{ id, name: character.name, avatar: character.avatar }}
          others={others}
          save={saveAvatar}
          about={() => (
            <>
              How {character.name} looks in the lobby: sex, skin, hair, clothes
              and all.
            </>
          )}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The Communications Agent, who sits at the lobby's reception desk as its
 * receptionist (FR-96): its name and Avatar. The rest of it, and its
 * Connections, are in the Connections admin.
 */
function CommunicationsAgentCharacterCard({
  character,
  others,
}: {
  character: LobbyCharacter;
  others: readonly Avatar[];
}) {
  const save = useSaveCommunicationsAgent(character);
  return (
    <LobbyCharacterCard
      id="lobby-receptionist"
      what="the Communications Agent"
      about={
        <>
          {roleAbout.receptionist} It tells you outside AI Office about Notices
          and finished work, through your Connections: its AI Provider, Model
          and Connections are in{" "}
          <Link to="/general-settings/connections" className="underline">
            the Connections admin
          </Link>
          .
        </>
      }
      character={character}
      others={others}
      save={save}
    />
  );
}

function VisitorCard({
  character,
  others,
}: {
  character: LobbyCharacter;
  others: readonly Avatar[];
}) {
  const save = useSaveLobbyCharacter("visitor");
  return (
    <LobbyCharacterCard
      id="lobby-visitor"
      what="the visitor"
      about={roleAbout.visitor}
      character={character}
      others={others}
      save={save}
    />
  );
}

function LobbySettings() {
  const { data: cast, isError } = useQuery(lobbyCastQuery);
  const { data: agent, isError: agentError } = useQuery(
    communicationsAgentQuery,
  );
  if (isError || agentError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The lobby&apos;s cast could not be loaded.
      </p>
    );
  }
  if (cast === undefined || agent === undefined) {
    return (
      <LoadingMessage className="text-sm">Loading the lobby…</LoadingMessage>
    );
  }
  const receptionist = { name: agent.name, avatar: agent.avatar };
  return (
    <Tabs
      label="The lobby's cast"
      tabs={[
        {
          id: "receptionist",
          label: receptionist.name,
          content: (
            <CommunicationsAgentCharacterCard
              character={receptionist}
              others={[cast.visitor.avatar]}
            />
          ),
        },
        {
          id: "visitor",
          label: cast.visitor.name,
          content: (
            <VisitorCard
              character={cast.visitor}
              others={[receptionist.avatar]}
            />
          ),
        },
      ]}
    />
  );
}

const capText = (cap: number | null) =>
  cap === null ? "the Floor's" : cap.toLocaleString("en-GB");

/**
 * One Agent: its Role and how it runs at a glance, then a tab for its
 * settings and one for its Avatar.
 */
function AgentSettingsCard({ agent }: { agent: Agent }) {
  const { data: library } = useQuery(rolesQuery);
  const [said, setSaid] = useState<string>();
  const pronouns = pronounsOf(agent.avatar);
  const sex =
    agent.avatar.presentation === "androgynous"
      ? "Androgynous"
      : agent.avatar.presentation === "male"
        ? "Male"
        : "Female";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>{agent.name}</h2>
          {/* The Agent's Role, picked out at a glance. */}
          <Badge tone="primary" data-agent-role={agent.role}>
            {roleLabel(agent.role, library)}
          </Badge>
          <ContractorBadge agent={agent} />
        </CardTitle>
        <CardDescription>
          {sex} ({pronouns.subject}) · {agent.aiProvider} {agent.model} ·{" "}
          {agent.enabled ? "Enabled" : "Paused"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Token Caps: {capText(agent.tokenCaps.daily)} a day,{" "}
          {capText(agent.tokenCaps.monthly)} a month.
        </p>
        <div className="flex flex-wrap gap-2">
          <KeepOnTeam agent={agent} onKept={setSaid} />
          <RemoveAgent agent={agent} onRemoved={setSaid} />
        </div>
        {said !== undefined && (
          <p role="status" className="text-sm">
            {said}
          </p>
        )}
        {agent.leavingAt !== null && said === undefined && (
          <p className="text-sm text-muted-foreground">
            Leaving once {pronouns.possessive} task ends.
          </p>
        )}
        <Tabs
          label={`${agent.name}'s settings and Avatar`}
          tabs={[
            {
              id: "settings",
              label: "Settings",
              content: <AgentEditor agent={agent} />,
            },
            {
              id: "avatar",
              label: "Avatar",
              content: <AvatarEditor agent={agent} />,
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

/** Renames a Floor: its name everywhere, not its repository's. */
function FloorName({ floor }: { floor: Floor }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [name, setName] = useState(floor.name);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== floor.name;
  const save = async () => {
    setSaving(true);
    setSaved(false);
    const response = await sendJson(
      "PATCH",
      `/api/floors/${encodeURIComponent(floor.id)}`,
      { name: name.trim() },
      session?.csrfToken,
    );
    setSaving(false);
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The Floor was not renamed."],
      );
      return;
    }
    const updated = floorSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    setName(updated.name);
    await queryClient.invalidateQueries(floorsQuery);
  };
  return (
    <form
      noValidate
      aria-label="The Floor's name"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="floor-name">Floor name</Label>
        <Input
          id="floor-name"
          autoComplete="off"
          aria-describedby="floor-name-hint"
          value={name}
          onChange={(event) => {
            setSaved(false);
            setName(event.target.value);
          }}
        />
        <p id="floor-name-hint" className="text-xs text-muted-foreground">
          Its repository stays{" "}
          <span className="font-mono">{floor.repository}</span>.
        </p>
      </div>
      <Button
        pending={saving}
        type="submit"
        disabled={!dirty || saving || session === undefined}
      >
        {saving ? "Saving…" : "Rename Floor"}
      </Button>
      {saved && !dirty && (
        <p role="status" className="text-sm">
          Renamed.
        </p>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="w-full text-sm text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

/**
 * A Floor's Agents: a tab each, then its team, the Agents table (status,
 * Context Usage, Gateway Keys, removing one), its Role memory and its
 * Token Caps and usage. `agentId` opens that Agent's editor in the table.
 */
function FloorAgentSettings({
  floor,
  agentId,
}: {
  floor: Floor;
  agentId?: string | undefined;
}) {
  const { data: team, isError } = useQuery(agentsQuery(floor.id));
  return (
    <div className="space-y-6">
      <FloorName floor={floor} />
      {isError ? (
        <p role="alert" className="text-sm text-destructive">
          The Floor&apos;s Agents could not be loaded.
        </p>
      ) : team === undefined ? (
        <LoadingMessage className="text-sm">Loading the Agents…</LoadingMessage>
      ) : team.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This Floor has no Agents yet.
        </p>
      ) : (
        <Tabs
          label={`Agents on ${floor.name}`}
          initial={agentId}
          tabs={team.map((agent) => ({
            id: agent.id,
            label: agent.name,
            content: <AgentSettingsCard key={agent.id} agent={agent} />,
          }))}
        />
      )}
      <TeamCard floor={floor} />
      <ActivitiesCard floor={floor} />
      <AgentsCard key={agentId} floor={floor} editAgentId={agentId} />
      <RoleMemoryCard floor={floor} />
      <FloorTokenUsageCard floor={floor} />
    </div>
  );
}

/**
 * Agent Settings for `place`: the lobby, or a Floor's id. `onPlaceChange`
 * is told when another is chosen.
 */
export function AgentSettingsPage({
  place,
  agentId,
  onPlaceChange,
}: {
  place: string;
  /** An Agent whose editor to open in the Agents table. */
  agentId?: string | undefined;
  onPlaceChange: (place: string) => void;
}) {
  const { data: floors } = useQuery(floorsQuery);
  const floor = floors?.find(({ id }) => id === place);
  const known = place === lobbyPlace || floor !== undefined;
  return (
    <section className="space-y-6">
      <PageHeader
        title="Agent Settings"
        description={
          <>
            Everyone on a Floor, or in the lobby: their names, sex and Avatars,
            and every Agent&apos;s settings: its AI Provider, Model, effort,
            Token Caps and the rest.
          </>
        }
      />
      <div className="max-w-sm space-y-2">
        <Label htmlFor="agent-settings-place">Floor</Label>
        <select
          id="agent-settings-place"
          className={selectClass}
          value={place}
          onChange={(event) => {
            onPlaceChange(event.target.value);
          }}
        >
          <option value={lobbyPlace}>Lobby</option>
          {(floors ?? []).map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
          {!known && floors === undefined && (
            <option value={place}>Loading…</option>
          )}
        </select>
      </div>
      {place === lobbyPlace ? (
        <LobbySettings />
      ) : floors === undefined ? (
        <LoadingMessage className="text-sm">Loading the Floor…</LoadingMessage>
      ) : floor === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          There is no Floor &quot;{place}&quot;.
        </p>
      ) : (
        <FloorAgentSettings key={place} floor={floor} agentId={agentId} />
      )}
    </section>
  );
}
