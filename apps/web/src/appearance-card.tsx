import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import {
  appearanceModes,
  themes,
  useAppearance,
  type AppearanceMode,
} from "./appearance.ts";

const modeLabels: Record<AppearanceMode, [string, LucideIcon]> = {
  light: ["Light", Sun],
  dark: ["Dark", Moon],
  system: ["System", Monitor],
};

// A radio as a tile: the whole tile is the target (at least 44px tall), and
// the chosen one is marked by its radio, its outline and its weight, not by
// colour alone.
const optionClass =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:font-medium has-[:checked]:ring-1 has-[:checked]:ring-primary";
const radioClass = "size-4 shrink-0 accent-primary";

/** Light, dark or system, and the colour theme, for this browser. */
export function AppearanceCard() {
  const mode = useAppearance((state) => state.mode);
  const theme = useAppearance((state) => state.theme);
  const setMode = useAppearance((state) => state.setMode);
  const setTheme = useAppearance((state) => state.setTheme);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Appearance</h2>
        </CardTitle>
        <CardDescription>
          How AI Office looks in this browser. Every theme meets WCAG 2.2 AA
          contrast in both light and dark.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Mode</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {appearanceModes.map((value) => {
              const [label, Icon] = modeLabels[value];
              return (
                <label key={value} className={optionClass}>
                  <input
                    type="radio"
                    name="appearance-mode"
                    value={value}
                    className={radioClass}
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                    }}
                  />
                  <Icon aria-hidden className="size-4" />
                  {label}
                  {value === "system" && (
                    <span className="text-muted-foreground">
                      (match device)
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">Theme</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {themes.map(({ id, label, swatch }) => (
              <label key={id} className={optionClass}>
                <input
                  type="radio"
                  name="appearance-theme"
                  value={id}
                  className={radioClass}
                  checked={theme === id}
                  onChange={() => {
                    setTheme(id);
                  }}
                />
                <span
                  aria-hidden
                  className="size-4 shrink-0 rounded-full border border-black/20 dark:border-white/30"
                  style={{ backgroundColor: swatch }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}
