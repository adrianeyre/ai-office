import {
  floorTemplateBundleSchema,
  floorTemplateDetailSchema,
  floorTemplateIcons as iconNames,
  floorTemplateSourceLabels,
  floorThemes,
  importFloorTemplateFromGitRequestSchema,
  mergePolicies,
  mergePolicyLabels,
  saveFloorTemplateRequestSchema,
  updateFloorTemplateRequestSchema,
  type Floor,
  type FloorTemplateDetail,
  type FloorTemplateIcon,
  type FloorTemplateSummary,
  type FloorTheme,
  type MergePolicy,
  type Stage,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Download, Eye, Plus, Trash2, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

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
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { selectClass } from "@/lib/utils.ts";

import {
  getJson,
  postJson,
  readApiError,
  sendDelete,
  sendJson,
} from "./api.ts";
import { floorTemplateIcons, startingTeamText } from "./floors-card.tsx";
import { floorTemplatesQuery } from "./floors.ts";
import { rolesQuery, stageLabels } from "./role-library.tsx";
import { sessionQuery } from "./session.ts";

// The Floor Templates (PRD FR-97, FR-101) in the office admin: the
// built-in ones, read-only, and the Owner's own. The Owner duplicates a
// template and edits the copy (its Roles and their counts, settings, the
// Manager's guidance, labels and 3D theme), exports one with its Roles and
// Skills to a file, and imports one from a file or a Git repository. An
// imported template shows its full contents (every Role's instructions and
// every Skill's files) and where it clashes with the Role and Skill
// libraries, and a Floor can be added from it only once the Owner has
// read them and enabled it. A Floor's own set-up is saved as a template
// from its Floor admin page (`SaveAsTemplateCard`).

const templateUrl = (id: string): string =>
  `/api/floor-templates/${encodeURIComponent(id)}`;

/** A template with its full contents (`GET /api/floor-templates/:id`). */
export const floorTemplateQuery = (id: string) =>
  queryOptions({
    // Under the list's key, so a change to either refreshes both.
    queryKey: [...floorTemplatesQuery.queryKey, id],
    queryFn: () => getJson(templateUrl(id), floorTemplateDetailSchema),
  });

/** Each 3D theme, as people read it. */
const themeLabels: Record<FloorTheme, string> = {
  office: "Office (as every Floor was)",
  stockroom: "Stockroom: stock shelves and parcels",
  studio: "Photo studio",
  editorial: "Bookshelves and a printing press",
  library: "A wall of bookcases",
  atelier: "Colour swatches",
  observatory: "Wall dashboards",
  "data-centre": "Server racks",
  "device-lab": "A wall of phones",
};

/** Each icon, as people read it. */
const iconLabels: Record<FloorTemplateIcon, string> = {
  code: "Code",
  square: "Square",
  "shopping-bag": "Shopping bag",
  megaphone: "Megaphone",
  "pen-line": "Pen",
  "book-open": "Open book",
  palette: "Palette",
  "chart-column": "Chart",
  server: "Server",
  smartphone: "Phone",
};

const textareaClass =
  "min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const preClass =
  "max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs";

/** Whether a template is built in, the Owner's, or waiting for review. */
const kindOf = (template: FloorTemplateSummary): string =>
  template.builtIn
    ? "Built in"
    : template.enabled
      ? "Yours"
      : "Waiting for review";

/** What the last action did, and what was refused. */
interface Report {
  readonly said: readonly string[];
  readonly problems: readonly string[];
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

/** What went wrong with a request, one line each. */
const problemsOf = async (
  response: Response,
  fallback: string,
): Promise<string[]> => {
  const error = await readApiError(response);
  return error.problems ?? [error.message ?? fallback];
};

/**
 * A template's full contents, as the Owner reads them before enabling an
 * imported one: its settings, the Manager's guidance, its labels, every
 * Role with its instructions and every Skill with its files.
 */
function TemplateContents({ template }: { template: FloorTemplateDetail }) {
  const { settings, manager } = template;
  const reviewers = settings.requiredReviewers
    .map(
      (id) =>
        template.roles.find(({ role }) => role.id === id)?.role.name ?? id,
    )
    .join(", ");
  return (
    <div className="space-y-4 text-sm">
      <section aria-label="Settings" className="space-y-1">
        <h4 className="font-medium">Settings</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Setup command</dt>
          <dd className="font-mono">{settings.setupCommand || "None"}</dd>
          <dt className="text-muted-foreground">Check command</dt>
          <dd className="font-mono">{settings.testCommand || "None"}</dd>
          <dt className="text-muted-foreground">Merge Policy</dt>
          <dd>{mergePolicyLabels[settings.mergePolicy]}</dd>
          <dt className="text-muted-foreground">Round Cap</dt>
          <dd>{settings.roundCap}</dd>
          <dt className="text-muted-foreground">Required reviewers</dt>
          <dd>{reviewers === "" ? "None" : reviewers}</dd>
          <dt className="text-muted-foreground">3D theme</dt>
          <dd>{themeLabels[template.theme]}</dd>
        </dl>
      </section>
      <section aria-label="The Manager's guidance" className="space-y-1">
        <h4 className="font-medium">The Manager&apos;s planning guidance</h4>
        {manager.planningGuidance === "" ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <pre className={preClass}>{manager.planningGuidance}</pre>
        )}
        {manager.firstIssue !== null && (
          <>
            <h5 className="font-medium">
              Suggested first issue: {manager.firstIssue.title}
            </h5>
            {manager.firstIssue.body !== "" && (
              <pre className={preClass}>{manager.firstIssue.body}</pre>
            )}
          </>
        )}
      </section>
      <section aria-label="Labels" className="space-y-1">
        <h4 className="font-medium">Labels</h4>
        {template.labels.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-1">
            {template.labels.map((label) => (
              <li key={label.name}>
                <span className="font-mono">{label.name}</span> (#
                {label.color})
                {label.description === "" ? "" : `: ${label.description}`}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Roles" className="space-y-2">
        <h4 className="font-medium">Roles</h4>
        {template.roles.length === 0 && (
          <p className="text-muted-foreground">None: a Manager only.</p>
        )}
        {template.roles.map(({ role, count }) => (
          <article
            key={role.id}
            aria-label={`Role ${role.name}`}
            className="space-y-1 rounded-md border p-3"
          >
            <h5 className="font-medium">
              {role.name}{" "}
              <span className="font-normal text-muted-foreground">
                ({role.id}), {stageLabels[role.stage]} Stage,{" "}
                {count === 1 ? "1 Agent" : `${String(count)} Agents`}
              </span>
            </h5>
            <p className="text-muted-foreground">{role.description}</p>
            <p className="text-muted-foreground">
              Suggested: {role.aiProvider ?? "the office default"}
              {role.model === null ? "" : `, ${role.model}`}. Skills:{" "}
              {role.skills.length === 0 ? "none" : role.skills.join(", ")}.
            </p>
            <pre
              aria-label={`${role.name}'s instructions`}
              className={preClass}
            >
              {role.instructions === ""
                ? "(No instructions.)"
                : role.instructions}
            </pre>
          </article>
        ))}
      </section>
      <section aria-label="Skills" className="space-y-2">
        <h4 className="font-medium">Skills</h4>
        {template.skills.length === 0 && (
          <p className="text-muted-foreground">None.</p>
        )}
        {template.skills.map((skill) => (
          <article
            key={skill.name}
            aria-label={`Skill ${skill.name}`}
            className="space-y-1 rounded-md border p-3"
          >
            <h5 className="font-mono font-medium">{skill.name}</h5>
            <p className="text-muted-foreground">{skill.description}</p>
            {skill.files.map((file) => (
              <div key={file.path} className="space-y-1">
                <p className="font-mono text-xs">{file.path}</p>
                <pre className={preClass}>{file.content}</pre>
              </div>
            ))}
          </article>
        ))}
      </section>
    </div>
  );
}

/** Where a template's Roles and Skills meet the libraries'. */
function Clashes({ clashes }: { clashes: readonly string[] }) {
  return clashes.length === 0 ? null : (
    <div role="note" className="space-y-1 rounded-md border p-3 text-sm">
      <p className="font-medium">Clashes with the libraries</p>
      <ul className="list-disc space-y-1 pl-5">
        {clashes.map((clash) => (
          <li key={clash}>{clash}</li>
        ))}
      </ul>
    </div>
  );
}

/** A template's parts as the editor holds them: text until saved. */
interface FormValues {
  readonly name: string;
  readonly description: string;
  readonly icon: FloorTemplateIcon;
  readonly theme: FloorTheme;
  readonly roles: readonly { readonly role: string; readonly count: string }[];
  readonly setupCommand: string;
  readonly testCommand: string;
  readonly mergePolicy: MergePolicy;
  readonly roundCap: string;
  readonly requiredReviewers: readonly string[];
  readonly planningGuidance: string;
  readonly suggestFirstIssue: boolean;
  readonly firstIssueTitle: string;
  readonly firstIssueBody: string;
  readonly labels: readonly {
    readonly name: string;
    readonly color: string;
    readonly description: string;
  }[];
}

const valuesOf = (template: FloorTemplateDetail): FormValues => ({
  name: template.name,
  description: template.description,
  icon: template.icon,
  theme: template.theme,
  roles: template.roles.map(({ role, count }) => ({
    role: role.id,
    count: String(count),
  })),
  setupCommand: template.settings.setupCommand,
  testCommand: template.settings.testCommand,
  mergePolicy: template.settings.mergePolicy,
  roundCap: String(template.settings.roundCap),
  requiredReviewers: template.settings.requiredReviewers,
  planningGuidance: template.manager.planningGuidance,
  suggestFirstIssue: template.manager.firstIssue !== null,
  firstIssueTitle: template.manager.firstIssue?.title ?? "",
  firstIssueBody: template.manager.firstIssue?.body ?? "",
  labels: template.labels,
});

/** The editor's values as a template's parts. */
const partsOf = (values: FormValues) => ({
  name: values.name,
  description: values.description,
  icon: values.icon,
  theme: values.theme,
  roles: values.roles.map(({ role, count }) => ({
    role,
    count: Number(count),
  })),
  settings: {
    setupCommand: values.setupCommand,
    testCommand: values.testCommand,
    mergePolicy: values.mergePolicy,
    roundCap: Number(values.roundCap),
    requiredReviewers: [...values.requiredReviewers],
  },
  manager: {
    planningGuidance: values.planningGuidance,
    firstIssue: values.suggestFirstIssue
      ? { title: values.firstIssueTitle, body: values.firstIssueBody }
      : null,
  },
  labels: values.labels.map((label) => ({ ...label })),
});

/** Only the parts that differ from the template's. */
function changesOf(template: FloorTemplateDetail, values: FormValues) {
  const next = partsOf(values);
  const current = partsOf(valuesOf(template));
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(current[key as keyof typeof current]),
    ),
  );
}

/**
 * The editor of one of the Owner's templates: its name, description,
 * icon and theme; its Roles and their counts; its settings; the Manager's
 * guidance and first issue; and its labels. Its Roles are chosen from the
 * Role library (or are ones it already holds), each copied in as the
 * library has it when it is saved.
 */
function TemplateForm({
  template,
  onSaved,
}: {
  template: FloorTemplateDetail;
  onSaved: (said: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: library } = useQuery(rolesQuery);
  const [values, setValues] = useState<FormValues>(valuesOf(template));
  const [adding, setAdding] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const id = (field: string) => `template-${template.id}-${field}`;
  const set = (changes: Partial<FormValues>) => {
    setValues({ ...values, ...changes });
  };

  /** Each Role the template can hold: the library's, then its own. */
  const choices: { id: string; name: string; stage: Stage }[] = [
    ...(library ?? []).map(({ id: roleId, name, stage }) => ({
      id: roleId,
      name,
      stage,
    })),
    ...template.roles
      .map(({ role }) => role)
      .filter(({ id: roleId }) => !library?.some((role) => role.id === roleId))
      .map(({ id: roleId, name, stage }) => ({ id: roleId, name, stage })),
  ];
  const roleNamed = (roleId: string) =>
    choices.find((choice) => choice.id === roleId);
  const reviewerChoices = values.roles.filter(
    ({ role, count }) =>
      roleNamed(role)?.stage === "review" && Number(count) > 0,
  );
  const changes = changesOf(template, values);
  const unchanged = Object.keys(changes).length === 0;

  const save = async () => {
    const parsed = updateFloorTemplateRequestSchema.safeParse(changes);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setBusy(true);
    const response = await sendJson(
      "PATCH",
      templateUrl(template.id),
      parsed.data,
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, "The template was not saved."));
      return;
    }
    const saved = floorTemplateDetailSchema.parse(await response.json());
    setProblems([]);
    await queryClient.invalidateQueries(floorTemplatesQuery);
    onSaved(
      `Saved ${saved.name}. A Floor added from it now starts with ${startingTeamText(saved.team)}.`,
    );
  };

  return (
    <form
      noValidate
      aria-label={`Edit ${template.name}`}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
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
        <Field id={id("description")} label="Description">
          <Input
            id={id("description")}
            autoComplete="off"
            value={values.description}
            onChange={(event) => {
              set({ description: event.target.value });
            }}
          />
        </Field>
        <Field id={id("icon")} label="Icon">
          <select
            id={id("icon")}
            className={selectClass}
            value={values.icon}
            onChange={(event) => {
              set({ icon: event.target.value as FloorTemplateIcon });
            }}
          >
            {iconNames.map((icon) => (
              <option key={icon} value={icon}>
                {iconLabels[icon]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id={id("theme")}
          label="3D theme"
          hint="How its Floors are dressed in the Office: decoration only."
        >
          <select
            id={id("theme")}
            className={selectClass}
            aria-describedby={id("theme-hint")}
            value={values.theme}
            onChange={(event) => {
              set({ theme: event.target.value as FloorTheme });
            }}
          >
            {floorThemes.map((theme) => (
              <option key={theme} value={theme}>
                {themeLabels[theme]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Roles and counts</legend>
        <p className="text-xs text-muted-foreground">
          Besides the Manager, which every Floor has one of. A count of 0 brings
          the Role into the library without an Agent. Each Role is copied in as
          the Role library has it when you save.
        </p>
        <ul className="space-y-2">
          {values.roles.map(({ role, count }, index) => {
            const choice = roleNamed(role);
            const label = choice?.name ?? role;
            return (
              <li key={role} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40 text-sm">
                  {label}{" "}
                  <span className="text-muted-foreground">
                    ({choice === undefined ? "?" : stageLabels[choice.stage]})
                  </span>
                </span>
                <Label htmlFor={id(`count-${role}`)} className="sr-only">
                  {label} count
                </Label>
                <Input
                  id={id(`count-${role}`)}
                  type="number"
                  min={0}
                  max={10}
                  className="w-20"
                  value={count}
                  onChange={(event) => {
                    set({
                      roles: values.roles.map((entry, at) =>
                        at === index
                          ? { ...entry, count: event.target.value }
                          : entry,
                      ),
                    });
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    set({
                      roles: values.roles.filter((_, at) => at !== index),
                      requiredReviewers: values.requiredReviewers.filter(
                        (reviewer) => reviewer !== role,
                      ),
                    });
                  }}
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <Field id={id("add-role")} label="Add a Role">
            <select
              id={id("add-role")}
              className={selectClass}
              value={adding}
              onChange={(event) => {
                setAdding(event.target.value);
              }}
            >
              <option value="">Choose a Role…</option>
              {choices
                .filter(
                  (choice) =>
                    !values.roles.some(({ role }) => role === choice.id),
                )
                .map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name} ({stageLabels[choice.stage]})
                  </option>
                ))}
            </select>
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={adding === ""}
            onClick={() => {
              set({ roles: [...values.roles, { role: adding, count: "1" }] });
              setAdding("");
            }}
          >
            <Plus aria-hidden />
            Add
          </Button>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="text-sm font-medium">Settings</legend>
        <Field id={id("setup")} label="Setup command">
          <Input
            id={id("setup")}
            autoComplete="off"
            className="font-mono"
            value={values.setupCommand}
            onChange={(event) => {
              set({ setupCommand: event.target.value });
            }}
          />
        </Field>
        <Field id={id("test")} label="Check command">
          <Input
            id={id("test")}
            autoComplete="off"
            className="font-mono"
            value={values.testCommand}
            onChange={(event) => {
              set({ testCommand: event.target.value });
            }}
          />
        </Field>
        <Field id={id("merge")} label="Merge Policy">
          <select
            id={id("merge")}
            className={selectClass}
            value={values.mergePolicy}
            onChange={(event) => {
              set({ mergePolicy: event.target.value as MergePolicy });
            }}
          >
            {mergePolicies.map((policy) => (
              <option key={policy} value={policy}>
                {mergePolicyLabels[policy]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id("round-cap")} label="Round Cap">
          <Input
            id={id("round-cap")}
            type="number"
            min={1}
            value={values.roundCap}
            onChange={(event) => {
              set({ roundCap: event.target.value });
            }}
          />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <p className="text-sm font-medium">Required reviewers</p>
          {reviewerChoices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              It starts no Agent in a review Stage Role.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              {reviewerChoices.map(({ role }) => (
                <li key={role} className="flex items-center gap-2 text-sm">
                  <input
                    id={id(`reviewer-${role}`)}
                    type="checkbox"
                    className="size-4"
                    checked={values.requiredReviewers.includes(role)}
                    onChange={(event) => {
                      set({
                        requiredReviewers: event.target.checked
                          ? [...values.requiredReviewers, role]
                          : values.requiredReviewers.filter(
                              (reviewer) => reviewer !== role,
                            ),
                      });
                    }}
                  />
                  <label htmlFor={id(`reviewer-${role}`)}>
                    {roleNamed(role)?.name ?? role}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">The Manager</legend>
        <Field
          id={id("guidance")}
          label="Planning guidance"
          hint="How the Manager plans this kind of work. A new Floor's Manager starts with it as its own instructions."
        >
          <textarea
            id={id("guidance")}
            className={textareaClass}
            aria-describedby={id("guidance-hint")}
            value={values.planningGuidance}
            onChange={(event) => {
              set({ planningGuidance: event.target.value });
            }}
          />
        </Field>
        <div className="flex items-center gap-2 text-sm">
          <input
            id={id("first-issue")}
            type="checkbox"
            className="size-4"
            checked={values.suggestFirstIssue}
            onChange={(event) => {
              set({ suggestFirstIssue: event.target.checked });
            }}
          />
          <label htmlFor={id("first-issue")}>
            Suggest a first set-up issue
          </label>
        </div>
        {values.suggestFirstIssue && (
          <div className="grid gap-4">
            <Field id={id("first-issue-title")} label="First issue's title">
              <Input
                id={id("first-issue-title")}
                autoComplete="off"
                value={values.firstIssueTitle}
                onChange={(event) => {
                  set({ firstIssueTitle: event.target.value });
                }}
              />
            </Field>
            <Field id={id("first-issue-body")} label="First issue's body">
              <textarea
                id={id("first-issue-body")}
                className={textareaClass}
                value={values.firstIssueBody}
                onChange={(event) => {
                  set({ firstIssueBody: event.target.value });
                }}
              />
            </Field>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Labels</legend>
        <p className="text-xs text-muted-foreground">
          Made on a new Floor&apos;s repository, besides AI Office&apos;s own.
        </p>
        <ul className="space-y-2">
          {values.labels.map((label, index) => {
            const change = (part: Partial<typeof label>) => {
              set({
                labels: values.labels.map((entry, at) =>
                  at === index ? { ...entry, ...part } : entry,
                ),
              });
            };
            return (
              <li key={index} className="flex flex-wrap items-end gap-2">
                <Field id={id(`label-${String(index)}-name`)} label="Label">
                  <Input
                    id={id(`label-${String(index)}-name`)}
                    autoComplete="off"
                    value={label.name}
                    onChange={(event) => {
                      change({ name: event.target.value });
                    }}
                  />
                </Field>
                <Field
                  id={id(`label-${String(index)}-color`)}
                  label="Colour (hex)"
                >
                  <Input
                    id={id(`label-${String(index)}-color`)}
                    autoComplete="off"
                    className="w-28 font-mono"
                    value={label.color}
                    onChange={(event) => {
                      change({ color: event.target.value });
                    }}
                  />
                </Field>
                <Field
                  id={id(`label-${String(index)}-description`)}
                  label="Description"
                >
                  <Input
                    id={id(`label-${String(index)}-description`)}
                    autoComplete="off"
                    value={label.description}
                    onChange={(event) => {
                      change({ description: event.target.value });
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove the label ${label.name}`}
                  onClick={() => {
                    set({
                      labels: values.labels.filter((_, at) => at !== index),
                    });
                  }}
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            set({
              labels: [
                ...values.labels,
                { name: "", color: "cccccc", description: "" },
              ],
            });
          }}
        >
          <Plus aria-hidden />
          Add a label
        </Button>
      </fieldset>

      <Problems problems={problems} />
      <Button
        pending={busy}
        type="submit"
        disabled={busy || unchanged || session?.csrfToken === undefined}
      >
        {busy ? "Saving…" : `Save ${template.name}`}
      </Button>
    </form>
  );
}

/**
 * An imported template's review: where it came from, its clashes and its
 * full contents. Enabling it names the digest of what was read, so it
 * covers exactly that.
 */
function ReviewSection({
  template,
  onReviewed,
}: {
  template: FloorTemplateDetail;
  onReviewed: (said: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const review = async () => {
    setBusy(true);
    const response = await postJson(
      `${templateUrl(template.id)}/review`,
      { digest: template.digest },
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, "It was not enabled."));
      await queryClient.invalidateQueries(floorTemplatesQuery);
      return;
    }
    setProblems([]);
    await queryClient.invalidateQueries(floorTemplatesQuery);
    onReviewed(`Enabled ${template.name}: a Floor can now be added from it.`);
  };
  return (
    <section aria-label={`Review ${template.name}`} className="space-y-3">
      <p role="note" className="rounded-md border p-3 text-sm">
        {floorTemplateSourceLabels[template.source]}
        {template.origin === null
          ? ""
          : ` (${template.origin.url}${template.origin.path === "" ? "" : `, ${template.origin.path}`}, at ${template.origin.commit.slice(0, 12)})`}
        . Its Roles&apos; instructions and its Skills reach models, so read
        every one below before enabling it. No Floor can be added from it until
        you do.
      </p>
      <Clashes clashes={template.clashes} />
      <TemplateContents template={template} />
      <Problems problems={problems} />
      <Button
        pending={busy}
        disabled={busy || session?.csrfToken === undefined}
        onClick={() => void review()}
      >
        {busy ? "Enabling…" : `I have read it: enable ${template.name}`}
      </Button>
    </section>
  );
}

/** The open template: its contents, and its editor or review if it is the Owner's. */
function TemplatePanel({
  templateId,
  onClose,
  onReport,
}: {
  templateId: string;
  onClose: () => void;
  onReport: (report: Report) => void;
}) {
  const { data: template, isError } = useQuery(floorTemplateQuery(templateId));
  const said = (line: string) => {
    onReport({ said: [line], problems: [] });
  };
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The Floor Template could not be loaded.
      </p>
    );
  }
  if (template === undefined) {
    return <LoadingMessage className="text-sm">Loading…</LoadingMessage>;
  }
  return (
    <section
      aria-label={template.name}
      className="space-y-4 rounded-md border p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="font-medium">{template.name}</h3>
          <p className="text-sm text-muted-foreground">
            {template.description}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Close ${template.name}`}
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </div>
      {template.builtIn ? (
        <>
          <p role="note" className="text-sm">
            A built-in template is read-only: duplicate it to change the copy.
          </p>
          <TemplateContents template={template} />
        </>
      ) : !template.enabled ? (
        <ReviewSection
          // Starts again whenever its contents change.
          key={template.digest}
          template={template}
          onReviewed={said}
        />
      ) : (
        <>
          <Clashes clashes={template.clashes} />
          <TemplateForm
            key={template.digest}
            template={template}
            onSaved={said}
          />
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm font-medium">
              Its full contents: every Role&apos;s instructions and every Skill
            </summary>
            <TemplateContents template={template} />
          </details>
        </>
      )}
    </section>
  );
}

/** One template's row: what it is, its team and what can be done with it. */
function TemplateRow({
  template,
  open,
  onOpen,
  onReport,
}: {
  template: FloorTemplateSummary;
  open: boolean;
  onOpen: (templateId: string | undefined) => void;
  onReport: (report: Report) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const Icon = floorTemplateIcons[template.icon];

  const duplicate = async () => {
    setBusy(true);
    const response = await postJson(
      `${templateUrl(template.id)}/duplicate`,
      {},
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      onReport({
        said: [],
        problems: await problemsOf(response, "It was not copied."),
      });
      return;
    }
    const copy = floorTemplateDetailSchema.parse(await response.json());
    await queryClient.invalidateQueries(floorTemplatesQuery);
    onReport({
      said: [`Made ${copy.name}, a copy of ${template.name}. Edit it below.`],
      problems: [],
    });
    onOpen(copy.id);
  };

  const remove = async () => {
    setBusy(true);
    const response = await sendDelete(
      templateUrl(template.id),
      session?.csrfToken,
    );
    setBusy(false);
    setConfirming(false);
    if (!response.ok) {
      onReport({
        said: [],
        problems: await problemsOf(
          response,
          `${template.name} was not deleted.`,
        ),
      });
      return;
    }
    if (open) {
      onOpen(undefined);
    }
    onReport({
      said: [
        `Deleted ${template.name}. Floors added from it keep everything it set up.`,
      ],
      problems: [],
    });
    await queryClient.invalidateQueries(floorTemplatesQuery);
  };

  return (
    <tr className="border-b align-top last:border-b-0">
      <th scope="row" className="py-2 pr-4 text-left font-medium">
        <span className="flex items-center gap-2">
          <Icon aria-hidden className="size-4 shrink-0" />
          {template.name}
        </span>
      </th>
      <td className="py-2 pr-4">{kindOf(template)}</td>
      <td className="py-2 pr-4 text-muted-foreground">
        {startingTeamText(template.team)}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label={`${template.enabled ? "Open" : "Review"} ${template.name}`}
            aria-expanded={open}
            onClick={() => {
              onOpen(open ? undefined : template.id);
            }}
          >
            <Eye aria-hidden />
            {template.enabled ? "Open" : "Review"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Duplicate ${template.name}`}
            disabled={busy || session?.csrfToken === undefined}
            onClick={() => void duplicate()}
          >
            <Copy aria-hidden />
            Duplicate
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a
              href={`${templateUrl(template.id)}/export`}
              download={`${template.id}.floor-template.json`}
              aria-label={`Export ${template.name}`}
            >
              <Download aria-hidden />
              Export
            </a>
          </Button>
          {!template.builtIn && !confirming && (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Delete ${template.name}`}
              disabled={busy}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
        </div>
        {confirming && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="w-full text-sm font-medium">
              Delete {template.name}? Floors added from it keep everything it
              set up.
            </p>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || session?.csrfToken === undefined}
              onClick={() => void remove()}
            >
              Yes, delete {template.name}
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

/**
 * Importing a template: from a file exported by AI Office, or a folder in
 * a public Git repository. It arrives waiting for review, which opens.
 */
function ImportCard({
  onImported,
}: {
  onImported: (template: FloorTemplateDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const formId = useId();
  const [file, setFile] = useState<File>();
  const [fileName, setFileName] = useState("");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [gitName, setGitName] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const finish = async (response: Response) => {
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, "It was not imported."));
      return;
    }
    const imported = floorTemplateDetailSchema.parse(await response.json());
    setProblems([]);
    await queryClient.invalidateQueries(floorTemplatesQuery);
    onImported(imported);
  };

  const importFile = async () => {
    if (file === undefined) {
      return;
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      setProblems([`${file.name} is not JSON.`]);
      return;
    }
    const parsed = floorTemplateBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setBusy(true);
    await finish(
      await postJson(
        "/api/floor-templates/import",
        {
          bundle: parsed.data,
          ...(fileName.trim() === "" ? {} : { name: fileName.trim() }),
        },
        session?.csrfToken,
      ),
    );
  };

  const importGit = async () => {
    const parsed = importFloorTemplateFromGitRequestSchema.safeParse({
      url: url.trim(),
      ...(ref.trim() === "" ? {} : { ref: ref.trim() }),
      ...(path.trim() === "" ? {} : { path: path.trim() }),
      ...(gitName.trim() === "" ? {} : { name: gitName.trim() }),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setBusy(true);
    await finish(
      await postJson(
        "/api/floor-templates/import/git",
        parsed.data,
        session?.csrfToken,
      ),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Import a Floor Template</h2>
        </CardTitle>
        <CardDescription>
          From a file another AI Office exported, or a template&apos;s folder in
          a public Git repository (its template.yaml, roles/ and skills/). It
          arrives disabled: read its full contents, then enable it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          aria-label="Import from a file"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void importFile();
          }}
        >
          <Field id={`${formId}-file`} label="Exported template file">
            <Input
              id={`${formId}-file`}
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                setFile(event.target.files?.[0]);
              }}
            />
          </Field>
          <Field
            id={`${formId}-file-name`}
            label="Name (optional)"
            hint="Import it under another name, when another template has its own."
          >
            <Input
              id={`${formId}-file-name`}
              autoComplete="off"
              aria-describedby={`${formId}-file-name-hint`}
              value={fileName}
              onChange={(event) => {
                setFileName(event.target.value);
              }}
            />
          </Field>
          <div>
            <Button
              type="submit"
              disabled={
                busy || file === undefined || session?.csrfToken === undefined
              }
            >
              Import the file
            </Button>
          </div>
        </form>
        <form
          aria-label="Import from Git"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void importGit();
          }}
        >
          <Field id={`${formId}-url`} label="Repository URL">
            <Input
              id={`${formId}-url`}
              autoComplete="off"
              placeholder="https://github.com/owner/templates.git"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
            />
          </Field>
          <Field id={`${formId}-ref`} label="Branch or tag (optional)">
            <Input
              id={`${formId}-ref`}
              autoComplete="off"
              value={ref}
              onChange={(event) => {
                setRef(event.target.value);
              }}
            />
          </Field>
          <Field
            id={`${formId}-path`}
            label="Folder (optional)"
            hint="Where its template.yaml is, when the repository holds several."
          >
            <Input
              id={`${formId}-path`}
              autoComplete="off"
              aria-describedby={`${formId}-path-hint`}
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
              }}
            />
          </Field>
          <Field id={`${formId}-git-name`} label="Name (optional)">
            <Input
              id={`${formId}-git-name`}
              autoComplete="off"
              value={gitName}
              onChange={(event) => {
                setGitName(event.target.value);
              }}
            />
          </Field>
          <div>
            <Button
              pending={busy}
              type="submit"
              disabled={
                busy || url.trim() === "" || session?.csrfToken === undefined
              }
            >
              {busy ? "Importing…" : "Import from Git"}
            </Button>
          </div>
        </form>
        <Problems problems={problems} />
      </CardContent>
    </Card>
  );
}

/**
 * The Floor Templates page (FR-101): every template with its kind and
 * starting team, the open one's contents and editor or review, and
 * importing one.
 */
export function FloorTemplatesPage({
  openTemplateId,
  onOpen,
}: {
  /** The template that is open, from the page's address. */
  openTemplateId?: string | undefined;
  onOpen: (templateId: string | undefined) => void;
}) {
  const { data, isError } = useQuery(floorTemplatesQuery);
  const [report, setReport] = useState<Report>({ said: [], problems: [] });
  const open = data?.templates.find(({ id }) => id === openTemplateId);

  return (
    <section className="space-y-6">
      <PageHeader
        title="Floor Templates"
        description={
          <>
            What a new Floor starts with: its team, settings, the Manager&apos;s
            guidance, labels and 3D theme. The built-in templates are read-only;
            duplicate one to make your own, or save a Floor&apos;s set-up from
            its admin page.
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Templates</h2>
          </CardTitle>
          <CardDescription>
            Each one&apos;s export holds its Roles and Skills. Every add, change
            and removal is in the Activity Feed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isError && (
            <p role="alert" className="text-sm text-destructive">
              The Floor Templates could not be loaded.
            </p>
          )}
          {data !== undefined && (
            <TableFrame label="Floor Templates, scrollable">
              <table aria-label="Floor Templates" className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Template
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Kind
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Starting team
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.templates.map((template) => (
                    <TemplateRow
                      key={template.id}
                      template={template}
                      open={template.id === openTemplateId}
                      onOpen={onOpen}
                      onReport={setReport}
                    />
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
          {report.said.length > 0 && (
            <div role="status">
              <ul className="space-y-1 text-sm">
                {report.said.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <Problems problems={report.problems} />
          {open !== undefined && (
            <TemplatePanel
              key={open.id}
              templateId={open.id}
              onClose={() => {
                onOpen(undefined);
              }}
              onReport={setReport}
            />
          )}
        </CardContent>
      </Card>
      <ImportCard
        onImported={(template) => {
          setReport({
            said: [
              `Imported ${template.name}. It is disabled until you have read it below and enabled it.`,
            ],
            problems: [],
          });
          onOpen(template.id);
        }}
      />
    </section>
  );
}

/** The Admin page's way to the Floor Templates. */
export function FloorTemplatesCard() {
  const { data } = useQuery(floorTemplatesQuery);
  const yours = data?.templates.filter(({ builtIn }) => !builtIn) ?? [];
  const waiting = yours.filter(({ enabled }) => !enabled);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Floor Templates</h2>
        </CardTitle>
        <CardDescription>
          The set-ups a new Floor starts from: duplicate and edit one, export or
          import one, and review imported ones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {data !== undefined && (
          <p>
            {String(data.templates.length - yours.length)} built in,{" "}
            {String(yours.length)} of your own
            {waiting.length === 0
              ? "."
              : `, ${String(waiting.length)} waiting for review.`}
          </p>
        )}
        <Link
          to="/general-settings/templates"
          className="font-medium hover:underline"
        >
          Open the Floor Templates
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * Saving a Floor's set-up as a new template (FR-101): its team (each
 * Role and how many Agents fill it), its settings, its Manager's
 * instructions as the planning guidance, and its theme.
 */
export function SaveAsTemplateCard({ floor }: { floor: Floor }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<FloorTemplateDetail>();
  const [busy, setBusy] = useState(false);
  const id = (field: string) => `save-template-${floor.id}-${field}`;

  const save = async () => {
    const parsed = saveFloorTemplateRequestSchema.safeParse({
      floorId: floor.id,
      name,
      description,
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    setBusy(true);
    const response = await postJson(
      "/api/floor-templates",
      parsed.data,
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, "It was not saved."));
      return;
    }
    setSaved(floorTemplateDetailSchema.parse(await response.json()));
    setProblems([]);
    setName("");
    setDescription("");
    await queryClient.invalidateQueries(floorTemplatesQuery);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Save as a Floor Template</h2>
        </CardTitle>
        <CardDescription>
          A new template with this Floor&apos;s team (each Role and how many
          Agents fill it), its settings, its Manager&apos;s instructions and its
          3D theme, for new Floors to start from.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="Save as a Floor Template"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field id={id("name")} label="Template name">
            <Input
              id={id("name")}
              autoComplete="off"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Field id={id("description")} label="Template description">
            <Input
              id={id("description")}
              autoComplete="off"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
          <div className="space-y-2 sm:col-span-2">
            <Problems problems={problems} />
            {saved !== undefined && (
              <p role="status" className="text-sm">
                Saved {saved.name}: {startingTeamText(saved.team)}.{" "}
                <Link
                  to="/general-settings/templates"
                  search={{ template: saved.id }}
                  className="font-medium hover:underline"
                >
                  Open {saved.name}
                </Link>
              </p>
            )}
            <Button
              pending={busy}
              type="submit"
              disabled={busy || session?.csrfToken === undefined}
            >
              {busy ? "Saving…" : "Save as a template"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
