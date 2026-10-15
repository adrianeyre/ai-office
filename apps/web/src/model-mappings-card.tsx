import {
  aiAccountKinds,
  maxModelMappings,
  modelMappingListSchema,
  modelMappingRequestSchema,
  modelMappingSchema,
  type AiProviderEntry,
  type ModelMappingEntry,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { selectClass } from "@/lib/utils.ts";

import { aiProvidersQuery } from "./ai-providers-card.tsx";
import { getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Model mappings and aliases (PRD FR-41): a name callers ask for, sent to
// the AI Provider as another Model. An alias applies to every request and
// is routed as its Model; a mapping for one kind of AI Account applies
// when an account of that kind serves. An AI Account's own forced Model,
// and its extra usage, are set on the account, in AI Accounts.

/** The Owner's model mappings (`GET /api/gateway/model-mappings`). */
export const modelMappingsQuery = queryOptions({
  queryKey: ["gateway", "model-mappings"],
  queryFn: async () =>
    (await getJson("/api/gateway/model-mappings", modelMappingListSchema))
      .mappings,
});

const mappingUrl = (mapping: ModelMappingEntry): string =>
  `/api/gateway/model-mappings/${encodeURIComponent(mapping.id)}`;

/** The "applies to" choice for every kind of AI Account: an alias. */
const everyKind = "";

/** How a kind of AI Account is chosen in the form. */
const kindValue = (kind: {
  aiProvider: string | null;
  accountType: string | null;
}): string =>
  kind.aiProvider === null || kind.accountType === null
    ? everyKind
    : `${kind.aiProvider}:${kind.accountType}`;

/** What a mapping applies to, as the Owner reads it. */
const scopeLabel = (mapping: ModelMappingEntry): string =>
  mapping.aiProvider === null
    ? "Alias, for every AI Account"
    : `For ${
        aiAccountKinds.find((kind) => kindValue(kind) === kindValue(mapping))
          ?.label ?? `${mapping.aiProvider} (${mapping.accountType ?? ""})`
      }`;

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

interface MappingValues {
  from: string;
  to: string;
  /** `everyKind`, or `aiProvider:accountType`. */
  kind: string;
}

/** Adds a mapping, or changes one. */
function MappingForm({
  mapping,
  providers,
  csrfToken,
  onDone,
  onCancel,
}: {
  mapping?: ModelMappingEntry;
  providers: readonly AiProviderEntry[];
  csrfToken: string | undefined;
  onDone: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = useForm<MappingValues>({
    defaultValues:
      mapping === undefined
        ? { from: "", to: "", kind: everyKind }
        : { from: mapping.from, to: mapping.to, kind: kindValue(mapping) },
  });
  const kind = useWatch({ control, name: "kind" });
  const aiProvider = kind === everyKind ? null : (kind.split(":")[0] ?? null);
  // The Models to offer: the kind's AI Provider's, or every catalogue's.
  const models = providers
    .filter(
      (provider) => aiProvider === null || provider.aiProvider === aiProvider,
    )
    .flatMap((provider) => provider.models);

  const onSubmit = async (values: MappingValues) => {
    const [provider = null, accountType = null] =
      values.kind === everyKind ? [] : values.kind.split(":");
    const parsed = modelMappingRequestSchema.safeParse({
      from: values.from,
      to: values.to,
      aiProvider: provider,
      accountType,
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      mapping === undefined ? "POST" : "PUT",
      mapping === undefined
        ? "/api/gateway/model-mappings"
        : mappingUrl(mapping),
      parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(
        await problemsOf(
          response,
          mapping === undefined
            ? "The mapping was not added."
            : "The mapping was not changed.",
        ),
      );
      return;
    }
    modelMappingSchema.parse(await response.json());
    setProblems([]);
    if (mapping === undefined) {
      reset();
    }
    await onDone();
  };

  const id = mapping === undefined ? "new-mapping" : `mapping-${mapping.id}`;
  return (
    <form
      noValidate
      aria-label={
        mapping === undefined
          ? "Add a mapping"
          : `Edit the mapping of ${mapping.from}`
      }
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`${id}-from`}>Asked for</Label>
          <Input
            id={`${id}-from`}
            autoComplete="off"
            spellCheck={false}
            placeholder="opus"
            {...register("from")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-to`}>Sent as</Label>
          <Input
            id={`${id}-to`}
            autoComplete="off"
            spellCheck={false}
            list={`${id}-models`}
            placeholder="claude-opus-5-5"
            {...register("to")}
          />
          <datalist id={`${id}-models`}>
            {models.map((model) => (
              <option key={model.model} value={model.model} />
            ))}
          </datalist>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-kind`}>Applies to</Label>
          <select
            id={`${id}-kind`}
            className={selectClass}
            {...register("kind")}
          >
            <option value={everyKind}>Every AI Account (an alias)</option>
            {aiAccountKinds.map((each) => (
              <option key={kindValue(each)} value={kindValue(each)}>
                {each.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Problems problems={problems} />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          pending={isSubmitting}
          disabled={csrfToken === undefined}
        >
          {isSubmitting
            ? "Saving…"
            : mapping === undefined
              ? "Add the mapping"
              : "Save"}
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

/** One mapping in the list, with its actions. */
function MappingRow({
  mapping,
  providers,
  csrfToken,
  onChanged,
}: {
  mapping: ModelMappingEntry;
  providers: readonly AiProviderEntry[];
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"show" | "edit" | "delete">("show");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const label = `${mapping.from} (${scopeLabel(mapping)})`;

  const remove = async () => {
    setBusy(true);
    const response = await sendDelete(mappingUrl(mapping), csrfToken);
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, "The mapping was not deleted."));
      return;
    }
    setProblems([]);
    await onChanged();
  };

  return (
    <li aria-label={label} className="space-y-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5 text-sm">
          <p>
            <span className="font-mono">{mapping.from}</span> →{" "}
            <span className="font-mono">{mapping.to}</span>
          </p>
          <p className="text-muted-foreground">{scopeLabel(mapping)}</p>
        </div>
        {mode === "show" && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label={`Edit the mapping of ${label}`}
              onClick={() => {
                setMode("edit");
              }}
            >
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Delete the mapping of ${label}`}
              onClick={() => {
                setMode("delete");
              }}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          </div>
        )}
      </div>
      {mode === "delete" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete this mapping? Requests for {mapping.from} are sent as they
            ask.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() => void remove()}
          >
            Yes, delete it
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
      {mode === "edit" && (
        <MappingForm
          mapping={mapping}
          providers={providers}
          csrfToken={csrfToken}
          onCancel={() => {
            setMode("show");
          }}
          onDone={async () => {
            await onChanged();
            setMode("show");
          }}
        />
      )}
      <Problems problems={problems} />
    </li>
  );
}

/**
 * Model mappings in AI Settings (PRD FR-41): each alias and mapping, what
 * it applies to, and a form to add one.
 */
export function ModelMappingsCard() {
  const queryClient = useQueryClient();
  const mappings = useQuery(modelMappingsQuery);
  const providers = useQuery(aiProvidersQuery);
  const { data: session } = useQuery(sessionQuery);
  const refresh = () => queryClient.invalidateQueries(modelMappingsQuery);
  const providerList = providers.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Model mappings</h2>
        </CardTitle>
        <CardDescription>
          Send a request for one Model, or for an alias such as
          &ldquo;opus&rdquo;, as another Model. An alias applies to every
          request, which is then routed as the Model it stands for. A mapping
          for one kind of AI Account applies when an account of that kind
          serves, and comes before the alias. An AI Account&apos;s forced Model
          comes before both, and a Combo slot&apos;s Model before mappings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {mappings.isError && (
          <p role="alert" className="text-sm text-destructive">
            The model mappings could not be loaded.
          </p>
        )}
        {mappings.data !== undefined &&
          (mappings.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No model mappings: every request is sent the Model it asks for.
            </p>
          ) : (
            <ul aria-label="Model mappings" className="divide-y">
              {mappings.data.map((mapping) => (
                <MappingRow
                  key={mapping.id}
                  mapping={mapping}
                  providers={providerList}
                  csrfToken={session?.csrfToken}
                  onChanged={refresh}
                />
              ))}
            </ul>
          ))}
        {mappings.data !== undefined && (
          <section aria-labelledby="add-a-mapping" className="space-y-2">
            <h3 id="add-a-mapping" className="text-sm font-medium">
              Add a mapping
            </h3>
            {mappings.data.length >= maxModelMappings ? (
              <p className="text-sm text-muted-foreground">
                There are {maxModelMappings} mappings, the most there may be:
                delete one first.
              </p>
            ) : (
              <MappingForm
                providers={providerList}
                csrfToken={session?.csrfToken}
                onDone={refresh}
              />
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
