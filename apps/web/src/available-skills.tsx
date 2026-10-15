import {
  floorSkillDetailSchema,
  isMattPocockSkill,
  parseSkillDocument,
  skillFileName,
  startsGrillingSession,
  type FloorSkill,
  type FloorSkillDetail,
} from "@ai-office/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { getJson } from "./api.ts";
import { floorSkillsQuery } from "./floor-skills-card.tsx";
import { floorsQuery } from "./floors.ts";
import { SkillMarkdown } from "./skill-markdown.tsx";

// The Available Skills list (PRD FR-73): a Floor's Skills, the office
// library's enabled ones and its repository's own, each with its name,
// description and where it comes from. Opening one shows a modal with its
// `SKILL.md` rendered and its supporting files, each viewable there; its
// run button puts `/name` in the Manager chat (FR-74). The list sits beside
// the Manager chat, in Admin (for a Floor the Owner picks) and on the
// bookshelf in the Manager's office in the 3D Office.

/** One of a Floor's Skills in full (`GET /api/floors/:floorId/skills/:name`). */
export const floorSkillQuery = (floorId: string, name: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "skills", name],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/skills/${encodeURIComponent(name)}`,
        floorSkillDetailSchema,
      ),
  });

/** The Floor's Manager chat, with `/skill` put in its box when one is named. */
export const managerChatHref = (floorId: string, skill?: string): string =>
  `/floors/${encodeURIComponent(floorId)}/manager${skill === undefined ? "" : `?skill=${encodeURIComponent(skill)}`}`;

/**
 * The chat box's text with `/name ` at its start: in place of a Skill's
 * command already there, and before anything else written, which becomes
 * its arguments.
 */
export function withSkillCommand(text: string, name: string): string {
  const rest = text.trimStart().replace(/^\/\S*\s*/, "");
  return `/${name} ${rest}`;
}

const sourceLabels = {
  office: "Office",
  repository: "Repository",
  "built-in": "Built in",
} as const;

const sourceTones = {
  office: "info",
  repository: "violet",
  "built-in": "success",
} as const;

function SourceBadge({ source }: { source: FloorSkill["source"] }) {
  return <Badge tone={sourceTones[source]}>{sourceLabels[source]}</Badge>;
}

/**
 * Where a Skill comes from, in words. A built-in Skill says what running it
 * does, a Grilling Session or instructions, and credits Matt Pocock for
 * those adapted from his skills.
 */
function whereFrom(
  skill: Pick<
    FloorSkillDetail,
    "name" | "source" | "folder" | "overridesOffice"
  >,
) {
  if (skill.source === "office") {
    return <>From the office Skill library.</>;
  }
  if (skill.source === "built-in") {
    return (
      <>
        Built into AI Office, on every Floor.{" "}
        {startsGrillingSession(skill.name)
          ? "Running it starts a Grilling Session with the Manager."
          : "Running it loads its instructions into the Manager chat; an office or repository Skill of its name takes its place."}
        {isMattPocockSkill(skill.name) && (
          <>
            {" "}
            Adapted from{" "}
            <a
              href="https://github.com/mattpocock/skills"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              Matt Pocock&rsquo;s skills
            </a>
            , MIT.
          </>
        )}
      </>
    );
  }
  return (
    <>
      From the repository, <code className="font-mono">{skill.folder}</code>
      {skill.overridesOffice && ", in place of the office Skill of its name"}.
    </>
  );
}

/** One file of a Skill, as the modal shows it. */
function SkillFileView({ path, content }: { path: string; content: string }) {
  if (path === skillFileName) {
    const parsed = parseSkillDocument(content);
    return (
      <SkillMarkdown
        label={`${skillFileName}, rendered`}
        text={parsed.ok ? parsed.document.instructions : content}
      />
    );
  }
  if (/\.(md|markdown)$/i.test(path)) {
    return <SkillMarkdown label={`${path}, rendered`} text={content} />;
  }
  return (
    <pre
      aria-label={path}
      className="overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre"
    >
      {content}
    </pre>
  );
}

/** The modal for one Skill: its `SKILL.md`, its supporting files, and run. */
function SkillDialog({
  floorId,
  name,
  onClose,
  onRun,
}: {
  floorId: string;
  name: string | undefined;
  onClose: () => void;
  onRun: (name: string) => void;
}) {
  const skill = useQuery({
    ...floorSkillQuery(floorId, name ?? ""),
    enabled: name !== undefined,
  });
  const [shown, setShown] = useState<string>(skillFileName);
  const filesId = useId();
  const files = skill.data?.files ?? [];
  const supporting = files.filter(({ path }) => path !== skillFileName);
  const file = files.find(({ path }) => path === shown) ?? files[0];

  const fileButton = (path: string) => (
    <Button
      size="sm"
      variant={file?.path === path ? "secondary" : "ghost"}
      aria-current={file?.path === path ? "true" : undefined}
      className="justify-start font-mono text-xs"
      onClick={() => {
        setShown(path);
      }}
    >
      {path}
    </Button>
  );

  return (
    <Dialog
      open={name !== undefined}
      onClose={() => {
        setShown(skillFileName);
        onClose();
      }}
      title={name ?? ""}
      closeLabel={`Close ${name ?? "the Skill"}`}
      className="w-[min(60rem,calc(100vw-2rem))]"
      footer={
        name === undefined ? undefined : (
          <>
            <Button
              onClick={() => {
                setShown(skillFileName);
                onRun(name);
              }}
            >
              <Play aria-hidden />
              Run /{name}
            </Button>
            <p className="text-xs text-muted-foreground">
              Puts <code>/{name}</code> in the Manager chat, to add what it is
              for and send.
            </p>
          </>
        )
      }
    >
      {skill.isError && (
        <p role="alert" className="text-destructive">
          This Skill could not be read: {skill.error.message}
        </p>
      )}
      {skill.isPending && name !== undefined && (
        <LoadingMessage>Reading the Skill…</LoadingMessage>
      )}
      {skill.data !== undefined && file !== undefined && (
        <div className="space-y-4">
          <div className="space-y-1">
            <p>{skill.data.description}</p>
            <p className="text-xs text-muted-foreground">
              {whereFrom(skill.data)}
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-[13rem_1fr]">
            <nav aria-labelledby={filesId} className="space-y-1">
              <h3 id={filesId} className="text-xs font-semibold">
                Files
              </h3>
              <ul className="flex flex-col gap-0.5">
                <li>{fileButton(skillFileName)}</li>
              </ul>
              <h4 className="pt-2 text-xs text-muted-foreground">
                Supporting files
              </h4>
              {supporting.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
              ) : (
                <ul
                  aria-label="Supporting files"
                  className="flex flex-col gap-0.5"
                >
                  {supporting.map(({ path }) => (
                    <li key={path}>{fileButton(path)}</li>
                  ))}
                </ul>
              )}
            </nav>
            <div className="min-w-0 space-y-2">
              <p className="font-mono text-xs text-muted-foreground">
                {file.path}
              </p>
              <SkillFileView path={file.path} content={file.content} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * A Floor's Available Skills: the list, and the modal each opens. `onRun`
 * is given the name of the Skill whose run button was pressed.
 */
export function AvailableSkillList({
  floorId,
  onRun,
  className,
}: {
  floorId: string;
  onRun: (name: string) => void;
  className?: string;
}) {
  const { data, error } = useQuery(floorSkillsQuery(floorId));
  const [open, setOpen] = useState<string | undefined>();
  return (
    <div className={cn("space-y-2 text-sm", className)}>
      {error !== null && (
        <p role="alert" className="text-destructive">
          The Skills could not be loaded: {error.message}
        </p>
      )}
      {data === undefined && error === null && (
        <LoadingMessage>Loading the Skills…</LoadingMessage>
      )}
      {data?.repositoryError != null && (
        <p role="note" className="text-xs text-muted-foreground">
          {data.repositoryError}
        </p>
      )}
      {data?.skills.length === 0 && (
        <p className="text-muted-foreground">
          No Skills yet. Add one to the office library in General Settings, or
          to the repository under <code>.agents/skills/</code> or{" "}
          <code>.claude/skills/</code>.
        </p>
      )}
      {data !== undefined && data.skills.length > 0 && (
        <ul aria-label="Available Skills" className="space-y-2">
          {data.skills.map((skill) => (
            <li
              key={skill.name}
              aria-label={skill.name}
              className="space-y-1 rounded-lg border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-sm font-mono font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  aria-label={`Open ${skill.name}`}
                  onClick={() => {
                    setOpen(skill.name);
                  }}
                >
                  {skill.name}
                </button>
                <SourceBadge source={skill.source} />
              </div>
              <p className="text-xs text-muted-foreground">
                {skill.description}
              </p>
            </li>
          ))}
        </ul>
      )}
      <SkillDialog
        floorId={floorId}
        name={open}
        onClose={() => {
          setOpen(undefined);
        }}
        onRun={(name) => {
          setOpen(undefined);
          onRun(name);
        }}
      />
    </div>
  );
}

/** Opens a page of AI Office: without a reload, given `navigate`. */
const goTo = (href: string, navigate?: (href: string) => void) => {
  if (navigate === undefined) {
    window.location.assign(href);
  } else {
    navigate(href);
  }
};

/**
 * A Floor's Available Skills away from its chat, as the Manager's office
 * bookshelf shows them: running one opens the Manager chat with its
 * command in the box.
 */
export function FloorAvailableSkills({
  floorId,
  navigate,
}: {
  floorId: string;
  navigate?: ((href: string) => void) | undefined;
}) {
  return (
    <AvailableSkillList
      floorId={floorId}
      onRun={(name) => {
        goTo(managerChatHref(floorId, name), navigate);
      }}
    />
  );
}

/** Admin's Available Skills: each Floor's, for the Floor chosen. */
export function AvailableSkillsCard() {
  const router = useRouter();
  const { data: floors } = useQuery(floorsQuery);
  const [chosen, setChosen] = useState<string | undefined>();
  const floorId = chosen ?? floors?.[0]?.id;
  const selectId = useId();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Available Skills</h2>
        </CardTitle>
        <CardDescription>
          The Skills a Floor&apos;s Manager can run: the office library&apos;s
          enabled Skills and the Floor repository&apos;s own. Open one to read
          it; run it to put its command in that Floor&apos;s Manager chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {floors?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Add a Floor to see the Skills its Manager can run.
          </p>
        )}
        {floors !== undefined && floors.length > 0 && floorId !== undefined && (
          <>
            <div className="max-w-sm space-y-1">
              <Label htmlFor={selectId}>Floor</Label>
              <select
                id={selectId}
                className={selectClass}
                value={floorId}
                onChange={(event) => {
                  setChosen(event.target.value);
                }}
              >
                {floors.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name}
                  </option>
                ))}
              </select>
            </div>
            <AvailableSkillList
              key={floorId}
              floorId={floorId}
              onRun={(name) => {
                router.history.push(managerChatHref(floorId, name));
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
