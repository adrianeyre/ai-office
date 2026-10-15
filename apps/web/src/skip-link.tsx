/** The id of each page's `<main>`, which the skip link leads to. */
export const mainContentId = "main-content";

/**
 * "Skip to main content": the first thing the keyboard reaches, hidden
 * until it has focus (WCAG 2.4.1).
 */
export function SkipLink() {
  return (
    <a
      href={`#${mainContentId}`}
      // Focus `<main>` directly, leaving the router's location alone.
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(mainContentId)?.focus();
      }}
      className="sr-only rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to main content
    </a>
  );
}
