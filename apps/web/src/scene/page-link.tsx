import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/** A link to a page of AI Office, opened without a reload when it can be. */
export function PageLink({
  href,
  navigate,
  children,
}: {
  href: string;
  navigate?: ((href: string) => void) | undefined;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
      onClick={(event) => {
        if (navigate !== undefined) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      <ExternalLink aria-hidden className="size-4" />
      {children}
    </a>
  );
}
