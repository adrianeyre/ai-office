import {
  defaultRulesFor,
  type Connection,
  type ConnectionDelivery,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { outTray, receptionHands } from "./lobby-layout.ts";
import {
  createOutTray,
  dropGapSeconds,
  dropSeconds,
  emptyTally,
  envelopePose,
  envelopeSize,
  failingConnections,
  maxPile,
  maxWaiting,
  pileTop,
  tallySent,
} from "./reception-desk.ts";

// The Communications Agent's reception desk as data (PRD FR-96): counting
// what it sends from its Connections' latest deliveries, the failing
// Connections that show the red marker, and the out-tray's envelopes.

const delivery = (
  id: string,
  status: ConnectionDelivery["status"] = "delivered",
): ConnectionDelivery => ({
  id,
  message: {
    kind: "action_notice",
    title: "PR #3 awaits approval",
    floor: null,
    aiOfficeUrl: "https://office.example/notices",
    githubUrl: null,
    occurredAt: "2026-10-10T09:00:00.000Z",
  },
  test: false,
  status,
  attempts: 1,
  createdAt: "2026-10-10T09:00:00.000Z",
  nextAttemptAt: null,
  lastAttemptAt: "2026-10-10T09:00:00.000Z",
  deliveredAt: status === "delivered" ? "2026-10-10T09:00:01.000Z" : null,
  error: null,
});

const connection = (
  id: string,
  lastDelivery: ConnectionDelivery | null,
  status: Connection["status"] = "ok",
): Connection => ({
  id,
  name: `Connection ${id}`,
  type: "webhook",
  rules: defaultRulesFor("webhook"),
  detailLevel: "titles_and_summaries",
  hint: "…/hook",
  details: [],
  paused: false,
  status,
  consecutiveFailures: status === "failing" ? 5 : 0,
  lastDelivery,
  createdAt: "2026-10-10T08:00:00.000Z",
});

describe("what the Communications Agent has sent", () => {
  it("counts nothing sent before the Connections were first read", () => {
    const tally = tallySent(emptyTally, [
      connection("slack", delivery("d1")),
      connection("ntfy", null),
    ]);
    expect(tally.sent).toBe(0);
    expect(tallySent(tally, [connection("slack", delivery("d1"))]).sent).toBe(
      0,
    );
  });

  it("counts each new delivered message or test once, on any Connection", () => {
    let tally = tallySent(emptyTally, [
      connection("slack", delivery("d1")),
      connection("ntfy", null),
    ]);
    tally = tallySent(tally, [
      connection("slack", delivery("d2")),
      connection("ntfy", delivery("d3")),
    ]);
    expect(tally.sent).toBe(2);
    // Read again with nothing new.
    tally = tallySent(tally, [
      connection("slack", delivery("d2")),
      connection("ntfy", delivery("d3")),
    ]);
    expect(tally.sent).toBe(2);
    // A Connection added and tested.
    tally = tallySent(tally, [connection("email", delivery("d4"))]);
    expect(tally.sent).toBe(3);
  });

  it("does not count a delivery until it is delivered", () => {
    let tally = tallySent(emptyTally, [connection("slack", null)]);
    tally = tallySent(tally, [connection("slack", delivery("d1", "pending"))]);
    tally = tallySent(tally, [connection("slack", delivery("d1", "failed"))]);
    expect(tally.sent).toBe(0);
    tally = tallySent(tally, [connection("slack", delivery("d1"))]);
    expect(tally.sent).toBe(1);
  });

  it("keeps its count while the Connections are not read", () => {
    const tally = tallySent(
      tallySent(emptyTally, [connection("slack", null)]),
      [connection("slack", delivery("d1"))],
    );
    expect(tallySent(tally, undefined)).toBe(tally);
  });
});

describe("the failing Connections", () => {
  it("are named, in order; none when every one is well", () => {
    expect(
      failingConnections([
        connection("slack", null, "failing"),
        connection("ntfy", null),
        connection("email", null, "failing"),
      ]),
    ).toEqual(["Connection slack", "Connection email"]);
    expect(failingConnections([connection("ntfy", null)])).toEqual([]);
    expect(failingConnections(undefined)).toEqual([]);
  });
});

describe("an envelope's drop", () => {
  it("leaves the Agent's hands held up and lands flat on the pile in the tray", () => {
    const start = envelopePose(0, 0);
    expect(start.position).toEqual(receptionHands);
    expect(start.tilt).toBeLessThan(0);
    const end = envelopePose(dropSeconds, 2);
    expect(end.position[0]).toBeCloseTo(outTray.centre[0]);
    expect(end.position[2]).toBeCloseTo(outTray.centre[2]);
    expect(end.position[1]).toBeCloseTo(pileTop(2) + envelopeSize[1] / 2);
    expect(end.tilt).toBeCloseTo(0);
  });

  it("arcs over the desk on its way", () => {
    const middle = envelopePose(dropSeconds / 2, 0);
    const straight = (receptionHands[1] + pileTop(0)) / 2;
    expect(middle.position[1]).toBeGreaterThan(straight + 0.1);
  });

  it("fits in the tray", () => {
    expect(envelopeSize[0]).toBeLessThan(outTray.size[0]);
    expect(envelopeSize[2]).toBeLessThan(outTray.size[2]);
    expect(pileTop(maxPile + 5)).toBe(pileTop(maxPile));
  });
});

describe("the out-tray", () => {
  it("drops an envelope for a message sent, which lands in the tray", () => {
    const tray = createOutTray();
    expect(tray.envelope()).toBeUndefined();
    tray.send(1, false);
    expect(tray.envelope()?.position).toEqual(receptionHands);
    tray.advance(dropSeconds / 2);
    expect(tray.pile()).toBe(0);
    tray.advance(dropSeconds / 2);
    expect(tray.envelope()).toBeUndefined();
    expect(tray.pile()).toBe(1);
  });

  it("drops several one after another, a moment apart", () => {
    const tray = createOutTray();
    tray.send(2, false);
    expect(tray.waiting()).toBe(1);
    tray.advance(dropSeconds);
    expect(tray.pile()).toBe(1);
    // The gap before the next.
    expect(tray.envelope()).toBeUndefined();
    tray.advance(dropGapSeconds);
    expect(tray.envelope()).toBeDefined();
    tray.advance(dropSeconds);
    expect(tray.pile()).toBe(2);
    expect(tray.envelope()).toBeUndefined();
  });

  it("catches up: beyond a few, envelopes land at once", () => {
    const tray = createOutTray();
    tray.send(maxWaiting + 4, false);
    expect(tray.pile()).toBe(4);
    expect(tray.waiting()).toBe(maxWaiting - 1);
    tray.advance(60);
    expect(tray.pile()).toBe(maxWaiting + 4);
    expect(tray.envelope()).toBeUndefined();
  });

  it("lands every envelope at once with reduced motion", () => {
    const tray = createOutTray();
    tray.send(1, false);
    tray.send(2, true);
    expect(tray.envelope()).toBeUndefined();
    expect(tray.waiting()).toBe(0);
    expect(tray.pile()).toBe(3);
  });

  it("starts with the envelopes already in it, and shows at most a pile's worth", () => {
    expect(createOutTray(3).pile()).toBe(3);
    expect(createOutTray(40).pile()).toBe(maxPile);
  });
});
