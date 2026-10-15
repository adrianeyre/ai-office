import {
  defaultLobbyCast,
  noTokens,
  type FloorContextUsage,
  type FloorTokenUsage,
  type LobbyCast,
  type Notice,
  type Role,
} from "@ai-office/shared";
import {
  randomAvatar,
  seededRandom,
  type Avatar,
} from "@ai-office/shared/avatar";

import { aboveHeads, type AboveHead } from "../src/scene/above-head.ts";
import { agentLook, type AgentLook } from "../src/scene/agent-state.ts";
import type { CameraPose } from "../src/scene/camera-rig.ts";
import { officeViews } from "../src/scene/camera-store.ts";
import type { FloorAgent } from "../src/scene/floor-layout.ts";
import { communicationsAgentObject } from "../src/scene/inspectable.ts";
import { lobby, type LiftStop } from "../src/scene/lift-stops.ts";
import type { Reception } from "../src/scene/reception-desk.tsx";
import {
  lineTokens,
  type MonitorScreen,
  type ScreenLine,
  type ScreenLineKind,
} from "../src/scene/monitor-preview.ts";

// The scenes the screenshot tests take (PRD §9, Visual), as fixed data: the
// same Agents, Avatars, Notices and monitors every time, from fixed seeds,
// each seen from a fixed camera. Nothing here comes from a server, a clock
// or Math.random, so the same build draws the same pictures. It loads no
// three.js; main.tsx draws it.

/** The scenes, by the name the page's `?scene=` takes. */
export const sceneNames = [
  "lobby",
  "reception",
  "floor",
  "above-head",
  "meeting-room",
  "avatar-editor",
] as const;
export type SceneName = (typeof sceneNames)[number];

export const isSceneName = (name: string | null): name is SceneName =>
  (sceneNames as readonly (string | null)[]).includes(name);

/** The Floor shown, as the lift's stop and in its Notices. */
export const floorId = "web-shop";

/** The size the Office's scenes are drawn at, in CSS pixels: 720p. */
export const officeSize = { width: 1280, height: 720 } as const;

/**
 * The Avatar Editor's preview, at the size the editor gives it on a
 * desktop: its column's widest (18rem) by its height (h-64).
 */
export const previewSize = { width: 288, height: 256 } as const;

/**
 * The meeting room (`meetingRoom` in floor-layout.ts: x from -6 to 0, z
 * from the back wall at -6 to -2), from above its glass front: the table
 * for ten, its chairs and the whiteboard on the feature wall.
 */
export const meetingRoomView: CameraPose = {
  position: [-1.4, 6.2, 3.4],
  target: [-3.1, 0.6, -4.1],
};

/** The scenes in the lobby; the rest but the Avatar Editor are on a Floor. */
export const inLobby = (scene: SceneName) =>
  scene === "lobby" || scene === "reception";

/**
 * Each Office scene's camera: the Office's overview, the default camera
 * distance (for the Floor with what floats above its Agents' heads too);
 * the view the Office flies to when the Communications Agent at the
 * lobby's reception desk is clicked, close in on the desk, its out-tray
 * and its marker (FR-96); or the meeting room.
 */
export const sceneViews: Readonly<
  Record<Exclude<SceneName, "avatar-editor">, CameraPose>
> = {
  lobby: officeViews.overview,
  reception: communicationsAgentObject(undefined).view,
  floor: officeViews.overview,
  "above-head": officeViews.overview,
  "meeting-room": meetingRoomView,
};

/** One of the Floor's Agents, and what it is doing. */
interface Member {
  readonly id: string;
  readonly role: Role;
  readonly working?: boolean;
  readonly enabled?: boolean;
  readonly capped?: boolean;
  readonly awaitingReview?: number;
  readonly queued?: number;
  /** Its Context Usage in its session going, from 0 to 1; none without one. */
  readonly contextUsage?: number;
  /** The tokens it has used today and this month. */
  readonly tokens: { readonly today: number; readonly month: number };
}

/**
 * A Floor's team showing every state the Office draws (FR-62): working at
 * a lit monitor, waiting on review, paused, capped, sitting back, and
 * piles of tickets. Above their heads: the busy coder's Context Usage bar
 * (the reviewer, also at work, has none: its calls are stateless, FR-84),
 * and everyone's tokens today, below 80% of the daily cap, from 80%, and
 * at it.
 */
const members: readonly Member[] = [
  {
    id: "mira",
    role: "manager",
    queued: 1,
    tokens: { today: 42_000, month: 610_000 },
  },
  {
    id: "ada",
    role: "coder",
    working: true,
    queued: 3,
    contextUsage: 0.62,
    tokens: { today: 128_000, month: 3_400_000 },
  },
  {
    id: "linus",
    role: "coder",
    awaitingReview: 1,
    tokens: { today: 812_000, month: 9_100_000 },
  },
  {
    id: "grace",
    role: "reviewer",
    working: true,
    queued: 2,
    tokens: { today: 230_000, month: 2_000_000 },
  },
  {
    id: "alan",
    role: "qa",
    enabled: false,
    tokens: { today: 0, month: 450_000 },
  },
  {
    id: "hedy",
    role: "docs",
    capped: true,
    queued: 1,
    tokens: { today: 1_000_000, month: 12_000_000 },
  },
  { id: "dieter", role: "designer", tokens: { today: 9_400, month: 75_000 } },
];

/** Every Agent's daily and monthly Token Caps: a Floor's own, for its Agents. */
const caps = { daily: 1_000_000, monthly: 100_000_000 } as const;

/**
 * The Floor's Agents, each with an Avatar from a fixed seed, unlike the
 * ones before it, as a new Agent's is on its Floor.
 */
export const team: readonly FloorAgent[] = members.reduce<
  (FloorAgent & { avatar: Avatar })[]
>(
  (agents, { id, role, enabled = true }) => [
    ...agents,
    {
      id,
      role,
      enabled,
      avatar: randomAvatar(
        seededRandom(`screenshots:${id}`),
        agents.map(({ avatar }) => avatar),
      ),
    },
  ],
  [],
);

export const looks: ReadonlyMap<string, AgentLook> = new Map(
  members.map((member) => [
    member.id,
    agentLook({
      working: member.working ?? false,
      enabled: member.enabled ?? true,
      capped: member.capped ?? false,
      awaitingReview: member.awaitingReview ?? 0,
      queued: member.queued ?? 0,
    }),
  ]),
);

/**
 * The Floor's Agents with a session going, and their Context Usage, as
 * `GET /api/floors/:floorId/context-usage` lists them.
 */
export const contextUsage: FloorContextUsage = {
  agents: members.flatMap(({ id, contextUsage: usage }) =>
    usage === undefined
      ? []
      : [
          {
            agentId: id,
            floorId,
            issue: 4,
            model: "claude-opus-5-5",
            inputTokens: Math.round(usage * 200_000),
            contextWindow: 200_000,
            contextUsage: usage,
            updatedAt: "2026-10-10T09:00:00.000Z",
          },
        ],
  ),
};

/** The Floor's tokens, as `GET /api/floors/:floorId/token-usage` gives them. */
export const tokenUsage: FloorTokenUsage = {
  floorId,
  caps,
  agentDefaults: {
    daily: { level: "floor", cap: caps.daily },
    monthly: { level: "floor", cap: caps.monthly },
  },
  usage: { daily: noTokens, monthly: noTokens },
  agents: members.map(({ id, tokens }) => ({
    agentId: id,
    usage: { daily: noTokens, monthly: noTokens },
    caps: {
      daily: { level: "floor", cap: caps.daily, used: tokens.today },
      monthly: { level: "floor", cap: caps.monthly, used: tokens.month },
    },
  })),
  issues: [],
};

/** What floats above each Agent's head (FR-62, FR-85), as the Office makes it. */
export const aboveHead: ReadonlyMap<string, AboveHead> = aboveHeads({
  agentIds: members.map(({ id }) => id),
  contextUsage: contextUsage.agents,
  tokenUsage,
});

/** A screen's lines, from each one's kind, indent and width. */
const screenLines = (
  lines: readonly (readonly [ScreenLineKind, number, number])[],
): ScreenLine[] =>
  lines.map(([kind, indent, width], index) => ({
    seq: index + 1,
    kind,
    token: lineTokens[kind],
    indent,
    width,
  }));

/** What the working Agents' monitors show: a terminal and a diff. */
export const monitors: ReadonlyMap<string, MonitorScreen> = new Map(
  team.map(({ id }): [string, MonitorScreen] => {
    const member = members.find((each) => each.id === id);
    const working = member?.working ?? false;
    const lines = !working
      ? []
      : id === "ada"
        ? screenLines([
            ["tool", 0, 0.42],
            ["text", 0, 0.8],
            ["text", 0.08, 0.55],
            ["hunk", 0, 0.3],
            ["removed", 0, 0.62],
            ["added", 0, 0.7],
            ["added", 0.08, 0.48],
            ["model", 0, 0.36],
          ])
        : screenLines([
            ["model", 0, 0.4],
            ["text", 0, 0.9],
            ["text", 0, 0.66],
            ["tool", 0, 0.5],
            ["text", 0.16, 0.44],
          ]);
    return [id, { agentId: id, working, lines, activity: lines.length }];
  }),
);

/** An open Notice, as the API lists it. */
const notice = (
  id: string,
  kind: Notice["kind"],
  title: string,
  noticeFloorId: string | null,
  createdAt: string,
): Notice => ({
  id,
  kind,
  title,
  floorId: noticeFloorId,
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  links: [],
  positions: [],
  actions: [],
  createdAt,
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
});

/** The open Notices, newest first. */
export const notices: readonly Notice[] = [
  notice(
    "n5",
    "action",
    "PR #14 awaiting your approval",
    floorId,
    "2026-10-10T09:05:00.000Z",
  ),
  notice(
    "n4",
    "info",
    "PR #13 merged by the App",
    floorId,
    "2026-10-10T09:00:00.000Z",
  ),
  notice(
    "n3",
    "action",
    "Hedy reached its daily Token Cap",
    floorId,
    "2026-10-10T08:40:00.000Z",
  ),
  notice(
    "n2",
    "info",
    "Batch started: issues 1 to 5",
    "blog",
    "2026-10-10T08:30:00.000Z",
  ),
  notice(
    "n1",
    "action",
    "Claude account 2 needs signing in again",
    null,
    "2026-10-10T08:00:00.000Z",
  ),
];

/** The lift's stops: the lobby and two Floors, with their action Notices. */
export const stops: readonly LiftStop[] = [
  {
    order: 0,
    location: lobby,
    name: "Lobby",
    repository: undefined,
    actionNotices: 1,
  },
  {
    order: 1,
    location: { kind: "floor", floorId },
    name: "web-shop",
    repository: "adrianeyre/web-shop",
    actionNotices: 2,
  },
  {
    order: 2,
    location: { kind: "floor", floorId: "blog" },
    name: "blog",
    repository: "adrianeyre/blog",
    actionNotices: 0,
  },
];

/** The Avatar in the Avatar Editor's preview: the first coder's. */
export const editorAvatar: Avatar =
  team.find(({ id }) => id === "ada")?.avatar ??
  randomAvatar(seededRandom("screenshots:ada"));

/**
 * The lobby's people: the Communications Agent at the reception desk as
 * the receptionist, with an Avatar from a fixed seed, and the visitor.
 * With reduced motion the receptionist types at the desk and the visitor
 * sits on the sofa.
 */
export const lobbyCast: LobbyCast = {
  receptionist: {
    name: "Grace",
    avatar: randomAvatar(seededRandom("screenshots:communications")),
  },
  visitor: defaultLobbyCast.visitor,
};

/**
 * The reception desk (FR-96): three messages sent, so three envelopes in
 * the out-tray, and a failing Connection, so the red marker on the desk.
 */
export const reception: Reception = { sent: 3, failing: ["Team chat"] };
