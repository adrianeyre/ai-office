import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { cn } from "@/lib/utils.ts";

import { AccessibilityStatement } from "./legal/accessibility-statement.tsx";
import { Changelog } from "./legal/changelog.tsx";
import { CookiePolicy } from "./legal/cookie-policy.tsx";
import { repositoryUrl } from "./legal/links.ts";
import { PrivacyPolicy } from "./legal/privacy-policy.tsx";
import { TermsAndConditions } from "./legal/terms-and-conditions.tsx";

const policies = {
  privacy: {
    label: "Privacy Policy",
    closeLabel: "Close privacy policy",
    Body: PrivacyPolicy,
  },
  terms: {
    label: "Terms and Conditions",
    closeLabel: "Close terms and conditions",
    Body: TermsAndConditions,
  },
  cookies: {
    label: "Cookie Policy",
    closeLabel: "Close cookie policy",
    Body: CookiePolicy,
  },
  accessibility: {
    label: "Accessibility",
    closeLabel: "Close accessibility statement",
    Body: AccessibilityStatement,
  },
} as const;

type Policy = keyof typeof policies;

// Every dialog the footer opens: the policies, and the changelog, which the
// version opens.
const dialogs = {
  ...policies,
  changelog: {
    label: "Changelog",
    closeLabel: "Close changelog",
    Body: Changelog,
  },
} as const;

type FooterDialog = keyof typeof dialogs;

function GitHubMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.42c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.76.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.82 0c2.22-1.5 3.2-1.18 3.2-1.18.63 1.59.23 2.76.11 3.05.75.81 1.2 1.84 1.2 3.1 0 4.43-2.7 5.41-5.26 5.69.42.36.8 1.08.8 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

// Text-link styling for the footer's links and buttons: muted, darker on
// hover, and at least 24px tall (WCAG 2.5.8).
const footerLink =
  "inline-flex min-h-6 items-center gap-1.5 rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

/**
 * The footer on every page, stuck to the bottom of the screen: the design
 * credit, the version (which opens the changelog), and the policies, each
 * opened in a dialog.
 */
export function SiteFooter({ className }: { className?: string }) {
  const [open, setOpen] = useState<FooterDialog | null>(null);
  const ref = useRef<HTMLElement>(null);

  // Publishes the footer's height as `--site-footer-height`, so pages that
  // fill the screen (the Office) leave room for it, and scrolling to focus
  // stops above it (it is sticky). It wraps onto more lines on narrow
  // screens, so it is measured rather than assumed.
  useEffect(() => {
    const footer = ref.current;
    const root = document.documentElement;
    if (footer === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      root.style.setProperty(
        "--site-footer-height",
        `${String(footer.offsetHeight)}px`,
      );
    });
    observer.observe(footer);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--site-footer-height");
    };
  }, []);

  return (
    <footer
      ref={ref}
      className={cn(
        "sticky bottom-0 z-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t bg-background/90 px-4 py-2 text-[0.8125rem] text-muted-foreground backdrop-blur-md supports-[not(backdrop-filter:blur(1px))]:bg-background",
        className,
      )}
    >
      <nav aria-label="About AI Office">
        <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <li>
            <a
              className={cn(footerLink, "font-medium")}
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubMark />
              Website design
              <span className="sr-only">
                , source on GitHub, opens in a new tab
              </span>
            </a>
          </li>
          <li>
            <button
              type="button"
              aria-haspopup="dialog"
              className={cn(footerLink, "cursor-pointer tabular-nums")}
              onClick={() => {
                setOpen("changelog");
              }}
            >
              Version: {__APP_VERSION__}
              <span className="sr-only">, changelog</span>
            </button>
          </li>
          {(Object.keys(policies) as Policy[]).map((key) => (
            <li key={key}>
              <button
                type="button"
                aria-haspopup="dialog"
                className={cn(footerLink, "cursor-pointer")}
                onClick={() => {
                  setOpen(key);
                }}
              >
                {policies[key].label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {(Object.keys(dialogs) as FooterDialog[]).map((key) => {
        const { label, closeLabel, Body } = dialogs[key];
        return (
          <Dialog
            key={key}
            open={open === key}
            onClose={() => {
              setOpen(null);
            }}
            title={label}
            closeLabel={closeLabel}
            footer={
              <Button
                className="ml-auto"
                onClick={() => {
                  setOpen(null);
                }}
              >
                Close
              </Button>
            }
          >
            <Body />
          </Dialog>
        );
      })}
    </footer>
  );
}
