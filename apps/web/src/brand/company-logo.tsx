import { cn } from "@/lib/utils.ts";

import { brand } from "./brand.ts";

/**
 * The company's horizontal logo, as set in `brand.ts`: the dark-mode one
 * swaps in when the page is dark.
 */
export function CompanyLogo({ className }: { className?: string }) {
  return (
    <span className={cn("block h-8", className)}>
      <img
        src={brand.logo}
        alt={brand.name}
        className="h-full w-auto dark:hidden"
        data-testid="company-logo"
      />
      <img
        src={brand.logoDark}
        alt={brand.name}
        className="hidden h-full w-auto dark:block"
        data-testid="company-logo-dark"
      />
    </span>
  );
}
