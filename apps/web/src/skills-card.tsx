import {
  importSkillRequestSchema,
  skillErrorCodes,
  skillFileName,
  skillFilesInOrder,
  skillListSchema,
  skillProblems,
  skillSchema,
  skillSourceLabels,
  skillTemplate,
  type Skill,
  type SkillFile,
  type SkillSummary,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  FileCheck,
  FilePlus,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";

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
import { LoadingMessage } from "@/components/ui/spinner.tsx";

import {
  getJson,
  postJson,
  readApiError,
  sendDelete,
  sendJson,
} from "./api.ts";
import { sessionQuery } from "./session.ts";

// The office Skill library (PRD FR-71, FR-72, FR-76): Skills in the Agent
// Skills format, added by uploading a folder, by importing from a Git
// repository, or by writing one here. Skills are instructions Agents
// follow, so one that was uploaded or imported starts disabled: the Owner
// reads its full contents here, then enables it.

/** The library, by name (`GET /api/skills`). */
export const skillsQuery = queryOptions({
  queryKey: ["skills"],
  queryFn: async () => (await getJson("/api/skills", skillListSchema)).skills,
});

const skillUrl = (id: string): string =>
  `/api/skills/${encodeURIComponent(id)}`;

/** One Skill with its full contents (`GET /api/skills/:id`). */
const skillQuery = (id: string) =>
  queryOptions({
    queryKey: ["skills", id],
    queryFn: () => getJson(skillUrl(id), skillSchema),
  });

const textareaClass =
  "min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** What the API said was wrong, one line each. */
async function problemsOf(
  response: Response,
  fallback: string,
): Promise<string[]> {
  const error = await readApiError(response);
  return error.problems === undefined
    ? [error.message ?? fallback]
    : error.message === undefined
      ? error.problems
      : [error.message, ...error.problems];
}

function Problems({ problems }: { problems: readonly string[] }) {
  return problems.length === 0 ? null : (
    <div role="alert">
      <ul className="space-y-1 text-sm text-destructive">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
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
  hint?: string;
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

const needsReview = (skill: SkillSummary): boolean => skill.reviewedAt === null;

function Status({ skill }: { skill: SkillSummary }) {
  const [label, tone] = needsReview(skill)
    ? (["Needs review", "warning"] as const)
    : skill.enabled
      ? (["Enabled", "success"] as const)
      : (["Disabled", "neutral"] as const);
  return <Badge tone={tone}>{label}</Badge>;
}

/** Where an imported Skill came from in its repository. */
function Origin({ origin }: { origin: SkillSummary["origin"] }) {
  if (origin === null) {
    return null;
  }
  const { url, ref, commit, path } = origin;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Repository</dt>
      <dd className="font-mono break-all">{url}</dd>
      <dt className="text-muted-foreground">Branch or tag</dt>
      <dd className="font-mono">{ref ?? "the default branch"}</dd>
      <dt className="text-muted-foreground">Commit</dt>
      <dd className="font-mono break-all">{commit}</dd>
      <dt className="text-muted-foreground">Folder</dt>
      <dd className="font-mono">{path === "" ? "the top" : path}</dd>
    </dl>
  );
}

/**
 * A Skill's full contents, every file in full. For a Skill not yet
 * reviewed, the Owner enables it from here, naming the contents read.
 */
function SkillContents({
  id,
  csrfToken,
  onChanged,
  onClose,
}: {
  id: string;
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const skill = useQuery(skillQuery(id));
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (skill.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The Skill could not be loaded.
      </p>
    );
  }
  if (skill.data === undefined) {
    return <LoadingMessage className="text-sm">Loading…</LoadingMessage>;
  }
  const { data } = skill;
  const reviewing = data.reviewedAt === null;

  const review = async () => {
    setBusy(true);
    setProblems([]);
    const response = await postJson(
      `${skillUrl(id)}/review`,
      { digest: data.digest },
      csrfToken,
    );
    if (response.ok) {
      await onChanged();
      onClose();
    } else {
      const error = await readApiError(response);
      setProblems([error.message ?? "The Skill was not enabled."]);
      if (error.error === skillErrorCodes.skillChanged) {
        // Show what it holds now, to be read again.
        await queryClient.invalidateQueries(skillQuery(id));
      }
    }
    setBusy(false);
  };

  return (
    <section
      aria-label={`${reviewing ? "Review" : "Contents of"} ${data.name}`}
      className="w-full space-y-4 rounded-md border p-4"
    >
      {reviewing && (
        <p className="text-sm">
          {data.name} was {data.source === "git" ? "imported" : "uploaded"}, and
          Skills are instructions Agents follow. Read every file below before
          enabling it.
        </p>
      )}
      <Origin origin={data.origin} />
      {data.files.map((file) => (
        <figure key={file.path} className="space-y-1">
          <figcaption className="font-mono text-sm font-medium">
            {file.path}
          </figcaption>
          <pre
            aria-label={file.path}
            className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap"
          >
            {file.content === "" ? "(empty)" : file.content}
          </pre>
        </figure>
      ))}
      <Problems problems={problems} />
      <div className="flex flex-wrap gap-2">
        {reviewing && (
          <Button
            size="sm"
            disabled={busy || csrfToken === undefined}
            onClick={() => void review()}
          >
            <FileCheck aria-hidden />I have read it all: enable {data.name}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}

/**
 * Edits a Skill's files: its `SKILL.md` and any supporting files. Saves a
 * new Skill (written here) or replaces an existing one's files.
 */
function SkillEditor({
  initial,
  submitLabel,
  csrfToken,
  save,
  onSaved,
  onCancel,
}: {
  initial: readonly SkillFile[];
  submitLabel: string;
  csrfToken: string | undefined;
  save: (files: SkillFile[]) => Promise<Response>;
  onSaved: (skill: Skill) => Promise<void>;
  onCancel?: () => void;
}) {
  const [files, setFiles] = useState<SkillFile[]>(() =>
    skillFilesInOrder(initial),
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const change = (index: number, update: Partial<SkillFile>) => {
    setFiles((current) =>
      current.map((file, at) => (at === index ? { ...file, ...update } : file)),
    );
  };

  const submit = async () => {
    const found = skillProblems(files);
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    setBusy(true);
    setProblems([]);
    const response = await save(files);
    if (response.ok) {
      await onSaved(skillSchema.parse(await response.json()));
    } else {
      setProblems(await problemsOf(response, "The Skill was not saved."));
    }
    setBusy(false);
  };

  return (
    <form
      noValidate
      aria-label="Skill editor"
      className="w-full space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {files.map((file, index) => {
        const id = `skill-file-${String(index)}`;
        const isSkillMd = file.path === skillFileName && index === 0;
        return (
          <div key={id} className="space-y-2">
            {isSkillMd ? (
              <Label htmlFor={`${id}-content`}>{skillFileName}</Label>
            ) : (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field id={`${id}-path`} label={`File ${String(index)} path`}>
                    <Input
                      id={`${id}-path`}
                      value={file.path}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        change(index, { path: event.target.value });
                      }}
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${file.path === "" ? `file ${String(index)}` : file.path}`}
                  onClick={() => {
                    setFiles((current) =>
                      current.filter((_, at) => at !== index),
                    );
                  }}
                >
                  <X aria-hidden />
                </Button>
              </div>
            )}
            <textarea
              id={`${id}-content`}
              aria-label={isSkillMd ? undefined : `Contents of ${file.path}`}
              className={textareaClass}
              spellCheck={false}
              value={file.content}
              onChange={(event) => {
                change(index, { content: event.target.value });
              }}
            />
          </div>
        );
      })}
      <Problems problems={problems} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setFiles((current) => [...current, { path: "", content: "" }]);
          }}
        >
          <FilePlus aria-hidden />
          Add a file
        </Button>
        <Button
          pending={busy}
          type="submit"
          size="sm"
          disabled={busy || csrfToken === undefined}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** Loads a Skill's files, then edits them. */
function EditSkill({
  id,
  csrfToken,
  onDone,
}: {
  id: string;
  csrfToken: string | undefined;
  onDone: () => Promise<void>;
}) {
  const skill = useQuery(skillQuery(id));
  if (skill.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The Skill could not be loaded.
      </p>
    );
  }
  if (skill.data === undefined) {
    return <LoadingMessage className="text-sm">Loading…</LoadingMessage>;
  }
  return (
    <SkillEditor
      initial={skill.data.files}
      submitLabel="Save"
      csrfToken={csrfToken}
      save={(files) => sendJson("PATCH", skillUrl(id), { files }, csrfToken)}
      onSaved={onDone}
      onCancel={() => void onDone()}
    />
  );
}

/** One Skill in the library, with its actions. */
function SkillRow({
  skill,
  csrfToken,
  onChanged,
}: {
  skill: SkillSummary;
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"show" | "contents" | "edit" | "delete">(
    "show",
  );
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const changed = async () => {
    await queryClient.invalidateQueries(skillQuery(skill.id));
    await onChanged();
  };

  const act = async (send: () => Promise<Response>, fallback: string) => {
    setBusy(true);
    setProblems([]);
    const response = await send();
    if (response.ok) {
      await changed();
    } else {
      setProblems(await problemsOf(response, fallback));
    }
    setBusy(false);
  };

  const fileCount = `${String(skill.files.length)} ${skill.files.length === 1 ? "file" : "files"}`;

  return (
    <li
      aria-label={skill.name}
      className="flex flex-wrap items-center justify-between gap-2 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5 text-sm">
        <p className="flex items-center gap-2">
          <span className="font-mono font-medium">{skill.name}</span>
          <Status skill={skill} />
        </p>
        <p>{skill.description}</p>
        <p className="text-muted-foreground">
          {skillSourceLabels[skill.source]} · {fileCount}
          {skill.origin !== null && (
            <>
              {" "}
              · <span className="font-mono break-all">{skill.origin.url}</span>
            </>
          )}
        </p>
      </div>
      {mode === "show" && (
        <div className="flex flex-wrap gap-2">
          {needsReview(skill) ? (
            <Button
              size="sm"
              aria-label={`Review ${skill.name}`}
              onClick={() => {
                setMode("contents");
              }}
            >
              <Eye aria-hidden />
              Review
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              aria-label={`View ${skill.name}`}
              onClick={() => {
                setMode("contents");
              }}
            >
              <Eye aria-hidden />
              View
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-label={`Edit ${skill.name}`}
            onClick={() => {
              setMode("edit");
            }}
          >
            <Pencil aria-hidden />
            Edit
          </Button>
          {!needsReview(skill) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || csrfToken === undefined}
              aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
              onClick={() =>
                void act(
                  () =>
                    sendJson(
                      "PATCH",
                      skillUrl(skill.id),
                      { enabled: !skill.enabled },
                      csrfToken,
                    ),
                  skill.enabled
                    ? "The Skill was not disabled."
                    : "The Skill was not enabled.",
                )
              }
            >
              {skill.enabled ? <PowerOff aria-hidden /> : <Power aria-hidden />}
              {skill.enabled ? "Disable" : "Enable"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-label={`Delete ${skill.name}`}
            onClick={() => {
              setMode("delete");
            }}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        </div>
      )}
      {mode === "delete" && (
        <div className="flex w-full flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete {skill.name}? Agents can no longer use it.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() =>
              void act(
                () => sendDelete(skillUrl(skill.id), csrfToken),
                "The Skill was not deleted.",
              )
            }
          >
            Yes, delete {skill.name}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMode("show");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {mode === "contents" && (
        <SkillContents
          id={skill.id}
          csrfToken={csrfToken}
          onChanged={changed}
          onClose={() => {
            setMode("show");
          }}
        />
      )}
      {mode === "edit" && (
        <EditSkill
          id={skill.id}
          csrfToken={csrfToken}
          onDone={async () => {
            await changed();
            setMode("show");
          }}
        />
      )}
      <div className="w-full">
        <Problems problems={problems} />
      </div>
    </li>
  );
}

/** Files a browser should not send: its own and Git's. */
const isClutter = (path: string): boolean =>
  path.split("/").some((part) => part === ".git" || part === ".DS_Store");

interface ChosenFolder {
  readonly folder: string | undefined;
  readonly files: SkillFile[];
  readonly problems: string[];
}

/** Reads the chosen folder's files as text, the folder's own name aside. */
async function readFolder(list: FileList): Promise<ChosenFolder> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chosen = [...list].map((file) => ({
    file,
    path: file.webkitRelativePath === "" ? file.name : file.webkitRelativePath,
  }));
  const tops = new Set(
    chosen.map(({ path }) => (path.includes("/") ? path.split("/")[0] : "")),
  );
  const [top] = tops;
  const folder =
    tops.size === 1 && top !== undefined && top !== "" ? top : undefined;
  const files: SkillFile[] = [];
  const problems: string[] = [];
  for (const { file, path } of chosen) {
    const inFolder =
      folder === undefined ? path : path.slice(folder.length + 1);
    if (isClutter(inFolder)) {
      continue;
    }
    try {
      files.push({
        path: inFolder,
        content: decoder.decode(await file.arrayBuffer()),
      });
    } catch {
      problems.push(`"${inFolder}" is not a text file; Skills hold text only.`);
    }
  }
  return {
    folder,
    files,
    problems: [...problems, ...skillProblems(files, { folder })],
  };
}

/** Uploads a Skill's folder from the Owner's computer. */
function UploadForm({
  csrfToken,
  onAdded,
}: {
  csrfToken: string | undefined;
  onAdded: (skill: Skill) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<ChosenFolder>();
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (chosen === undefined || chosen.problems.length > 0) {
      return;
    }
    setBusy(true);
    setProblems([]);
    const response = await postJson(
      "/api/skills",
      {
        source: "upload",
        files: chosen.files,
        ...(chosen.folder === undefined ? {} : { folder: chosen.folder }),
      },
      csrfToken,
    );
    if (response.ok) {
      setChosen(undefined);
      await onAdded(skillSchema.parse(await response.json()));
    } else {
      setProblems(await problemsOf(response, "The Skill was not uploaded."));
    }
    setBusy(false);
  };

  return (
    <form
      noValidate
      aria-label="Upload a Skill"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void upload();
      }}
    >
      <Field
        id="skill-upload"
        label="Skill folder"
        hint={`The folder holding ${skillFileName} and its supporting files. Text files only.`}
      >
        <Input
          id="skill-upload"
          type="file"
          multiple
          aria-describedby="skill-upload-hint"
          // Lets the Owner pick a folder; not in React's typings.
          ref={(input) => {
            input?.setAttribute("webkitdirectory", "");
          }}
          onChange={(event) => {
            const { files } = event.target;
            setProblems([]);
            if (files === null || files.length === 0) {
              setChosen(undefined);
              return;
            }
            void readFolder(files).then(setChosen);
          }}
        />
      </Field>
      {chosen !== undefined && (
        <p className="text-sm">
          {chosen.folder ?? "The files chosen"}:{" "}
          {chosen.files.map(({ path }) => path).join(", ") || "no files"}
        </p>
      )}
      <Problems problems={[...(chosen?.problems ?? []), ...problems]} />
      <Button
        pending={busy}
        type="submit"
        disabled={
          busy ||
          csrfToken === undefined ||
          chosen === undefined ||
          chosen.problems.length > 0
        }
      >
        {busy ? "Uploading…" : "Upload Skill"}
      </Button>
    </form>
  );
}

interface ImportValues {
  url: string;
  ref: string;
  path: string;
}

/** Imports a Skill from a public Git repository. */
function ImportForm({
  csrfToken,
  onAdded,
}: {
  csrfToken: string | undefined;
  onAdded: (skill: Skill) => Promise<void>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { isSubmitting },
  } = useForm<ImportValues>({ defaultValues: { url: "", ref: "", path: "" } });

  const onSubmit = async (values: ImportValues) => {
    setFolders([]);
    const parsed = importSkillRequestSchema.safeParse({
      url: values.url.trim(),
      ...(values.ref.trim() === "" ? {} : { ref: values.ref }),
      ...(values.path.trim() === "" ? {} : { path: values.path }),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await postJson(
      "/api/skills/import",
      parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      if (error.error === skillErrorCodes.skillPathRequired) {
        setProblems([error.message ?? "Name the Skill's folder."]);
        setFolders(error.problems ?? []);
      } else {
        setProblems(
          error.problems === undefined
            ? [error.message ?? "The Skill was not imported."]
            : [
                ...(error.message === undefined ? [] : [error.message]),
                ...error.problems,
              ],
        );
      }
      return;
    }
    setProblems([]);
    reset();
    await onAdded(skillSchema.parse(await response.json()));
  };

  return (
    <form
      noValidate
      aria-label="Import a Skill from Git"
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <Field
            id="skill-import-url"
            label="Repository URL"
            hint="A public repository, over https://."
          >
            <Input
              id="skill-import-url"
              type="url"
              autoComplete="off"
              placeholder="https://github.com/owner/skills"
              aria-describedby="skill-import-url-hint"
              {...register("url")}
            />
          </Field>
        </div>
        <Field
          id="skill-import-ref"
          label="Branch or tag"
          hint="Optional; the default branch if empty."
        >
          <Input
            id="skill-import-ref"
            autoComplete="off"
            aria-describedby="skill-import-ref-hint"
            {...register("ref")}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field
            id="skill-import-path"
            label="Skill folder in the repository"
            hint="Optional when the repository holds one Skill."
          >
            <Input
              id="skill-import-path"
              autoComplete="off"
              placeholder="skills/pdf-processing"
              aria-describedby="skill-import-path-hint"
              {...register("path")}
            />
          </Field>
        </div>
      </div>
      <Problems problems={problems} />
      {folders.length > 0 && (
        <ul
          aria-label="Skills in the repository"
          className="flex flex-wrap gap-2"
        >
          {folders.map((folder) => (
            <li key={folder}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="font-mono"
                onClick={() => {
                  setValue("path", folder);
                  setFolders([]);
                  setProblems([]);
                }}
              >
                {folder}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={isSubmitting || csrfToken === undefined}
      >
        {isSubmitting ? "Importing…" : "Import Skill"}
      </Button>
    </form>
  );
}

const addModes = [
  ["upload", "Upload a folder"],
  ["git", "Import from Git"],
  ["editor", "Write one"],
] as const;

/**
 * The Skills section of the office admin (PRD FR-72, FR-76): the office
 * Skill library, and the three ways to add to it.
 */
export function SkillsCard() {
  const queryClient = useQueryClient();
  const skills = useQuery(skillsQuery);
  const { data: session } = useQuery(sessionQuery);
  const [mode, setMode] = useState<(typeof addModes)[number][0]>("upload");
  const [added, setAdded] = useState<Skill>();
  // A new editor after each Skill written.
  const [written, setWritten] = useState(0);
  // Each Floor's Skills hold the library's, so they are read again too.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries(skillsQuery),
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "floors" && queryKey[2] === "skills",
      }),
    ]);
  };
  const csrfToken = session?.csrfToken;

  const onAdded = async (skill: Skill) => {
    setAdded(skill);
    await refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Skills</h2>
        </CardTitle>
        <CardDescription>
          The office Skill library: instructions in the Agent Skills format, a{" "}
          {skillFileName} and its supporting files. A Skill that was uploaded or
          imported stays disabled until you have reviewed its full contents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="skills-in-library" className="space-y-2">
          <h3 id="skills-in-library" className="text-sm font-medium">
            Library
          </h3>
          {skills.isError && (
            <p role="alert" className="text-sm text-destructive">
              The Skills could not be loaded.
            </p>
          )}
          {skills.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No Skills yet. Upload one, import one from Git, or write one.
            </p>
          )}
          {skills.data !== undefined && skills.data.length > 0 && (
            <ul aria-label="Skills" className="divide-y">
              {skills.data.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  csrfToken={csrfToken}
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="add-a-skill" className="space-y-3">
          <h3 id="add-a-skill" className="text-sm font-medium">
            Add a Skill
          </h3>
          <div
            role="group"
            aria-label="How to add"
            className="flex flex-wrap gap-2"
          >
            {addModes.map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? "default" : "outline"}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setAdded(undefined);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {mode === "upload" && (
            <UploadForm csrfToken={csrfToken} onAdded={onAdded} />
          )}
          {mode === "git" && (
            <ImportForm csrfToken={csrfToken} onAdded={onAdded} />
          )}
          {mode === "editor" && (
            <SkillEditor
              key={written}
              initial={[{ path: skillFileName, content: skillTemplate }]}
              submitLabel="Add Skill"
              csrfToken={csrfToken}
              save={(files) =>
                postJson("/api/skills", { source: "editor", files }, csrfToken)
              }
              onSaved={async (skill) => {
                setWritten((count) => count + 1);
                await onAdded(skill);
              }}
            />
          )}
          {added !== undefined && (
            <p role="status" className="text-sm">
              {added.enabled
                ? `Added ${added.name}. It is enabled.`
                : `Added ${added.name}. It stays disabled until you review it in the library above.`}
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
