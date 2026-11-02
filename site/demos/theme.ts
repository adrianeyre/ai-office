// The demos' light or dark theme, following the system as the page does
// (styles.css switches on the same media query), and switching with it.
import { useSyncExternalStore } from "react";
import type { Theme } from "../stageshow/kit";

const query = window.matchMedia("(prefers-color-scheme: dark)");

const subscribe = (onChange: () => void): (() => void) => {
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

/** "dark" while the system asks for dark, else "light". */
export function usePageTheme(): Theme {
  return useSyncExternalStore(subscribe, () =>
    query.matches ? "dark" : "light",
  );
}
