import {
  defaultMostAgents,
  maxFloorNameLength,
  maxMostAgents,
  floorSchema,
  floorSettingsUpdateSchema,
  mergePolicies,
  mergePolicyLabels,
  type Floor,
  type FloorSettingsUpdate,
  type MergePolicy,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ClipboardList, MessageSquare } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";

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
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { selectClass } from "@/lib/utils.ts";

import { postJson, readApiError, sendJson } from "./api.ts";
import { FloorSkillsCard } from "./floor-skills-card.tsx";
import { SaveAsTemplateCard } from "./floor-templates-page.tsx";
import {
  agentsQuery,
  floorQuery,
  floorsQuery,
  installedRepositoriesQuery,
} from "./floors.ts";
import {
  hourlyStatusUpdatesHint,
  hourlyStatusUpdatesLabel,
} from "./hourly-status-setting.tsx";
import { sessionQuery } from "./session.ts";
import { floorTokenUsageQuery } from "./token-caps.tsx";

// The Floor admin (PRD FR-66): the Floor's settings (FR-7), required
// reviewers included; its team size per Role (FR-10); its Agents, with
// their status, current issue and tokens against caps, each editable and
// removable, and new ones added (FR-12, FR-13); its Skills, its token usage
// and caps; and archiving it (FR-9), with a link to the Manager chat
// (FR-24).

/** The settings form's fields, as typed: numbers are text until saved. */
interface FormValues {
  name: string;
  defaultBranch: string;
  setupCommand: string;
  testCommand: string;
  mergePolicy: MergePolicy;
  roundCap: string;
  freshStartThreshold: string;
  dailyTokenCap: string;
  monthlyTokenCap: string;
  concurrencyLimit: string;
  priority: string;
  planApproval: boolean;
  /** "Most Agents" (FR-10): its number, unless there is no limit. */
  mostAgents: string;
  mostAgentsUnlimited: boolean;
  /** Whether the Manager spins work off from its chat (FR-24, ADR 0004). */
  spinOffFromChat: boolean;
  /** Whether it gives a Status update each hour while its Agents work. */
  hourlyStatusUpdates: boolean;
  requiredReviewerAgentIds: string[];
  gitName: string;
  gitEmail: string;
}

const text = (value: number | null): string =>
  value === null ? "" : String(value);

const formValues = (floor: Floor): FormValues => ({
  name: floor.name,
  defaultBranch: floor.defaultBranch,
  setupCommand: floor.setupCommand,
  testCommand: floor.testCommand,
  mergePolicy: floor.mergePolicy,
  roundCap: String(floor.roundCap),
  freshStartThreshold: String(floor.freshStartThreshold),
  dailyTokenCap: text(floor.tokenCaps.daily),
  monthlyTokenCap: text(floor.tokenCaps.monthly),
  concurrencyLimit: text(floor.concurrencyLimit),
  priority: String(floor.priority),
  planApproval: floor.planApproval,
  // With no limit, the field offers the default to start from.
  mostAgents: String(floor.mostAgents ?? defaultMostAgents),
  mostAgentsUnlimited: floor.mostAgents === null,
  spinOffFromChat: floor.spinOffFromChat,
  hourlyStatusUpdates: floor.hourlyStatusUpdates,
  requiredReviewerAgentIds: [...floor.requiredReviewerAgentIds],
  gitName: floor.gitIdentity?.name ?? "",
  gitEmail: floor.gitIdentity?.email ?? "",
});

/** Blank is "none"; anything else is a number, or NaN for the schema to refuse. */
const optionalNumber = (value: string): number | null =>
  value.trim() === "" ? null : Number(value);

/** The settings that changed, as `PATCH /api/floors/:floorId` takes them. */
function settingsUpdate(
  floor: Floor,
  values: FormValues,
  dirty: Partial<Record<keyof FormValues, unknown>>,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const key of [
    "name",
    "defaultBranch",
    "setupCommand",
    "testCommand",
    "mergePolicy",
    "planApproval",
    "spinOffFromChat",
    "hourlyStatusUpdates",
  ] as const) {
    if (dirty[key] === true) {
      update[key] = values[key];
    }
  }
  if (dirty.roundCap === true) {
    update["roundCap"] = Number(values.roundCap);
  }
  if (dirty.priority === true) {
    update["priority"] = Number(values.priority);
  }
  if (dirty.freshStartThreshold === true) {
    update["freshStartThreshold"] = Number(values.freshStartThreshold);
  }
  if (dirty.dailyTokenCap === true || dirty.monthlyTokenCap === true) {
    update["tokenCaps"] = {
      daily: optionalNumber(values.dailyTokenCap),
      monthly: optionalNumber(values.monthlyTokenCap),
    };
  }
  if (dirty.mostAgents === true || dirty.mostAgentsUnlimited === true) {
    // A blank number is NaN, for the schema to refuse.
    update["mostAgents"] = values.mostAgentsUnlimited
      ? null
      : values.mostAgents.trim() === ""
        ? Number.NaN
        : Number(values.mostAgents);
  }
  if (dirty.concurrencyLimit === true) {
    update["concurrencyLimit"] = optionalNumber(values.concurrencyLimit);
  }
  const required = values.requiredReviewerAgentIds;
  if (
    required.length !== floor.requiredReviewerAgentIds.length ||
    required.some((id) => !floor.requiredReviewerAgentIds.includes(id))
  ) {
    update["requiredReviewerAgentIds"] = required;
  }
  if (dirty.gitName === true || dirty.gitEmail === true) {
    // Both blank: the office's identity. One blank is refused by the schema.
    const name = values.gitName.trim();
    const email = values.gitEmail.trim();
    update["gitIdentity"] =
      name === "" && email === "" ? null : { name, email };
  }
  return update;
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

function SettingsForm({
  floor,
  csrfToken,
}: {
  floor: Floor;
  csrfToken: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    resetField,
    getFieldState,
    control,
    formState: { dirtyFields, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: formValues(floor) });
  const unlimited = useWatch({ control, name: "mostAgentsUnlimited" });
  // Removing or adding a reviewer may change who is required: the form
  // follows, unless the Owner is changing them.
  const required = floor.requiredReviewerAgentIds.join(",");
  useEffect(() => {
    if (!getFieldState("requiredReviewerAgentIds").isDirty) {
      resetField("requiredReviewerAgentIds", {
        defaultValue: required === "" ? [] : required.split(","),
      });
    }
  }, [required, getFieldState, resetField]);
  const archived = floor.archivedAt !== null;
  const { data: agents } = useQuery(agentsQuery(floor.id));
  // Its review-Stage Agents, whatever their Role is called (ADR 0003).
  const reviewers = (agents ?? []).filter(
    ({ stage, leavingAt }) => stage === "review" && leavingAt === null,
  );

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const parsed = floorSettingsUpdateSchema.safeParse(
      settingsUpdate(floor, values, dirtyFields),
    );
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const update: FloorSettingsUpdate = parsed.data;
    const response = await sendJson(
      "PATCH",
      `/api/floors/${encodeURIComponent(floor.id)}`,
      update,
      csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The settings were not saved."],
      );
      return;
    }
    const updated = floorSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(floorQuery(floor.id).queryKey, updated);
    await Promise.all([
      queryClient.invalidateQueries(floorsQuery),
      // Its Token Caps are its Agents' defaults.
      queryClient.invalidateQueries(floorTokenUsageQuery(floor.id)),
    ]);
  };

  return (
    <form
      noValidate
      aria-label="Floor settings"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <fieldset disabled={archived} className="grid gap-4 sm:grid-cols-2">
        <Field
          id="floor-name"
          label="Name"
          hint={`Shown for this Floor everywhere, unique among the Floors in use. Its address keeps ${floor.id}.`}
        >
          <Input
            id="floor-name"
            maxLength={maxFloorNameLength}
            aria-describedby="floor-name-hint"
            {...register("name")}
          />
        </Field>
        <Field
          id="floor-default-branch"
          label="Default branch"
          hint="Pull requests merge into it."
        >
          <Input
            id="floor-default-branch"
            aria-describedby="floor-default-branch-hint"
            {...register("defaultBranch")}
          />
        </Field>
        <Field
          id="floor-setup-command"
          label="Setup command"
          hint="Run in the sandbox before work starts. Empty for none."
        >
          <Input
            id="floor-setup-command"
            className="font-mono"
            aria-describedby="floor-setup-command-hint"
            {...register("setupCommand")}
          />
        </Field>
        <Field
          id="floor-test-command"
          label="Test command"
          hint="Run in the sandbox to test the work. Empty for none."
        >
          <Input
            id="floor-test-command"
            className="font-mono"
            aria-describedby="floor-test-command-hint"
            {...register("testCommand")}
          />
        </Field>
        <Field
          id="floor-merge-policy"
          label="Merge Policy"
          hint="What happens to a pull request that passes its Review Loop."
        >
          <select
            id="floor-merge-policy"
            className={selectClass}
            aria-describedby="floor-merge-policy-hint"
            {...register("mergePolicy")}
          >
            {mergePolicies.map((policy) => (
              <option key={policy} value={policy}>
                {mergePolicyLabels[policy]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="floor-round-cap"
          label="Round Cap"
          hint="Review Loop rounds before the pull request goes to you."
        >
          <Input
            id="floor-round-cap"
            type="number"
            min={1}
            max={10}
            aria-describedby="floor-round-cap-hint"
            {...register("roundCap")}
          />
        </Field>
        <Field
          id="floor-fresh-start-threshold"
          label="Fresh Start threshold (%)"
          hint="The Context Usage at which a sandbox Agent starts afresh from a summary it writes. An Agent's own overrides it."
        >
          <Input
            id="floor-fresh-start-threshold"
            type="number"
            min={10}
            max={100}
            aria-describedby="floor-fresh-start-threshold-hint"
            {...register("freshStartThreshold")}
          />
        </Field>
        <Field
          id="floor-daily-token-cap"
          label="Daily Token Cap"
          hint="Tokens a day for this Floor. Empty uses the office's."
        >
          <Input
            id="floor-daily-token-cap"
            type="number"
            min={1}
            aria-describedby="floor-daily-token-cap-hint"
            {...register("dailyTokenCap")}
          />
        </Field>
        <Field
          id="floor-monthly-token-cap"
          label="Monthly Token Cap"
          hint="Tokens a month for this Floor. Empty uses the office's."
        >
          <Input
            id="floor-monthly-token-cap"
            type="number"
            min={1}
            aria-describedby="floor-monthly-token-cap-hint"
            {...register("monthlyTokenCap")}
          />
        </Field>
        <Field
          id="floor-concurrency-limit"
          label="Concurrency limit"
          hint="Sandboxes this Floor may run at once. Empty for the office's limit."
        >
          <Input
            id="floor-concurrency-limit"
            type="number"
            min={1}
            aria-describedby="floor-concurrency-limit-hint"
            {...register("concurrencyLimit")}
          />
        </Field>
        <Field
          id="floor-most-agents"
          label="Most Agents"
          hint="Every Agent on the Floor but the Manager counts, the Owner's and Contractors alike. The Manager adds Contractors only within it."
        >
          <Input
            id="floor-most-agents"
            type="number"
            min={1}
            max={maxMostAgents}
            disabled={unlimited}
            aria-describedby="floor-most-agents-hint"
            {...register("mostAgents")}
          />
          <div className="flex items-center gap-2">
            <input
              id="floor-most-agents-unlimited"
              type="checkbox"
              className="size-4"
              {...register("mostAgentsUnlimited")}
            />
            <Label htmlFor="floor-most-agents-unlimited">No limit</Label>
          </div>
        </Field>
        <Field
          id="floor-priority"
          label="Priority"
          hint="From 0 to 10. Queued work on a higher-priority Floor starts first."
        >
          <Input
            id="floor-priority"
            type="number"
            min={0}
            max={10}
            aria-describedby="floor-priority-hint"
            {...register("priority")}
          />
        </Field>
        <Field
          id="floor-git-name"
          label="Commit author name"
          hint="Who this Floor's commits are by. Empty uses the office's Git identity."
        >
          <Input
            id="floor-git-name"
            autoComplete="off"
            aria-describedby="floor-git-name-hint"
            {...register("gitName")}
          />
        </Field>
        <Field
          id="floor-git-email"
          label="Commit author email"
          hint="Set both name and email, or neither."
        >
          <Input
            id="floor-git-email"
            type="email"
            autoComplete="off"
            aria-describedby="floor-git-email-hint"
            {...register("gitEmail")}
          />
        </Field>
        <div className="flex items-center gap-2 self-end pb-2">
          <input
            id="floor-plan-approval"
            type="checkbox"
            className="size-4"
            {...register("planApproval")}
          />
          <Label htmlFor="floor-plan-approval">
            Work waits for me to approve each Plan
          </Label>
        </div>
        <div className="space-y-1 self-end pb-2">
          <div className="flex items-center gap-2">
            <input
              id="floor-spin-off-from-chat"
              type="checkbox"
              className="size-4"
              aria-describedby="floor-spin-off-from-chat-hint"
              {...register("spinOffFromChat")}
            />
            <Label htmlFor="floor-spin-off-from-chat">
              Manager spins off work from chat
            </Label>
          </div>
          <p
            id="floor-spin-off-from-chat-hint"
            className="text-xs text-muted-foreground"
          >
            The Manager files issues for your chat requests and adds
            Contractors, starting them at once. Off, it only talks and takes
            typed commands.
          </p>
        </div>
        <div className="space-y-1 self-end pb-2">
          <div className="flex items-center gap-2">
            <input
              id="floor-hourly-status-updates"
              type="checkbox"
              className="size-4"
              aria-describedby="floor-hourly-status-updates-hint"
              {...register("hourlyStatusUpdates")}
            />
            <Label htmlFor="floor-hourly-status-updates">
              {hourlyStatusUpdatesLabel}
            </Label>
          </div>
          <p
            id="floor-hourly-status-updates-hint"
            className="text-xs text-muted-foreground"
          >
            {hourlyStatusUpdatesHint}
          </p>
        </div>
        <fieldset
          className="space-y-2 sm:col-span-2"
          aria-describedby="floor-required-reviewers-hint"
        >
          <legend className="text-sm leading-none font-medium">
            Required reviewers
          </legend>
          <p
            id="floor-required-reviewers-hint"
            className="text-xs text-muted-foreground"
          >
            {reviewers.length === 0
              ? "This Floor has no reviewer Agents: add one under Team."
              : "Every round of the Review Loop needs each one's approval."}
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {reviewers.map((reviewer) => (
              <div key={reviewer.id} className="flex items-center gap-2">
                <input
                  id={`floor-required-reviewer-${reviewer.id}`}
                  type="checkbox"
                  className="size-4"
                  value={reviewer.id}
                  {...register("requiredReviewerAgentIds")}
                />
                <Label htmlFor={`floor-required-reviewer-${reviewer.id}`}>
                  {reviewer.name} ({reviewer.aiProvider} {reviewer.model})
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
      </fieldset>
      {problems.length > 0 && (
        <div role="alert">
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {saved && !isDirty && (
        <p role="status" className="text-sm">
          Saved.
        </p>
      )}
      {!archived && (
        <Button
          pending={isSubmitting}
          type="submit"
          disabled={!isDirty || isSubmitting || csrfToken === undefined}
        >
          {isSubmitting ? "Saving…" : "Save settings"}
        </Button>
      )}
    </form>
  );
}

function ArchiveSection({
  floor,
  csrfToken,
}: {
  floor: Floor;
  csrfToken: string | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();

  const archive = async () => {
    setProblem(undefined);
    const response = await postJson(
      `/api/floors/${encodeURIComponent(floor.id)}/archive`,
      {},
      csrfToken,
    );
    if (!response.ok) {
      setProblem(
        (await readApiError(response)).message ?? "The Floor was not archived.",
      );
      return;
    }
    queryClient.setQueryData(
      floorQuery(floor.id).queryKey,
      floorSchema.parse(await response.json()),
    );
    await Promise.all([
      queryClient.invalidateQueries(floorsQuery),
      queryClient.invalidateQueries(installedRepositoriesQuery),
    ]);
    await navigate({ to: "/floor-settings" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Archive</h2>
        </CardTitle>
        <CardDescription>
          Archiving stops all work on this Floor and hides it. Its history is
          kept, and its repository stays this Floor&apos;s.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="w-full text-sm font-medium">
              Archive {floor.name}? This cannot be undone here.
            </p>
            <Button
              variant="destructive"
              disabled={csrfToken === undefined}
              onClick={() => void archive()}
            >
              Archive {floor.name}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Archive aria-hidden />
            Archive Floor
          </Button>
        )}
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One Floor's settings page (`/floor-settings/:floorId`). Its Agents, team,
 * Role memory and Token usage are in Agent Settings.
 */
export function FloorAdminPage({ floorId }: { floorId: string }) {
  const { data: floor, isError, error } = useQuery(floorQuery(floorId));
  const { data: session } = useQuery(sessionQuery);

  if (isError) {
    return (
      <section className="space-y-6">
        <PageHeader
          title="Floor"
          eyebrow={<Link to="/floor-settings">Floor Settings</Link>}
        >
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        </PageHeader>
      </section>
    );
  }
  if (floor === undefined) {
    return <LoadingMessage>Loading the Floor…</LoadingMessage>;
  }
  const archived = floor.archivedAt !== null;
  return (
    <section className="space-y-6">
      <PageHeader
        title={floor.name}
        eyebrow={<Link to="/floor-settings">Floor Settings</Link>}
        actions={
          <>
            <Button asChild variant="outline">
              <Link
                to="/floors/$floorId/manager"
                params={{ floorId: floor.id }}
              >
                <MessageSquare aria-hidden />
                Chat with the Manager
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link
                to="/floors/$floorId/whiteboard"
                params={{ floorId: floor.id }}
              >
                <ClipboardList aria-hidden />
                The whiteboard: Plans and Batch history
              </Link>
            </Button>
          </>
        }
        description={
          <>
            The Floor for{" "}
            <a
              href={`https://github.com/${floor.repository}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono hover:underline"
            >
              {floor.repository}
            </a>
            . It started from the {floor.template.name} Floor Template.
          </>
        }
      >
        {archived && (
          <p role="note" className="rounded-md border p-3 text-sm">
            This Floor is archived: its work has stopped and it is hidden. Its
            history is kept.
          </p>
        )}
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Settings</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Remounted when the Floor changes, so the form starts from it. */}
          <SettingsForm
            key={`${floor.id}:${floor.archivedAt ?? ""}`}
            floor={floor}
            csrfToken={session?.csrfToken}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Agents</h2>
          </CardTitle>
          <CardDescription>
            The Floor&apos;s Agents, its team, Role memory and Token usage are
            in Agent Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/agent-settings"
            search={{ floor: floor.id }}
            className="text-sm font-medium hover:underline"
          >
            Open {floor.name}&apos;s Agent Settings
          </Link>
        </CardContent>
      </Card>
      <FloorSkillsCard floor={floor} />
      {!archived && <SaveAsTemplateCard floor={floor} />}
      {!archived && (
        <ArchiveSection floor={floor} csrfToken={session?.csrfToken} />
      )}
    </section>
  );
}
