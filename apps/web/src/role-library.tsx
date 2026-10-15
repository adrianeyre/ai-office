import {
  aiProviders,
  createRoleRequestSchema,
  deskDressings,
  roleListSchema,
  roleSchema,
  stages,
  updateRoleRequestSchema,
  type DeskDressing,
  type LibraryRole,
  type Stage,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Eye, Plus, Trash2, X } from "lucide-react";
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
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { selectClass } from "@/lib/utils.ts";

import { aiProvidersQuery, optionLabel } from "./ai-providers-card.tsx";
import {
  getJson,
  postJson,
  readApiError,
  sendDelete,
  sendJson,
} from "./api.ts";
import { skillsQuery } from "./skills-card.tsx";
import { sessionQuery } from "./session.ts";

// The office Role library (PRD FR-98, FR-65): every Role an Agent can fill
// but the Manager's, each in one of the four Stages, with how many Agents
// fill it. The Owner views, makes, duplicates and edits a Role (its name,
// Stage, routing description, instructions, Skills from the Skill library,
// desk dressing and suggested AI Provider and Model), and deletes one no
// Agent fills. Changing a Role changes every Agent with it, from each
// one's next task, so the editor says how many that is.

/** The library, in its order (`GET /api/roles`). */
export const rolesQuery = queryOptions({
  queryKey: ["roles"],
  queryFn: async () => (await getJson("/api/roles", roleListSchema)).roles,
});

const roleUrl = (id: string): string => `/api/roles/${encodeURIComponent(id)}`;

/** Each Stage, as people read it. */
export const stageLabels: Record<Stage, string> = {
  work: "Work",
  review: "Review",
  qa: "QA",
  docs: "Docs",
};

/** What each Stage's Agents do, for the Stage's hint. */
const stageHints: Record<Stage, string> = {
  work: "Changes the repository in a sandbox.",
  review: "Reviews a pull request and gives a verdict, without a sandbox.",
  qa: "Checks the result in a sandbox.",
  docs: "Documents the change in a sandbox.",
};

/** What sits on the Role's desks in the Office. */
const deskDressingLabels: Record<DeskDressing, string> = {
  monitor: "A monitor",
  "dual-monitors": "Two monitors",
  printouts: "Printouts",
  "test-devices": "Test devices",
  books: "Books and a notebook",
  notebooks: "Notebooks",
  "product-samples": "Product samples",
};

const textareaClass =
  "min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** "1 Agent", "3 Agents". */
const agentCount = (count: number): string =>
  count === 1 ? "1 Agent" : `${String(count)} Agents`;

/** A Role's fields as the form holds them: text until saved. */
interface FormValues {
  readonly name: string;
  readonly stage: Stage;
  readonly description: string;
  readonly instructions: string;
  readonly skills: readonly string[];
  readonly deskDressing: DeskDressing;
  /** "" for the office default. */
  readonly aiProvider: string;
  /** "" for its AI Provider's default Model. */
  readonly model: string;
}

const blank: FormValues = {
  name: "",
  stage: "work",
  description: "",
  instructions: "",
  skills: [],
  deskDressing: "monitor",
  aiProvider: "",
  model: "",
};

const valuesOf = (role: LibraryRole): FormValues => ({
  name: role.name,
  stage: role.stage,
  description: role.description,
  instructions: role.instructions,
  skills: role.skills,
  deskDressing: role.deskDressing,
  aiProvider: role.aiProvider ?? "",
  model: role.model ?? "",
});

/** The form's values as a Role's fields. */
const fieldsOf = (values: FormValues) => ({
  name: values.name,
  stage: values.stage,
  description: values.description,
  instructions: values.instructions,
  skills: [...values.skills],
  deskDressing: values.deskDressing,
  aiProvider: values.aiProvider === "" ? null : values.aiProvider,
  model: values.model === "" ? null : values.model,
});

/** Only the fields that differ from `role`'s. */
function changesOf(
  role: LibraryRole,
  values: FormValues,
): Partial<ReturnType<typeof fieldsOf>> {
  const next = fieldsOf(values);
  const current = fieldsOf(valuesOf(role));
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(current[key as keyof typeof current]),
    ),
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function Problems({ problems }: { problems: readonly string[] }) {
  return problems.length === 0 ? null : (
    <ul role="alert" className="space-y-1 text-sm text-destructive">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

/**
 * A Role's form: a new one's, or an existing one's to view and edit. An
 * existing Role's says how many Agents saving it reaches, and keeps its
 * Stage while any Agent fills it.
 */
function RoleForm({
  role,
  onSaved,
  onClose,
}: {
  /** The Role to edit; a new Role when absent. */
  role?: LibraryRole;
  onSaved: (role: LibraryRole, said: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: providers } = useQuery(aiProvidersQuery);
  const { data: skills } = useQuery(skillsQuery);
  const [values, setValues] = useState<FormValues>(
    role === undefined ? blank : valuesOf(role),
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const key = role?.id ?? "new";
  const id = (field: string) => `role-${key}-${field}`;
  const set = (changes: Partial<FormValues>) => {
    setValues({ ...values, ...changes });
  };

  const provider = providers?.find(
    (entry) => entry.aiProvider === values.aiProvider,
  );
  const models = provider?.models ?? [];
  // A Model suggested before it left the catalogue stays until changed.
  const unlisted =
    values.model !== "" && !models.some(({ model }) => model === values.model);
  const stageLocked = role !== undefined && role.agents > 0;
  const changes = role === undefined ? undefined : changesOf(role, values);
  const unchanged = changes !== undefined && Object.keys(changes).length === 0;

  const save = async () => {
    setBusy(true);
    const parsed =
      role === undefined
        ? createRoleRequestSchema.safeParse(fieldsOf(values))
        : updateRoleRequestSchema.safeParse(changes);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      setBusy(false);
      return;
    }
    const response =
      role === undefined
        ? await postJson("/api/roles", parsed.data, session?.csrfToken)
        : await sendJson(
            "PATCH",
            roleUrl(role.id),
            parsed.data,
            session?.csrfToken,
          );
    setBusy(false);
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The Role was not saved."],
      );
      return;
    }
    const saved = roleSchema.parse(await response.json());
    setProblems([]);
    await queryClient.invalidateQueries(rolesQuery);
    onSaved(
      saved,
      role === undefined
        ? `Made ${saved.name}. Add an Agent in it from a Floor's admin.`
        : saved.agents === 0
          ? `Saved ${saved.name}. No Agent fills it yet.`
          : `Saved ${saved.name}. ${agentCount(saved.agents)} with it ${saved.agents === 1 ? "uses" : "use"} the change from their next task.`,
    );
  };

  const title = role === undefined ? "New Role" : role.name;
  return (
    <form
      noValidate
      aria-label={role === undefined ? "New Role" : `Edit ${role.name}`}
      className="space-y-4 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="font-medium">{title}</h3>
          {role !== undefined && (
            <p
              id={id("reach")}
              role="status"
              className="text-sm text-muted-foreground"
            >
              {role.agents === 0
                ? "No Agent fills this Role: a change reaches no one yet."
                : `${agentCount(role.agents)} ${role.agents === 1 ? "fills" : "fill"} this Role. A change reaches ${role.agents === 1 ? "it" : "every one"} from ${role.agents === 1 ? "its" : "their"} next task; ${role.agents === 1 ? "its" : "their"} own extra instructions still apply on top.`}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={id("name")} label="Name">
          <Input
            id={id("name")}
            autoComplete="off"
            value={values.name}
            onChange={(event) => {
              set({ name: event.target.value });
            }}
          />
        </Field>
        <Field
          id={id("stage")}
          label="Stage"
          hint={
            stageLocked
              ? `Kept while Agents fill it: their work goes by its Stage. Duplicate the Role to give a copy another Stage.`
              : stageHints[values.stage]
          }
        >
          <select
            id={id("stage")}
            className={selectClass}
            disabled={stageLocked}
            aria-describedby={id("stage-hint")}
            value={values.stage}
            onChange={(event) => {
              set({ stage: event.target.value as Stage });
            }}
          >
            {stages.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabels[stage]}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field
            id={id("description")}
            label="Routing description"
            hint="One line: what the Manager gives this Role, when a Floor has several Roles in its Stage."
          >
            <Input
              id={id("description")}
              autoComplete="off"
              aria-describedby={id("description-hint")}
              value={values.description}
              onChange={(event) => {
                set({ description: event.target.value });
              }}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field
            id={id("instructions")}
            label="Instructions"
            hint="What its Agents are told about their work, in their Stage's prompt. Each Agent's own extra instructions apply on top."
          >
            <textarea
              id={id("instructions")}
              className={textareaClass}
              aria-describedby={id("instructions-hint")}
              value={values.instructions}
              onChange={(event) => {
                set({ instructions: event.target.value });
              }}
            />
          </Field>
        </div>
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">Skills</legend>
          {skills === undefined ? null : skills.length === 0 &&
            values.skills.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The Skill library has no Skills yet: add them on the Admin page.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              {[
                ...skills.map(({ name }) => name),
                ...values.skills.filter(
                  (name) => !skills.some((skill) => skill.name === name),
                ),
              ].map((name) => (
                <li key={name} className="flex items-center gap-2 text-sm">
                  <input
                    id={id(`skill-${name}`)}
                    type="checkbox"
                    className="size-4"
                    checked={values.skills.includes(name)}
                    onChange={(event) => {
                      set({
                        skills: event.target.checked
                          ? [...values.skills, name]
                          : values.skills.filter((skill) => skill !== name),
                      });
                    }}
                  />
                  <label htmlFor={id(`skill-${name}`)} className="font-mono">
                    {name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <Field
          id={id("desk")}
          label="Desk dressing"
          hint="What sits on its Agents' desks in the Office: decoration only."
        >
          <select
            id={id("desk")}
            className={selectClass}
            aria-describedby={id("desk-hint")}
            value={values.deskDressing}
            onChange={(event) => {
              set({ deskDressing: event.target.value as DeskDressing });
            }}
          >
            {deskDressings.map((dressing) => (
              <option key={dressing} value={dressing}>
                {deskDressingLabels[dressing]}
              </option>
            ))}
          </select>
        </Field>
        <div aria-hidden className="hidden sm:block" />
        <Field
          id={id("ai-provider")}
          label="Suggested AI Provider"
          hint="What a new Agent in this Role starts on. Without an AI Account for it, the new Agent gets the office default."
        >
          <select
            id={id("ai-provider")}
            className={selectClass}
            aria-describedby={id("ai-provider-hint")}
            value={values.aiProvider}
            onChange={(event) => {
              // Another AI Provider's Model means nothing here.
              set({ aiProvider: event.target.value, model: "" });
            }}
          >
            <option value="">The office default</option>
            {aiProviders.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id("model")} label="Suggested Model">
          <select
            id={id("model")}
            className={selectClass}
            disabled={values.aiProvider === ""}
            value={values.model}
            onChange={(event) => {
              set({ model: event.target.value });
            }}
          >
            <option value="">
              {provider?.defaultModel == null
                ? "Its AI Provider's default"
                : `Default (${provider.defaultModel})`}
            </option>
            {unlisted && (
              <option value={values.model}>
                {values.model} (not in the catalogue)
              </option>
            )}
            {models.map((model) => (
              <option key={model.model} value={model.model}>
                {optionLabel(model)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Problems problems={problems} />
      <Button
        type="submit"
        pending={busy}
        disabled={unchanged || session?.csrfToken === undefined}
        {...(role === undefined ? {} : { "aria-describedby": id("reach") })}
      >
        {busy
          ? "Saving…"
          : role === undefined
            ? "Make Role"
            : `Save ${role.name}`}
      </Button>
    </form>
  );
}

/** Why a Role cannot be deleted, if it cannot. */
const keptBecause = (role: LibraryRole): string | undefined =>
  role.inStartingTeam
    ? `A Floor Template starts Floors with a ${role.name} Agent, so it stays.`
    : role.agents > 0
      ? `${agentCount(role.agents)} ${role.agents === 1 ? "fills" : "fill"} it: remove ${role.agents === 1 ? "it" : "them"} from ${role.agents === 1 ? "its Floor" : "their Floors"} first.`
      : undefined;

/** One Role's row: its Stage, its Agents and what can be done with it. */
function RoleRow({
  role,
  open,
  onOpen,
  onReport,
}: {
  role: LibraryRole;
  open: boolean;
  onOpen: (roleId: string | undefined) => void;
  onReport: (report: Report) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const kept = keptBecause(role);

  const duplicate = async () => {
    setBusy(true);
    const response = await postJson(
      `${roleUrl(role.id)}/duplicate`,
      {},
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      const error = await readApiError(response);
      onReport({ said: [], problems: [error.message ?? "It was not copied."] });
      return;
    }
    const copy = roleSchema.parse(await response.json());
    await queryClient.invalidateQueries(rolesQuery);
    onReport({
      said: [`Made ${copy.name}, a copy of ${role.name}. Edit it below.`],
      problems: [],
    });
    onOpen(copy.id);
  };

  const remove = async () => {
    setBusy(true);
    const response = await sendDelete(roleUrl(role.id), session?.csrfToken);
    setBusy(false);
    setConfirming(false);
    if (!response.ok) {
      const error = await readApiError(response);
      onReport({
        said: [],
        problems: [error.message ?? `${role.name} was not deleted.`],
      });
      return;
    }
    if (open) {
      onOpen(undefined);
    }
    onReport({ said: [`Deleted ${role.name}.`], problems: [] });
    await queryClient.invalidateQueries(rolesQuery);
  };

  return (
    <tr className="border-b align-top last:border-b-0">
      <th scope="row" className="py-2 pr-4 text-left font-medium">
        {role.name}
      </th>
      <td className="py-2 pr-4">{stageLabels[role.stage]}</td>
      <td className="py-2 pr-4 text-muted-foreground">{role.description}</td>
      <td className="py-2 pr-4 tabular-nums">{role.agents}</td>
      <td className="py-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label={`Open ${role.name}`}
            aria-expanded={open}
            onClick={() => {
              onOpen(open ? undefined : role.id);
            }}
          >
            <Eye aria-hidden />
            Open
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Duplicate ${role.name}`}
            disabled={busy || session?.csrfToken === undefined}
            onClick={() => void duplicate()}
          >
            <Copy aria-hidden />
            Duplicate
          </Button>
          {!confirming && (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Delete ${role.name}`}
              disabled={kept !== undefined || busy}
              aria-describedby={
                kept === undefined ? undefined : `role-${role.id}-kept`
              }
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
        </div>
        {kept !== undefined && (
          <p
            id={`role-${role.id}-kept`}
            className="mt-1 text-xs text-muted-foreground"
          >
            {kept}
          </p>
        )}
        {confirming && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="w-full text-sm font-medium">
              Delete {role.name}? Its Role memory on every Floor goes with it.
            </p>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || session?.csrfToken === undefined}
              onClick={() => void remove()}
            >
              Yes, delete {role.name}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** What the last action did, and what was refused. */
interface Report {
  readonly said: readonly string[];
  readonly problems: readonly string[];
}

/**
 * The Role library page (FR-98): the Roles with their Stage and Agents, a
 * new Role's form, and the open Role's.
 */
export function RoleLibraryPage({
  openRoleId,
  onOpen,
}: {
  /** The Role whose form is open, from the page's address. */
  openRoleId?: string | undefined;
  onOpen: (roleId: string | undefined) => void;
}) {
  const { data: roles, isError } = useQuery(rolesQuery);
  const [making, setMaking] = useState(false);
  const [report, setReport] = useState<Report>({ said: [], problems: [] });
  const open = roles?.find(({ id }) => id === openRoleId);

  return (
    <section className="space-y-6">
      <PageHeader
        title="Role library"
        description={
          <>
            Every Role an Agent can fill, each in one of the four Stages: work,
            review, QA and docs. The Manager is built in, not a library Role.
            Changing a Role changes every Agent with it.
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Roles</h2>
          </CardTitle>
          <CardDescription>
            Make a Role, or duplicate one to start from, then add Agents in it
            from a Floor&apos;s admin. A Role no Agent fills can be deleted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isError && (
            <p role="alert" className="text-sm text-destructive">
              The Role library could not be loaded.
            </p>
          )}
          {roles !== undefined && (
            <TableFrame label="Roles, scrollable">
              <table aria-label="Roles" className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Role
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Stage
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Routing description
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Agents
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((role) => (
                    <RoleRow
                      key={role.id}
                      role={role}
                      open={role.id === openRoleId}
                      onOpen={onOpen}
                      onReport={setReport}
                    />
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
          {report.said.length > 0 && (
            <ul role="status" className="space-y-1 text-sm">
              {report.said.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <Problems problems={report.problems} />
          {open !== undefined && (
            <RoleForm
              // Starts again from the Role whenever it changes elsewhere.
              key={JSON.stringify(open)}
              role={open}
              onSaved={(_, said) => {
                setReport({ said: [said], problems: [] });
              }}
              onClose={() => {
                onOpen(undefined);
              }}
            />
          )}
          {making ? (
            <RoleForm
              onSaved={(role, said) => {
                setMaking(false);
                setReport({ said: [said], problems: [] });
                onOpen(role.id);
              }}
              onClose={() => {
                setMaking(false);
              }}
            />
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setMaking(true);
              }}
            >
              <Plus aria-hidden />
              New Role
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** The Admin page's way to the Role library. */
export function RoleLibraryCard() {
  const { data: roles } = useQuery(rolesQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Role library</h2>
        </CardTitle>
        <CardDescription>
          The Roles Agents fill, each in the work, review, QA or docs Stage:
          their instructions, Skills, desk dressing and suggested AI Provider
          and Model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {roles !== undefined && (
          <p>
            {roles.length === 1 ? "1 Role" : `${String(roles.length)} Roles`}:{" "}
            {roles.map(({ name }) => name).join(", ")}.
          </p>
        )}
        <Link
          to="/general-settings/roles"
          className="font-medium hover:underline"
        >
          Open the Role library
        </Link>
      </CardContent>
    </Card>
  );
}
