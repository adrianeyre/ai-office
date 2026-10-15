import { defaultFloorSettings, type StatusUpdate } from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FloorRecord } from "../floors/store.ts";
import type { WorkItem } from "../work/store.ts";
import { createHourlyStatusUpdates } from "./hourly-status-updates.ts";

// Each hour, each Floor whose Agents are working gives a Status update
// (PRD FR-23a): not a quiet one, nor one with its hourly setting off, and
// work that only waits to merge is not working.

const floor = (
  id: string,
  changes: Partial<FloorRecord> = {},
): FloorRecord => ({
  ...defaultFloorSettings,
  tokenCaps: { daily: null, monthly: null },
  requiredReviewerAgentIds: [],
  id,
  name: id,
  defaultBranch: "main",
  githubRepositoryId: id.length,
  repository: `adrianeyre/${id}`,
  template: { id: "development", name: "Development" },
  theme: "office",
  createdAt: new Date("2026-10-12T08:00:00Z"),
  archivedAt: null,
  ...changes,
});

const item = (
  id: number,
  floorId: string,
  changes: Partial<WorkItem> = {},
): WorkItem => ({
  id,
  floorId,
  issue: id,
  stage: "needs-work",
  agentId: "coder",
  priority: "normal",
  status: "running",
  createdAt: new Date("2026-10-12T08:00:00Z"),
  startedAt: new Date("2026-10-12T08:00:00Z"),
  finishedAt: null,
  ...changes,
});

const given = (floorId: string): StatusUpdate => ({
  floorId,
  eventId: 1,
  trigger: "hourly",
  day: "2026-10-12",
  reportedDay: "2026-10-12",
  givenAt: "2026-10-12T09:00:00.000Z",
  entries: [],
});

function setUp(floors: FloorRecord[], work: WorkItem[]) {
  const give = vi.fn((floorId: string) =>
    Promise.resolve<StatusUpdate | undefined>(given(floorId)),
  );
  const active = vi.fn(() => Promise.resolve(work));
  const onError = vi.fn();
  const hourly = createHourlyStatusUpdates({
    floors: { list: () => Promise.resolve(floors) },
    work: { active },
    statusUpdates: { give },
    intervalMs: 1000,
    onError,
  });
  return { hourly, give, active, onError };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hourly Status updates", () => {
  it("are given by each Floor whose Agents are working, and no other", async () => {
    const s = setUp(
      [
        floor("working"),
        floor("queued"),
        floor("merging"),
        floor("off", { hourlyStatusUpdates: false }),
        floor("quiet"),
      ],
      [
        item(1, "working"),
        item(2, "queued", { status: "queued" }),
        item(3, "merging", { stage: "ready-to-merge" }),
        item(4, "off"),
      ],
    );
    expect(await s.hourly.check()).toEqual([given("working")]);
    expect(s.give.mock.calls).toEqual([["working", "hourly"]]);
    // The queue is read once for every Floor.
    expect(s.active).toHaveBeenCalledOnce();
  });

  it("skip a Floor with no Manager, and go on past one that fails", async () => {
    const s = setUp(
      [floor("broken"), floor("no-manager"), floor("working")],
      [item(1, "broken"), item(2, "no-manager"), item(3, "working")],
    );
    const failure = new Error("The chat is down.");
    s.give.mockImplementation((floorId) =>
      floorId === "broken"
        ? Promise.reject(failure)
        : Promise.resolve(
            floorId === "no-manager" ? undefined : given(floorId),
          ),
    );
    expect(await s.hourly.check()).toEqual([given("working")]);
    expect(s.onError).toHaveBeenCalledWith(failure);
  });

  it("are checked each interval once started, until stopped", async () => {
    vi.useFakeTimers();
    const s = setUp([floor("working")], [item(1, "working")]);
    s.active.mockRejectedValueOnce(new Error("The database is down."));
    s.hourly.start();
    s.hourly.start();
    expect(s.active).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    // A check that fails is reported, and the next comes all the same.
    expect(s.onError).toHaveBeenCalledOnce();
    expect(s.give).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.give).toHaveBeenCalledOnce();
    await s.hourly.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.active).toHaveBeenCalledTimes(2);
  });
});
