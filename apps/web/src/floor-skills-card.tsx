import {
  floorSkillListSchema,
  repositorySkillDetailSchema,
  roleName,
  sandboxRoles,
  type AwaitingSkill,
  type Floor,
  type FloorSkill,
  type RepositorySkillDetail,
  type SandboxRole,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// A Floor's Skills in its admin (PRD FR-72, FR-75): the office library's
// enabled Skills and the repository's own, the repository's overriding
// the office's of the same name, each turned on or off for each Role whose
// Agents work in sandboxes. A repository Skill is used only once the Owner
// has read its files here and reviewed exactly those (FR-76, P1-10), and
// again only after a change is reviewed.

/** `GET /api/floors/:floorId/skills`. */
export const floorSkillsQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "skills"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/skills`,
        floorSkillListSchema,
      ),
  });

function SourceOf({ skill }: { skill: FloorSkill }) {
  if (skill.source === "office") {
    return <span className="text-muted-foreground">Office library</span>;
  }
  return (
    <span className="text-muted-foreground">
      Repository, <code className="font-mono">{skill.folder}</code>
      {skill.overridesOffice && " (overrides the office Skill)"}
    </span>
  );
}

/**
 * One repository Skill waiting for the Owner's review: its files, read
 * whole and shown as they are, and the review of exactly those.
 */
function AwaitingSkillReview({
  floor,
  skill,
  onReviewed,
}: {
  floor: Floor;
  skill: AwaitingSkill;
  onReviewed: () => Promise<void>;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [read, setRead] = useState<RepositorySkillDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const base = `/api/floors/${encodeURIComponent(floor.id)}/repository-skills`;

  const open = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setRead(
        await getJson(
          `${base}?folder=${encodeURIComponent(skill.folder)}`,
          repositorySkillDetailSchema,
        ),
      );
    } catch (error) {
      setProblem((error as Error).message);
    }
    setBusy(false);
  };

  const review = async (detail: RepositorySkillDetail) => {
    setBusy(true);
    setProblem(null);
    const response = await sendJson(
      "POST",
      `${base}/review`,
      { folder: detail.folder, digest: detail.digest },
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      const refused = await readApiError(response);
      setProblem(refused.message ?? "The Skill was not reviewed.");
      setRead(null);
      return;
    }
    await onReviewed();
  };

  return (
    <li className="space-y-2 rounded-md border p-3">
      <p>
        <span className="font-mono font-medium">{skill.name}</span>{" "}
        <span className="text-muted-foreground">
          in <code className="font-mono">{skill.folder}</code>
        </span>
      </p>
      <p>{skill.description}</p>
      <p className="text-xs text-muted-foreground">
        {skill.changed
          ? "It changed after you reviewed it, so it is not used until you review it again."
          : "Never reviewed, so it is not used."}
        {skill.overridesOffice &&
          " The office Skill of its name is used in its place meanwhile."}
      </p>
      {read === null ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || floor.archivedAt !== null}
          onClick={() => void open()}
        >
          Read {skill.name} to review it
        </Button>
      ) : (
        <div className="space-y-2">
          {read.files.map(({ path, content }) => (
            <div key={path} className="space-y-1">
              <p className="font-mono text-xs text-muted-foreground">{path}</p>
              <pre
                aria-label={`${read.folder}/${path}`}
                className="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre"
              >
                {content}
              </pre>
            </div>
          ))}
          <Button size="sm" disabled={busy} onClick={() => void review(read)}>
            I have read {read.files.length === 1 ? "it" : "every file"}: use{" "}
            {read.name} on this Floor
          </Button>
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}

export function FloorSkillsCard({ floor }: { floor: Floor }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const query = floorSkillsQuery(floor.id);
  const { data: list, error } = useQuery(query);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const archived = floor.archivedAt !== null;
  // Built-in Skills, such as /grilling, are the Manager's: never in a sandbox.
  const skills = list?.skills.filter(({ source }) => source !== "built-in");

  const toggle = async (skill: FloorSkill, role: SandboxRole) => {
    const key = `${skill.name}:${role}`;
    setSaving(key);
    setProblem(null);
    const enabled = !skill.roles[role];
    const response = await sendJson(
      "PUT",
      `/api/floors/${encodeURIComponent(floor.id)}/skills/${encodeURIComponent(skill.name)}/roles/${role}`,
      { enabled },
      session?.csrfToken,
    );
    setSaving(null);
    if (!response.ok) {
      const refused = await readApiError(response);
      setProblem(refused.message ?? "The Skill was not changed.");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: query.queryKey });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Skills</h2>
        </CardTitle>
        <CardDescription>
          The office library&apos;s Skills and the repository&apos;s own, from{" "}
          <code className="font-mono">.agents/skills/</code> and{" "}
          <code className="font-mono">.claude/skills/</code>. A repository Skill
          is used once you have read and reviewed it, and then overrides the
          office Skill of the same name on this Floor. Each Skill on for a Role
          is mounted read-only into its Agents&apos; sandboxes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== null && (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        )}
        {list === undefined && error === null && (
          <LoadingMessage>Loading the Skills…</LoadingMessage>
        )}
        {list?.repositoryError != null && (
          <p role="note" className="rounded-md border p-3 text-sm">
            {list.repositoryError}
          </p>
        )}
        {skills?.length === 0 && (
          <p className="text-muted-foreground">This Floor has no Skills yet.</p>
        )}
        {skills !== undefined && skills.length > 0 && (
          <TableFrame label="Skills and their Roles, scrollable">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Each Skill, and the Roles it is on for
              </caption>
              <thead>
                <tr className="text-left">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Skill
                  </th>
                  {sandboxRoles.map((role) => (
                    <th
                      key={role}
                      scope="col"
                      className="px-2 py-1 font-medium"
                    >
                      {roleName(role)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {skills.map((skill) => (
                  <tr key={skill.name} className="border-t align-top">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <span className="font-mono font-medium">
                        {skill.name}
                      </span>
                      <span className="block">{skill.description}</span>
                      <span className="block text-xs">
                        <SourceOf skill={skill} />
                      </span>
                    </th>
                    {sandboxRoles.map((role) => (
                      <td key={role} className="px-2 py-2">
                        <input
                          type="checkbox"
                          aria-label={`${skill.name} for ${roleName(role)} Agents`}
                          checked={skill.roles[role]}
                          disabled={
                            archived || saving === `${skill.name}:${role}`
                          }
                          onChange={() => void toggle(skill, role)}
                          className="size-4"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
        {list !== undefined && list.awaitingReview.length > 0 && (
          <section aria-label="Repository Skills waiting for your review">
            <h3 className="font-medium">Waiting for your review</h3>
            <p className="text-sm text-muted-foreground">
              These repository Skills reach no Agent and not the Manager&apos;s
              chat until you have read their files and reviewed exactly those.
            </p>
            <ul className="mt-2 space-y-2">
              {list.awaitingReview.map((skill) => (
                <AwaitingSkillReview
                  key={skill.folder}
                  floor={floor}
                  skill={skill}
                  onReviewed={() =>
                    queryClient.invalidateQueries({ queryKey: query.queryKey })
                  }
                />
              ))}
            </ul>
          </section>
        )}
        {list !== undefined && list.ignored.length > 0 && (
          <div className="text-sm">
            <p>These repository folders hold no usable Skill:</p>
            <ul className="list-disc pl-5">
              {list.ignored.map(({ folder, problems }) => (
                <li key={folder}>
                  <code className="font-mono">{folder}</code>:{" "}
                  {problems.join(" ")}
                </li>
              ))}
            </ul>
          </div>
        )}
        {problem !== null && (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
