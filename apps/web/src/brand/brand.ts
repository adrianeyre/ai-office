/**
 * The company shown in AI Office's UI. There is no upload, because AI Office
 * has no file storage; to rebrand, replace the images beside this file (or
 * point these at others) and rebuild.
 *
 * - `logo`: the horizontal logo, mark and wordmark together, shown in the
 *   navigation and on the sign-in and setup screens.
 * - `logoDark`: the same, with a wordmark light enough for dark mode.
 * - `icon`: the square mark alone, used as the browser tab's icon (set in
 *   `index.html`, which must name the same file). Its raster copies, the
 *   favicon, home-screen icons and the link-preview image, are in `public/`
 *   (named in `index.html` and `public/site.webmanifest`): redraw those too.
 * - `name`: the logo's alternative text.
 */
import icon from "./icon.svg";
import logoDark from "./logo-dark.svg";
import logo from "./logo.svg";

export const brand = {
  name: "AI Office",
  logo,
  logoDark,
  icon,
} as const;
