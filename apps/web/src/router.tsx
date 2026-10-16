import { eventTypes, type EventType } from "@ai-office/events/schema";
import {
  analyticsDimensions,
  gatewayEndpoints,
  googleRedirectPath,
  skillNamePattern,
} from "@ai-office/shared";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useRouter,
  useRouterState,
  type RouterHistory,
} from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { z } from "zod";

import { ActivityFeedPage } from "./activity-feed.tsx";
import { ConnectionsPage } from "./connections-page.tsx";
import { GoogleRedirectPage } from "./google-sign-in.tsx";
import { DocumentTitle, RouteTitle } from "./document-title.tsx";
import {
  AnalyticsPage,
  analyticsRanges,
  type AnalyticsRange,
} from "./analytics-page.tsx";
import { AgentLivePage } from "./agent-live-view.tsx";
import { AgentChatPage } from "./agent-chat-page.tsx";
import { AgentSettingsPage, lobbyPlace } from "./agent-settings-page.tsx";
import { AiSettingsPage } from "./ai-settings-page.tsx";
import { BranchesPage } from "./branches-page.tsx";
import { ApiKeysPage } from "./api-keys-page.tsx";
import { FloorAdminPage } from "./floor-admin-page.tsx";
import {
  GatewayRequestPage,
  GatewayRequestsPage,
} from "./gateway-requests.tsx";
import { AppLayout } from "./layout.tsx";
import { LoginPage } from "./login-page.tsx";
import { ManagerChatPage } from "./manager-chat.tsx";
import { NoticeBoardPage } from "./notice-board.tsx";
import {
  AdminPage,
  FloorSettingsPage,
  NotFoundPage,
  OfficePage,
} from "./pages.tsx";
import { FloorTemplatesPage } from "./floor-templates-page.tsx";
import { RoleLibraryPage } from "./role-library.tsx";
import { inspectSearch, inspectTargetOf } from "./scene/inspectable.ts";
import { liftLocation } from "./scene/lift.ts";
import { useLiftStore } from "./scene/lift-store.ts";
import { SetupPage } from "./setup-page.tsx";
import { TerminalPage } from "./terminal-page.tsx";
import { OverviewPage, overviewSearchSchema } from "./overview-page.tsx";
import { WhiteboardPage } from "./whiteboard.tsx";

// Code-based routes. The setup and login pages stand alone; every other page
// is in the app layout.
const rootRoute = createRootRoute({
  component: () => (
    <>
      <RouteTitle />
      <Outlet />
    </>
  ),
  notFoundComponent: () => (
    <AppLayout>
      <DocumentTitle title="Page not found" />
      <NotFoundPage />
    </AppLayout>
  ),
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  staticData: { title: "Set up" },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  staticData: { title: "Sign in" },
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});

const floorParamsSchema = z.object({ floorId: z.string() });

/**
 * Floor Settings' search for one Floor: an Agent whose editor to open, as
 * older links have it; the Agents are in Agent Settings now, so it goes
 * there.
 */
const floorAdminSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
});

/** Floor Settings: every Floor, to add, rename or archive, and each one's Skills. */
const floorSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/floor-settings",
  staticData: { title: "Floor Settings" },
  component: FloorSettingsPage,
});

/** One Floor's settings. */
const floorAdminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/floor-settings/$floorId",
  staticData: { title: "Floor Settings" },
  validateSearch: (search) => floorAdminSearchSchema.parse(search),
  component: function FloorAdminRoute() {
    // The router's own types resolve these params to `any` in this module,
    // so they are checked here instead.
    const params: unknown = floorAdminRoute.useParams();
    const { floorId } = floorParamsSchema.parse(params);
    const search: unknown = floorAdminRoute.useSearch();
    const { agent } = floorAdminSearchSchema.parse(search);
    if (agent !== undefined) {
      return (
        <Navigate
          to="/agent-settings"
          search={{ floor: floorId, agent }}
          replace
        />
      );
    }
    return <FloorAdminPage key={floorId} floorId={floorId} />;
  },
});

/**
 * Where a Floor's settings were, under Admin (now General Settings): older
 * links, the Manager's included, go to Floor Settings, card and all.
 */
const oldFloorAdminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/floors/$floorId",
  validateSearch: (search) => floorAdminSearchSchema.parse(search),
  component: function OldFloorAdminRoute() {
    const params: unknown = oldFloorAdminRoute.useParams();
    const { floorId } = floorParamsSchema.parse(params);
    const search: unknown = oldFloorAdminRoute.useSearch();
    const { agent } = floorAdminSearchSchema.parse(search);
    const hash = useRouterState({ select: (state) => state.location.hash });
    return (
      <Navigate
        to="/floor-settings/$floorId"
        params={{ floorId }}
        search={agent === undefined ? {} : { agent }}
        hash={hash}
        replace
      />
    );
  },
});

const agentParamsSchema = z.object({
  floorId: z.string(),
  agentId: z.string(),
});

const agentLiveRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/floors/$floorId/agents/$agentId",
  staticData: { title: "Agent" },
  component: function AgentLiveRoute() {
    const params: unknown = agentLiveRoute.useParams();
    const { floorId, agentId } = agentParamsSchema.parse(params);
    return <AgentLivePage key={agentId} floorId={floorId} agentId={agentId} />;
  },
});

const agentChatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/floors/$floorId/agents/$agentId/chat",
  staticData: { title: "Agent chat" },
  component: function AgentChatRoute() {
    const params: unknown = agentChatRoute.useParams();
    const { floorId, agentId } = agentParamsSchema.parse(params);
    return <AgentChatPage key={agentId} floorId={floorId} agentId={agentId} />;
  },
});

/** The Manager chat's search: a Skill to put in its box, as running one elsewhere asks. */
const managerChatSearchSchema = z.object({
  skill: z.string().regex(skillNamePattern).optional().catch(undefined),
});

const managerChatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/floors/$floorId/manager",
  staticData: { title: "Manager chat" },
  validateSearch: (search) => managerChatSearchSchema.parse(search),
  component: function ManagerChatRoute() {
    const params: unknown = managerChatRoute.useParams();
    const { floorId } = floorParamsSchema.parse(params);
    const search: unknown = managerChatRoute.useSearch();
    const { skill } = managerChatSearchSchema.parse(search);
    const navigate = managerChatRoute.useNavigate();
    const onSkillTaken = useCallback(() => {
      void navigate({ search: {}, replace: true });
    }, [navigate]);
    return (
      <ManagerChatPage
        key={floorId}
        floorId={floorId}
        skill={skill}
        onSkillTaken={onSkillTaken}
      />
    );
  },
});

/** The whiteboard's search: the Batch to show, as a Notice links it. */
const whiteboardSearchSchema = z.object({
  batch: z.coerce.number().int().positive().optional().catch(undefined),
});

const whiteboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/floors/$floorId/whiteboard",
  staticData: { title: "Whiteboard" },
  validateSearch: (search) => whiteboardSearchSchema.parse(search),
  component: function WhiteboardRoute() {
    const params: unknown = whiteboardRoute.useParams();
    const { floorId } = floorParamsSchema.parse(params);
    const search: unknown = whiteboardRoute.useSearch();
    const { batch } = whiteboardSearchSchema.parse(search);
    const navigate = whiteboardRoute.useNavigate();
    return (
      <WhiteboardPage
        key={floorId}
        floorId={floorId}
        batchId={batch}
        onBatchChange={(next) => {
          void navigate({ search: { batch: next }, replace: true });
        }}
      />
    );
  },
});

/** Agent Settings' search: the Floor to show, or `lobby`; none for where the lift is. */
const agentSettingsSearchSchema = z.object({
  floor: z.string().min(1).optional().catch(undefined),
  /** An Agent whose editor to open, as its card in the Office links to it. */
  agent: z.string().min(1).optional().catch(undefined),
});

const agentSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agent-settings",
  staticData: { title: "Agent Settings" },
  validateSearch: (search) => agentSettingsSearchSchema.parse(search),
  component: function AgentSettingsRoute() {
    const search: unknown = agentSettingsRoute.useSearch();
    const { floor, agent } = agentSettingsSearchSchema.parse(search);
    const navigate = agentSettingsRoute.useNavigate();
    // Where the lift is, unless the address names somewhere else.
    const here = useLiftStore((state) => {
      const location = liftLocation(state.lift);
      return location.kind === "floor" ? location.floorId : lobbyPlace;
    });
    return (
      <AgentSettingsPage
        place={floor ?? here}
        agentId={agent}
        onPlaceChange={(next) => {
          void navigate({ search: { floor: next }, replace: true });
        }}
      />
    );
  },
});

const apiKeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/api-keys",
  staticData: { title: "API Key Management" },
  component: ApiKeysPage,
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/general-settings",
  staticData: { title: "General Settings" },
  component: AdminPage,
});

/**
 * Where General Settings and its pages were, under `/admin`: older links
 * and bookmarks go to the same page under `/general-settings`, with their
 * search and hash. A Floor's settings (`/admin/floors/…`) and Google's
 * sign-in callback (`googleRedirectPath`, registered with Google) have
 * routes of their own.
 */
const oldAdminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: function OldAdminRoute() {
    return <OldAdminRedirect rest="" />;
  },
});

const oldAdminPagesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/$",
  component: function OldAdminPagesRoute() {
    const params: unknown = oldAdminPagesRoute.useParams();
    const { _splat: rest = "" } = z
      .object({ _splat: z.string().optional() })
      .parse(params);
    return <OldAdminRedirect rest={rest} />;
  },
});

function OldAdminRedirect({ rest }: { rest: string }) {
  const router = useRouter();
  const { searchStr, hash } = useRouterState({
    select: (state) => ({
      searchStr: state.location.searchStr,
      hash: state.location.hash,
    }),
  });
  const path = rest === "" ? "/general-settings" : `/general-settings/${rest}`;
  const href = `${path}${searchStr}${hash === "" ? "" : `#${hash}`}`;
  useEffect(() => {
    router.history.replace(href);
  }, [router, href]);
  return null;
}

/** The Role library's search: the Role whose form is open. */
const roleLibrarySearchSchema = z.object({
  role: z.string().min(1).optional().catch(undefined),
});

const roleLibraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/general-settings/roles",
  staticData: { title: "Role library" },
  validateSearch: (search) => roleLibrarySearchSchema.parse(search),
  component: function RoleLibraryRoute() {
    const search: unknown = roleLibraryRoute.useSearch();
    const { role } = roleLibrarySearchSchema.parse(search);
    const navigate = roleLibraryRoute.useNavigate();
    return (
      <RoleLibraryPage
        openRoleId={role}
        onOpen={(next) => {
          void navigate({ search: next === undefined ? {} : { role: next } });
        }}
      />
    );
  },
});

/** The Floor Templates' search: the template that is open. */
const floorTemplatesSearchSchema = z.object({
  template: z.string().min(1).optional().catch(undefined),
});

const floorTemplatesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/general-settings/templates",
  staticData: { title: "Floor Templates" },
  validateSearch: (search) => floorTemplatesSearchSchema.parse(search),
  component: function FloorTemplatesRoute() {
    const search: unknown = floorTemplatesRoute.useSearch();
    const { template } = floorTemplatesSearchSchema.parse(search);
    const navigate = floorTemplatesRoute.useNavigate();
    return (
      <FloorTemplatesPage
        openTemplateId={template}
        onOpen={(next) => {
          void navigate({
            search: next === undefined ? {} : { template: next },
          });
        }}
      />
    );
  },
});

/**
 * AI Settings' search, from a Notice's action: an AI Account to sign in
 * again, or an AI Provider with no AI Account left.
 */
const aiSettingsSearchSchema = z.object({
  reauthenticate: z.string().min(1).optional().catch(undefined),
  aiProvider: z.string().min(1).optional().catch(undefined),
});

const aiSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ai-settings",
  staticData: { title: "AI Settings" },
  validateSearch: (search) => aiSettingsSearchSchema.parse(search),
  component: function AiSettingsRoute() {
    const search: unknown = aiSettingsRoute.useSearch();
    const { reauthenticate, aiProvider } = aiSettingsSearchSchema.parse(search);
    return (
      <AiSettingsPage reauthenticate={reauthenticate} aiProvider={aiProvider} />
    );
  },
});

/** The Connections page's search: a Connection to show, as a Notice links it. */
const connectionsSearchSchema = z.object({
  connection: z.string().min(1).optional().catch(undefined),
});

const connectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/general-settings/connections",
  staticData: { title: "Connections" },
  validateSearch: (search) => connectionsSearchSchema.parse(search),
  component: function ConnectionsRoute() {
    const search: unknown = connectionsRoute.useSearch();
    const { connection } = connectionsSearchSchema.parse(search);
    return <ConnectionsPage connection={connection} />;
  },
});

/** What Google's redirect brings back after the consent screen (FR-91). */
const googleRedirectSearchSchema = z.object({
  code: z.string().min(1).optional().catch(undefined),
  state: z.string().min(1).optional().catch(undefined),
  error: z.string().min(1).optional().catch(undefined),
});

const googleRedirectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: googleRedirectPath,
  staticData: { title: "Google sign-in" },
  validateSearch: (search) => googleRedirectSearchSchema.parse(search),
  component: function GoogleRedirectRoute() {
    const search: unknown = googleRedirectRoute.useSearch();
    const { code, state, error } = googleRedirectSearchSchema.parse(search);
    return <GoogleRedirectPage code={code} state={state} error={error} />;
  },
});

/**
 * The Office's search: an inspectable object to open, and the Floor it is
 * on (`?floor=web-shop&inspect=monitor:ada`; no Floor in the lobby).
 */
const officeSearchSchema = z.object({
  floor: z.string().min(1).optional().catch(undefined),
  inspect: z.string().min(1).optional().catch(undefined),
});

const officeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  staticData: { title: "Office", officePlace: true },
  validateSearch: (search) => officeSearchSchema.parse(search),
  component: function OfficeRoute() {
    const search: unknown = officeRoute.useSearch();
    const navigate = officeRoute.useNavigate();
    return (
      <OfficePage
        inspect={inspectTargetOf(officeSearchSchema.parse(search))}
        onInspect={(target) => {
          void navigate({
            search: target === undefined ? {} : inspectSearch(target),
            replace: true,
          });
        }}
      />
    );
  },
});

/** The Notice Board's search: a Floor to show, and a Notice to bring up. */
const noticeSearchSchema = z.object({
  floorId: z.string().min(1).optional().catch(undefined),
  notice: z.string().min(1).optional().catch(undefined),
});

const noticesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/notices",
  staticData: { title: "Notice Board" },
  validateSearch: (search) => noticeSearchSchema.parse(search),
  component: function NoticesRoute() {
    const search: unknown = noticesRoute.useSearch();
    const { floorId, notice } = noticeSearchSchema.parse(search);
    const navigate = noticesRoute.useNavigate();
    return (
      <NoticeBoardPage
        floorId={floorId}
        highlight={notice}
        onFloorChange={(next) => {
          void navigate({
            search: next === undefined ? {} : { floorId: next },
          });
        }}
      />
    );
  },
});

/** The Activity Feed's search: its filters. */
const activitySearchSchema = z.object({
  floorId: z.string().min(1).optional().catch(undefined),
  agentId: z.string().min(1).optional().catch(undefined),
  issue: z.coerce.number().int().positive().optional().catch(undefined),
  type: z
    .enum(eventTypes as [EventType, ...EventType[]])
    .optional()
    .catch(undefined),
  from: z.iso.datetime({ offset: true }).optional().catch(undefined),
  to: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

const terminalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/terminal",
  staticData: { title: "Terminal" },
  component: TerminalPage,
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity",
  staticData: { title: "Activity" },
  validateSearch: (search) => activitySearchSchema.parse(search),
  component: function ActivityRoute() {
    const search: unknown = activityRoute.useSearch();
    const filters = activitySearchSchema.parse(search);
    const navigate = activityRoute.useNavigate();
    return (
      <ActivityFeedPage
        filters={filters}
        onFiltersChange={(next) => {
          void navigate({
            search: Object.fromEntries(
              Object.entries(next).filter(([, value]) => value !== undefined),
            ),
          });
        }}
      />
    );
  },
});

const workingNowRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/overview",
  staticData: { title: "Overview" },
  validateSearch: (search) => overviewSearchSchema.parse(search),
  component: function OverviewRoute() {
    const search: unknown = workingNowRoute.useSearch();
    const filters = overviewSearchSchema.parse(search);
    const navigate = workingNowRoute.useNavigate();
    return (
      <OverviewPage
        filters={filters}
        onFiltersChange={(next) => {
          void navigate({
            search: Object.fromEntries(
              Object.entries(next).filter(([, value]) => value !== undefined),
            ),
            // Typing or filtering is not a step back to take.
            replace: true,
          });
        }}
      />
    );
  },
});

/** The request history's search: its filters. */
const gatewaySearchSchema = z.object({
  q: z.string().min(1).optional().catch(undefined),
  status: z.enum(["2xx", "3xx", "4xx", "5xx"]).optional().catch(undefined),
  endpoint: z.enum(gatewayEndpoints).optional().catch(undefined),
  floorId: z.string().min(1).optional().catch(undefined),
  agentId: z.string().min(1).optional().catch(undefined),
  ownerTool: z.string().min(1).optional().catch(undefined),
});

const gatewayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/gateway",
  staticData: { title: "Gateway requests" },
  validateSearch: (search) => gatewaySearchSchema.parse(search),
  component: function GatewayRoute() {
    const search: unknown = gatewayRoute.useSearch();
    const filters = gatewaySearchSchema.parse(search);
    const navigate = gatewayRoute.useNavigate();
    return (
      <GatewayRequestsPage
        filters={filters}
        onFiltersChange={(next) => {
          void navigate({
            search: Object.fromEntries(
              Object.entries(next).filter(([, value]) => value !== undefined),
            ),
          });
        }}
      />
    );
  },
});

const gatewayRequestParamsSchema = z.object({
  requestId: z.coerce.number().int().positive(),
});

const gatewayRequestRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/gateway/requests/$requestId",
  staticData: { title: "Gateway request" },
  component: function GatewayRequestRoute() {
    const params: unknown = gatewayRequestRoute.useParams();
    const parsed = gatewayRequestParamsSchema.safeParse(params);
    return parsed.success ? (
      <GatewayRequestPage
        key={parsed.data.requestId}
        requestId={parsed.data.requestId}
      />
    ) : (
      <NotFoundPage />
    );
  },
});

/** The analytics dashboards' search: the range, and the breakdown. */
const analyticsSearchSchema = z.object({
  range: z
    .enum(Object.keys(analyticsRanges) as [AnalyticsRange, ...AnalyticsRange[]])
    .optional()
    .catch(undefined),
  by: z.enum(analyticsDimensions).optional().catch(undefined),
});

const analyticsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/analytics",
  staticData: { title: "Analytics" },
  validateSearch: (search) => analyticsSearchSchema.parse(search),
  component: function AnalyticsRoute() {
    const search: unknown = analyticsRoute.useSearch();
    const { range, by } = analyticsSearchSchema.parse(search);
    const navigate = analyticsRoute.useNavigate();
    return (
      <AnalyticsPage
        range={range ?? "7d"}
        by={by ?? "model"}
        onChange={(next) => {
          void navigate({ search: next });
        }}
      />
    );
  },
});

/** The Branches page's search: the Floor shown. */
const branchesSearchSchema = z.object({
  floor: z.string().min(1).optional().catch(undefined),
});

const branchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/branches",
  staticData: { title: "Branches" },
  validateSearch: (search) => branchesSearchSchema.parse(search),
  component: function BranchesRoute() {
    const search: unknown = branchesRoute.useSearch();
    const { floor } = branchesSearchSchema.parse(search);
    const navigate = branchesRoute.useNavigate();
    const onFloorChange = useCallback(
      (next: string, options: { readonly replace?: boolean } = {}) => {
        void navigate({
          search: { floor: next },
          replace: options.replace ?? false,
        });
      },
      [navigate],
    );
    return <BranchesPage floorId={floor} onFloorChange={onFloorChange} />;
  },
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    officeRoute,
    noticesRoute,
    activityRoute,
    workingNowRoute,
    terminalRoute,
    adminRoute,
    oldAdminRoute,
    oldAdminPagesRoute,
    roleLibraryRoute,
    floorTemplatesRoute,
    agentSettingsRoute,
    apiKeysRoute,
    aiSettingsRoute,
    connectionsRoute,
    googleRedirectRoute,
    floorSettingsRoute,
    floorAdminRoute,
    oldFloorAdminRoute,
    agentLiveRoute,
    agentChatRoute,
    managerChatRoute,
    whiteboardRoute,
    gatewayRoute,
    gatewayRequestRoute,
    analyticsRoute,
    branchesRoute,
  ]),
]);

/** The app's router; tests pass a memory history, the browser uses its own. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    ...(history === undefined ? {} : { history }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
