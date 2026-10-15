import {
  addComboRequestSchema,
  comboListSchema,
  comboSchema,
  comboSettingsSchema,
  maxComboSlots,
  type AiAccount,
  type AiProviderEntry,
  type ComboEntry,
  type ComboSettings,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";

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

import { aiAccountsQuery } from "./ai-accounts-card.tsx";
import { aiProvidersQuery } from "./ai-providers-card.tsx";
import { getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Combos (PRD FR-40): named, ordered fallback chains of (AI Account, Model)
// slots, each assigned to model families. While Combos are on, a request
// for a Model of a family an enabled Combo is assigned to waterfalls
// through its slots: the first that can serve does, with its own Model,
// and the next serves when it fails. Off until the Owner turns them on.

/** Whether Combos are on (`GET /api/office/combos`). */
export const comboSettingsQuery = queryOptions({
  queryKey: ["office", "combos"],
  queryFn: () => getJson("/api/office/combos", comboSettingsSchema),
});

/** The Owner's Combos (`GET /api/gateway/combos`), oldest first. */
export const combosQuery = queryOptions({
  queryKey: ["gateway", "combos"],
  queryFn: async () =>
    (await getJson("/api/gateway/combos", comboListSchema)).combos,
});

const comboUrl = (combo: ComboEntry): string =>
  `/api/gateway/combos/${encodeURIComponent(combo.id)}`;

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

/** The switch for every Combo. */
function ComboSwitchForm({ settings }: { settings: ComboSettings }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<ComboSettings>({ defaultValues: settings });

  const onSubmit = async (values: ComboSettings) => {
    setSaved(false);
    const response = await sendJson(
      "PUT",
      "/api/office/combos",
      values,
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "Combos were not turned on."));
      return;
    }
    const updated = comboSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(updated);
    queryClient.setQueryData(comboSettingsQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Combos on or off"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          aria-describedby="combos-on-hint"
          {...register("enabled")}
        />
        <span>
          <span className="font-medium">
            Waterfall requests through enabled Combos
          </span>
          <span id="combos-on-hint" className="block text-muted-foreground">
            Off, every request is served by the load-balancing strategy with the
            Model it asks for, whatever Combos are enabled.
          </span>
        </span>
      </label>
      <Problems problems={problems} />
      {saved && !isDirty && (
        <p role="status" className="text-sm">
          Saved. It applies from the next request.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save Combos setting"}
      </Button>
    </form>
  );
}

/** A field of the `index`th slot, as the form names it. */
const slotField = <Field extends "aiAccountId" | "model">(
  index: number,
  field: Field,
) => `slots.${String(index)}.${field}` as `slots.${number}.${Field}`;

interface ComboValues {
  name: string;
  /** Comma-separated. */
  modelFamilies: string;
  enabled: boolean;
  slots: { aiAccountId: string; model: string }[];
}

/** Adds a Combo, or changes one: its name, families, slots and whether on. */
function ComboForm({
  combo,
  accounts,
  providers,
  csrfToken,
  onDone,
  onCancel,
}: {
  /** The Combo being changed; absent for a new one. */
  combo?: ComboEntry;
  accounts: readonly AiAccount[];
  providers: readonly AiProviderEntry[];
  csrfToken: string | undefined;
  onDone: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const emptySlot = () => ({ aiAccountId: accounts[0]?.id ?? "", model: "" });
  const blank: ComboValues = {
    name: "",
    modelFamilies: "",
    enabled: true,
    slots: [emptySlot()],
  };
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<ComboValues>({
    defaultValues:
      combo === undefined
        ? blank
        : {
            name: combo.name,
            modelFamilies: combo.modelFamilies.join(", "),
            enabled: combo.enabled,
            slots: combo.slots.map((slot) => ({ ...slot })),
          },
  });
  const slots = useFieldArray({ control, name: "slots" });
  const chosen = useWatch({ control, name: "slots" });

  const onSubmit = async (values: ComboValues) => {
    const parsed = addComboRequestSchema.safeParse({
      name: values.name,
      modelFamilies: values.modelFamilies
        .split(",")
        .map((family) => family.trim())
        .filter((family) => family !== ""),
      slots: values.slots,
      enabled: values.enabled,
    });
    if (!parsed.success) {
      setProblems([
        ...new Set(parsed.error.issues.map(({ message }) => message)),
      ]);
      return;
    }
    const response =
      combo === undefined
        ? await sendJson("POST", "/api/gateway/combos", parsed.data, csrfToken)
        : await sendJson("PATCH", comboUrl(combo), parsed.data, csrfToken);
    if (!response.ok) {
      setProblems(await problemsOf(response, "The Combo was not saved."));
      return;
    }
    comboSchema.parse(await response.json());
    setProblems([]);
    if (combo === undefined) {
      reset(blank);
    }
    await onDone();
  };

  const id = `combo-${combo?.id ?? "new"}`;
  const label = combo === undefined ? "Add a Combo" : `Change ${combo.name}`;
  return (
    <form
      noValidate
      aria-label={label}
      className="w-full space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            placeholder="Opus, then Sonnet"
            {...register("name")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-families`}>Model families</Label>
          <Input
            id={`${id}-families`}
            autoComplete="off"
            placeholder="claude-opus, gpt-5"
            aria-describedby={`${id}-families-hint`}
            {...register("modelFamilies")}
          />
          <p
            id={`${id}-families-hint`}
            className="text-xs text-muted-foreground"
          >
            Separated by commas. A Model&apos;s name stands for its family:
            claude-opus-5-5 is claude-opus.
          </p>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Slots, in the order they are tried
        </legend>
        <ol className="space-y-2">
          {slots.fields.map((field, index) => {
            const number = String(index + 1);
            const provider = accounts.find(
              (account) => account.id === chosen[index]?.aiAccountId,
            )?.aiProvider;
            const models =
              providers.find((entry) => entry.aiProvider === provider)
                ?.models ?? [];
            return (
              <li
                key={field.id}
                aria-label={`Slot ${number}`}
                className="flex flex-wrap items-end gap-2 rounded-md border p-2"
              >
                <div className="min-w-48 flex-1 space-y-1">
                  <Label htmlFor={`${id}-slot-${number}-account`}>
                    AI Account for slot {number}
                  </Label>
                  <select
                    id={`${id}-slot-${number}-account`}
                    className={selectClass}
                    {...register(slotField(index, "aiAccountId"))}
                  >
                    {!accounts.some(
                      (account) => account.id === field.aiAccountId,
                    ) && (
                      <option value={field.aiAccountId}>
                        A deleted AI Account
                      </option>
                    )}
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} ({account.aiProvider}
                        {account.paused ? ", paused" : ""})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-48 flex-1 space-y-1">
                  <Label htmlFor={`${id}-slot-${number}-model`}>
                    Model for slot {number}
                  </Label>
                  <Input
                    id={`${id}-slot-${number}-model`}
                    autoComplete="off"
                    list={`${id}-slot-${number}-models`}
                    placeholder="claude-sonnet-5-5"
                    {...register(slotField(index, "model"))}
                  />
                  <datalist id={`${id}-slot-${number}-models`}>
                    {models.map((model) => (
                      <option key={model.model} value={model.model} />
                    ))}
                  </datalist>
                </div>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label={`Move slot ${number} up`}
                    disabled={index === 0}
                    onClick={() => {
                      slots.move(index, index - 1);
                    }}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label={`Move slot ${number} down`}
                    disabled={index === slots.fields.length - 1}
                    onClick={() => {
                      slots.move(index, index + 1);
                    }}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label={`Remove slot ${number}`}
                    disabled={slots.fields.length === 1}
                    onClick={() => {
                      slots.remove(index);
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={slots.fields.length >= maxComboSlots}
          onClick={() => {
            slots.append(emptySlot());
          }}
        >
          <Plus aria-hidden />
          Add a slot
        </Button>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...register("enabled")} />
        Enabled
      </label>
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
            : combo === undefined
              ? "Add Combo"
              : "Save Combo"}
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

/** One Combo: its families and slots, with Enable or Disable, Edit, Delete. */
function ComboRow({
  combo,
  accounts,
  providers,
  csrfToken,
  onChanged,
}: {
  combo: ComboEntry;
  accounts: readonly AiAccount[];
  providers: readonly AiProviderEntry[];
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"show" | "edit" | "delete">("show");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const run = async (send: () => Promise<Response>, fallback: string) => {
    setBusy(true);
    const response = await send();
    setBusy(false);
    if (!response.ok) {
      setProblems(await problemsOf(response, fallback));
      return;
    }
    setProblems([]);
    await onChanged();
  };

  return (
    <li aria-label={combo.name} className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            {combo.name}{" "}
            <span className="font-normal text-muted-foreground">
              · {combo.enabled ? "Enabled" : "Disabled"}
            </span>
          </p>
          <p className="text-muted-foreground">
            For{" "}
            <span className="font-mono">{combo.modelFamilies.join(", ")}</span>
          </p>
          <ol
            aria-label={`${combo.name}'s slots`}
            className="list-decimal space-y-0.5 pl-5"
          >
            {combo.slots.map((slot) => {
              const account = accounts.find(
                ({ id }) => id === slot.aiAccountId,
              );
              return (
                <li key={`${slot.aiAccountId}:${slot.model}`}>
                  {account?.name ?? "A deleted AI Account"} ·{" "}
                  <span className="font-mono">{slot.model}</span>
                  {(account === undefined || account.paused) && (
                    <span className="text-muted-foreground">
                      {" "}
                      (skipped while {account === undefined ? "gone" : "paused"}
                      )
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        {mode === "show" && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || csrfToken === undefined}
              aria-label={`${combo.enabled ? "Disable" : "Enable"} ${combo.name}`}
              onClick={() =>
                void run(
                  () =>
                    sendJson(
                      "PATCH",
                      comboUrl(combo),
                      { enabled: !combo.enabled },
                      csrfToken,
                    ),
                  "The Combo was not changed.",
                )
              }
            >
              {combo.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Edit ${combo.name}`}
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
              aria-label={`Delete ${combo.name}`}
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
        <div className="flex w-full flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete {combo.name}? Requests for its model families are served by
            the load-balancing strategy again.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() =>
              void run(
                () => sendDelete(comboUrl(combo), csrfToken),
                "The Combo was not deleted.",
              )
            }
          >
            Yes, delete {combo.name}
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
        <ComboForm
          combo={combo}
          accounts={accounts}
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
 * Combos in AI Settings (PRD FR-40): the switch for every Combo, each
 * Combo with its model families and slots, and a form to build one.
 */
export function CombosCard() {
  const queryClient = useQueryClient();
  const settings = useQuery(comboSettingsQuery);
  const combos = useQuery(combosQuery);
  const accounts = useQuery(aiAccountsQuery);
  const providers = useQuery(aiProvidersQuery);
  const { data: session } = useQuery(sessionQuery);
  const refresh = () => queryClient.invalidateQueries(combosQuery);
  const accountList = accounts.data ?? [];
  const providerList = providers.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Combos</h2>
        </CardTitle>
        <CardDescription>
          A Combo is a named fallback chain of AI Accounts, each with a Model,
          for some model families. While Combos are on, a request for a Model of
          one of those families goes to the first slot that can serve it, asking
          for that slot&apos;s Model, and to the next when it fails. Slots whose
          AI Account is paused, deleted or held back are skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {(settings.isError || combos.isError) && (
          <p role="alert" className="text-sm text-destructive">
            The Combos could not be loaded.
          </p>
        )}
        {settings.data !== undefined && (
          <ComboSwitchForm settings={settings.data} />
        )}
        {combos.data !== undefined &&
          (combos.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Combos yet.</p>
          ) : (
            <ul aria-label="Combos" className="divide-y">
              {combos.data.map((combo) => (
                <ComboRow
                  key={combo.id}
                  combo={combo}
                  accounts={accountList}
                  providers={providerList}
                  csrfToken={session?.csrfToken}
                  onChanged={refresh}
                />
              ))}
            </ul>
          ))}
        {accounts.data !== undefined && (
          <section aria-labelledby="add-a-combo" className="space-y-2">
            <h3 id="add-a-combo" className="text-sm font-medium">
              Add a Combo
            </h3>
            {accounts.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add an AI Account first: every slot is one.
              </p>
            ) : (
              <ComboForm
                accounts={accountList}
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
