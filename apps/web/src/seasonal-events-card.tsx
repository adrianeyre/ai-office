import {
  formatActorLines,
  parseActorLines,
  seasonalActors,
  seasonalEventIds,
  seasonalEventKit,
  seasonalEventsSchema,
  seasonalExtras,
  type SeasonalActorId,
  type SeasonalEventId,
  type SeasonalEvents,
  type SeasonalEventSettings,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useId, useState } from "react";

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
import { Spinner } from "@/components/ui/spinner.tsx";

import { readApiError, sendJson } from "./api.ts";
import { PreviewBoundary, PreviewMessage } from "./avatar-editor.tsx";
import { webgl } from "./scene/webgl.ts";
import { sessionQuery } from "./session.ts";

// The seasonal events in General Settings: Christmas, Halloween, Easter
// and New Year, each on or off, its first and last day (a day and a month,
// every year), its actors, each shown on a turntable to drag round with
// its lines to write, separated by commas, and its extras. Saved
// together. The turntables are all drawn on one canvas, the card's: a
// browser keeps only so many.

const ActorPreview = lazy(() =>
  import("./scene/actor-preview.tsx").then(({ ActorPreview }) => ({
    default: ActorPreview,
  })),
);
const ActorPreviewCanvas = lazy(() =>
  import("./scene/actor-preview.tsx").then(({ ActorPreviewCanvas }) => ({
    default: ActorPreviewCanvas,
  })),
);

import {
  seasonalEventsQuery,
  seasonalEventsUrl as url,
} from "./seasonal-events.ts";

/**
 * An actor's lines, written separated by commas. The text is kept as
 * typed, so a trailing comma survives, until the lines change elsewhere.
 */
function ActorLines({
  name,
  lines,
  onChange,
}: {
  name: string;
  lines: readonly string[];
  onChange: (lines: string[]) => void;
}) {
  const field = useId();
  const [text, setText] = useState(() => formatActorLines(lines));
  const [shownFor, setShownFor] = useState(lines);
  if (shownFor !== lines) {
    setShownFor(lines);
    if (formatActorLines(parseActorLines(text)) !== formatActorLines(lines)) {
      setText(formatActorLines(lines));
    }
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={field} className="text-xs">
        What {name} says
      </Label>
      <textarea
        id={field}
        rows={3}
        className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={text}
        aria-describedby={`${field}-hint`}
        onChange={(change) => {
          setText(change.target.value);
          onChange(parseActorLines(change.target.value));
        }}
      />
      <p id={`${field}-hint`} className="text-xs text-muted-foreground">
        Separate lines with commas; one is said at each stop.
      </p>
    </div>
  );
}

/** An actor on its turntable, or why it cannot be shown, and its lines. */
function ActorTile({
  actor,
  on,
  lines,
  onChange,
  onLines,
}: {
  actor: SeasonalActorId;
  on: boolean;
  lines: readonly string[];
  onChange: (on: boolean) => void;
  onLines: (lines: string[]) => void;
}) {
  const { name } = seasonalActors[actor];
  return (
    <li className="w-44 space-y-1">
      <div
        role="img"
        aria-label={`${name}: drag to turn it round`}
        className="relative h-56 overflow-hidden rounded-md border bg-office-light-sky"
      >
        {webgl.available() ? (
          <PreviewBoundary>
            <Suspense
              fallback={
                <PreviewMessage>
                  <Spinner className="mr-1.5 size-3.5" />
                  Loading…
                </PreviewMessage>
              }
            >
              <ActorPreview actor={actor} />
            </Suspense>
          </PreviewBoundary>
        ) : (
          <PreviewMessage>
            This browser cannot show {name}: it has no WebGL 2.
          </PreviewMessage>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={on}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {name}
      </label>
      <ActorLines name={name} lines={lines} onChange={onLines} />
    </li>
  );
}

/** One event: on or off, its dates, actors and extras. */
function EventFields({
  id,
  event,
  onChange,
}: {
  id: SeasonalEventId;
  event: SeasonalEventSettings;
  onChange: (event: SeasonalEventSettings) => void;
}) {
  const field = useId();
  const kit = seasonalEventKit[id];
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border p-4">
      <legend className="px-1 font-medium">{kit.name}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={event.enabled}
          onChange={(change) => {
            onChange({ ...event, enabled: change.target.checked });
          }}
        />
        {kit.name} is on
      </label>
      <div className="flex flex-wrap gap-6">
        {(["start", "end"] as const).map((end) => {
          const [month = "", day = ""] = event[end].split("-");
          const set = (part: "month" | "day", typed: string) => {
            const digits = typed.replace(/\D/g, "").slice(0, 2);
            const padded = digits.length === 1 ? `0${digits}` : digits;
            onChange({
              ...event,
              [end]:
                part === "month" ? `${padded}-${day}` : `${month}-${padded}`,
            });
          };
          const shown = (part: string) =>
            part === "" ? "" : String(Number(part));
          return (
            <fieldset key={end} className="space-y-1">
              <legend className="text-sm font-medium">
                {end === "start" ? "First day" : "Last day"}
              </legend>
              <div className="flex gap-2">
                <div className="space-y-1">
                  <Label
                    htmlFor={`${field}-${end}-day`}
                    className="text-xs text-muted-foreground"
                  >
                    Day
                  </Label>
                  <Input
                    id={`${field}-${end}-day`}
                    className="w-16"
                    value={shown(day)}
                    placeholder="DD"
                    inputMode="numeric"
                    maxLength={2}
                    aria-describedby={`${field}-dates`}
                    onChange={(change) => {
                      set("day", change.target.value);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor={`${field}-${end}-month`}
                    className="text-xs text-muted-foreground"
                  >
                    Month
                  </Label>
                  <Input
                    id={`${field}-${end}-month`}
                    className="w-16"
                    value={shown(month)}
                    placeholder="MM"
                    inputMode="numeric"
                    maxLength={2}
                    aria-describedby={`${field}-dates`}
                    onChange={(change) => {
                      set("month", change.target.value);
                    }}
                  />
                </div>
              </div>
            </fieldset>
          );
        })}
      </div>
      <p id={`${field}-dates`} className="text-xs text-muted-foreground">
        A day and a month, every year, by each viewer's own clock: day 1, month
        12 is 1 December.
      </p>
      {kit.extras.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {kit.extras.map((extra) => (
            <label key={extra} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={event.extras[extra] !== false}
                onChange={(change) => {
                  onChange({
                    ...event,
                    extras: { ...event.extras, [extra]: change.target.checked },
                  });
                }}
              />
              {seasonalExtras[extra]}
            </label>
          ))}
        </div>
      )}
      {kit.actors.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm">
            Who steps out of the lift now and then, goes round the Office, says
            one of its lines at each stop and leaves again (drag each to turn it
            round):
          </p>
          <ul
            aria-label={`${kit.name}'s actors`}
            className="flex flex-wrap gap-3"
          >
            {kit.actors.map((actor) => (
              <ActorTile
                key={actor}
                actor={actor}
                on={event.actors[actor] !== false}
                lines={event.says[actor] ?? seasonalActors[actor].says}
                onChange={(on) => {
                  onChange({
                    ...event,
                    actors: { ...event.actors, [actor]: on },
                  });
                }}
                onLines={(lines) => {
                  onChange({
                    ...event,
                    says: { ...event.says, [actor]: lines },
                  });
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

export function SeasonalEventsCard() {
  const queryClient = useQueryClient();
  const { data: saved, isError } = useQuery(seasonalEventsQuery);
  const { data: session } = useQuery(sessionQuery);
  const [draft, setDraft] = useState<SeasonalEvents>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const shown = draft ?? saved;
  const dirty =
    draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async () => {
    if (draft === undefined) {
      return;
    }
    setSaid(undefined);
    const parsed = seasonalEventsSchema.safeParse(draft);
    if (!parsed.success) {
      setProblem(
        parsed.error.issues[0]?.message ?? "Check the seasonal events.",
      );
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const response = await sendJson(
      "PUT",
      url,
      parsed.data,
      session?.csrfToken,
    );
    if (response.ok) {
      queryClient.setQueryData(
        seasonalEventsQuery.queryKey,
        seasonalEventsSchema.parse(await response.json()),
      );
      setDraft(undefined);
      setSaid("Saved. The Office dresses up on the days set.");
    } else {
      const error = await readApiError(response);
      setProblem(
        error.problems?.[0] ??
          error.message ??
          "The seasonal events were not saved.",
      );
    }
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Seasonal events</h2>
        </CardTitle>
        <CardDescription>
          Decorations in the lobby and on every Floor for Christmas, Halloween,
          Easter and New Year, with visitors from the lift and a few extras.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The seasonal events could not be loaded.
          </p>
        )}
        {shown !== undefined && webgl.available() && (
          <PreviewBoundary>
            <Suspense fallback={null}>
              <ActorPreviewCanvas />
            </Suspense>
          </PreviewBoundary>
        )}
        {shown !== undefined && (
          <form
            aria-label="Seasonal events"
            className="space-y-4"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              void save();
            }}
          >
            {seasonalEventIds.map((id) => (
              <EventFields
                key={id}
                id={id}
                event={shown.events[id]}
                onChange={(event) => {
                  setSaid(undefined);
                  setProblem(undefined);
                  setDraft({ events: { ...shown.events, [id]: event } });
                }}
              />
            ))}
            {problem !== undefined && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            {said !== undefined && (
              <p role="status" className="text-sm">
                {said}
              </p>
            )}
            <Button
              type="submit"
              disabled={!dirty || busy || session === undefined}
            >
              {busy && <Spinner aria-hidden />}
              Save seasonal events
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
