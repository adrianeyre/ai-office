import { defaultTimeZone } from "@ai-office/shared";

// The time zones the forms offer, British time first (the default for the
// Owner's passwords and API keys).

/** Every time zone the browser knows, British time first. */
export function timeZones(): string[] {
  const known =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [defaultTimeZone, ...known.filter((zone) => zone !== defaultTimeZone)];
}

/** A time zone, for people: `Europe/London (British time)`, `America/New York`. */
export const timeZoneLabel = (zone: string): string =>
  zone === defaultTimeZone
    ? `${zone} (British time)`
    : zone.replaceAll("_", " ");
