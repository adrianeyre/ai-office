import { PageHeader } from "@/components/ui/page-header.tsx";
import { AiAccountsCard } from "./ai-accounts-card.tsx";
import { AiProvidersCard } from "./ai-providers-card.tsx";
import { AutoRefreshCard } from "./auto-refresh-card.tsx";
import { CombosCard } from "./combos-card.tsx";
import { DecisionModelCard } from "./decision-model-card.tsx";
import { GatewayKeysCard } from "./gateway-keys-card.tsx";
import { KeepAliveCard } from "./keep-alive-card.tsx";
import { LoadBalancingCard } from "./load-balancing-card.tsx";
import { ModelMappingsCard } from "./model-mappings-card.tsx";
import { ModelPricesCard } from "./model-prices-card.tsx";
import { OutboundProxyCard } from "./outbound-proxy-card.tsx";
import { RequestBodiesCard } from "./request-bodies-card.tsx";
import { RetriesCard } from "./retries-card.tsx";
import { TokenCapsCard } from "./token-caps.tsx";
import { UsageThrottlingCard } from "./usage-throttling-card.tsx";

// AI Settings (PRD FR-65, §6.8): the AI Providers, the Decision Model
// (FR-17), the AI Accounts the AI Gateway serves from, and the rest of the
// Gateway's configuration, apart from the office's own settings in Admin.

export function AiSettingsPage({
  reauthenticate,
  aiProvider,
}: {
  /** An AI Account to sign in again, as a Notice's action asks. */
  reauthenticate?: string | undefined;
  /** An AI Provider with no AI Account left, as a Notice's action asks. */
  aiProvider?: string | undefined;
} = {}) {
  return (
    <section className="space-y-6">
      <PageHeader
        title="AI Settings"
        description={
          <>
            The AI Providers and their accounts, and how the AI Gateway serves
            every Agent&apos;s model calls.
          </>
        }
      />
      <AiProvidersCard />
      <DecisionModelCard />
      <AiAccountsCard reauthenticate={reauthenticate} aiProvider={aiProvider} />
      <LoadBalancingCard />
      <UsageThrottlingCard />
      <AutoRefreshCard />
      <KeepAliveCard />
      <RetriesCard />
      <OutboundProxyCard />
      <CombosCard />
      <ModelMappingsCard />
      <GatewayKeysCard />
      <ModelPricesCard />
      <RequestBodiesCard />
      <TokenCapsCard />
    </section>
  );
}
