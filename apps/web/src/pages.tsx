import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { CommunicationsCard } from "./connections-page.tsx";
import { AppearanceCard } from "./appearance-card.tsx";
import { ConfigurationCard } from "./configuration-card.tsx";
import { CreditsCard } from "./credits-card.tsx";
import { AvailableSkillsCard } from "./available-skills.tsx";
import { FloorsCard } from "./floors-card.tsx";
import { GitHubConnectionsCard } from "./github-connections-card.tsx";
import { GitIdentityCard } from "./git-identity-card.tsx";
import { IntakeCard } from "./intake-card.tsx";
import { NoticeAlertsCard } from "./notice-alerts-card.tsx";
import { Office2D } from "./office-2d.tsx";
import { useOfficePlace } from "./office-place.ts";
import { usePhoneView } from "./phone-view.ts";
import { OfficeMemoryCard } from "./office-memory-card.tsx";
import { PromptCacheCard } from "./prompt-cache-card.tsx";
import { RetentionCard } from "./retention-card.tsx";
import type { InspectTarget } from "./scene/inspectable.ts";
import { OfficeView } from "./scene/office-view.tsx";
import { SandboxesCard } from "./sandboxes-card.tsx";
import { SeasonalEventsCard } from "./seasonal-events-card.tsx";
import { FloorTemplatesCard } from "./floor-templates-page.tsx";
import { RoleLibraryCard } from "./role-library.tsx";
import { SkillsCard } from "./skills-card.tsx";
import { StorageCard } from "./storage-card.tsx";
import { TotpSettings } from "./totp-settings.tsx";
import { VersionCard } from "./version-check.tsx";
import { WebhooksCard } from "./webhooks-card.tsx";

// Placeholders until each page is built; every one names what it will hold.

function Placeholder({
  title,
  description,
  comingSoon,
  children,
}: {
  title: string;
  description: string;
  comingSoon: string;
  /** What the page already holds, above what is still to come. */
  children?: ReactNode;
}) {
  return (
    <section className="space-y-6">
      <PageHeader title={title} description={description} />
      {children}
      <Card>
        <CardHeader>
          <CardTitle>Nothing here yet</CardTitle>
          <CardDescription>{comingSoon}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </section>
  );
}

export function OfficePage({
  inspect,
  onInspect,
}: {
  /** An object to open in the Office, from its address. */
  inspect?: InspectTarget | undefined;
  /** Told when an object's panel opens or closes, to keep the address in step. */
  onInspect?: ((target: InspectTarget | undefined) => void) | undefined;
} = {}) {
  const router = useRouter();
  const title = `Office - ${useOfficePlace()}`;
  // Phones get the Office in 2D instead of the 3D one (PRD §7).
  const phone = usePhoneView();
  if (phone) {
    return (
      <section className="space-y-6">
        <PageHeader
          title="Office"
          description={
            <>
              The Office in 2D: its Notices, its latest activity, every Floor
              with its Agents, and Admin.
            </>
          }
        />
        <Office2D inspect={inspect} />
      </section>
    );
  }
  // The screen less the main area's padding and the footer, so the footer
  // stays above the fold.
  return (
    <section className="flex min-h-[calc(100dvh-3rem-var(--site-footer-height,0px))] flex-col gap-4 lg:min-h-[calc(100dvh-4rem-var(--site-footer-height,0px))]">
      <PageHeader
        title={title}
        description={
          <>Every Floor, and the lobby with the office-wide Notice Board.</>
        }
      />
      <OfficeView
        navigate={(href) => {
          router.history.push(href);
        }}
        inspect={inspect}
        onInspect={onInspect}
      />
    </section>
  );
}

export function AdminPage() {
  return (
    <Placeholder
      title="General Settings"
      description="Configuration for the whole Office. Each Floor's own settings are in Floor Settings; the AI Providers, their accounts and the AI Gateway are in AI Settings."
      comingSoon="More office settings, such as notification channels, will be set here."
    >
      <AppearanceCard />
      <SeasonalEventsCard />
      <RoleLibraryCard />
      <FloorTemplatesCard />
      <SkillsCard />
      <OfficeMemoryCard />
      <IntakeCard />
      <WebhooksCard />
      <SandboxesCard />
      <GitIdentityCard />
      <PromptCacheCard />
      <RetentionCard />
      <StorageCard />
      <ConfigurationCard />
      <NoticeAlertsCard />
      <CommunicationsCard />
      <TotpSettings />
      <CreditsCard />
      <VersionCard />
    </Placeholder>
  );
}

/**
 * Floor Settings: every Floor, to add, rename, archive or open for its own
 * settings (`/floor-settings/:floorId`), and the Skills each one has.
 */
export function FloorSettingsPage() {
  return (
    <section className="space-y-6">
      <PageHeader
        title="Floor Settings"
        description="The GitHub Apps and access tokens the Office works through, and every Floor: add one, rename or archive it, or open its own settings (its Manager, Merge Policy, Skills, memory and more)."
      />
      <GitHubConnectionsCard />
      <FloorsCard />
      <AvailableSkillsCard />
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section>
      <PageHeader
        title="Page not found"
        description="There is no page at this address."
      />
    </section>
  );
}
