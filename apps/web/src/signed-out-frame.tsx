import type { ReactNode } from "react";

import { CompanyLogo } from "@/brand/company-logo.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import { SiteFooter } from "./site-footer.tsx";

/** A centred card, and the footer, for the pages shown before the Owner is signed in. */
export function SignedOutFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden">
      {/* The logo's indigo-to-violet, as a soft light behind the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60rem_32rem_at_50%_-8rem,color-mix(in_oklab,#6366f1_18%,transparent),transparent_70%),radial-gradient(40rem_24rem_at_85%_110%,color-mix(in_oklab,#7c3aed_12%,transparent),transparent_70%)]"
      />
      <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
        <CompanyLogo className="h-10" />
        <Card className="w-full max-w-sm shadow-lg">
          <CardHeader>
            <CardTitle>
              <h1 className="text-xl font-semibold tracking-[-0.02em]">
                {title}
              </h1>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </main>
      <SiteFooter />
    </div>
  );
}
