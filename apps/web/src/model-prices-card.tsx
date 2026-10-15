import {
  modelNameSchema,
  modelPriceEntrySchema,
  modelPriceListSchema,
  modelPriceSchema,
  type ModelPrice,
  type ModelPriceEntry,
  type PriceSource,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
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
import { TableFrame } from "@/components/ui/table-frame.tsx";

import { getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Model prices (PRD FR-43): what the AI Gateway estimates each request's
// cost from, in US dollars per million tokens. The pricing table gives the
// defaults, AI Providers' published prices replace them, and the Owner's
// price for a Model wins over both.

/** Every priced Model (`GET /api/gateway/prices`). */
export const modelPricesQuery = queryOptions({
  queryKey: ["gateway", "prices"],
  queryFn: async () =>
    (await getJson("/api/gateway/prices", modelPriceListSchema)).prices,
});

const sourceLabel: Record<PriceSource, string> = {
  table: "Pricing table",
  published: "Published",
  override: "Yours",
};

const priceFields = [
  ["input", "Input"],
  ["output", "Output"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
] as const satisfies readonly (readonly [keyof ModelPrice, string])[];

const dollars = (amount: number): string =>
  `$${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

const priceUrl = (model: string): string =>
  `/api/gateway/prices/${encodeURIComponent(model)}`;

type PriceValues = Record<keyof ModelPrice, string> & { model: string };

/** What the API said was wrong, one line each. */
async function problemsOf(response: Response): Promise<string[]> {
  const error = await readApiError(response);
  return error.problems ?? [error.message ?? "The price was not saved."];
}

/** Sets a Model's price: one being edited, or a new one. */
function PriceForm({
  model,
  initial,
  csrfToken,
  onDone,
  onCancel,
}: {
  /** The Model being edited; absent for a new one, named in the form. */
  model?: string;
  initial?: ModelPrice;
  csrfToken: string | undefined;
  onDone: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const empty = { input: "", output: "", cacheWrite: "", cacheRead: "" };
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<PriceValues>({
    defaultValues: {
      model: model ?? "",
      ...(initial === undefined
        ? empty
        : {
            input: String(initial.input),
            output: String(initial.output),
            cacheWrite: String(initial.cacheWrite),
            cacheRead: String(initial.cacheRead),
          }),
    },
  });

  const onSubmit = async (values: PriceValues) => {
    const name = modelNameSchema.safeParse(model ?? values.model);
    const price = modelPriceSchema.safeParse(
      Object.fromEntries(
        priceFields.map(([field]) => [
          field,
          values[field].trim() === "" ? undefined : Number(values[field]),
        ]),
      ),
    );
    const found = [
      ...(name.success ? [] : name.error.issues),
      ...(price.success ? [] : price.error.issues),
    ].map(({ message }) => message);
    if (!name.success || !price.success) {
      setProblems([...new Set(found)]);
      return;
    }
    const response = await sendJson(
      "PUT",
      priceUrl(name.data),
      price.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response));
      return;
    }
    modelPriceEntrySchema.parse(await response.json());
    setProblems([]);
    if (model === undefined) {
      reset({ model: "", ...empty });
    }
    await onDone();
  };

  const id = `price-${model ?? "new"}`;
  return (
    <form
      noValidate
      aria-label={model === undefined ? "Price a Model" : `Price ${model}`}
      className="w-full space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-5">
        {model === undefined && (
          <div className="space-y-1 sm:col-span-5">
            <Label htmlFor={`${id}-model`}>Model</Label>
            <Input
              id={`${id}-model`}
              autoComplete="off"
              placeholder="gpt-5.5"
              {...register("model")}
            />
          </div>
        )}
        {priceFields.map(([field, label]) => (
          <div key={field} className="space-y-1">
            <Label htmlFor={`${id}-${field}`}>{label}</Label>
            <Input
              id={`${id}-${field}`}
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              {...register(field)}
            />
          </div>
        ))}
      </div>
      {problems.length > 0 && (
        <div role="alert">
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          pending={isSubmitting}
          type="submit"
          size="sm"
          disabled={isSubmitting || csrfToken === undefined}
        >
          {isSubmitting ? "Saving…" : "Save price"}
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

/** One Model's row, with Edit and, for the Owner's price, Use default. */
function PriceRow({
  entry,
  csrfToken,
  onChanged,
}: {
  entry: ModelPriceEntry;
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);

  const restoreDefault = async () => {
    const response = await sendDelete(priceUrl(entry.model), csrfToken);
    setFailed(!response.ok);
    if (response.ok) {
      await onChanged();
    }
  };

  return (
    <>
      <tr aria-label={entry.model} className="border-b last:border-0">
        <th scope="row" className="py-2 pr-4 font-mono font-medium">
          {entry.model}
        </th>
        {priceFields.map(([field]) => (
          <td key={field} className="py-2 pr-4 tabular-nums">
            {dollars(entry.price[field])}
          </td>
        ))}
        <td className="py-2 pr-4">{sourceLabel[entry.source]}</td>
        <td className="py-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label={`Edit ${entry.model}'s price`}
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil aria-hidden />
              Edit
            </Button>
            {entry.source === "override" && (
              <Button
                size="sm"
                variant="outline"
                aria-label={`Use the default price for ${entry.model}`}
                disabled={csrfToken === undefined}
                onClick={() => void restoreDefault()}
              >
                <RotateCcw aria-hidden />
                {entry.standard === null ? "Remove" : "Use default"}
              </Button>
            )}
          </div>
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              The price was not changed.
            </p>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={7} className="py-2">
            <PriceForm
              model={entry.model}
              initial={entry.price}
              csrfToken={csrfToken}
              onCancel={() => {
                setEditing(false);
              }}
              onDone={async () => {
                await onChanged();
                setEditing(false);
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The Model prices section of the office admin (PRD FR-43): each Model's
 * price per million tokens of each type, where it comes from, and the
 * Owner's own.
 */
export function ModelPricesCard() {
  const queryClient = useQueryClient();
  const prices = useQuery(modelPricesQuery);
  const { data: session } = useQuery(sessionQuery);
  const refresh = () => queryClient.invalidateQueries(modelPricesQuery);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Model prices</h2>
        </CardTitle>
        <CardDescription>
          US dollars per million tokens, from which each request&apos;s cost is
          estimated, for information only. Your price for a Model wins over the
          pricing table and over prices AI Providers publish.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {prices.isError && (
          <p role="alert" className="text-sm text-destructive">
            The Model prices could not be loaded.
          </p>
        )}
        {prices.data !== undefined && (
          <TableFrame label="Model prices, scrollable">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Model prices</caption>
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Model
                  </th>
                  {priceFields.map(([field, label]) => (
                    <th
                      key={field}
                      scope="col"
                      className="py-2 pr-4 font-medium"
                    >
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="py-2 pr-4 font-medium">
                    From
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {prices.data.map((entry) => (
                  <PriceRow
                    key={entry.model}
                    entry={entry}
                    csrfToken={session?.csrfToken}
                    onChanged={refresh}
                  />
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
        <section aria-labelledby="price-a-model" className="space-y-2">
          <h3 id="price-a-model" className="text-sm font-medium">
            Price another Model
          </h3>
          <PriceForm csrfToken={session?.csrfToken} onDone={refresh} />
        </section>
      </CardContent>
    </Card>
  );
}
