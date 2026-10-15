import { palette } from "@ai-office/shared/palette";
import type { Config } from "tailwindcss";

// Tailwind's theme beyond src/styles.css: the Office's colour palette from
// @ai-office/shared, as `office-*` colours (`bg-office-stage-work`,
// `text-office-state-critical`), so the 2D UI and the 3D scene share one set
// of tokens (docs/reference/art-direction.md). src/styles.css loads this
// file with `@config`.
export default {
  theme: { extend: { colors: { office: palette } } },
} satisfies Config;
