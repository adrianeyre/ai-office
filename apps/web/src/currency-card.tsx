import {
  currencyCodes,
  currencyResponseSchema,
  currencySettingsSchema,
  maxExchangeRate,
  type CurrencyResponse,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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

import { readApiError, sendJson } from "./api.ts";
import { currencyName, currencyQuery, formatMoney, moneyOf } from "./money.ts";
import { sessionQuery } from "./session.ts";

// The currency costs are shown in, everywhere a cost is: British pounds
// until the Owner chooses another of the world's currencies. Costs are
// kept in US dollars, as AI Providers price their Models, and converted at
// the day's exchange rate, or at the Owner's own when they give one.

interface FormValues {
  currency: string;
  manualRate: string;
}

const formValues = (settings: CurrencyResponse): FormValues => ({
  currency: settings.currency,
  manualRate: settings.manualRate === null ? "" : String(settings.manualRate),
});

const updatedFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

function CurrencyForm({ settings }: { settings: CurrencyResponse }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: formValues(settings) });
  // Every currency, by name, with its code.
  const options = useMemo(
    () =>
      currencyCodes
        .map((code) => ({ code, name: currencyName(code) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  const chosen = useWatch({ control, name: "currency" });
  const dayRate = chosen === "USD" ? 1 : settings.rates?.[chosen];

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const parsed = currencySettingsSchema.safeParse({
      currency: values.currency,
      manualRate:
        values.manualRate.trim() === "" ? null : Number(values.manualRate),
    });
    if (!parsed.success) {
      setProblems([
        ...new Set(parsed.error.issues.map(({ message }) => message)),
      ]);
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/currency",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The currency was not saved."],
      );
      return;
    }
    const updated = currencyResponseSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(currencyQuery.queryKey, updated);
  };

  const money = moneyOf(settings);
  return (
    <form
      noValidate
      aria-label="Currency"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="currency-code">Currency</Label>
          <select
            id="currency-code"
            className={selectClass}
            aria-describedby="currency-code-hint"
            {...register("currency")}
          >
            {options.map(({ code, name }) => (
              <option key={code} value={code}>
                {name} ({code})
              </option>
            ))}
          </select>
          <p id="currency-code-hint" className="text-xs text-muted-foreground">
            {dayRate === undefined
              ? chosen === "USD"
                ? "Costs are kept in US dollars."
                : "No exchange rate for it today: give your own, or costs stay in US dollars."
              : `Today, one US dollar is ${String(dayRate)} ${chosen}.`}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency-rate">
            Your own rate (one US dollar in {chosen})
          </Label>
          <Input
            id="currency-rate"
            type="number"
            inputMode="decimal"
            min={0}
            max={maxExchangeRate}
            step="any"
            placeholder="The day's rate"
            aria-describedby="currency-rate-hint"
            disabled={chosen === "USD"}
            {...register("manualRate")}
          />
          <p id="currency-rate-hint" className="text-xs text-muted-foreground">
            Leave it empty for the day&apos;s rate.
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {money.currency === "USD" && settings.currency !== "USD"
          ? "Costs are shown in US dollars until there is an exchange rate."
          : `A cost of $1.00 shows as ${formatMoney(1, money)}.`}{" "}
        {settings.ratesUpdatedAt === null
          ? "The day's rates could not be fetched."
          : `Rates by ExchangeRate-API, updated ${updatedFormat.format(new Date(settings.ratesUpdatedAt))}.`}
      </p>
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
          Saved. Every cost is now shown in {currencyName(settings.currency)} (
          {settings.currency}).
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save currency"}
      </Button>
    </form>
  );
}

/** The currency costs are shown in: British pounds until set. */
export function CurrencyCard() {
  const { data: settings, isError } = useQuery(currencyQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Currency</h2>
        </CardTitle>
        <CardDescription>
          Every cost AI Office shows (the analytics, the request history, API
          keys&apos; usage, Token Caps, Batches and Model prices) is shown in
          this currency. Costs are estimated in US dollars, as AI Providers
          price their Models, and converted at the day&apos;s exchange rate, or
          at your own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The currency could not be loaded.
          </p>
        )}
        {settings !== undefined && <CurrencyForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
