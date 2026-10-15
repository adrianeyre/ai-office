import {
  agentSchema,
  pronounsOf,
  randomAvatar,
  sameAvatar,
  type Agent,
  type Avatar,
} from "@ai-office/shared";
import {
  accessoryKinds,
  bodyShapes,
  deskItemKinds,
  deskMascots,
  faces,
  facialHairStyles,
  glassesStyles,
  hairColours,
  hairstyles,
  maxDeskItems,
  outfitColours,
  outfitStyles,
  presentations,
  skinTones,
} from "@ai-office/shared/avatar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, RotateCw, Shuffle, Undo2 } from "lucide-react";
import {
  Component,
  lazy,
  Suspense,
  useId,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { readApiError, sendJson } from "./api.ts";
import { agentsQuery } from "./floors.ts";
import { webgl } from "./scene/webgl.ts";
import { sessionQuery } from "./session.ts";

// The Avatar Editor (PRD FR-13, FR-14; §5 scenario 7): one Agent's Avatar,
// every part of it, with a live 3D preview that turns. Randomise gives a
// look unlike the Floor's other Agents' (and unlike the one before), Reset
// goes back to the saved Avatar, and Save stores it: the Office draws the
// Agent's new look at once. It is opened from the Floor admin's Agents
// table and by clicking an Agent in the Office. The Avatar never reaches a
// prompt, so it never changes how the Agent works. The UI's pronouns for
// the Agent follow the presentation chosen.

// The preview loads three.js, so it comes in the scene's own chunk.
const AvatarPreview = lazy(() =>
  import("./scene/avatar-preview.tsx").then(({ AvatarPreview }) => ({
    default: AvatarPreview,
  })),
);

/** How far each press of a turn button turns the preview: 30°. */
export const turnStep = Math.PI / 6;

/** Each swatch's name, so no colour is told by colour alone. */
export const colourNames: Record<
  | (typeof hairColours)[number]
  | (typeof skinTones)[number]
  | (typeof outfitColours)[number],
  string
> = {
  "#1c1c1c": "Black",
  "#4a3021": "Dark brown",
  "#8b5a2b": "Brown",
  "#c68642": "Caramel",
  "#e6be8a": "Blonde",
  "#b55239": "Auburn",
  "#9e9e9e": "Grey",
  "#f2f2f2": "White",
  "#2e6fd8": "Blue",
  "#d64f8f": "Pink",
  "#3b2219": "Deep",
  "#5c3a21": "Dark",
  "#8d5524": "Brown",
  "#a0662f": "Warm brown",
  "#e0ac69": "Medium",
  "#f1c27d": "Light",
  "#ffdbac": "Fair",
  "#1f3a5f": "Navy",
  "#2f6f4f": "Green",
  "#8c2f39": "Burgundy",
  "#d98e04": "Mustard",
  "#5b4b8a": "Purple",
  "#2b2b2b": "Charcoal",
  "#e8e4da": "Cream",
  "#3f88c5": "Sky blue",
  "#e07a5f": "Terracotta",
  "#81b29a": "Sage",
};

// A skin tone that is also a hair colour is named as a skin tone there.
const skinToneNames: Partial<Record<string, string>> = { "#c68642": "Tan" };

const optionNames: Partial<Record<string, string>> = {
  "t-shirt": "T-shirt",
  "cat-eye": "Cat-eye",
  "rubber-duck": "Rubber duck",
  none: "None",
};

/** An option as the editor writes it: `Rubber duck`, `Cat-eye`. */
export const optionName = (value: string): string =>
  optionNames[value] ?? `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

/** A desk item's name in words: "Coffee mug". */
export const deskItemName = (kind: string): string =>
  optionName(kind).replaceAll("-", " ");

const presentationNames: Record<Avatar["presentation"], string> = {
  male: "Male (he)",
  female: "Female (she)",
  androgynous: "Androgynous (they)",
};

/** Draws the preview, or says why it cannot. */
export class PreviewBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <PreviewMessage>The preview could not start.</PreviewMessage>
    ) : (
      this.props.children
    );
  }
}

export function PreviewMessage({ children }: { children: ReactNode }) {
  return (
    <p className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** A choice from a list, as a select. */
function Choice<Value extends string>({
  id,
  label,
  value,
  options,
  name = optionName,
  onChange,
}: {
  id: string;
  label: string;
  value: Value;
  options: readonly Value[];
  name?: (value: Value) => string;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as Value);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {name(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A colour from a set of swatches, as radio buttons, each named. A colour
 * the set does not have (set before it changed) is offered as its own.
 */
function Swatches({
  label,
  value,
  colours,
  names = {},
  onChange,
}: {
  label: string;
  value: string;
  colours: readonly string[];
  names?: Partial<Record<string, string>>;
  onChange: (colour: string) => void;
}) {
  const group = useId();
  const offered = colours.some(
    (colour) => colour.toLowerCase() === value.toLowerCase(),
  )
    ? colours
    : [...colours, value];
  const nameOf = (colour: string) =>
    names[colour] ??
    (colourNames as Partial<Record<string, string>>)[colour] ??
    `Its own colour (${colour})`;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2.5 p-1">
        {offered.map((colour) => {
          const checked = colour.toLowerCase() === value.toLowerCase();
          return (
            <input
              key={colour}
              type="radio"
              name={group}
              aria-label={nameOf(colour)}
              title={nameOf(colour)}
              className={cn(
                "size-7 cursor-pointer appearance-none rounded-full border border-input",
                "checked:ring-2 checked:ring-foreground checked:ring-offset-2 checked:ring-offset-background",
              )}
              style={{ backgroundColor: colour }}
              checked={checked}
              onChange={() => {
                onChange(colour);
              }}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

/** Whose Avatar the editor changes: an Agent, or one of the lobby's cast. */
export interface AvatarSubject {
  readonly id: string;
  readonly name: string;
  readonly avatar: Avatar;
}

/** What saving an Avatar gave: the subject as now saved, or what was wrong. */
export type AvatarSaveResult =
  | { readonly saved: AvatarSubject; readonly message: string }
  | { readonly problems: string[] };

/**
 * Edits one Avatar. `others` are the looks Randomise keeps away from;
 * `about` says what the look is for; `save` stores it. `compact` lays it
 * out in one column, for the Office's panel; `onClose`, when given, offers
 * a Close button.
 */
export function AvatarForm({
  subject,
  others,
  about,
  save: store,
  compact = false,
  onClose,
}: {
  subject: AvatarSubject;
  others: readonly Avatar[];
  about: (pronouns: ReturnType<typeof pronounsOf>) => ReactNode;
  save: (avatar: Avatar) => Promise<AvatarSaveResult>;
  compact?: boolean;
  onClose?: (() => void) | undefined;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [avatar, setAvatar] = useState<Avatar>(subject.avatar);
  const [turn, setTurn] = useState(0);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string>();
  const id = (field: string) => `avatar-${subject.id}-${field}`;
  // Across both columns, when there are two: a span in one column would
  // make a second.
  const wide = compact ? undefined : "sm:col-span-2";
  const dirty = !sameAvatar(avatar, subject.avatar);
  const pronouns = pronounsOf(avatar);

  const change = (changes: Partial<Avatar>) => {
    setSaved(undefined);
    setProblems([]);
    setAvatar({ ...avatar, ...changes });
  };
  const changeOutfit = (changes: Partial<Avatar["outfit"]>) => {
    change({ outfit: { ...avatar.outfit, ...changes } });
  };

  const randomise = () => {
    // Unlike the others, and unlike the look before; the desk keeps its things.
    change({
      ...randomAvatar(Math.random, [...others, avatar]),
      deskItems: avatar.deskItems,
    });
  };

  const save = async () => {
    setSaving(true);
    setSaved(undefined);
    const result = await store(avatar);
    setSaving(false);
    if ("problems" in result) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    setAvatar(result.saved.avatar);
    setSaved(result.message);
  };

  return (
    <form
      noValidate
      aria-label={`${subject.name}'s Avatar`}
      className={cn("space-y-4", !compact && "mt-4 rounded-md border p-4")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1">
        {!compact && (
          <h3 className="font-medium">{subject.name}&apos;s Avatar</h3>
        )}
        <p className="text-sm text-muted-foreground">{about(pronouns)}</p>
      </div>
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          !compact && "md:grid-cols-[minmax(14rem,18rem)_1fr]",
        )}
      >
        <div className="space-y-2">
          <div
            role="img"
            aria-label={`A preview of ${subject.name}'s Avatar, as it stands now`}
            className="relative h-64 overflow-hidden rounded-md border bg-office-light-sky"
          >
            {webgl.available() ? (
              <PreviewBoundary>
                <Suspense
                  fallback={
                    <PreviewMessage>
                      <Spinner className="mr-1.5 size-3.5" />
                      Loading the preview…
                    </PreviewMessage>
                  }
                >
                  <AvatarPreview avatar={avatar} turn={turn} />
                </Suspense>
              </PreviewBoundary>
            ) : (
              <PreviewMessage>
                This browser cannot show the preview: it has no WebGL 2.
              </PreviewMessage>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Turn the preview left"
              onClick={() => {
                setTurn(turn - turnStep);
              }}
            >
              <RotateCcw aria-hidden />
              Left
            </Button>
            <span className="min-w-0 text-center text-xs text-muted-foreground">
              Drag to look around
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Turn the preview right"
              onClick={() => {
                setTurn(turn + turnStep);
              }}
            >
              Right
              <RotateCw aria-hidden />
            </Button>
          </div>
        </div>
        <div
          className={cn("grid grid-cols-1 gap-4", !compact && "sm:grid-cols-2")}
        >
          <fieldset className={cn("space-y-2", wide)}>
            <legend className="text-sm font-medium">Sex</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {presentations.map((presentation) => (
                <label
                  key={presentation}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name={id("presentation")}
                    className="size-4 accent-primary"
                    checked={avatar.presentation === presentation}
                    onChange={() => {
                      change({ presentation });
                    }}
                  />
                  {presentationNames[presentation]}
                </label>
              ))}
            </div>
          </fieldset>
          <Choice
            id={id("body-shape")}
            label="Body shape"
            value={avatar.bodyShape}
            options={bodyShapes}
            onChange={(bodyShape) => {
              change({ bodyShape });
            }}
          />
          <Choice
            id={id("face")}
            label="Face"
            value={avatar.face}
            options={faces}
            onChange={(face) => {
              change({ face });
            }}
          />
          <Choice
            id={id("hairstyle")}
            label="Hairstyle"
            value={avatar.hairstyle}
            options={hairstyles}
            onChange={(hairstyle) => {
              change({ hairstyle });
            }}
          />
          <Choice
            id={id("facial-hair")}
            label="Facial hair"
            value={avatar.facialHair}
            options={facialHairStyles}
            onChange={(facialHair) => {
              change({ facialHair });
            }}
          />
          <div className={wide}>
            <Swatches
              label="Hair colour"
              value={avatar.hairColour}
              colours={hairColours}
              onChange={(hairColour) => {
                change({ hairColour });
              }}
            />
          </div>
          <div className={wide}>
            <Swatches
              label="Skin tone"
              value={avatar.skinTone}
              colours={skinTones}
              names={skinToneNames}
              onChange={(skinTone) => {
                change({ skinTone });
              }}
            />
          </div>
          <Choice
            id={id("glasses")}
            label="Glasses"
            value={avatar.glasses}
            options={glassesStyles}
            onChange={(glasses) => {
              change({ glasses });
            }}
          />
          <Choice
            id={id("desk-mascot")}
            label="Desk mascot"
            value={avatar.deskMascot}
            options={deskMascots}
            onChange={(deskMascot) => {
              change({ deskMascot });
            }}
          />
          <fieldset
            className={cn("space-y-2", wide)}
            aria-describedby={id("desk-items-help")}
          >
            <legend className="text-sm font-medium">On the desk</legend>
            <p
              id={id("desk-items-help")}
              className="text-xs text-muted-foreground"
            >
              Up to {maxDeskItems}, each at its real size, placed in the order
              chosen wherever the desk has room: {avatar.deskItems.length} of{" "}
              {maxDeskItems}.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {deskItemKinds.map((kind) => {
                const kept = avatar.deskItems.includes(kind);
                return (
                  <label
                    key={kind}
                    className="flex items-center gap-2 text-sm has-disabled:text-muted-foreground"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={kept}
                      disabled={
                        !kept && avatar.deskItems.length >= maxDeskItems
                      }
                      onChange={(event) => {
                        change({
                          deskItems: event.target.checked
                            ? [...avatar.deskItems, kind]
                            : avatar.deskItems.filter((each) => each !== kind),
                        });
                      }}
                    />
                    {deskItemName(kind)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <fieldset className={cn("space-y-2", wide)}>
            <legend className="text-sm font-medium">Accessories</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {accessoryKinds.map((kind) => (
                <label key={kind} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={avatar.accessories.includes(kind)}
                    onChange={(event) => {
                      change({
                        accessories: accessoryKinds.filter((each) =>
                          each === kind
                            ? event.target.checked
                            : avatar.accessories.includes(each),
                        ),
                      });
                    }}
                  />
                  {optionName(kind)}
                </label>
              ))}
            </div>
          </fieldset>
          <Choice
            id={id("outfit")}
            label="Outfit"
            value={avatar.outfit.style}
            options={outfitStyles}
            onChange={(style) => {
              changeOutfit({ style });
            }}
          />
          <div className={wide}>
            <Swatches
              label="Outfit colour"
              value={avatar.outfit.primaryColour}
              colours={outfitColours}
              onChange={(primaryColour) => {
                changeOutfit({ primaryColour });
              }}
            />
          </div>
          <div className={wide}>
            <Swatches
              label="Outfit's second colour"
              value={avatar.outfit.secondaryColour}
              colours={outfitColours}
              onChange={(secondaryColour) => {
                changeOutfit({ secondaryColour });
              }}
            />
          </div>
        </div>
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {saved !== undefined && !dirty && (
        <p role="status" className="text-sm">
          {saved}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={randomise}>
          <Shuffle aria-hidden />
          Randomise
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty}
          onClick={() => {
            change(subject.avatar);
          }}
        >
          <Undo2 aria-hidden />
          Reset
        </Button>
        <Button
          pending={saving}
          type="submit"
          disabled={!dirty || saving || session === undefined}
        >
          {saving ? "Saving…" : `Save ${subject.name}'s Avatar`}
        </Button>
        {onClose !== undefined && (
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Edits one Agent's Avatar. `compact` lays it out in one column, for the
 * Office's panel; `onClose`, when given, offers a Close button.
 */
export function AvatarEditor({
  agent,
  compact = false,
  onClose,
}: {
  agent: Agent;
  compact?: boolean;
  onClose?: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: team } = useQuery(agentsQuery(agent.floorId));
  // Unlike the Floor's other Agents.
  const others = (team ?? [])
    .filter(({ id: other }) => other !== agent.id)
    .map(({ avatar: theirs }) => theirs);

  const save = async (avatar: Avatar): Promise<AvatarSaveResult> => {
    const response = await sendJson(
      "PATCH",
      `/api/floors/${encodeURIComponent(agent.floorId)}/agents/${encodeURIComponent(agent.id)}`,
      { avatar },
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      return {
        problems: error.problems ?? [
          error.message ?? "The Avatar was not saved.",
        ],
      };
    }
    const updated = agentSchema.parse(await response.json());
    // The Office draws the Agents from this query: it shows the new look
    // at once, before the refetch.
    queryClient.setQueryData(agentsQuery(agent.floorId).queryKey, (agents) =>
      agents?.map((each) => (each.id === updated.id ? updated : each)),
    );
    await queryClient.invalidateQueries(agentsQuery(agent.floorId));
    return {
      saved: updated,
      message: `Saved. The Office shows ${updated.name}'s new look; it never changes how ${pronounsOf(updated.avatar).subject} works.`,
    };
  };

  return (
    <AvatarForm
      subject={agent}
      others={others}
      compact={compact}
      onClose={onClose}
      save={save}
      about={(pronouns) => (
        <>
          How {agent.name} looks in the Office. It never changes how{" "}
          {pronouns.subject} {pronouns.subject === "they" ? "work" : "works"}:
          no model ever sees it.
        </>
      )}
    />
  );
}
