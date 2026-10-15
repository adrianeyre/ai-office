import type { OfficeEvent } from "@ai-office/events/schema";
import { eventTypes } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import { randomAvatar } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sourceLinks } from "./activity-feed.tsx";
import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { describeEvent, eventTypeGroups } from "./event-text.ts";
import { createAppRouter } from "./router.tsx";

// The Activity Feed (PRD FR-52) against a stubbed server, with the live
// event stream driven by the test.

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 8, 12, 0, second)).toISOString();

const stored = (id: number, event: OfficeEvent): StreamedEvent => ({
  id,
  occurredAt: at(id),
  event,
});

const log: StreamedEvent[] = [
  stored(1, {
    type: "sign_in.succeeded",
    version: 1,
    ip: "203.0.113.7",
    userAgent: null,
  }),
  stored(2, {
    type: "floor.created",
    version: 1,
    floorId: "web-shop",
    name: "web-shop",
    repository: "adrianeyre/web-shop",
  }),
  stored(3, {
    type: "issue.label_changed",
    version: 1,
    floorId: "web-shop",
    issue: 4,
    agentId: "ada",
    from: "needs-work",
    to: "needs-review",
  }),
  stored(4, {
    type: "notice.raised",
    version: 1,
    noticeId: "notice-1",
    kind: "action",
    title: "PR #14 awaiting your approval",
    floorId: "blog",
  }),
  stored(5, {
    type: "config.changed",
    version: 1,
    scope: "floor",
    floorId: "blog",
    keys: ["roundCap"],
  }),
];

const floor = (id: string) => ({
  id,
  name: id,
  repository: `adrianeyre/${id}`,
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office" as const,
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  mergePolicy: "send_to_me",
  roundCap: 3,
  tokenCaps: { daily: null, monthly: null },
  concurrencyLimit: null,
  priority: 0,
  requiredReviewerAgentIds: [],
  planApproval: true,
  mostAgents: 8,
  spinOffFromChat: true,
  hourlyStatusUpdates: true,
  freshStartThreshold: 85,
  gitIdentity: null,
  createdAt: at(0),
  archivedAt: null,
});

const ada = {
  id: "ada",
  floorId: "web-shop",
  name: "Ada",
  role: "coder",
  stage: "work",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  freshStartThreshold: null,
  enabled: true,
  avatar: randomAvatar(() => 0.5, []),
  tokenCaps: { daily: null, monthly: null },
  createdAt: at(0),
  leavingAt: null,
  contractor: null,
};

/** A server answering GET /api/events from `log`, as the real one does. */
function stubServer(pageSize = 50) {
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const parsed = new URL(url, "http://office");
      if (parsed.pathname === "/api/events") {
        requests.push(parsed);
        const query = parsed.searchParams;
        const before = Number(query.get("before") ?? Infinity);
        const types = query.get("type")?.split(",");
        const matching = log
          .filter(({ id, occurredAt, event }) => {
            const fields = event as {
              floorId?: string;
              agentId?: string;
              issue?: number;
            };
            return (
              id < before &&
              (!query.has("floorId") ||
                fields.floorId === query.get("floorId")) &&
              (!query.has("agentId") ||
                fields.agentId === query.get("agentId")) &&
              (!query.has("issue") ||
                String(fields.issue) === query.get("issue")) &&
              (types === undefined || types.includes(event.type)) &&
              (!query.has("from") || occurredAt >= (query.get("from") ?? "")) &&
              (!query.has("to") || occurredAt < (query.get("to") ?? ""))
            );
          })
          .toReversed();
        const events = matching.slice(0, pageSize);
        return Promise.resolve(
          Response.json({
            events,
            nextBefore:
              matching.length > pageSize ? (events.at(-1)?.id ?? null) : null,
          }),
        );
      }
      if (url === "/api/floors") {
        return Promise.resolve(
          Response.json({ floors: [floor("web-shop"), floor("blog")] }),
        );
      }
      if (url === "/api/floors/web-shop/agents") {
        return Promise.resolve(Response.json({ agents: [ada] }));
      }
      if (url === "/api/floors/blog/agents") {
        return Promise.resolve(Response.json({ agents: [] }));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({ csrfToken: "csrf", expiresAt: at(59) }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { requests };
}

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];

function renderAt(path: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <App
      router={router}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return router;
}

const entries = async () => {
  const list = await screen.findByRole("list", { name: "Activity" });
  return within(list)
    .getAllByRole("listitem")
    .filter((item) => item.parentElement === list);
};

const texts = async () =>
  (await entries()).map((item) => item.querySelector("p")?.textContent ?? "");

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  streams = [];
  vi.spyOn(eventSources, "open").mockImplementation((url) => {
    const source: FakeStream = {
      url,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() {
        source.readyState = 2;
      },
      send(data: unknown) {
        source.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(data) }),
        );
      },
    };
    streams.push(source);
    return source;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Activity Feed", () => {
  it("lists every event newest first, each linked to its source", async () => {
    stubServer();
    renderAt("/activity");
    await waitFor(async () => {
      expect(await texts()).toEqual([
        "Floor settings changed: roundCap.",
        "Action Notice: PR #14 awaiting your approval",
        "#4 moved from needs-work to needs-review by Ada.",
        'Floor "web-shop" added for adrianeyre/web-shop.',
        "The Owner signed in from 203.0.113.7.",
      ]);
    });
    const [, notice, moved] = await entries();
    if (notice === undefined || moved === undefined) {
      throw new Error("The feed lost its entries.");
    }
    const movedSources = within(
      within(moved).getByRole("list", { name: "Sources" }),
    );
    expect(
      movedSources
        .getByRole("link", { name: "#4 on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/4");
    expect(
      movedSources.getByRole("link", { name: "Ada" }).getAttribute("href"),
    ).toBe("/?floor=web-shop&inspect=agent%3Aada");
    expect(
      within(notice).getByRole("link", { name: "Notice" }).getAttribute("href"),
    ).toBe("/notices?notice=notice-1");
    expect(screen.getByText("That is everything.")).toBeDefined();
  });

  it("narrows the list by Floor, Agent, issue and type, in the address", async () => {
    const { requests } = stubServer();
    const router = renderAt("/activity");
    await screen.findByRole("list", { name: "Activity" });

    await screen.findByRole("option", { name: "blog" });
    await userEvent.selectOptions(screen.getByLabelText("Floor"), "web-shop");
    await waitFor(async () => {
      expect(await texts()).toHaveLength(2);
    });
    expect(router.state.location.search).toEqual({ floorId: "web-shop" });

    await userEvent.selectOptions(screen.getByLabelText("Agent"), "ada");
    await waitFor(async () => {
      expect(await texts()).toEqual([
        "#4 moved from needs-work to needs-review by Ada.",
      ]);
    });

    await userEvent.selectOptions(screen.getByLabelText("Floor"), "");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "Signed in");
    await waitFor(async () => {
      expect(await texts()).toEqual(["The Owner signed in from 203.0.113.7."]);
    });
    expect(router.state.location.search).toEqual({ type: "sign_in.succeeded" });

    await userEvent.selectOptions(screen.getByLabelText("Type"), "");
    await userEvent.type(screen.getByLabelText("Issue"), "4");
    await waitFor(async () => {
      expect(await texts()).toHaveLength(1);
    });
    expect(requests.at(-1)?.searchParams.get("issue")).toBe("4");
  });

  it("narrows the list by time", async () => {
    stubServer();
    renderAt(
      `/activity?from=${encodeURIComponent(at(2))}&to=${encodeURIComponent(at(4))}`,
    );
    await waitFor(async () => {
      expect(await texts()).toEqual([
        "#4 moved from needs-work to needs-review by Ada.",
        'Floor "web-shop" added for adrianeyre/web-shop.',
      ]);
    });
    expect(screen.getByLabelText<HTMLInputElement>("From").value).not.toBe("");
  });

  it("loads older events a page at a time", async () => {
    const { requests } = stubServer(2);
    renderAt("/activity");
    await waitFor(async () => {
      expect(await texts()).toHaveLength(2);
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Load older events" }),
    );
    await waitFor(async () => {
      expect(await texts()).toHaveLength(4);
    });
    expect(requests.at(-1)?.searchParams.get("before")).toBe("4");
    await userEvent.click(
      screen.getByRole("button", { name: "Load older events" }),
    );
    await waitFor(async () => {
      expect(await texts()).toHaveLength(5);
    });
    expect(screen.getByText("That is everything.")).toBeDefined();
  });

  it("streams nothing in when the time range has ended", async () => {
    stubServer();
    renderAt(`/activity?to=${encodeURIComponent(at(4))}`);
    await waitFor(async () => {
      expect(await texts()).toHaveLength(3);
    });
    // No stream at all: Browser notifications are off here.
    expect(streams).toEqual([]);
  });

  it("shows new events at the top as they stream in", async () => {
    stubServer();
    renderAt("/activity?floorId=web-shop");
    await waitFor(async () => {
      expect(await texts()).toHaveLength(2);
    });
    const stream = streams.find(({ url }) => url.includes("floorId=web-shop"));
    // It resumes right after the newest event read, so none is missed.
    expect(stream?.url).toBe(
      "/api/events/stream?floorId=web-shop&lastEventId=3",
    );
    act(() => {
      stream?.send(
        stored(6, {
          type: "agent.status_changed",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          status: "working",
          issue: 4,
        }),
      );
    });
    await waitFor(async () => {
      expect((await texts())[0]).toBe("Ada is working on #4.");
    });
    expect(await texts()).toHaveLength(3);
  });
});

describe("event text", () => {
  it("lists every event type in exactly one group", () => {
    const grouped = eventTypeGroups.flatMap(({ types }) => types);
    expect([...grouped].sort()).toEqual([...eventTypes].sort());
  });

  it("names Agents, and never needs more than the event", () => {
    expect(
      describeEvent(
        {
          type: "handoff",
          version: 1,
          floorId: "web-shop",
          issue: 4,
          fromAgentId: "ada",
          toAgentId: "grace",
          stage: "needs-review",
          summary: { changed: "Added the basket.", check: "", risks: "" },
        },
        { agent: (id) => (id === "ada" ? "Ada" : "Grace") },
      ),
    ).toBe("Ada handed #4 to Grace (needs-review): Added the basket.");
    const statusUpdate: Extract<OfficeEvent, { type: "status_update.given" }> =
      {
        type: "status_update.given",
        version: 1,
        floorId: "web-shop",
        agentId: "grace",
        agentIds: ["ada"],
        day: "2026-10-12",
        reportedDay: "2026-10-09",
        trigger: "daily",
        messageId: 7,
      };
    expect(
      describeEvent(statusUpdate, {
        agent: (id) => (id === "ada" ? "Ada" : "Grace"),
      }),
    ).toBe(
      "Grace gave the Floor's Status update, as it was opened first today: 2 Agents on Friday 9 October, and today.",
    );
    expect(
      describeEvent(
        { ...statusUpdate, trigger: "hourly", reportedDay: "2026-10-12" },
        { agent: (id) => (id === "ada" ? "Ada" : "Grace") },
      ),
    ).toBe(
      "Grace gave the Floor's hourly Status update, as its Agents work: 2 Agents in the last hour, and today.",
    );
    expect(
      describeEvent({
        type: "sign_in.locked_out",
        version: 1,
        ip: "203.0.113.7",
        lockoutSeconds: 120,
      }),
    ).toBe("Sign-ins from 203.0.113.7 are locked out for 120 seconds.");
    expect(
      describeEvent({
        type: "cap.warning",
        version: 1,
        level: "office",
        period: "daily",
        used: 800_000,
        cap: 1_000_000,
      }),
    ).toBe(
      "The Office used 80% of its daily Token Cap (800,000 of 1,000,000 tokens).",
    );
  });

  it("names Floors as the Owner chose, and tells of a rename (PRD FR-7)", () => {
    const names = {
      agent: (id: string) => id,
      floor: (id: string) => (id === "web-shop" ? "Storefront" : id),
    };
    expect(
      describeEvent(
        {
          type: "floor.renamed",
          version: 1,
          floorId: "web-shop",
          name: "Storefront",
          previousName: "web-shop",
        },
        names,
      ),
    ).toBe('Floor "web-shop" renamed "Storefront".');
    expect(
      describeEvent(
        { type: "floor.archived", version: 1, floorId: "web-shop" },
        names,
      ),
    ).toBe('Floor "Storefront" archived.');
    expect(
      describeEvent(
        {
          type: "cap.reached",
          version: 1,
          level: "floor",
          period: "monthly",
          floorId: "web-shop",
          used: 10,
          cap: 10,
        },
        names,
      ),
    ).toBe(
      'Floor "Storefront" reached its monthly Token Cap (10 of 10 tokens).',
    );
  });

  it("tells of Contractors arriving, kept and leaving, and the issues the Manager files for a chat request (ADR 0004)", () => {
    const names = {
      agent: (id: string) => (id === "mira" ? "Mira" : "Migration writer"),
    };
    expect(
      describeEvent(
        {
          type: "contractor.added",
          version: 1,
          floorId: "web-shop",
          agentId: "mo",
          name: "Migration writer",
          role: "contractor-1a2b3c4d5e",
          roleName: "Migration writer",
          oneOff: true,
          kind: "work",
          batchId: 4,
          managerId: "mira",
        },
        names,
      ),
    ).toBe(
      "Mira added Migration writer, a Contractor in a one-off Migration writer Role, for Batch 4.",
    );
    expect(
      describeEvent(
        {
          type: "contractor.kept",
          version: 1,
          floorId: "web-shop",
          agentId: "mo",
        },
        names,
      ),
    ).toBe(
      "The Owner kept Migration writer on the team: no longer a Contractor.",
    );
    expect(
      describeEvent({
        type: "contractor.left",
        version: 1,
        floorId: "web-shop",
        agentId: "mo",
        name: "Migration writer",
        batchId: 4,
      }),
    ).toBe("Migration writer left: Batch 4 needs it no more.");
    expect(
      describeEvent(
        {
          type: "manager.issue_filed",
          version: 1,
          floorId: "web-shop",
          issue: 12,
          agentId: "mira",
          title: "Add the status column",
          url: "https://github.com/adrianeyre/web-shop/issues/12",
          messageId: 41,
        },
        names,
      ),
    ).toBe(
      'Mira filed issue #12 "Add the status column" for the Owner\'s chat request.',
    );
  });

  it("names the Floor Template a Floor, a Role or a Skill came from (PRD FR-97)", () => {
    const created = {
      type: "floor.created",
      version: 1,
      floorId: "blog",
      name: "blog",
      repository: "adrianeyre/blog",
    } as const;
    expect(describeEvent(created)).toBe(
      'Floor "blog" added for adrianeyre/blog.',
    );
    expect(
      describeEvent({ ...created, template: { id: "blank", name: "Blank" } }),
    ).toBe(
      'Floor "blog" added for adrianeyre/blog, from the Blank Floor Template.',
    );
    const role = {
      type: "role.created",
      version: 1,
      roleId: "merchandiser",
      name: "merchandiser",
      stage: "work",
      duplicatedFrom: null,
    } as const;
    expect(describeEvent(role)).toBe(
      'Role "merchandiser" made, in the work Stage.',
    );
    expect(
      describeEvent({
        ...role,
        template: { id: "online-store", name: "Online store" },
      }),
    ).toBe(
      'Role "merchandiser" added to the library by the Online store Floor Template, in the work Stage.',
    );
    expect(
      describeEvent({
        type: "skill.added",
        version: 1,
        skillId: "b6f1c3a2-1d4e-4f5a-9b8c-7d6e5f4a3b2c",
        name: "product-data",
        source: "template",
        enabled: true,
        template: { id: "online-store", name: "Online store" },
      }),
    ).toBe(
      'Skill "product-data" added to the library by the Online store Floor Template.',
    );
  });

  it("says what happened to each of the Owner's Floor Templates (PRD FR-101)", () => {
    const added = {
      type: "floor_template.added",
      version: 1,
      templateId: "my-shop",
      name: "My shop",
      source: "floor",
      duplicatedFrom: null,
      floorId: "web-shop",
      enabled: true,
    } as const;
    const changed = {
      type: "floor_template.changed",
      version: 1,
      templateId: "my-shop",
      name: "My shop",
      change: "edited",
      keys: ["roles", "manager", "theme"],
    } as const;
    expect(
      [
        added,
        {
          ...added,
          source: "duplicate",
          floorId: null,
          duplicatedFrom: { id: "development", name: "Development" },
        },
        { ...added, source: "file", floorId: null, enabled: false },
        { ...added, source: "git", floorId: null, enabled: false },
        changed,
        { ...changed, change: "reviewed", keys: [] },
        { ...changed, change: "replaced", keys: ["files"] },
        {
          type: "floor_template.removed",
          version: 1,
          templateId: "my-shop",
          name: "My shop",
        },
      ].map((event) => describeEvent(event as OfficeEvent)),
    ).toEqual([
      'Floor Template "My shop" saved from the web-shop Floor\'s set-up.',
      'Floor Template "My shop" made as a copy of Development.',
      'Floor Template "My shop" imported from a file; it waits for review before a Floor can be added from it.',
      'Floor Template "My shop" imported from Git; it waits for review before a Floor can be added from it.',
      'Floor Template "My shop" changed: Roles and counts, Manager\'s guidance, 3D theme.',
      'Floor Template "My shop" reviewed and enabled: a Floor can be added from it.',
      'Floor Template "My shop" replaced by a configuration import; it waits for review before a Floor can be added from it.',
      'Floor Template "My shop" deleted. Floors added from it keep everything it set up.',
    ]);
  });

  it("says how a Grilling Session went, from its counts", () => {
    const changed = (
      change: Extract<
        OfficeEvent,
        { type: "grilling.session_changed" }
      >["change"],
      status: "active" | "paused" | "ended" = "active",
    ): OfficeEvent => ({
      type: "grilling.session_changed",
      version: 1,
      floorId: "web-shop",
      agentId: "mo",
      sessionId: 3,
      change,
      status,
      round: 2,
      openQuestions: 1,
      decisions: 4,
    });
    const names = { agent: () => "Evelyn" };
    expect(
      [
        changed("started"),
        changed("round"),
        changed("settled"),
        changed("paused", "paused"),
        changed("resumed"),
        changed("ended", "ended"),
      ].map((event) => describeEvent(event, names)),
    ).toEqual([
      "Evelyn started Grilling Session 3, in the meeting room.",
      "Evelyn asked round 2 of Grilling Session 3: 1 question open, 4 decisions settled.",
      "Grilling Session 3, round 2: 1 question open, 4 decisions settled.",
      "Grilling Session 3 was paused in round 2, with 1 question open and 4 decisions settled.",
      "Grilling Session 3 was resumed in round 2, with 1 question open and 4 decisions settled.",
      "Grilling Session 3 ended with 4 decisions settled.",
    ]);
  });

  it("says what auto-refresh did to an AI Account's usage windows", () => {
    const refreshed: Extract<
      OfficeEvent,
      { type: "ai_account.window_refreshed" }
    > = {
      type: "ai_account.window_refreshed",
      version: 1,
      aiAccountId: "00000000-0000-4000-8000-000000000001",
      name: "Claude Max",
      windows: ["five_hour"],
      served: true,
      resetsAt: null,
    };
    expect(describeEvent(refreshed)).toBe(
      "Auto-refresh started a new five-hour window on Claude Max.",
    );
    expect(
      describeEvent({ ...refreshed, resetsAt: "2026-10-09T19:01:00.000Z" }),
    ).toBe(
      `Auto-refresh started a new five-hour window on Claude Max; the five-hour window resets at ${new Date("2026-10-09T19:01:00.000Z").toLocaleString()}.`,
    );
    expect(
      describeEvent({
        ...refreshed,
        windows: ["five_hour", "weekly"],
        served: false,
      }),
    ).toBe(
      "Auto-refresh's request to Claude Max was not served, so no new five-hour and weekly window started. It is sent again only once a later window resets.",
    );
  });

  it("says how the Manager triaged an issue, and who judged", () => {
    const triaged = {
      type: "issue.triaged",
      version: 1,
      floorId: "web-shop",
      issue: 4,
      agentId: "ada",
      outcome: "clear",
      priority: "high",
      judgedBy: "model",
    } as const;
    const names = { agent: () => "Ada" };
    expect(describeEvent(triaged, names)).toBe(
      "Ada triaged #4: clear to work, high priority.",
    );
    expect(
      describeEvent(
        { ...triaged, outcome: "unclear", priority: "normal" },
        names,
      ),
    ).toBe(
      "Ada triaged #4: not clear enough to work, so it waits for the Owner.",
    );
    expect(describeEvent({ ...triaged, judgedBy: "rules" }, names)).toBe(
      "Ada triaged #4: clear to work, high priority (by AI Office's rules).",
    );
    expect(describeEvent({ ...triaged, judgedBy: "owner" }, names)).toBe(
      "Ada triaged #4: clear to work, high priority (the Owner's choice).",
    );
    expect(
      describeEvent({ ...triaged, judgedBy: "decision_model" }, names),
    ).toBe(
      "Ada triaged #4: clear to work, high priority (by the Decision Model).",
    );
  });

  it("says which work Role an issue went to, and who chose it", () => {
    const routed = {
      type: "issue.routed",
      version: 1,
      floorId: "web-shop",
      issue: 4,
      agentId: "ada",
      role: "copywriter",
      roleName: "copywriter",
      routedBy: "model",
    } as const;
    const names = { agent: () => "Ada" };
    expect(describeEvent(routed, names)).toBe(
      "Ada gave #4 to the copywriter Role.",
    );
    expect(describeEvent({ ...routed, routedBy: "label" }, names)).toBe(
      "Ada gave #4 to the copywriter Role (by its role label).",
    );
    expect(describeEvent({ ...routed, routedBy: "owner" }, names)).toBe(
      "Ada gave #4 to the copywriter Role (the Owner's choice).",
    );
    expect(describeEvent({ ...routed, routedBy: "plan" }, names)).toBe(
      "Ada gave #4 to the copywriter Role (by its Batch's Plan).",
    );
  });

  it("says what the Manager's watchdog decided, and what it was refused", () => {
    const names = {
      agent: (id: string) =>
        ({ grace: "Grace", ada: "Ada", alan: "Alan" })[id] ?? id,
    };
    const decision = {
      type: "manager.decision",
      version: 1,
      floorId: "web-shop",
      issue: 4,
      agentId: "grace",
      action: "reassign",
      trigger: "stalled",
      stage: "needs-work",
      fromAgentId: "ada",
      toAgentId: "alan",
    } as const;
    expect(describeEvent(decision, names)).toBe(
      "Grace reassigned #4 (needs-work) from Ada to Alan, as it had stalled.",
    );
    expect(
      describeEvent(
        {
          type: "manager.decision",
          version: 1,
          floorId: "web-shop",
          issue: 4,
          agentId: "grace",
          action: "escalate",
          trigger: "failing",
          stage: "needs-work",
          to: "needs-human",
        },
        names,
      ),
    ).toBe(
      "Grace escalated #4 (needs-work) to the Owner, moving it to needs-human, as it kept failing.",
    );
    expect(
      describeEvent(
        {
          type: "manager.action_refused",
          version: 1,
          floorId: "web-shop",
          issue: 4,
          agentId: "grace",
          action: "merge",
        },
        names,
      ),
    ).toBe(
      'Grace was refused "merge" on #4: a Manager may never merge, change repository settings or raise a cap.',
    );
  });

  it("says whether a pushed branch was rebased onto the default branch before review", () => {
    const pushed = {
      type: "branch.pushed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 2,
      branch: "ai-office/2-show-the-total",
      sha: "0123456789abcdef0123456789abcdef01234567",
      commits: 2,
    } as const;
    const base = "fedcba9876543210fedcba9876543210fedcba98";
    const names = { agent: () => "Ada" };
    expect(describeEvent(pushed, names)).toBe(
      "ai-office/2-show-the-total pushed for #2 with 2 new commits by Ada.",
    );
    expect(
      describeEvent(
        { ...pushed, rebase: { outcome: "rebased", onto: "main", base } },
        names,
      ),
    ).toBe(
      "ai-office/2-show-the-total pushed for #2 with 2 new commits by Ada, rebased onto main at fedcba9.",
    );
    expect(
      describeEvent(
        { ...pushed, rebase: { outcome: "up_to_date", onto: "main", base } },
        names,
      ),
    ).toBe(
      "ai-office/2-show-the-total pushed for #2 with 2 new commits by Ada, already on main.",
    );
    expect(
      describeEvent(
        {
          ...pushed,
          rebase: {
            outcome: "conflict",
            onto: "main",
            base,
            files: ["src/basket.ts", "src/total.ts"],
          },
        },
        names,
      ),
    ).toBe(
      "ai-office/2-show-the-total pushed for #2 with 2 new commits by Ada, not rebased onto main: src/basket.ts, src/total.ts conflict.",
    );
  });

  it("links an opened pull request to itself on GitHub", () => {
    const opened: OfficeEvent = {
      type: "pull_request.opened",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 4,
      pullRequest: 14,
      url: "https://github.com/adrianeyre/web-shop/pull/14",
      branch: "ai-office/4-add-a-basket",
    };
    expect(describeEvent(opened, { agent: () => "Ada" })).toBe(
      "Pull request #14 opened for #4, by Ada.",
    );
    expect(sourceLinks(opened, [])).toEqual([
      {
        kind: "github",
        href: "https://github.com/adrianeyre/web-shop/pull/14",
        label: "PR #14 on GitHub",
      },
      { kind: "agent", floorId: "web-shop", agentId: "ada" },
    ]);
  });

  it("says what a reviewer's verdict was, and links the review on GitHub", () => {
    const posted: OfficeEvent = {
      type: "review.posted",
      version: 1,
      floorId: "web-shop",
      agentId: "grace",
      issue: 4,
      pullRequest: 14,
      round: 2,
      verdict: "changes_requested",
      blocking: 2,
      nits: 1,
      url: "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-7",
    };
    expect(describeEvent(posted, { agent: () => "Grace" })).toBe(
      "Grace reviewed pull request #14 for #4 (round 2): changes requested, with 2 blocking comments and 1 nit.",
    );
    expect(sourceLinks(posted, [])).toEqual([
      {
        kind: "github",
        href: "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-7",
        label: "Review of PR #14 on GitHub",
      },
      { kind: "agent", floorId: "web-shop", agentId: "grace" },
    ]);
  });
  it("says what QA found, and links its comment on GitHub", () => {
    const reported: OfficeEvent = {
      type: "qa.reported",
      version: 1,
      floorId: "web-shop",
      agentId: "quill",
      issue: 4,
      pullRequest: 14,
      round: 1,
      result: "fail",
      url: "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-9",
    };
    expect(describeEvent(reported, { agent: () => "Quill" })).toBe(
      "Quill checked pull request #14 for #4 (QA round 1): failed.",
    );
    expect(sourceLinks(reported, [])).toEqual([
      {
        kind: "github",
        href: "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-9",
        label: "QA result on PR #14 on GitHub",
      },
      { kind: "agent", floorId: "web-shop", agentId: "quill" },
    ]);
  });

  it("says what a designer found in the UI, and links its comment on GitHub", () => {
    const reported: OfficeEvent = {
      type: "design.reported",
      version: 1,
      floorId: "web-shop",
      agentId: "dee",
      issue: 4,
      pullRequest: 14,
      round: 2,
      result: "changes",
      url: "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-11",
    };
    expect(describeEvent(reported, { agent: () => "Dee" })).toBe(
      "Dee reviewed the UI of pull request #14 for #4 (design round 2): changes requested.",
    );
    expect(
      describeEvent({ ...reported, result: "pass" }, { agent: () => "Dee" }),
    ).toBe(
      "Dee reviewed the UI of pull request #14 for #4 (design round 2): approved.",
    );
    expect(sourceLinks(reported, [])).toEqual([
      {
        kind: "github",
        href: "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-11",
        label: "Design review on PR #14 on GitHub",
      },
      { kind: "agent", floorId: "web-shop", agentId: "dee" },
    ]);
  });

  it("says how the office-wide memory changed, never its text, and what was proposed for and decided on a Role's memory", () => {
    const names = {
      agent: (id: string) => ({ ada: "Ada", grace: "Grace" })[id] ?? id,
    };
    expect(
      describeEvent(
        {
          type: "memory.office_changed",
          version: 1,
          added: 3,
          removed: 1,
          characters: 1412,
        },
        names,
      ),
    ).toBe(
      "The Owner changed the office-wide memory: 3 lines added and 1 removed (1,412 characters now).",
    );
    const proposed: OfficeEvent = {
      type: "memory.role_proposed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 4,
      role: "qa",
      entries: ["Run the tests twice."],
      refused: 1,
    };
    expect(describeEvent(proposed, names)).toBe(
      'Ada proposed an entry ("Run the tests twice.") for the QA memory, on #4; one was refused for looking like a credential.',
    );
    expect(describeEvent({ ...proposed, entries: [], refused: 2 }, names)).toBe(
      "Ada proposed nothing for the QA memory, on #4; 2 were refused for looking like a credential.",
    );
    const changed: OfficeEvent = {
      type: "memory.role_changed",
      version: 1,
      floorId: "web-shop",
      role: "coder",
      entryId: 7,
      text: "Write the failing test first.",
      change: "accepted",
      by: "manager",
      agentId: "grace",
      reason: "It holds for every coder here.",
    };
    expect(describeEvent(changed, names)).toBe(
      'Grace accepted "Write the failing test first." for the coder memory: It holds for every coder here.',
    );
    // Only the Owner accepts (ADR 0005): the Manager recommends.
    expect(describeEvent({ ...changed, change: "recommended" }, names)).toBe(
      'Grace recommended "Write the failing test first." for the coder memory: It holds for every coder here.',
    );
    expect(
      describeEvent(
        {
          type: "memory.role_changed",
          version: 1,
          floorId: "web-shop",
          role: "coder",
          entryId: 7,
          text: "Write the failing test first.",
          change: "removed",
          by: "owner",
        },
        names,
      ),
    ).toBe(
      'The Owner removed "Write the failing test first." from the coder memory.',
    );
    expect(sourceLinks(changed, [])).toEqual([
      { kind: "agent", floorId: "web-shop", agentId: "grace" },
    ]);
  });

  it("says what was proposed for the repository's memory, and how the Manager curated it, linking its pull request", () => {
    const names = {
      agent: (id: string) => ({ ada: "Ada", grace: "Grace" })[id] ?? id,
    };
    const proposed: OfficeEvent = {
      type: "memory.proposed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 4,
      entries: ["Run pnpm build first.", "Tests live in test/."],
    };
    expect(describeEvent(proposed, names)).toBe(
      'Ada proposed 2 entries for the repository\'s memory: "Run pnpm build first."; "Tests live in test/.".',
    );
    expect(
      describeEvent({ ...proposed, entries: ["Run pnpm build first."] }, names),
    ).toBe(
      'Ada proposed an entry for the repository\'s memory: "Run pnpm build first.".',
    );
    const curated: OfficeEvent = {
      type: "memory.curated",
      version: 1,
      floorId: "web-shop",
      agentId: "grace",
      reason: "batch",
      batchId: 3,
      curatedBy: "model",
      entries: 6,
      added: 2,
      removed: 1,
      proposals: 3,
      pullRequest: 12,
      url: "https://github.com/adrianeyre/web-shop/pull/12",
    };
    expect(describeEvent(curated, names)).toBe(
      "Grace curated the repository's memory as Batch 3 ended, in PR #12: 6 entries, 2 added and 1 removed, from 3 proposals.",
    );
    expect(sourceLinks(curated, [])).toEqual([
      {
        kind: "github",
        href: "https://github.com/adrianeyre/web-shop/pull/12",
        label: "Memory PR #12 on GitHub",
      },
      { kind: "agent", floorId: "web-shop", agentId: "grace" },
    ]);
    expect(
      describeEvent(
        {
          type: "memory.curated",
          version: 1,
          floorId: "web-shop",
          agentId: "grace",
          reason: "weekly",
          curatedBy: "rules",
          entries: 6,
          added: 0,
          removed: 0,
          proposals: 1,
        },
        names,
      ),
    ).toBe(
      "Grace curated the repository's memory in its weekly tidy-up, by AI Office's rules: nothing changed (1 proposal taken).",
    );
  });

  it("says who merged a pull request, and links it on GitHub", () => {
    const merged: OfficeEvent = {
      type: "pull_request.merged",
      version: 1,
      floorId: "web-shop",
      issue: 4,
      pullRequest: 14,
      url: "https://github.com/adrianeyre/web-shop/pull/14",
      sha: "89abcdef0123456789abcdef0123456789abcdef",
      by: "app",
    };
    expect(describeEvent(merged, { agent: () => "Ada" })).toBe(
      "Pull request #14 for #4 merged by the GitHub App, as the Merge Policy allowed.",
    );
    expect(
      describeEvent({ ...merged, by: "owner" }, { agent: () => "Ada" }),
    ).toBe(
      "Pull request #14 for #4 merged by the GitHub App, as the Owner approved it.",
    );
    expect(sourceLinks(merged, [])).toEqual([
      {
        kind: "github",
        href: "https://github.com/adrianeyre/web-shop/pull/14",
        label: "PR #14 on GitHub",
      },
    ]);
  });
});
