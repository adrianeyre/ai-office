import type { StreamedEvent } from "@ai-office/events/stream";
import { describe, expect, it } from "vitest";

import {
  advanceContractors,
  awaitSeconds,
  contractorPose,
  contractorSignals,
  createContractorWalker,
  deskWaitSeconds,
  insideLift,
  liftDoorsFor,
  liftRoute,
  receiveContractor,
  walkDone,
  walkLength,
  withLeaving,
  type ContractorSignal,
  type LiftPlanner,
} from "./contractor-walks.ts";
import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import { walkSeconds, walkSpeed } from "./handoff-walks.ts";
import { distance } from "./waypoints.ts";

// Contractors coming and going (PRD FR-10, FR-57; ADR 0004): one the
// Manager adds steps out of the lift and walks to its own desk; one that
// leaves walks back into the lift, its desk kept until then.

const team: FloorAgent[] = [
  { id: "manager", role: "manager" },
  { id: "coder", role: "coder" },
  { id: "reviewer", role: "reviewer" },
  {
    id: "migration-writer",
    role: "contractor-1a2b3c4d5e",
    contractor: { kind: "work", batchId: 3, oneOffRole: null },
  },
];
const layout = floorLayout(team);
const plan: LiftPlanner = (agentId) => liftRoute(layout, agentId);
const route = (agentId: string) => {
  const found = plan(agentId);
  if (found === undefined) {
    throw new Error(`No way to the lift for ${agentId}.`);
  }
  return found;
};
const seatOf = (agentId: string) => {
  const desk = layout.desks.find((each) => each.agentId === agentId);
  if (desk === undefined) {
    throw new Error(`No desk for ${agentId}.`);
  }
  return [desk.seat[0], desk.seat[2]] as const;
};

const signal = (
  type: ContractorSignal["type"],
  id = 1,
  agentId = "migration-writer",
): ContractorSignal => ({ type, id, floorId: "web-shop", agentId });

describe("Contractor signals", () => {
  it("reads contractor.added as an arrival and contractor.left as a leaving, and nothing else", () => {
    const events = [
      {
        id: 7,
        occurredAt: "2026-10-11T09:00:00.000Z",
        event: {
          type: "contractor.added",
          version: 1,
          floorId: "web-shop",
          agentId: "migration-writer",
          name: "Migration writer",
          role: "contractor-1a2b3c4d5e",
          roleName: "Migration writer",
          oneOff: true,
          kind: "work",
          batchId: 3,
          managerId: "manager",
        },
      },
      {
        id: 8,
        occurredAt: "2026-10-11T09:00:00.000Z",
        event: {
          type: "agent.removed",
          version: 1,
          floorId: "web-shop",
          agentId: "migration-writer",
        },
      },
      {
        id: 9,
        occurredAt: "2026-10-11T09:00:00.000Z",
        event: {
          type: "contractor.left",
          version: 1,
          floorId: "web-shop",
          agentId: "migration-writer",
          name: "Migration writer",
          batchId: 3,
        },
      },
    ] as StreamedEvent[];
    expect(contractorSignals(events)).toEqual([
      signal("arrive", 7),
      signal("leave", 9),
    ]);
  });
});

describe("the way between a desk and the lift", () => {
  it("runs from the Contractor's own chair, along the waypoints, into the lift", () => {
    const way = route("migration-writer");
    expect(way.path[0]).toEqual(seatOf("migration-writer"));
    expect(way.path.at(-1)).toEqual(insideLift);
    expect(way.length).toBeGreaterThan(
      distance(seatOf("migration-writer"), insideLift) - 1e-6,
    );
  });

  it("has no way for an Agent with no desk", () => {
    expect(plan("nobody")).toBeUndefined();
  });
});

describe("walking in and out", () => {
  const way = route("migration-writer");

  it("arriving: steps out of the lift, walks to its desk and sits down", () => {
    const start = contractorPose({ type: "arrive", route: way, elapsed: 0 });
    expect(distance(start.position, insideLift)).toBeLessThan(1e-6);
    expect(start.animation).toBe("walk");
    const halfway = contractorPose({
      type: "arrive",
      route: way,
      elapsed: way.length / walkSpeed / 2,
    });
    expect(halfway.animation).toBe("walk");
    const seated = contractorPose({
      type: "arrive",
      route: way,
      elapsed: way.length / walkSpeed + 0.1,
    });
    expect(seated).toEqual({
      position: seatOf("migration-writer"),
      heading: way.seatHeading,
      animation: "sit-down",
    });
    expect(walkLength({ type: "arrive", route: way })).toBeCloseTo(
      way.length / walkSpeed + walkSeconds.sitDown,
    );
  });

  it("leaving: stands up, walks to the lift and steps in", () => {
    expect(
      contractorPose({ type: "leave", route: way, elapsed: 0 }).animation,
    ).toBe("stand-up");
    const end = contractorPose({
      type: "leave",
      route: way,
      elapsed: walkLength({ type: "leave", route: way }),
    });
    expect(distance(end.position, insideLift)).toBeLessThan(1e-6);
    expect(
      walkDone({
        type: "leave",
        route: way,
        elapsed: walkLength({ type: "leave", route: way }),
      }),
    ).toBe(true);
  });

  it("opens the lift's doors only while someone walks through them", () => {
    const at = (elapsed: number) =>
      liftDoorsFor(
        new Map([
          [
            "migration-writer",
            {
              kind: "walking",
              walk: { type: "arrive", route: way, elapsed },
            } as const,
          ],
        ]),
      );
    expect(at(0)).toBe(1);
    expect(at(way.length / walkSpeed - 0.5)).toBe(0);
    expect(liftDoorsFor(new Map())).toBe(0);
  });
});

describe("a Floor's Contractors, as the scene plays them", () => {
  it("an arrival walks as soon as its desk is laid out, and waits a while for it", () => {
    const noDesk: LiftPlanner = () => undefined;
    let states = receiveContractor(new Map(), signal("arrive"), noDesk);
    expect(states.get("migration-writer")?.kind).toBe("awaiting-desk");
    states = advanceContractors(states, 1, plan);
    expect(states.get("migration-writer")?.kind).toBe("walking");
    const dropped = advanceContractors(
      receiveContractor(new Map(), signal("arrive"), noDesk),
      deskWaitSeconds,
      noDesk,
    );
    expect(dropped.size).toBe(0);
  });

  it("an arrival is over once it has sat down", () => {
    const states = advanceContractors(
      receiveContractor(new Map(), signal("arrive"), plan),
      walkLength({ type: "arrive", route: route("migration-writer") }) + 0.1,
      plan,
    );
    expect(states.size).toBe(0);
  });

  it("keeps a leaving Contractor's desk until it has walked into the lift, then lets it go", () => {
    const walker = createContractorWalker("web-shop");
    walker.receive(signal("leave"), plan);
    expect(walker.holds("migration-writer")).toBe(true);
    expect(walker.attending("migration-writer")).toBe(true);
    walker.advance(
      walkLength({ type: "leave", route: route("migration-writer") }),
      plan,
    );
    // In the lift, out of sight: its desk can go.
    expect(walker.holds("migration-writer")).toBe(false);
    expect(
      distance(
        walker.poseOf("migration-writer")?.position ?? [0, 0],
        insideLift,
      ),
    ).toBeLessThan(1e-6);
    walker.missing("migration-writer");
    expect(walker.poseOf("migration-writer")).toBeUndefined();
    // Gone for good: never kept again.
    walker.missing("migration-writer");
    expect(walker.holds("migration-writer")).toBe(false);
  });

  it("keeps a Contractor gone from the team a moment for its walk out, even before its signal", () => {
    const walker = createContractorWalker("web-shop");
    walker.missing("migration-writer");
    expect(walker.holds("migration-writer")).toBe(true);
    walker.receive(signal("leave"), plan);
    expect(walker.poseOf("migration-writer")?.animation).toBe("stand-up");

    const late = createContractorWalker("web-shop");
    late.missing("migration-writer");
    late.advance(awaitSeconds, plan);
    expect(late.holds("migration-writer")).toBe(false);
  });

  it("ignores another Floor's signals, and walks none with everything skipped", () => {
    const walker = createContractorWalker("web-shop");
    walker.receive({ ...signal("arrive"), floorId: "blog" }, plan);
    expect(walker.attending("migration-writer")).toBe(false);
    walker.receive(signal("arrive"), plan);
    walker.skipAll();
    expect(walker.poseOf("migration-writer")).toBeUndefined();
    expect(walker.liftDoors()).toBe(0);
  });
});

describe("the team a Floor lays out", () => {
  it("keeps a leaving Contractor where it was, so no other desk moves", () => {
    const staying = team.filter(({ id }) => id !== "coder");
    expect(
      withLeaving(staying, team, (agentId) => agentId === "coder").map(
        ({ id }) => id,
      ),
    ).toEqual(["manager", "coder", "reviewer", "migration-writer"]);
    expect(withLeaving(staying, team, () => false)).toEqual(staying);
  });
});
