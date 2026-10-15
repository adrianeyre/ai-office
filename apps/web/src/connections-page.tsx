import {
  addConnectionRequestSchema,
  aiProviders,
  communicationsAgentSchema,
  connectionDeliveryListSchema,
  connectionListSchema,
  connectionSchema,
  connectionTestResultSchema,
  connectionTypeNames,
  connectionTypes,
  defaultConnectionRules,
  defaultDetailLevel,
  defaultRulesFor,
  detailLevelNames,
  detailLevels,
  emailTlsModeNames,
  emailTlsModes,
  isGoogleConnection,
  isPublishingDestination,
  isWorkLog,
  keepsChangelog,
  messageKindNames,
  notionParentTypes,
  updateCommunicationsAgentRequestSchema,
  type CommunicationsAgent,
  type Connection,
  type ConnectionDelivery,
  type ConnectionRules,
  type ConnectionTestResult,
  type ConnectionType,
  type DetailLevel,
  type EmailTlsMode,
  type NotionParentType,
  type QuietHours,
} from "@ai-office/shared";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pause, Play, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

import { aiProvidersQuery } from "./ai-providers-card.tsx";
import { getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import { floorsQuery } from "./floors.ts";
import { GoogleSignInCard } from "./google-sign-in.tsx";
import { sessionQuery } from "./session.ts";

// Communications in the office admin (PRD FR-90, FR-93): the
// Communications Agent's config, and the Connections it tells the Owner
// through. A Connection's credentials are typed in once, when it is
// added, and never shown again; each Connection shows its last delivery,
// its status and a log of its recent deliveries. Each also has its detail
// level, quiet hours and Digest (FR-92, FR-95). A publishing destination
// (Confluence, Notion, Google Docs) publishes each finished Batch's Wrap-up
// report, and optionally a running changelog, within its Floors; Google
// Slides a deck of it, and Google Drive its Markdown and PDF files; Google
// Calendar an event per Batch, from its start to its finish; a work log
// (Google Sheets) a row per completed issue, and optionally a row per
// Notice. The Google Connections publish through Google sign-in.

/** The Communications Agent (`GET /api/communications-agent`). */
export const communicationsAgentQuery = queryOptions({
  queryKey: ["communications-agent"],
  queryFn: () =>
    getJson("/api/communications-agent", communicationsAgentSchema),
});

/** Every Connection, oldest first (`GET /api/connections`). */
export const connectionsQuery = queryOptions({
  queryKey: ["connections"],
  queryFn: async () =>
    (await getJson("/api/connections", connectionListSchema)).connections,
});

/** A Connection's recent deliveries, newest first. */
export const connectionDeliveriesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ["connections", connectionId, "deliveries"],
    queryFn: async () =>
      (
        await getJson(
          `/api/connections/${encodeURIComponent(connectionId)}/deliveries`,
          connectionDeliveryListSchema,
        )
      ).deliveries,
  });

const when = (iso: string): string => new Date(iso).toLocaleString();

/** How a delivery went, in a few words. */
export function deliveryOutcome(delivery: ConnectionDelivery): string {
  const what = delivery.test ? "Test" : messageKindNames[delivery.message.kind];
  switch (delivery.status) {
    case "delivered":
      return `${what} delivered ${when(delivery.deliveredAt ?? delivery.createdAt)}`;
    case "failed":
      return `${what} failed ${when(delivery.lastAttemptAt ?? delivery.createdAt)}${delivery.test ? "" : ", given up"}: ${delivery.error ?? "no reason given"}`;
    case "pending":
      if (delivery.attempts > 0) {
        return `${what} failed ${String(delivery.attempts)} time${delivery.attempts === 1 ? "" : "s"}, next try ${when(delivery.nextAttemptAt ?? delivery.createdAt)}: ${delivery.error ?? "no reason given"}`;
      }
      // Put off past when it was queued: held for quiet hours.
      return delivery.nextAttemptAt !== null &&
        delivery.nextAttemptAt > delivery.createdAt
        ? `${what} held for quiet hours until ${when(delivery.nextAttemptAt)}`
        : `${what} waiting to be sent`;
    case "summarised":
      return `${what} held for quiet hours, then summarised in a Digest`;
  }
}

/** The time zone this browser is in, for new quiet hours and Digests. */
const browserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

const quietHoursText = (hours: QuietHours): string =>
  `Quiet ${hours.start}–${hours.end} (${hours.timeZone})${hours.actionNotices ? ", action Notices let through" : ""}`;

/** A Connection's detail level, quiet hours and Digest, in a few words. */
export function deliveryRulesText(connection: Connection): string {
  const { quietHours, digest } = connection.rules;
  if (isWorkLog(connection.type)) {
    return [
      detailLevelNames[connection.detailLevel],
      "A row per completed issue",
      ...(connection.rules.notices === true ? ["A row per Notice"] : []),
    ].join(" · ");
  }
  if (isPublishingDestination(connection.type)) {
    return [
      detailLevelNames[connection.detailLevel],
      connection.type === "google_slides"
        ? "Wrap-up decks"
        : connection.type === "google_drive"
          ? "Wrap-up reports as Markdown and PDF files"
          : connection.type === "google_calendar"
            ? "An event per Batch"
            : "Wrap-up reports",
      ...(connection.rules.changelog === true ? ["Running changelog"] : []),
    ].join(" · ");
  }
  return [
    detailLevelNames[connection.detailLevel],
    ...(quietHours === undefined ? [] : [quietHoursText(quietHours)]),
    ...(digest === undefined
      ? []
      : [
          digest.frequency === "hourly"
            ? "Hourly Digest"
            : `Daily Digest at ${digest.at} (${digest.timeZone})`,
        ]),
  ].join(" · ");
}

/** What the API said was wrong, one line each. */
async function problemsOf(
  response: Response,
  fallback: string,
): Promise<string[]> {
  const error = await readApiError(response);
  return error.problems ?? [error.message ?? fallback];
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

const refreshConnections = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: ["connections"] });

/** The Communications Agent's name, AI Provider, Model and status (FR-90). */
function CommunicationsAgentCard() {
  const queryClient = useQueryClient();
  const agent = useQuery(communicationsAgentQuery);
  const { data: providers } = useQuery(aiProvidersQuery);
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { isSubmitting },
  } = useForm<{
    name: string;
    status: "enabled" | "paused";
    aiProvider: string;
    modelOverride: string;
  }>();

  const loaded = agent.data;
  useEffect(() => {
    if (loaded !== undefined) {
      reset(formValues(loaded));
    }
  }, [loaded, reset]);

  const aiProvider = useWatch({ control, name: "aiProvider" });
  const provider = providers?.find((entry) => entry.aiProvider === aiProvider);
  const providerField = register("aiProvider");

  const onSubmit = async (values: {
    name: string;
    status: "enabled" | "paused";
    aiProvider: string;
    modelOverride: string;
  }) => {
    setSaved(false);
    const parsed = updateCommunicationsAgentRequestSchema.safeParse({
      name: values.name,
      enabled: values.status === "enabled",
      aiProvider: values.aiProvider,
      modelOverride: values.modelOverride === "" ? null : values.modelOverride,
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PATCH",
      "/api/communications-agent",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblems(
        await problemsOf(response, "The Communications Agent was not saved."),
      );
      return;
    }
    setProblems([]);
    setSaved(true);
    queryClient.setQueryData(
      communicationsAgentQuery.queryKey,
      communicationsAgentSchema.parse(await response.json()),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Communications Agent</h2>
        </CardTitle>
        <CardDescription>
          The Agent at the lobby reception desk who tells you about Notices and
          finished work outside AI Office. Its messages come from templates; its
          AI Provider and Model are for Digests and reports.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {agent.isError && (
          <p role="alert" className="text-sm text-destructive">
            The Communications Agent could not be loaded.
          </p>
        )}
        {loaded !== undefined && (
          <form
            noValidate
            aria-label="Communications Agent"
            className="space-y-4"
            onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="communications-agent-name">Name</Label>
                <Input
                  id="communications-agent-name"
                  autoComplete="off"
                  {...register("name")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="communications-agent-status">Status</Label>
                <select
                  id="communications-agent-status"
                  className={selectClass}
                  aria-describedby="communications-agent-status-hint"
                  {...register("status")}
                >
                  <option value="enabled">Enabled</option>
                  <option value="paused">Paused</option>
                </select>
                <p
                  id="communications-agent-status-hint"
                  className="text-xs text-muted-foreground"
                >
                  While paused nothing is sent; deliveries wait until it
                  resumes.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="communications-agent-ai-provider">
                  AI Provider
                </Label>
                <select
                  id="communications-agent-ai-provider"
                  className={selectClass}
                  {...providerField}
                  onChange={(event) => {
                    void providerField.onChange(event);
                    setValue("modelOverride", "");
                  }}
                >
                  {aiProviders.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="communications-agent-model">Model</Label>
                <select
                  id="communications-agent-model"
                  className={selectClass}
                  {...register("modelOverride")}
                >
                  <option value="">
                    {provider?.defaultModel == null
                      ? "Its AI Provider's default"
                      : `Default (${provider.defaultModel})`}
                  </option>
                  {loaded.modelOverride !== null &&
                    loaded.aiProvider === aiProvider &&
                    !(provider?.models ?? []).some(
                      ({ model }) => model === loaded.modelOverride,
                    ) && (
                      <option value={loaded.modelOverride}>
                        {loaded.modelOverride}
                      </option>
                    )}
                  {(provider?.models ?? []).map(({ model }) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Problems problems={problems} />
            {saved && (
              <p role="status" className="text-sm">
                Saved.
              </p>
            )}
            <Button
              pending={isSubmitting}
              type="submit"
              disabled={isSubmitting || session === undefined}
            >
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const formValues = (agent: CommunicationsAgent) => ({
  name: agent.name,
  status: agent.enabled ? ("enabled" as const) : ("paused" as const),
  aiProvider: agent.aiProvider,
  modelOverride: agent.modelOverride ?? "",
});

/** The triggers and Floors a Connection is sent (FR-92). */
function RulesFields({
  idPrefix,
  type,
  rules,
  onChange,
}: {
  idPrefix: string;
  /** Its type: a publishing destination has only Floors and a changelog. */
  type: ConnectionType;
  rules: ConnectionRules;
  onChange: (rules: ConnectionRules) => void;
}) {
  const { data: floors } = useQuery(floorsQuery);
  const publishing = isPublishingDestination(type);
  return (
    <div className="space-y-3">
      {isWorkLog(type) ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Publish</legend>
          <p className="text-xs text-muted-foreground">
            A row for each completed issue: the date, Floor, issue, pull
            request, Agents, Review Loop rounds, tokens and estimated cost.
          </p>
          <div className="flex items-center gap-2">
            <input
              id={`${idPrefix}-notices`}
              type="checkbox"
              className="size-4"
              checked={rules.notices === true}
              onChange={(event) => {
                onChange({ ...rules, notices: event.currentTarget.checked });
              }}
            />
            <Label htmlFor={`${idPrefix}-notices`}>
              A row for each Notice too
            </Label>
          </div>
        </fieldset>
      ) : publishing ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Publish</legend>
          <p className="text-xs text-muted-foreground">
            {type === "google_slides"
              ? "A short deck for each finished Batch, from its Wrap-up report: its title, outcomes, issues and pull requests, and tokens and cost."
              : type === "google_drive"
                ? "Each finished Batch's Wrap-up report, saved as a Markdown and a PDF file: the Plan, each issue's outcome and pull request, rounds, tokens and estimated cost."
                : type === "google_calendar"
                  ? "An event on the calendar for each Batch, from its start to its finish, with a link to its Plan and, once it finishes, its outcome: each issue's outcome and pull request, and tokens."
                  : `A ${type === "google_docs" ? "document" : "page"} for each finished Batch, with its Wrap-up report: the Plan, each issue's outcome and pull request, rounds, tokens and estimated cost.`}
          </p>
          {keepsChangelog(type) && (
            <div className="flex items-center gap-2">
              <input
                id={`${idPrefix}-changelog`}
                type="checkbox"
                className="size-4"
                checked={rules.changelog === true}
                onChange={(event) => {
                  onChange({
                    ...rules,
                    changelog: event.currentTarget.checked,
                  });
                }}
              />
              <Label htmlFor={`${idPrefix}-changelog`}>
                A running changelog: an entry for each merged pull request
              </Label>
            </div>
          )}
        </fieldset>
      ) : (
        <SendFields idPrefix={idPrefix} rules={rules} onChange={onChange} />
      )}
      {!publishing && (
        <>
          <QuietHoursFields
            idPrefix={idPrefix}
            rules={rules}
            onChange={onChange}
          />
          <DigestFields idPrefix={idPrefix} rules={rules} onChange={onChange} />
        </>
      )}
      {floors !== undefined && floors.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Floors</legend>
          <p className="text-xs text-muted-foreground">
            {publishing
              ? "None chosen publishes every Floor's."
              : "None chosen sends every Floor's. Notices about the whole Office are always sent."}
          </p>
          {floors.map((floor) => (
            <div key={floor.id} className="flex items-center gap-2">
              <input
                id={`${idPrefix}-floor-${floor.id}`}
                type="checkbox"
                className="size-4"
                checked={rules.floorIds.includes(floor.id)}
                onChange={(event) => {
                  const { checked } = event.currentTarget;
                  onChange({
                    ...rules,
                    floorIds: checked
                      ? [...rules.floorIds, floor.id]
                      : rules.floorIds.filter((id) => id !== floor.id),
                  });
                }}
              />
              <Label htmlFor={`${idPrefix}-floor-${floor.id}`}>
                {floor.name}
              </Label>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** A notification channel's triggers (FR-92). */
function SendFields({
  idPrefix,
  rules,
  onChange,
}: {
  idPrefix: string;
  rules: ConnectionRules;
  onChange: (rules: ConnectionRules) => void;
}) {
  const triggers = [
    ["actionNotices", "Action Notices"],
    ["infoNotices", "Info Notices"],
    [
      "workComplete",
      "Work complete (a pull request merged, closing its issue, or a Batch finished)",
    ],
  ] as const;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Send</legend>
      {triggers.map(([key, label]) => (
        <div key={key} className="flex items-center gap-2">
          <input
            id={`${idPrefix}-${key}`}
            type="checkbox"
            className="size-4"
            checked={rules[key]}
            onChange={(event) => {
              onChange({ ...rules, [key]: event.currentTarget.checked });
            }}
          />
          <Label htmlFor={`${idPrefix}-${key}`}>{label}</Label>
        </div>
      ))}
    </fieldset>
  );
}

/** A time zone field, offering the zones this browser knows. */
function TimeZoneInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (timeZone: string) => void;
}) {
  return (
    <>
      <Input
        id={id}
        autoComplete="off"
        list={`${id}-zones`}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      <datalist id={`${id}-zones`}>
        {Intl.supportedValuesOf("timeZone").map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}

/** Quiet hours (FR-92): when messages are held. */
function QuietHoursFields({
  idPrefix,
  rules,
  onChange,
}: {
  idPrefix: string;
  rules: ConnectionRules;
  onChange: (rules: ConnectionRules) => void;
}) {
  const hours = rules.quietHours;
  const change = (changes: Partial<QuietHours>) => {
    if (hours !== undefined) {
      onChange({ ...rules, quietHours: { ...hours, ...changes } });
    }
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Quiet hours</legend>
      <div className="flex items-center gap-2">
        <input
          id={`${idPrefix}-quiet`}
          type="checkbox"
          className="size-4"
          checked={hours !== undefined}
          onChange={(event) => {
            onChange({
              ...rules,
              quietHours: event.currentTarget.checked
                ? {
                    start: "22:00",
                    end: "07:00",
                    timeZone: browserTimeZone(),
                    actionNotices: true,
                  }
                : undefined,
            });
          }}
        />
        <Label htmlFor={`${idPrefix}-quiet`}>
          Hold messages in quiet hours
        </Label>
      </div>
      {hours !== undefined && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-quiet-start`}>From</Label>
            <Input
              id={`${idPrefix}-quiet-start`}
              type="time"
              value={hours.start}
              onChange={(event) => {
                change({ start: event.currentTarget.value });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-quiet-end`}>Until</Label>
            <Input
              id={`${idPrefix}-quiet-end`}
              type="time"
              value={hours.end}
              onChange={(event) => {
                change({ end: event.currentTarget.value });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-quiet-zone`}>Time zone</Label>
            <TimeZoneInput
              id={`${idPrefix}-quiet-zone`}
              value={hours.timeZone}
              onChange={(timeZone) => {
                change({ timeZone });
              }}
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-3">
            <input
              id={`${idPrefix}-quiet-actions`}
              type="checkbox"
              className="size-4"
              checked={hours.actionNotices}
              onChange={(event) => {
                change({ actionNotices: event.currentTarget.checked });
              }}
            />
            <Label htmlFor={`${idPrefix}-quiet-actions`}>
              Let action Notices through
            </Label>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Messages in quiet hours wait for them to end, or with a Digest are
            summarised in the next one.
          </p>
        </div>
      )}
    </fieldset>
  );
}

/** A Digest (FR-92): a summary of what happened since the last one. */
function DigestFields({
  idPrefix,
  rules,
  onChange,
}: {
  idPrefix: string;
  rules: ConnectionRules;
  onChange: (rules: ConnectionRules) => void;
}) {
  const { digest } = rules;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Digest</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-digest`}>Send a Digest</Label>
          <select
            id={`${idPrefix}-digest`}
            className={selectClass}
            value={digest?.frequency ?? "none"}
            onChange={(event) => {
              const { value } = event.currentTarget;
              onChange({
                ...rules,
                digest:
                  value === "hourly"
                    ? { frequency: "hourly" }
                    : value === "daily"
                      ? {
                          frequency: "daily",
                          at: "08:00",
                          timeZone: browserTimeZone(),
                        }
                      : undefined,
              });
            }}
          >
            <option value="none">Never</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
          </select>
        </div>
        {digest?.frequency === "daily" && (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-digest-at`}>At</Label>
              <Input
                id={`${idPrefix}-digest-at`}
                type="time"
                value={digest.at}
                onChange={(event) => {
                  onChange({
                    ...rules,
                    digest: { ...digest, at: event.currentTarget.value },
                  });
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-digest-zone`}>Time zone</Label>
              <TimeZoneInput
                id={`${idPrefix}-digest-zone`}
                value={digest.timeZone}
                onChange={(timeZone) => {
                  onChange({ ...rules, digest: { ...digest, timeZone } });
                }}
              />
            </div>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        A summary of what happened since the last one, written by the
        Communications Agent from titles, outcomes and counts. Turn the triggers
        above off to send only Digests.
      </p>
    </fieldset>
  );
}

/** How much a Connection is told (FR-95). */
function DetailLevelField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: DetailLevel;
  onChange: (detailLevel: DetailLevel) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Detail</Label>
      <select
        id={id}
        className={selectClass}
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(event) => {
          const chosen = detailLevels.find(
            (level) => level === event.currentTarget.value,
          );
          if (chosen !== undefined) {
            onChange(chosen);
          }
        }}
      >
        {detailLevels.map((level) => (
          <option key={level} value={level}>
            {detailLevelNames[level]}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Links only sends kinds, counts and links, never a title. Code, diffs,
        issue bodies and memory are never sent.
      </p>
    </div>
  );
}

/** A Connection's recent deliveries, newest first. */
function DeliveryLog({ connectionId }: { connectionId: string }) {
  const deliveries = useQuery(connectionDeliveriesQuery(connectionId));
  if (deliveries.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The deliveries could not be loaded.
      </p>
    );
  }
  if (deliveries.data === undefined) {
    return <LoadingMessage className="text-sm">Loading…</LoadingMessage>;
  }
  return deliveries.data.length === 0 ? (
    <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
  ) : (
    <ol aria-label="Recent deliveries" className="space-y-1 text-sm">
      {deliveries.data.map((delivery) => (
        <li key={delivery.id}>
          <span className="font-medium">{delivery.message.title}</span>
          <span className="block text-muted-foreground">
            {deliveryOutcome(delivery)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One Connection, with everything the Owner can do to it (FR-93). */
function ConnectionItem({
  connection,
  highlighted,
}: {
  connection: Connection;
  highlighted: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const csrfToken = session?.csrfToken;
  const idPrefix = `connection-${useId().replaceAll(":", "")}`;
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [test, setTest] = useState<ConnectionTestResult>();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(connection.name);
  const [rules, setRules] = useState(connection.rules);
  const [detailLevel, setDetailLevel] = useState(connection.detailLevel);
  const [confirming, setConfirming] = useState(false);
  const [showLog, setShowLog] = useState(highlighted);
  const element = useRef<HTMLLIElement>(null);
  const url = `/api/connections/${encodeURIComponent(connection.id)}`;

  useEffect(() => {
    if (highlighted) {
      element.current?.scrollIntoView({ block: "start" });
    }
  }, [highlighted]);

  const run = async (
    request: () => Promise<Response>,
    fallback: string,
    then?: (response: Response) => Promise<void>,
  ) => {
    setBusy(true);
    try {
      const response = await request();
      if (!response.ok) {
        setProblems(await problemsOf(response, fallback));
        return;
      }
      setProblems([]);
      await then?.(response);
      await refreshConnections(queryClient);
    } finally {
      setBusy(false);
    }
  };

  const patch = (body: object, fallback: string, then?: () => void) =>
    run(
      () => sendJson("PATCH", url, body, csrfToken),
      fallback,
      async (response) => {
        connectionSchema.parse(await response.json());
        then?.();
      },
    );

  const status = connection.paused
    ? "Paused"
    : connection.status === "failing"
      ? `Failing: ${String(connection.consecutiveFailures)} deliveries in a row failed`
      : "Working";

  return (
    <li
      ref={element}
      aria-label={connection.name}
      className={`space-y-3 py-4 ${highlighted ? "rounded-md ring-2 ring-primary ring-offset-2" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-sm">
          <p className="font-medium">{connection.name}</p>
          <p className="text-muted-foreground">
            {connectionTypeNames[connection.type]} ·{" "}
            <span className="font-mono">{connection.hint}</span> ·{" "}
            {connection.details.join(" · ")}
          </p>
          <p className="text-muted-foreground">
            {deliveryRulesText(connection)}
          </p>
          <p>
            <span className="font-medium">Status:</span>{" "}
            <span
              className={
                connection.status === "failing" && !connection.paused
                  ? "text-destructive"
                  : ""
              }
            >
              {status}
            </span>
          </p>
          <p className="text-muted-foreground">
            Last delivery:{" "}
            {connection.lastDelivery === null
              ? "none yet"
              : deliveryOutcome(connection.lastDelivery)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || csrfToken === undefined}
            aria-label={`Send test to ${connection.name}`}
            onClick={() =>
              void run(
                () => sendJson("POST", `${url}/test`, {}, csrfToken),
                "The test was not sent.",
                async (response) => {
                  setTest(
                    connectionTestResultSchema.parse(await response.json()),
                  );
                  await queryClient.invalidateQueries(
                    connectionDeliveriesQuery(connection.id),
                  );
                },
              )
            }
          >
            <Send aria-hidden />
            Send test
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-expanded={editing}
            aria-label={`Edit ${connection.name}`}
            onClick={() => {
              setName(connection.name);
              setRules(connection.rules);
              setDetailLevel(connection.detailLevel);
              setEditing(!editing);
            }}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || csrfToken === undefined}
            aria-label={`${connection.paused ? "Resume" : "Pause"} ${connection.name}`}
            onClick={() =>
              void patch(
                { paused: !connection.paused },
                connection.paused
                  ? "The Connection was not resumed."
                  : "The Connection was not paused.",
              )
            }
          >
            {connection.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {connection.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Delete ${connection.name}`}
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        </div>
      </div>
      {test !== undefined && (
        <p
          role="status"
          className={`text-sm ${test.delivered ? "" : "text-destructive"}`}
        >
          {isPublishingDestination(connection.type)
            ? test.delivered
              ? `The test reached it: the ${connection.type === "google_calendar" ? "calendar" : isGoogleConnection(connection.type) && !isWorkLog(connection.type) ? "folder" : "parent"} can be read. Nothing was written.`
              : `The test did not reach it: ${test.error ?? "no reason given"}`
            : test.delivered
              ? "The test message was delivered."
              : `The test message was not delivered: ${test.error ?? "no reason given"}`}
        </p>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete {connection.name}? Nothing more is sent to it, and its
            deliveries are deleted with it.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() =>
              void run(
                () => sendDelete(url, csrfToken),
                "The Connection was not deleted.",
              )
            }
          >
            Yes, delete {connection.name}
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
      {editing && (
        <form
          noValidate
          aria-label={`Edit ${connection.name}`}
          className="space-y-3 rounded-md border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void patch(
              {
                name,
                rules,
                ...(detailLevel === connection.detailLevel
                  ? {}
                  : { detailLevel }),
              },
              "The Connection was not saved.",
              () => {
                setEditing(false);
              },
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-name`}>Name</Label>
            <Input
              id={`${idPrefix}-name`}
              autoComplete="off"
              value={name}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
            />
          </div>
          <DetailLevelField
            id={`${idPrefix}-detail`}
            value={detailLevel}
            onChange={setDetailLevel}
          />
          <RulesFields
            idPrefix={idPrefix}
            type={connection.type}
            rules={rules}
            onChange={setRules}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy || csrfToken === undefined}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <Problems problems={problems} />
      <div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showLog}
          onClick={() => {
            setShowLog(!showLog);
          }}
        >
          {showLog ? "Hide recent deliveries" : "Show recent deliveries"}
        </Button>
        {showLog && <DeliveryLog connectionId={connection.id} />}
      </div>
    </li>
  );
}

interface AddValues {
  type: ConnectionType;
  name: string;
  /** A generic webhook's. */
  url: string;
  secret: string;
  /** Slack's. */
  slackMode: "webhook" | "bot";
  slackWebhookUrl: string;
  botToken: string;
  channel: string;
  /** Email's. */
  smtpHost: string;
  smtpPort: string;
  tls: EmailTlsMode;
  username: string;
  password: string;
  from: string;
  /** One or more addresses, separated by commas or lines. */
  to: string;
  /** ntfy's. */
  ntfyServer: string;
  topic: string;
  accessToken: string;
  /** Pushover's. */
  applicationToken: string;
  userKey: string;
  /** Confluence's. */
  siteUrl: string;
  atlassianEmail: string;
  apiToken: string;
  spaceKey: string;
  parentPageId: string;
  /** Notion's. */
  notionToken: string;
  notionParentType: NotionParentType;
  notionParentId: string;
  /** Google Sheets'. */
  spreadsheet: string;
  tab: string;
  /** Google Docs', Slides' and Drive's. */
  folder: string;
  /** Google Calendar's. */
  calendar: string;
}

const emptyValues: AddValues = {
  type: "webhook",
  name: "",
  url: "",
  secret: "",
  slackMode: "webhook",
  slackWebhookUrl: "",
  botToken: "",
  channel: "",
  smtpHost: "",
  smtpPort: "587",
  tls: "starttls",
  username: "",
  password: "",
  from: "",
  to: "",
  ntfyServer: "https://ntfy.sh",
  topic: "",
  accessToken: "",
  applicationToken: "",
  userKey: "",
  siteUrl: "",
  atlassianEmail: "",
  apiToken: "",
  spaceKey: "",
  parentPageId: "",
  notionToken: "",
  notionParentType: "page",
  notionParentId: "",
  spreadsheet: "",
  tab: "Work log",
  folder: "",
  calendar: "",
};

/** The `credentials` of a new Connection of the chosen type. */
const credentialsOf = (values: AddValues) => {
  switch (values.type) {
    case "webhook":
      return {
        url: values.url.trim(),
        ...(values.secret === "" ? {} : { secret: values.secret }),
      };
    case "slack":
      return values.slackMode === "webhook"
        ? { mode: "webhook", webhookUrl: values.slackWebhookUrl.trim() }
        : {
            mode: "bot",
            botToken: values.botToken.trim(),
            channel: values.channel.trim(),
          };
    case "email":
      return {
        host: values.smtpHost.trim(),
        port: Number(values.smtpPort),
        tls: values.tls,
        ...(values.username.trim() === ""
          ? {}
          : { username: values.username.trim() }),
        ...(values.password === "" ? {} : { password: values.password }),
        from: values.from.trim(),
        to: values.to
          .split(/[,\n]/)
          .map((address) => address.trim())
          .filter((address) => address !== ""),
      };
    case "ntfy":
      return {
        server: values.ntfyServer.trim(),
        topic: values.topic.trim(),
        ...(values.accessToken.trim() === ""
          ? {}
          : { accessToken: values.accessToken.trim() }),
      };
    case "pushover":
      return {
        applicationToken: values.applicationToken.trim(),
        userKey: values.userKey.trim(),
      };
    case "confluence":
      return {
        siteUrl: values.siteUrl.trim(),
        email: values.atlassianEmail.trim(),
        apiToken: values.apiToken.trim(),
        spaceKey: values.spaceKey.trim(),
        parentPageId: values.parentPageId.trim(),
      };
    case "notion":
      return {
        token: values.notionToken.trim(),
        parentType: values.notionParentType,
        parentId: values.notionParentId.trim(),
      };
    case "google_sheets":
      return {
        spreadsheetId: values.spreadsheet.trim(),
        tab: values.tab.trim(),
      };
    case "google_docs":
    case "google_slides":
    case "google_drive":
      return { folderId: values.folder.trim() };
    case "google_calendar":
      return { calendarId: values.calendar.trim() };
  }
};

/**
 * Which rules a type keeps: a notification channel's, a report's (with a
 * changelog, or without: a deck's, files' or a calendar's) or a work log's.
 */
const rulesKind = (type: ConnectionType) =>
  isWorkLog(type)
    ? "log"
    : keepsChangelog(type)
      ? "pages"
      : isPublishingDestination(type)
        ? "files"
        : "notify";

/** What each type says of the credentials it takes. */
const credentialsHints: Record<ConnectionType, ReactNode> = {
  webhook: (
    <>
      Each message is a JSON POST. With a secret, it is signed with HMAC-SHA256
      in <code>X-AI-Office-Signature-256</code>.
    </>
  ),
  slack: (
    <>
      An incoming webhook posts to the channel it was made for; a bot token (
      <code>xoxb-</code>, with the <code>chat:write</code> scope) posts to the
      channel or user you name, once the bot is in that channel.
    </>
  ),
  email: (
    <>
      Each message is sent as plain text and HTML. Use STARTTLS (port 587) or
      TLS (465); no TLS only for a server on your own machine or network.
    </>
  ),
  ntfy: (
    <>
      Subscribe to the topic in the ntfy app. On a public server anyone who
      knows the topic can read it, so choose one hard to guess, or use an access
      token (<code>tk_</code>). Action Notices arrive at high priority.
    </>
  ),
  pushover: (
    <>
      Create an application in Pushover for its token, and use your user key (or
      a group key). Action Notices arrive at high priority.
    </>
  ),
  confluence: (
    <>
      Each finished Batch&apos;s Wrap-up report becomes a child page of the
      parent page, in the space. Create an API token for the Atlassian account
      at id.atlassian.com; the parent page&apos;s id is the number in its
      address. Send test only reads the space and the parent page.
    </>
  ),
  notion: (
    <>
      Each finished Batch&apos;s Wrap-up report becomes a page under the parent
      page, or in the database. Create an internal integration for its token (
      <code>ntn_</code>), then share the parent with it (Connections, in the
      page&apos;s menu). Send test only reads the parent.
    </>
  ),
  google_sheets: (
    <>
      Each completed issue becomes a row in the tab (made, with a header row, if
      the spreadsheet has none by that name). It is written through Google
      sign-in, above: share the spreadsheet with the Google account signed in.
      Send test writes a test row.
    </>
  ),
  google_docs: (
    <>
      Each finished Batch&apos;s Wrap-up report becomes a document in the
      folder; with a running changelog, each merged pull request is an entry in
      one &quot;AI Office changelog&quot; document there. It is written through
      Google sign-in, above: share the folder with the Google account signed in,
      as an editor. Send test only reads the folder.
    </>
  ),
  google_slides: (
    <>
      Each finished Batch&apos;s Wrap-up report becomes a short deck in the
      folder. It is written through Google sign-in, above: share the folder with
      the Google account signed in, as an editor. Send test only reads the
      folder.
    </>
  ),
  google_drive: (
    <>
      Each finished Batch&apos;s Wrap-up report is saved in the folder as a
      Markdown and a PDF file. It is written through Google sign-in, above:
      share the folder with the Google account signed in, as an editor. Send
      test only reads the folder.
    </>
  ),
  google_calendar: (
    <>
      Each Batch becomes an event on the calendar when it starts, changed to its
      finish when it finishes. The calendar&apos;s id is in its settings, under
      Integrate calendar (or use <code>primary</code> for the signed-in
      account&apos;s own). It is written through Google sign-in, above: share
      the calendar with the Google account signed in, with permission to make
      changes to events. Send test only reads the calendar.
    </>
  ),
};

/** Adds a Connection: its type, its name, its credentials, its rules. */
function AddConnectionForm() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [rules, setRules] = useState<ConnectionRules>(defaultConnectionRules);
  const [detailLevel, setDetailLevel] =
    useState<DetailLevel>(defaultDetailLevel);
  const [added, setAdded] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = useForm<AddValues>({ defaultValues: emptyValues });
  const type = useWatch({ control, name: "type" });
  const slackMode = useWatch({ control, name: "slackMode" });

  const onSubmit = async (values: AddValues) => {
    setAdded(undefined);
    const parsed = addConnectionRequestSchema.safeParse({
      type: values.type,
      name: values.name,
      rules,
      ...(detailLevel === defaultDetailLevel ? {} : { detailLevel }),
      credentials: credentialsOf(values),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "POST",
      "/api/connections",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The Connection was not added."));
      return;
    }
    const connection = connectionSchema.parse(await response.json());
    setProblems([]);
    // Its credentials are not kept here either.
    reset({
      ...emptyValues,
      type: values.type,
      slackMode: values.slackMode,
      tls: values.tls,
      ntfyServer: values.ntfyServer,
      notionParentType: values.notionParentType,
      tab: values.tab,
    });
    setRules(defaultRulesFor(values.type));
    setDetailLevel(defaultDetailLevel);
    setAdded(connection.name);
    await refreshConnections(queryClient);
    // A Google Connection changes what Google sign-in asks for.
    await queryClient.invalidateQueries({ queryKey: ["google"] });
  };

  return (
    <form
      noValidate
      aria-label="Add a Connection"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <h3 className="text-sm font-medium">Add a Connection</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="connection-type">Type</Label>
          <select
            id="connection-type"
            className={selectClass}
            {...register("type", {
              // A publishing destination's rules are its own: they start
              // afresh when the kind of Connection changes.
              onChange: (event: { target: { value: ConnectionType } }) => {
                if (rulesKind(event.target.value) !== rulesKind(type)) {
                  setRules(defaultRulesFor(event.target.value));
                }
              },
            })}
          >
            {connectionTypes.map((option) => (
              <option key={option} value={option}>
                {connectionTypeNames[option]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="connection-name">Name</Label>
          <Input
            id="connection-name"
            autoComplete="off"
            placeholder="Team chat"
            {...register("name")}
          />
        </div>
        {type === "webhook" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-url">Webhook address</Label>
              <Input
                id="connection-url"
                type="url"
                autoComplete="off"
                placeholder="https://hooks.example.com/…"
                aria-describedby="connection-credentials-hint"
                {...register("url")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-secret">
                Signing secret (optional)
              </Label>
              <Input
                id="connection-secret"
                type="password"
                autoComplete="new-password"
                aria-describedby="connection-credentials-hint"
                {...register("secret")}
              />
            </div>
          </>
        )}
        {type === "slack" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-slack-mode">Sends through</Label>
              <select
                id="connection-slack-mode"
                className={selectClass}
                {...register("slackMode")}
              >
                <option value="webhook">An incoming webhook</option>
                <option value="bot">A bot token</option>
              </select>
            </div>
            {slackMode === "webhook" ? (
              <div className="space-y-2">
                <Label htmlFor="connection-slack-webhook">
                  Incoming webhook address
                </Label>
                <Input
                  id="connection-slack-webhook"
                  type="password"
                  autoComplete="off"
                  placeholder="https://hooks.slack.com/services/…"
                  aria-describedby="connection-credentials-hint"
                  {...register("slackWebhookUrl")}
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="connection-slack-token">Bot token</Label>
                  <Input
                    id="connection-slack-token"
                    type="password"
                    autoComplete="off"
                    placeholder="xoxb-…"
                    aria-describedby="connection-credentials-hint"
                    {...register("botToken")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="connection-slack-channel">
                    Channel or user
                  </Label>
                  <Input
                    id="connection-slack-channel"
                    autoComplete="off"
                    placeholder="#ops, C0123456789 or U0123456789"
                    {...register("channel")}
                  />
                </div>
              </>
            )}
          </>
        )}
        {type === "email" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-smtp-host">SMTP server</Label>
              <Input
                id="connection-smtp-host"
                autoComplete="off"
                placeholder="smtp.example.com"
                {...register("smtpHost")}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="connection-smtp-port">Port</Label>
                <Input
                  id="connection-smtp-port"
                  inputMode="numeric"
                  autoComplete="off"
                  {...register("smtpPort")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="connection-smtp-tls">TLS</Label>
                <select
                  id="connection-smtp-tls"
                  className={selectClass}
                  {...register("tls")}
                >
                  {emailTlsModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {emailTlsModeNames[mode]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-smtp-username">
                Username (optional)
              </Label>
              <Input
                id="connection-smtp-username"
                autoComplete="off"
                {...register("username")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-smtp-password">
                Password (optional)
              </Label>
              <Input
                id="connection-smtp-password"
                type="password"
                autoComplete="new-password"
                aria-describedby="connection-credentials-hint"
                {...register("password")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-email-from">From</Label>
              <Input
                id="connection-email-from"
                type="email"
                autoComplete="off"
                placeholder="ai-office@example.com"
                {...register("from")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-email-to">To</Label>
              <Input
                id="connection-email-to"
                autoComplete="off"
                placeholder="you@example.com, team@example.com"
                aria-describedby="connection-email-to-hint"
                {...register("to")}
              />
              <p
                id="connection-email-to-hint"
                className="text-xs text-muted-foreground"
              >
                One or more addresses, separated by commas.
              </p>
            </div>
          </>
        )}
        {type === "ntfy" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-ntfy-server">Server</Label>
              <Input
                id="connection-ntfy-server"
                type="url"
                autoComplete="off"
                {...register("ntfyServer")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-ntfy-topic">Topic</Label>
              <Input
                id="connection-ntfy-topic"
                type="password"
                autoComplete="off"
                aria-describedby="connection-credentials-hint"
                {...register("topic")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-ntfy-token">
                Access token (optional)
              </Label>
              <Input
                id="connection-ntfy-token"
                type="password"
                autoComplete="off"
                placeholder="tk_…"
                aria-describedby="connection-credentials-hint"
                {...register("accessToken")}
              />
            </div>
          </>
        )}
        {type === "confluence" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-confluence-site">Site address</Label>
              <Input
                id="connection-confluence-site"
                type="url"
                autoComplete="off"
                placeholder="https://example.atlassian.net"
                {...register("siteUrl")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-confluence-email">
                Atlassian account email
              </Label>
              <Input
                id="connection-confluence-email"
                type="email"
                autoComplete="off"
                {...register("atlassianEmail")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-confluence-token">API token</Label>
              <Input
                id="connection-confluence-token"
                type="password"
                autoComplete="off"
                aria-describedby="connection-credentials-hint"
                {...register("apiToken")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-confluence-space">Space key</Label>
              <Input
                id="connection-confluence-space"
                autoComplete="off"
                placeholder="ENG"
                {...register("spaceKey")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-confluence-parent">
                Parent page id
              </Label>
              <Input
                id="connection-confluence-parent"
                inputMode="numeric"
                autoComplete="off"
                placeholder="123456"
                aria-describedby="connection-credentials-hint"
                {...register("parentPageId")}
              />
            </div>
          </>
        )}
        {type === "notion" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-notion-token">Integration token</Label>
              <Input
                id="connection-notion-token"
                type="password"
                autoComplete="off"
                placeholder="ntn_…"
                aria-describedby="connection-credentials-hint"
                {...register("notionToken")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-notion-parent-type">Publish to</Label>
              <select
                id="connection-notion-parent-type"
                className={selectClass}
                {...register("notionParentType")}
              >
                {notionParentTypes.map((option) => (
                  <option key={option} value={option}>
                    {option === "page" ? "A parent page" : "A database"}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-notion-parent">
                Parent page or database id
              </Label>
              <Input
                id="connection-notion-parent"
                autoComplete="off"
                placeholder="1f2e3d4c5b6a79881f2e3d4c5b6a7988"
                aria-describedby="connection-credentials-hint"
                {...register("notionParentId")}
              />
            </div>
          </>
        )}
        {type === "google_sheets" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-sheets-spreadsheet">
                Spreadsheet address or id
              </Label>
              <Input
                id="connection-sheets-spreadsheet"
                autoComplete="off"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                aria-describedby="connection-credentials-hint"
                {...register("spreadsheet")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-sheets-tab">Tab</Label>
              <Input
                id="connection-sheets-tab"
                autoComplete="off"
                {...register("tab")}
              />
            </div>
          </>
        )}
        {(type === "google_docs" ||
          type === "google_slides" ||
          type === "google_drive") && (
          <div className="space-y-2">
            <Label htmlFor="connection-google-folder">
              Folder address or id
            </Label>
            <Input
              id="connection-google-folder"
              autoComplete="off"
              placeholder="https://drive.google.com/drive/folders/…"
              aria-describedby="connection-credentials-hint"
              {...register("folder")}
            />
          </div>
        )}
        {type === "google_calendar" && (
          <div className="space-y-2">
            <Label htmlFor="connection-google-calendar">
              Calendar id or address
            </Label>
            <Input
              id="connection-google-calendar"
              autoComplete="off"
              placeholder="…@group.calendar.google.com"
              aria-describedby="connection-credentials-hint"
              {...register("calendar")}
            />
          </div>
        )}
        {type === "pushover" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="connection-pushover-token">
                Application token
              </Label>
              <Input
                id="connection-pushover-token"
                type="password"
                autoComplete="off"
                aria-describedby="connection-credentials-hint"
                {...register("applicationToken")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-pushover-user">User key</Label>
              <Input
                id="connection-pushover-user"
                type="password"
                autoComplete="off"
                aria-describedby="connection-credentials-hint"
                {...register("userKey")}
              />
            </div>
          </>
        )}
      </div>
      <p
        id="connection-credentials-hint"
        className="text-xs text-muted-foreground"
      >
        {credentialsHints[type]} Credentials are stored encrypted, and never
        shown again.
      </p>
      <DetailLevelField
        id="new-connection-detail"
        value={detailLevel}
        onChange={setDetailLevel}
      />
      <RulesFields
        idPrefix="new-connection"
        type={type}
        rules={rules}
        onChange={setRules}
      />
      <Problems problems={problems} />
      {added !== undefined && (
        <p role="status" className="text-sm">
          Added {added}. Send it a test to check it works.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={isSubmitting || session === undefined}
      >
        <Plus aria-hidden />
        {isSubmitting ? "Adding…" : "Add Connection"}
      </Button>
    </form>
  );
}

/** The Connections (FR-91, FR-93): each with its status and log, and a form to add one. */
function ConnectionsCard({ highlight }: { highlight: string | undefined }) {
  const connections = useQuery(connectionsQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Connections</h2>
        </CardTitle>
        <CardDescription>
          Where the Communications Agent tells you about action Notices and
          finished work. Nothing that comes back from a Connection is acted on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {connections.isError && (
          <p role="alert" className="text-sm text-destructive">
            The Connections could not be loaded.
          </p>
        )}
        {connections.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No Connections yet.</p>
        )}
        {connections.data !== undefined && connections.data.length > 0 && (
          <ul aria-label="Connections" className="divide-y">
            {connections.data.map((connection) => (
              <ConnectionItem
                key={connection.id}
                connection={connection}
                highlighted={connection.id === highlight}
              />
            ))}
          </ul>
        )}
        <AddConnectionForm />
      </CardContent>
    </Card>
  );
}

/** `/general-settings/connections`: the Communications Agent and its Connections. */
export function ConnectionsPage({
  connection,
}: {
  /** A Connection to bring into view, as a Notice links to it. */
  connection?: string | undefined;
}) {
  return (
    <section className="space-y-6">
      <PageHeader
        title="Connections"
        eyebrow={<Link to="/general-settings">General Settings</Link>}
        description={<>How AI Office reaches you outside AI Office.</>}
      />
      <CommunicationsAgentCard />
      <ConnectionsCard highlight={connection} />
      <GoogleSignInCard />
    </section>
  );
}

/** The office admin's card leading to the Connections page. */
export function CommunicationsCard() {
  const connections = useQuery(connectionsQuery);
  const failing =
    connections.data?.filter(
      ({ status, paused }) => status === "failing" && !paused,
    ).length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Communications</h2>
        </CardTitle>
        <CardDescription>
          The Communications Agent and its Connections: Slack, email, webhooks,
          phone push, Confluence, Notion and Google Sheets, Docs, Slides, Drive
          and Calendar, outside AI Office.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {connections.data !== undefined && (
          <p>
            {connections.data.length === 0
              ? "No Connections yet."
              : `${String(connections.data.length)} Connection${connections.data.length === 1 ? "" : "s"}${failing > 0 ? `, ${String(failing)} failing` : ""}.`}
          </p>
        )}
        <Link
          to="/general-settings/connections"
          className="font-medium underline underline-offset-4"
        >
          Manage Connections
        </Link>
      </CardContent>
    </Card>
  );
}
