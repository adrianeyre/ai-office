import type { Connection } from "@ai-office/shared";

import type { Vec3 } from "./camera-rig.ts";
import { outTray, receptionHands } from "./lobby-layout.ts";

// The Communications Agent's reception desk in the lobby (PRD FR-96), as
// pure data and functions, so it is tested without WebGL: what it has sent
// since the Office opened, read from its Connections' latest deliveries;
// which Connections are failing, for the red marker on its desk; and the
// out-tray, which an envelope drops into for each message sent. Delivery
// never waits for any of it: the scene only reads what was sent, and an
// envelope behind the others catches up by landing at once.

/**
 * How often the lobby reads the Connections again, to see what was sent:
 * a successful delivery is in its Connection's own log only, never on the
 * event bus (FR-94).
 */
export const receptionRefreshMs = 5000;

/** What the scene has counted of the messages sent, from the Connections it read. */
export interface SentTally {
  /**
   * Each Connection's latest delivery counted, by its id; undefined until
   * the Connections are first read, when what they sent before is not
   * counted.
   */
  readonly seen: ReadonlyMap<string, string> | undefined;
  /** Messages sent since the Connections were first read. */
  readonly sent: number;
}

export const emptyTally: SentTally = { seen: undefined, sent: 0 };

/**
 * The tally once `connections` are read again: each Connection whose
 * latest delivery (a message, or a test) was delivered and not counted
 * before is one more sent. Two sent between readings count as one.
 */
export function tallySent(
  tally: SentTally,
  connections: readonly Connection[] | undefined,
): SentTally {
  if (connections === undefined) {
    return tally;
  }
  const seen = new Map(tally.seen);
  let sent = tally.sent;
  for (const { id, lastDelivery } of connections) {
    if (
      lastDelivery?.status !== "delivered" ||
      seen.get(id) === lastDelivery.id
    ) {
      continue;
    }
    seen.set(id, lastDelivery.id);
    if (tally.seen !== undefined) {
      sent += 1;
    }
  }
  return { seen, sent };
}

/** The names of the failing Connections (FR-94): any shows the red marker. */
export const failingConnections = (
  connections: readonly Connection[] | undefined,
): string[] =>
  (connections ?? [])
    .filter(({ status }) => status === "failing")
    .map(({ name }) => name);

/** An envelope: a DL one, 22 cm by 11 cm. */
export const envelopeSize: Vec3 = [0.22, 0.004, 0.11];

/** How long an envelope takes from the Agent's hands into the tray, and between two. */
export const dropSeconds = 0.9;
export const dropGapSeconds = 0.3;

/** How many envelopes drop one after another at most; any more land at once. */
export const maxWaiting = 3;

/** How many envelopes the tray shows at most: more are under them. */
export const maxPile = 8;

/** Where an envelope is and how it is tilted, about its long side. */
export interface EnvelopePose {
  readonly position: Vec3;
  /** Radians about x: held up at first, flat as it lands. */
  readonly tilt: number;
}

/** How high over the straight line the envelope's arc rises, at its middle. */
const arcHeight = 0.18;

/** The top of the pile of `count` envelopes in the tray. */
export const pileTop = (count: number) =>
  outTray.top + Math.min(count, maxPile) * envelopeSize[1];

/** Smooth start and finish. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Where an envelope is `elapsed` seconds into its drop onto a pile of `pile`. */
export function envelopePose(elapsed: number, pile: number): EnvelopePose {
  const t = Math.min(1, Math.max(0, elapsed / dropSeconds));
  const along = ease(t);
  const to: Vec3 = [
    outTray.centre[0],
    pileTop(pile) + envelopeSize[1] / 2,
    outTray.centre[2],
  ];
  return {
    position: [
      receptionHands[0] + (to[0] - receptionHands[0]) * along,
      receptionHands[1] +
        (to[1] - receptionHands[1]) * along +
        arcHeight * Math.sin(Math.PI * t),
      receptionHands[2] + (to[2] - receptionHands[2]) * along,
    ],
    tilt: -0.9 * (1 - along),
  };
}

/** The out-tray: the envelope dropping into it, those waiting, and its pile. */
export interface OutTray {
  /** `count` more messages sent: an envelope each, or straight onto the pile with reduced motion. */
  send(count: number, reducedMotion: boolean): void;
  /** Moves the dropping envelope on by a frame's `seconds`. */
  advance(seconds: number): void;
  /** The envelope dropping now, if one is. */
  envelope(): EnvelopePose | undefined;
  /** How many envelopes are in the tray, at most `maxPile`. */
  pile(): number;
  /** How many wait their turn. */
  waiting(): number;
}

/** An out-tray holding `pile` envelopes already. */
export function createOutTray(pile = 0): OutTray {
  let landed = pile;
  let waiting = 0;
  /** Seconds into the current drop; negative while it waits its gap. */
  let elapsed: number | undefined;
  return {
    send(count, reducedMotion) {
      if (count <= 0) {
        return;
      }
      if (reducedMotion) {
        landed += count + waiting + (elapsed === undefined ? 0 : 1);
        waiting = 0;
        elapsed = undefined;
        return;
      }
      waiting += count;
      // An envelope too far behind lands at once: the drops catch up.
      if (waiting > maxWaiting) {
        landed += waiting - maxWaiting;
        waiting = maxWaiting;
      }
      if (elapsed === undefined) {
        waiting -= 1;
        elapsed = 0;
      }
    },
    advance(seconds) {
      if (elapsed === undefined) {
        return;
      }
      elapsed += Math.max(0, seconds);
      // A long frame (a hidden tab) may land more than one.
      while (elapsed !== undefined && elapsed >= dropSeconds) {
        landed += 1;
        if (waiting > 0) {
          waiting -= 1;
          elapsed = elapsed - dropSeconds - dropGapSeconds;
        } else {
          elapsed = undefined;
        }
      }
    },
    envelope: () =>
      elapsed === undefined || elapsed < 0
        ? undefined
        : envelopePose(elapsed, landed),
    pile: () => Math.min(landed, maxPile),
    waiting: () => waiting,
  };
}
