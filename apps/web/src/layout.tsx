import { signedOutEverywhereSchema } from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, Outlet } from "@tanstack/react-router";
import {
  Activity,
  BrainCircuit,
  Building2,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  GitBranch,
  GripVertical,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  Network,
  Radar,
  Settings,
  SquareTerminal,
  UserCog,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { browser, postJson } from "./api.ts";
import { CompanyLogo } from "./brand/company-logo.tsx";
import { healthQuery } from "./health.ts";
import {
  clampMenuHeight,
  inOrder,
  moved,
  menuHeights,
  navigationWidths,
  useNavigationPrefs,
} from "./navigation-prefs.ts";
import { NoticeNotifier } from "./notice-notifier.tsx";
import { SignedOutError, sessionQuery } from "./session.ts";
import { SiteFooter } from "./site-footer.tsx";
import { SkipLink, mainContentId } from "./skip-link.tsx";
import { keepStillSignIn } from "./still-sign-in.ts";
import { useUiStore } from "./ui-store.ts";
import { StartupVersionCheck } from "./version-check.tsx";

const navigation: readonly {
  to:
    | "/"
    | "/overview"
    | "/notices"
    | "/activity"
    | "/terminal"
    | "/gateway"
    | "/analytics"
    | "/branches"
    | "/agent-settings"
    | "/api-keys"
    | "/ai-settings"
    | "/floor-settings"
    | "/general-settings";
  label: string;
  icon: LucideIcon;
}[] = [
  { to: "/", label: "Office", icon: Building2 },
  { to: "/overview", label: "Overview", icon: Radar },
  { to: "/notices", label: "Notices", icon: ClipboardList },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/terminal", label: "Terminal", icon: SquareTerminal },
  { to: "/gateway", label: "Gateway", icon: Network },
  { to: "/analytics", label: "Analytics", icon: ChartColumn },
  { to: "/branches", label: "Branches", icon: GitBranch },
  { to: "/agent-settings", label: "Agent Settings", icon: UserCog },
  { to: "/api-keys", label: "API Key Management", icon: KeyRound },
  { to: "/ai-settings", label: "AI Settings", icon: BrainCircuit },
  { to: "/floor-settings", label: "Floor Settings", icon: Layers },
  { to: "/general-settings", label: "General Settings", icon: Settings },
];

function ServerStatus({ collapsed = false }: { collapsed?: boolean }) {
  const { data, isError } = useQuery(healthQuery);
  const [label, healthy] = isError
    ? ["Server unreachable", false]
    : data === undefined
      ? ["Checking the server…", true]
      : data.database === "up"
        ? ["Server and database up", true]
        : ["Database down", false];
  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-full border bg-background/60 px-2.5 py-1 text-xs",
        collapsed && "md:justify-center md:border-0 md:bg-transparent md:px-0",
      )}
      title={collapsed ? label : undefined}
    >
      {data === undefined && !isError ? (
        <Spinner className="size-3 text-muted-foreground" />
      ) : (
        /* A ring around the dot, so it reads on either surface. */
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full ring-3",
            healthy
              ? "bg-success ring-success/20"
              : "bg-destructive ring-destructive/20",
          )}
        />
      )}
      <span className={cn(collapsed && "md:sr-only")}>{label}</span>
    </p>
  );
}

/**
 * Sign out here or everywhere. Also sends the browser to the login page
 * when the session has ended (expired, or signed out elsewhere). Signed
 * out everywhere, the login page then says what still signs in (A1-3).
 */
function SessionControls({ collapsed = false }: { collapsed?: boolean }) {
  const { data: session, error } = useQuery(sessionQuery);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (error instanceof SignedOutError) {
      browser.load(error.page);
    }
  }, [error]);

  const signOut = async (url: string) => {
    if (session === undefined) {
      return;
    }
    setSigningOut(true);
    const response = await postJson(url, {}, session.csrfToken);
    if (url === "/api/logout/everywhere" && response.ok) {
      const body = signedOutEverywhereSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (body.success) {
        keepStillSignIn(body.data);
      }
    }
    browser.load("/login");
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="justify-start"
        disabled={session === undefined || signingOut}
        title={collapsed ? "Sign out" : undefined}
        onClick={() => void signOut("/api/logout")}
      >
        <LogOut aria-hidden />
        <span className={cn(collapsed && "md:sr-only")}>Sign out</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("justify-start", collapsed && "md:hidden")}
        disabled={session === undefined || signingOut}
        onClick={() => void signOut("/api/logout/everywhere")}
      >
        Sign out everywhere
      </Button>
    </div>
  );
}

/**
 * The main navigation's items, in the Owner's order: each can be dragged
 * into another's place, or moved with Alt+Arrow Up and Down while it has
 * focus. The order is kept in this browser. Collapsed, only the icons show
 * on wide screens, each named by its tooltip and to screen readers.
 */
function MainNavigation({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const order = useNavigationPrefs((state) => state.order);
  const setOrder = useNavigationPrefs((state) => state.setOrder);
  const resetOrder = useNavigationPrefs((state) => state.resetOrder);
  const items = inOrder(navigation, order);
  const addresses = items.map(({ to }) => to);
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const custom = order.length > 0;

  const move = (item: string, target: string) => {
    const next = moved(addresses, item, target);
    setOrder(next);
    const label = navigation.find(({ to }) => to === item)?.label ?? item;
    setAnnouncement(
      `${label} moved to place ${String(next.indexOf(item) + 1)} of ${String(next.length)}.`,
    );
  };

  return (
    <nav aria-label="Main" aria-describedby="navigation-reorder-hint">
      <p id="navigation-reorder-hint" className="sr-only">
        Drag an item, or press Alt with the up or down arrow, to change the
        order.
      </p>
      <ul className="space-y-px">
        {items.map(({ to, label, icon: Icon }, index) => (
          <li
            key={to}
            draggable
            data-dragging={dragging === to ? "" : undefined}
            onDragStart={(event) => {
              setDragging(to);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", to);
            }}
            onDragOver={(event) => {
              if (dragging !== undefined) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(to);
              }
            }}
            onDragLeave={() => {
              setOver((current) => (current === to ? undefined : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== undefined && dragging !== to) {
                move(dragging, to);
              }
              setDragging(undefined);
              setOver(undefined);
            }}
            onDragEnd={() => {
              setDragging(undefined);
              setOver(undefined);
            }}
            className={cn(
              "group relative rounded-lg data-dragging:opacity-50",
              over === to && dragging !== to && "ring-2 ring-ring/60",
            )}
          >
            <Link
              to={to}
              title={collapsed ? label : undefined}
              onClick={onNavigate}
              onKeyDown={(event) => {
                if (!event.altKey) {
                  return;
                }
                const target =
                  event.key === "ArrowUp"
                    ? addresses[index - 1]
                    : event.key === "ArrowDown"
                      ? addresses[index + 1]
                      : undefined;
                if (target !== undefined) {
                  event.preventDefault();
                  move(to, target);
                }
              }}
              className={cn(
                // The current page: the accent's fill, its ink, and a bar in
                // the primary colour at its left edge.
                "relative flex items-center gap-2.5 rounded-lg py-1.5 pr-2 pl-3 text-sm text-foreground/80 transition-colors duration-150 hover:bg-muted hover:text-foreground data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground pointer-coarse:min-h-11",
                "before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity data-[status=active]:before:opacity-100",
                collapsed && "md:justify-center md:px-0",
              )}
            >
              <Icon
                aria-hidden
                className="size-[1.125rem] shrink-0 opacity-80 group-hover:opacity-100 in-data-[status=active]:opacity-100"
              />
              <span className={cn("flex-1", collapsed && "md:sr-only")}>
                {label}
              </span>
              <GripVertical
                aria-hidden
                className={cn(
                  // Over the item's right edge, so it takes no room of its own.
                  "absolute right-1 size-4 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100",
                  collapsed && "md:hidden",
                )}
              />
            </Link>
          </li>
        ))}
      </ul>
      {custom && !collapsed && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 text-xs text-muted-foreground"
          onClick={() => {
            resetOrder();
            setAnnouncement("The menu is back in its first order.");
          }}
        >
          Reset the order
        </Button>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </nav>
  );
}

/** How far an arrow key moves the navigation's edge, in pixels. */
const resizeStep = 16;

/**
 * The navigation's right edge, dragged to make it narrower or wider (on
 * wide screens, while it is expanded). With focus, the left and right
 * arrows move it, Home and End take it to its least and most, and Enter or
 * a double click puts it back. The width is kept in this browser.
 */
function ResizeHandle() {
  const width = useNavigationPrefs((state) => state.width);
  const setWidth = useNavigationPrefs((state) => state.setWidth);
  const resetWidth = useNavigationPrefs((state) => state.resetWidth);
  const [dragging, setDragging] = useState(false);
  const from = useRef<{ x: number; width: number } | undefined>(undefined);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the menu"
      aria-controls="navigation"
      aria-valuenow={width}
      aria-valuemin={navigationWidths.min}
      aria-valuemax={navigationWidths.max}
      aria-valuetext={`${String(width)} pixels wide`}
      title="Drag to resize the menu; double-click to reset it"
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      className="absolute inset-y-0 right-0 z-10 hidden w-1.5 cursor-col-resize touch-none outline-none hover:bg-ring/40 focus-visible:bg-ring/60 data-dragging:bg-ring/60 md:block"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        from.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (from.current !== undefined) {
          setWidth(from.current.width + event.clientX - from.current.x, false);
        }
      }}
      onPointerUp={(event) => {
        if (from.current !== undefined) {
          setWidth(from.current.width + event.clientX - from.current.x);
        }
        from.current = undefined;
        setDragging(false);
      }}
      onPointerCancel={() => {
        if (from.current !== undefined) {
          setWidth(from.current.width);
        }
        from.current = undefined;
        setDragging(false);
      }}
      onDoubleClick={resetWidth}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? width - resizeStep
            : event.key === "ArrowRight"
              ? width + resizeStep
              : event.key === "Home"
                ? navigationWidths.min
                : event.key === "End"
                  ? navigationWidths.max
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          setWidth(next);
        } else if (event.key === "Enter") {
          event.preventDefault();
          resetWidth();
        }
      }}
    />
  );
}

/**
 * The line above Sign out, dragged up or down to make the menu of pages
 * shorter or taller (on wide screens), the menu scrolling within it when
 * its pages do not fit. With focus, the up and down arrows move it, Home
 * and End take it to its least and to all its pages, and Enter or a double
 * click gives the menu back its own height. The height is kept in this
 * browser.
 */
function MenuDivider({ menu }: { menu: RefObject<HTMLDivElement | null> }) {
  const height = useNavigationPrefs((state) => state.menuHeight);
  const setHeight = useNavigationPrefs((state) => state.setMenuHeight);
  const resetHeight = useNavigationPrefs((state) => state.resetMenuHeight);
  const [dragging, setDragging] = useState(false);
  const from = useRef<{ y: number; height: number } | undefined>(undefined);

  /** All the menu's pages: no taller than that, so nothing is left below. */
  const tallest = () => {
    const pages = menu.current?.scrollHeight ?? 0;
    return pages > 0 ? Math.max(menuHeights.min, pages) : menuHeights.max;
  };
  const set = (next: number, save = true) => {
    setHeight(Math.min(tallest(), next), save);
  };
  const current = () => height ?? menu.current?.clientHeight ?? 0;

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the menu's pages"
      aria-controls="navigation-pages"
      aria-valuenow={height}
      aria-valuemin={menuHeights.min}
      aria-valuetext={
        height === undefined
          ? "All the pages showing"
          : `${String(height)} pixels tall`
      }
      title="Drag to make the menu shorter or taller; double-click to reset it"
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        // A tall strip to grab, with the line through its middle.
        height === undefined ? "mt-auto" : "-mt-1.5",
        "relative -mb-1.5 hidden h-3 shrink-0 cursor-row-resize touch-none rounded-full outline-none md:block",
        "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-border hover:before:h-0.5 hover:before:bg-ring/60 focus-visible:before:h-0.5 focus-visible:before:bg-ring data-dragging:before:h-0.5 data-dragging:before:bg-ring",
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        from.current = { y: event.clientY, height: current() };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (from.current !== undefined) {
          set(from.current.height + event.clientY - from.current.y, false);
        }
      }}
      onPointerUp={(event) => {
        if (from.current !== undefined) {
          set(from.current.height + event.clientY - from.current.y);
        }
        from.current = undefined;
        setDragging(false);
      }}
      onPointerCancel={() => {
        if (from.current !== undefined) {
          set(from.current.height);
        }
        from.current = undefined;
        setDragging(false);
      }}
      onDoubleClick={resetHeight}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowUp"
            ? current() - resizeStep
            : event.key === "ArrowDown"
              ? current() + resizeStep
              : event.key === "Home"
                ? menuHeights.min
                : event.key === "End"
                  ? tallest()
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          set(clampMenuHeight(next));
        } else if (event.key === "Enter") {
          event.preventDefault();
          resetHeight();
        }
      }}
    />
  );
}

/**
 * The frame around every page: a skip link, navigation, server status, the
 * page (the matched route, unless `children` is given) and the footer.
 */
/**
 * Nothing of the app, not its navigation nor any page, until the session
 * is known to be signed in: the server serves its pages only to a signed-in
 * Owner, but the browser can reach them by itself once the page is loaded.
 * Signed out, or not set up yet, the browser goes to sign in or set up.
 */
export function AppLayout({ children }: { children?: ReactNode }) {
  const { data: session, error } = useQuery(sessionQuery);
  const signedOut = error instanceof SignedOutError;
  useEffect(() => {
    if (error instanceof SignedOutError) {
      browser.load(error.page);
    }
  }, [error]);
  if (session === undefined || signedOut) {
    return (
      <main
        id="main"
        className="flex min-h-dvh items-center justify-center p-4 text-sm text-muted-foreground"
      >
        {error !== null && !signedOut ? (
          <p role="alert">
            AI Office could not check that you are signed in. Reload the page to
            try again.
          </p>
        ) : (
          <p role="status">Checking that you are signed in…</p>
        )}
      </main>
    );
  }
  return <SignedInLayout>{children}</SignedInLayout>;
}

function SignedInLayout({ children }: { children?: ReactNode }) {
  const navigationOpen = useUiStore((state) => state.navigationOpen);
  const toggleNavigation = useUiStore((state) => state.toggleNavigation);
  const closeNavigation = useUiStore((state) => state.closeNavigation);
  const collapsed = useNavigationPrefs((state) => state.collapsed);
  const toggleCollapsed = useNavigationPrefs((state) => state.toggleCollapsed);
  const width = useNavigationPrefs((state) => state.width);
  const menuHeight = useNavigationPrefs((state) => state.menuHeight);
  const menu = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <div className="flex flex-1 flex-col md:flex-row">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/85 px-4 py-2 backdrop-blur-md md:hidden">
          <CompanyLogo />
          <Button
            variant="ghost"
            size="icon"
            aria-controls="navigation"
            aria-expanded={navigationOpen}
            aria-label={navigationOpen ? "Close navigation" : "Open navigation"}
            onClick={toggleNavigation}
          >
            {navigationOpen ? <X /> : <Menu />}
          </Button>
        </header>

        {/* Sticky on wide screens: it stays put as the page scrolls. */}
        <aside
          id="navigation"
          data-collapsed={collapsed ? "" : undefined}
          style={
            {
              "--navigation-width": `${String(width)}px`,
              ...(menuHeight !== undefined && {
                "--menu-height": `${String(menuHeight)}px`,
              }),
            } as CSSProperties
          }
          className={cn(
            "flex-col gap-4 border-b bg-card p-4 md:sticky md:top-0 md:flex md:h-dvh md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0 md:pt-4",
            collapsed
              ? "md:w-16 md:px-2"
              : "md:w-[var(--navigation-width)] md:pr-2",
            navigationOpen ? "flex" : "hidden",
          )}
        >
          {!collapsed && <ResizeHandle />}
          <div
            className={cn(
              "hidden items-center justify-between gap-2 md:flex",
              collapsed && "md:flex-col",
            )}
          >
            {!collapsed && <CompanyLogo />}
            <Button
              variant="ghost"
              size="icon"
              aria-controls="navigation"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
              title={collapsed ? "Expand the menu" : "Collapse the menu"}
              onClick={toggleCollapsed}
            >
              {collapsed ? (
                <ChevronsRight aria-hidden />
              ) : (
                <ChevronsLeft aria-hidden />
              )}
            </Button>
          </div>
          {/* Its own height, or the Owner's, scrolling within it either way. */}
          <div
            id="navigation-pages"
            ref={menu}
            className={cn(
              "md:min-h-0 md:overflow-y-auto",
              menuHeight !== undefined &&
                "md:h-[var(--menu-height)] md:shrink-0",
            )}
          >
            <MainNavigation
              collapsed={collapsed}
              onNavigate={closeNavigation}
            />
          </div>
          {/* At the foot with Sign out, until the Owner moves it. */}
          <MenuDivider menu={menu} />
          <div className="space-y-2 border-t pt-3 text-muted-foreground md:border-t-0 md:pt-0">
            <SessionControls collapsed={collapsed} />
            <ServerStatus collapsed={collapsed} />
          </div>
        </aside>

        <main
          id={mainContentId}
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          {children ?? <Outlet />}
        </main>
      </div>
      {/* The full width of the page, under the navigation too. */}
      <SiteFooter />
      <NoticeNotifier />
      <StartupVersionCheck />
    </div>
  );
}
