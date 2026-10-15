import { defaultLobbyCast, type Notice } from "@ai-office/shared";
import { palette, type PaletteToken } from "@ai-office/shared/palette";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import {
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetCamera } from "./camera-store.ts";
import { emissiveIntensity } from "./materials.ts";
import { liftDoor, liftDoorway } from "./lift-layout.ts";
import {
  answerSeconds,
  dwellSeconds,
  resetLift,
  useLiftStore,
} from "./lift-store.ts";
import { liftStops, type LiftStop } from "./lift-stops.ts";
import {
  lobbyPieces,
  noticeBoardPosition,
  outTray,
  receptionHands,
  receptionLogo,
  receptionMarker,
  receptionSeat,
} from "./lobby-layout.ts";
import {
  boardInstances,
  boardLayers,
  isNight,
  LiftDriver,
  Lobby,
} from "./lobby.tsx";
import { resetGreeting } from "./lobby-people.tsx";
import { provideModels } from "./models.ts";
import { boardPreview } from "./notice-board-preview.ts";
import { OfficeLocationScene } from "./office-location.tsx";
import { pieceGeometry, triangles } from "./piece-geometry.ts";
import { dropSeconds, envelopeSize, maxPile } from "./reception-desk.ts";
import { qualityPresets } from "./quality.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { noSeason, resetSeason, useSeason } from "./season.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { tapSlop } from "./touch-camera.ts";

// The lobby in React Three Fiber, rendered without WebGL by its test
// renderer: the Notice Board's cards for the open Notices, the lift and its
// lamps, and the move to a Floor.

// The test renderer acts through React's `act`, as Testing Library does.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const notice = (id: string, overrides: Partial<Notice> = {}): Notice => ({
  id,
  kind: "info",
  title: "PR #3 opened",
  floorId: "web-shop",
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  actions: [],
  createdAt: "2026-10-08T12:00:00.000Z",
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  links: [],
  positions: [],
  ...overrides,
});

const floor = (id: string, name: string) => ({
  id,
  name,
  repository: `adrianeyre/${id}`,
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office" as const,
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  mergePolicy: "send_to_me" as const,
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
  createdAt: "2026-10-08T12:00:00.000Z",
  archivedAt: null,
});

const floors = [floor("web-shop", "Web shop"), floor("blog", "Blog")];

const minuteApart = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    notice(`notice-${String(index + 1)}`, {
      kind: index % 3 === 0 ? "action" : "info",
      createdAt: new Date(Date.UTC(2026, 9, 8, 12, index)).toISOString(),
    }),
  );

let renderer: Renderer | undefined;

async function renderScene(element: React.ReactNode): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(element);
  return renderer;
}

/** The three.js object named `name` in the scene. */
function object(scene: Renderer, name: string): Object3D {
  const found = scene.scene.instance.getObjectByName(name);
  if (found === undefined) {
    throw new Error(`The scene has nothing named "${name}".`);
  }
  return found;
}

/** The instanced mesh named `name` in the scene. */
function instanced(scene: Renderer, name: string): InstancedMesh {
  const found = object(scene, name);
  if (!(found instanceof InstancedMesh)) {
    throw new Error(`"${name}" is not an instanced mesh.`);
  }
  return found as InstancedMesh;
}

/** An instance's matrix. */
function matrixAt(mesh: InstancedMesh, index: number): Matrix4 {
  const matrix = new Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix;
}

/** The colours of an instanced mesh's instances, as hex. */
function instanceColours(mesh: InstancedMesh): string[] {
  const colour = new Color();
  return Array.from({ length: mesh.count }, (_, index) => {
    mesh.getColorAt(index, colour);
    return colour.getHexString();
  });
}

/**
 * Run `count` frames of 1/60 s. The test renderer runs each frame
 * subscriber all of its frames before the next, so frames go one at a time.
 */
async function frames(scene: Renderer, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(() => scene.advanceFrames(1, 1 / 60));
  }
}

const hex = (token: PaletteToken, scale = 1) =>
  new Color(palette[token]).multiplyScalar(scale).getHexString();

// A Floor's models, read from disk rather than fetched.
beforeAll(async () => {
  provideModels(await loadModelsFromDisk());
});

beforeEach(() => {
  resetLift();
  resetCamera();
  resetSceneSettings();
  resetSeason();
});

afterEach(async () => {
  await act(async () => {
    await renderer?.unmount();
  });
  renderer = undefined;
});

describe("the lobby's logo", () => {
  it("hangs on the wall behind reception, unlit, hidden until its image loads", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={liftStops(floors, [])} />,
    );
    const logo = object(scene, "reception-logo");
    if (!(logo instanceof Mesh)) {
      throw new Error("The logo is not a mesh.");
    }
    expect(logo.position.toArray()).toEqual([...receptionLogo.position]);
    const geometry: BufferGeometry = (logo as Mesh).geometry;
    geometry.computeBoundingBox();
    const size = new Vector3();
    geometry.boundingBox?.getSize(size);
    expect(size.x).toBeCloseTo(receptionLogo.size[0]);
    expect(size.y).toBeCloseTo(receptionLogo.size[1]);
    const logoMaterial = logo.material as MeshBasicMaterial;
    expect(logoMaterial).toBeInstanceOf(MeshBasicMaterial);
    expect(logoMaterial.transparent).toBe(true);
    expect(logoMaterial.toneMapped).toBe(false);
    // jsdom loads no images, so the logo never shows here.
    expect(logo.visible).toBe(false);
  });
});

describe("the lobby's Notice Board", () => {
  it("is bare when there are no Notices", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={liftStops(floors, [])} />,
    );
    expect(instanced(scene, "notice-board-sheets").count).toBe(0);
    expect(instanced(scene, "notice-board-pins").count).toBe(0);
    expect(instanced(scene, "notice-board-writing").count).toBe(0);
  });

  it("pins a card for each Notice: an action card red with two pins, an info card blue with one", async () => {
    const notices = [
      notice("approve", {
        kind: "action",
        title: "PR #14 awaiting your approval",
        createdAt: "2026-10-08T12:01:00.000Z",
      }),
      notice("opened", { title: "PR #3 opened" }),
    ];
    const scene = await renderScene(
      <Lobby
        board={boardPreview(notices)}
        stops={liftStops(floors, notices)}
      />,
    );
    const sheets = instanced(scene, "notice-board-sheets");
    expect(sheets.count).toBe(2);
    expect(new Set(instanceColours(sheets))).toEqual(new Set([hex("paper")]));

    const pins = instanced(scene, "notice-board-pins");
    expect(instanceColours(pins)).toEqual([
      hex("state-critical"),
      hex("state-critical"),
      hex("state-info"),
    ]);

    // A stripe in the kind's colour on each card, then its lines in ink:
    // "PR #14 awaiting your approval" is 29 characters, two lines; "PR #3
    // opened" one.
    const writing = instanced(scene, "notice-board-writing");
    expect(instanceColours(writing)).toEqual([
      hex("state-critical"),
      hex("ink"),
      hex("ink"),
      hex("state-info"),
      hex("ink"),
    ]);
  });

  it("layers the board: felt, stacked sheets, cards, then their writing and pins", () => {
    const { sheets, writing, pins } = boardInstances(
      boardPreview(minuteApart(9)),
    );
    // The felt's face, in board space, is where the layout puts it.
    const felt = lobbyPieces.find(({ name }) => name === "Notice Board, felt");
    expect(
      (felt?.position[2] ?? 0) +
        (felt?.size[2] ?? 0) / 2 -
        noticeBoardPosition[2],
    ).toBeCloseTo(boardLayers.felt);
    /** An instance's nearest and furthest distance from the wall. */
    const depth = ({ matrix }: { matrix: Matrix4 }) => {
      const position = new Vector3();
      const scale = new Vector3();
      matrix.decompose(position, new Quaternion(), scale);
      return [position.z - scale.z / 2, position.z + scale.z / 2] as const;
    };
    const stacked = sheets.slice(0, 3).map(depth);
    const cards = sheets.slice(3).map(depth);
    expect(cards).toHaveLength(6);
    const highest = (spans: (readonly [number, number])[]) =>
      Math.max(...spans.map(([, front]) => front));
    const lowest = (spans: (readonly [number, number])[]) =>
      Math.min(...spans.map(([back]) => back));
    // Layers may touch, to within a micrometre, but never overlap.
    const touch = 1e-6;
    expect(lowest(stacked)).toBeGreaterThan(boardLayers.felt - touch);
    expect(lowest(cards)).toBeGreaterThan(highest(stacked) - touch);
    expect(lowest(writing.map(depth))).toBeGreaterThan(highest(cards) - touch);
    expect(lowest(pins.map(depth))).toBeGreaterThan(highest(cards) - 0.012);
    // A pin's head stands proud of its card.
    expect(highest(pins.map(depth))).toBeGreaterThan(
      highest(writing.map(depth)),
    );
  });

  it("stacks the Notices beyond six behind the last card", async () => {
    const notices = minuteApart(8);
    const scene = await renderScene(
      <Lobby
        board={boardPreview(notices)}
        stops={liftStops(floors, notices)}
      />,
    );
    // Six cards and two stacked sheets.
    expect(instanced(scene, "notice-board-sheets").count).toBe(8);
  });

  it("changes as Notices are raised and closed", async () => {
    const stops = liftStops(floors, []);
    const scene = await renderScene(
      <Lobby board={boardPreview(minuteApart(1))} stops={stops} />,
    );
    expect(instanced(scene, "notice-board-sheets").count).toBe(1);
    await scene.update(
      <Lobby board={boardPreview(minuteApart(12))} stops={stops} />,
    );
    expect(instanced(scene, "notice-board-sheets").count).toBe(9);
    await scene.update(<Lobby board={boardPreview([])} stops={stops} />);
    expect(instanced(scene, "notice-board-sheets").count).toBe(0);
  });
});

describe("the lobby in season", () => {
  it("has a tree and twinkling lights at Christmas, and Santa comes out of the lift with presents", async () => {
    useSeason.setState({
      ...noSeason,
      events: ["christmas"],
      actors: ["santa"],
    });
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={liftStops(floors, [])} />,
    );
    expect(object(scene, "seasonal-decorations")).toBeDefined();
    expect(object(scene, "seasonal-lights state-critical")).toBeDefined();
    // Within a minute, Santa is out of the lift.
    await act(() => scene.advanceFrames(1, 46));
    await frames(scene, 2);
    const santa = object(scene, "seasonal-visitor santa");
    expect(santa.visible).toBe(true);
  });

  it("has nobody visit out of season", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={liftStops(floors, [])} />,
    );
    await act(() => scene.advanceFrames(1, 300));
    await frames(scene, 2);
    expect(
      scene.scene.instance.getObjectByName("seasonal-visitor santa"),
    ).toBeUndefined();
    expect(
      scene.scene.instance.getObjectByName("seasonal-decorations"),
    ).toBeUndefined();
  });
});

describe("the lift's sign", () => {
  it("is lit at night, from 19:00 to 07:00 by the viewer's clock", () => {
    expect(isNight(new Date(2026, 9, 13, 6, 59))).toBe(true);
    expect(isNight(new Date(2026, 9, 13, 7, 0))).toBe(false);
    expect(isNight(new Date(2026, 9, 13, 18, 59))).toBe(false);
    expect(isNight(new Date(2026, 9, 13, 19, 0))).toBe(true);
  });
});

describe("the lift", () => {
  const stopsWithActions = (): LiftStop[] =>
    liftStops(floors, [notice("1", { kind: "action", floorId: "blog" })]);

  it("has a lamp for each stop, the car's lit, and a red marker for a stop with an action Notice", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={stopsWithActions()} />,
    );
    await frames(scene, 1);
    const lamps = instanced(scene, "lift-lamps");
    expect(instanceColours(lamps)).toEqual([
      hex("lamp", emissiveIntensity.lamp),
      hex("screen-off"),
      hex("screen-off"),
    ]);
    const markers = instanced(scene, "lift-markers");
    expect(instanceColours(markers)).toEqual([
      hex("state-critical", emissiveIntensity.lamp),
    ]);
    // The marker is under Blog's lamp, the third.
    const lampAt = new Vector3();
    const markerAt = new Vector3();
    lampAt.setFromMatrixPosition(matrixAt(lamps, 2));
    markerAt.setFromMatrixPosition(matrixAt(markers, 0));
    expect(markerAt.x).toBeCloseTo(lampAt.x);
    expect(markerAt.y).toBeLessThan(lampAt.y);
  });

  it("opens the floor picker when its doors are clicked", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={stopsWithActions()} />,
    );
    useLiftStore.getState().setPickerOpen(false);
    await scene.fireEvent(
      scene.scene.findByProps({ name: "lift-door-left" }),
      "onClick",
    );
    expect(useLiftStore.getState().pickerOpen).toBe(true);
  });

  it("is called by its button: it lights, the doors open, then the picker", async () => {
    const scene = await renderScene(
      <>
        <Lobby board={boardPreview([])} stops={stopsWithActions()} />
        <LiftDriver />
      </>,
    );
    await frames(scene, 1);
    const doorX = () => object(scene, "lift-door-left").position.x;
    const shut = liftDoorway.position[0] - liftDoor.size[0] / 2;
    // Waiting at the stop, the doors rest shut.
    expect(doorX()).toBeCloseTo(shut);
    useLiftStore.getState().setPickerOpen(false);
    for (const name of ["lift-call-button", "lift-call-target"]) {
      await scene.fireEvent(scene.scene.findByProps({ name }), "onClick");
    }
    expect(useLiftStore.getState().answering).toBeDefined();
    expect(
      (scene.scene.findByProps({ name: "lift-call-button" }).instance as Mesh)
        .material,
    ).toHaveProperty("name", "lift-call-button/pressed");
    expect(useLiftStore.getState().pickerOpen).toBe(false);

    await frames(scene, Math.ceil(answerSeconds * 60) + 60);
    expect(useLiftStore.getState().answering).toBeUndefined();
    expect(useLiftStore.getState().pickerOpen).toBe(true);
    expect(doorX()).toBeCloseTo(shut - liftDoor.travel);

    // After a while open, they close to rest again.
    await frames(scene, Math.ceil(dwellSeconds * 60) + 60);
    expect(doorX()).toBeCloseTo(shut);
  });

  it("opens at once to a call with reduced motion", async () => {
    useSceneSettings.getState().setReducedMotion(true);
    const scene = await renderScene(
      <>
        <Lobby board={boardPreview([])} stops={stopsWithActions()} />
        <LiftDriver />
      </>,
    );
    useLiftStore.getState().setPickerOpen(false);
    await scene.fireEvent(
      scene.scene.findByProps({ name: "lift-call-button" }),
      "onClick",
    );
    expect(useLiftStore.getState().pickerOpen).toBe(true);
    await frames(scene, 1);
    expect(object(scene, "lift-door-left").position.x).toBeCloseTo(
      liftDoorway.position[0] - liftDoor.size[0] / 2 - liftDoor.travel,
    );
  });

  it("does not open the floor picker for a drag that moved the camera", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={stopsWithActions()} />,
    );
    useLiftStore.getState().setPickerOpen(false);
    await scene.fireEvent(
      scene.scene.findByProps({ name: "lift-call-button" }),
      "onClick",
      { delta: tapSlop + 1 },
    );
    expect(useLiftStore.getState().pickerOpen).toBe(false);
  });

  it("closes its doors, rides to a Floor and shows it, then opens them", async () => {
    const stops = stopsWithActions();
    const scene = await renderScene(
      <>
        <OfficeLocationScene board={boardPreview([])} stops={stops} />
        <LiftDriver />
      </>,
    );
    await frames(scene, 1);
    const doorX = () => object(scene, "lift-door-left").position.x;
    const open =
      liftDoorway.position[0] - liftDoor.size[0] / 2 - liftDoor.travel;
    // At rest the doors are shut.
    expect(doorX()).toBeGreaterThan(open);
    expect(object(scene, "lobby")).toBeDefined();
    expect(object(scene, "lift-sign").userData["text"]).toBe("Lobby");

    const webShop = stops.find(({ name }) => name === "Web shop");
    if (webShop === undefined) {
      throw new Error("Web shop is a stop.");
    }
    await act(async () => {
      useLiftStore.getState().call({
        order: webShop.order,
        location: webShop.location,
      });
      await Promise.resolve();
    });
    await frames(scene, 20);
    // Shut, still in the lobby.
    expect(doorX()).toBeGreaterThan(open);
    expect(object(scene, "lobby")).toBeDefined();

    await frames(scene, 150);
    // Arrived: the Floor is shown, the lobby gone, the doors open again.
    expect(() => object(scene, "lobby")).toThrow();
    expect(object(scene, "floor-web-shop")).toBeDefined();
    // The sign over the lamps names the Floor.
    expect(object(scene, "lift-sign").userData["text"]).toBe("Web shop");
    expect(doorX()).toBeCloseTo(open);
    // Web shop's lamp is lit now.
    expect(instanceColours(instanced(scene, "lift-lamps"))).toEqual([
      hex("screen-off"),
      hex("lamp", emissiveIntensity.lamp),
      hex("screen-off"),
    ]);
  });

  it("is on the Floor in one frame with reduced motion", async () => {
    useSceneSettings.getState().setReducedMotion(true);
    const stops = stopsWithActions();
    const scene = await renderScene(
      <>
        <OfficeLocationScene board={boardPreview([])} stops={stops} />
        <LiftDriver />
      </>,
    );
    await act(async () => {
      useLiftStore.getState().call({
        order: 2,
        location: { kind: "floor", floorId: "blog" },
      });
      await Promise.resolve();
    });
    await frames(scene, 1);
    expect(object(scene, "floor-blog")).toBeDefined();
  });
});

describe("the lobby's cost", () => {
  it("is within the spec's per-frame budgets at Medium, with a full Notice Board", async () => {
    const notices = minuteApart(20);
    const scene = await renderScene(
      <Lobby
        board={boardPreview(notices)}
        stops={liftStops(floors, notices)}
      />,
    );
    await frames(scene, 1);
    let meshes = 0;
    let shadowCasters = 0;
    let triangleCount = 0;
    scene.scene.instance.traverse((child) => {
      if (!(child instanceof Mesh) || !child.visible) {
        return;
      }
      meshes += 1;
      if (child.castShadow) {
        shadowCasters += 1;
      }
      const perCopy = triangles(child.geometry as BufferGeometry);
      triangleCount +=
        perCopy * (child instanceof InstancedMesh ? child.count : 1);
    });
    // One draw call per mesh, and again per shadow caster for the key
    // light's shadow map at Medium; post-processing adds a dozen passes.
    expect(qualityPresets.medium.shadows).toBeDefined();
    const drawCalls = meshes + shadowCasters + 12;
    expect(drawCalls).toBeLessThanOrEqual(200);
    expect(triangleCount).toBeLessThanOrEqual(300_000);
    // A large prop (the lift's moving parts, a sofa) is far under its 4,000.
    expect(
      pieceGeometry({
        name: "a sofa seat",
        shape: "box",
        token: "sofa",
        surface: "fabric",
        role: "furniture",
        size: [2, 0.42, 0.85],
        position: [0, 0.21, 0],
      }).getAttribute("position").count / 3,
    ).toBeLessThan(4000 / 4);
  });
});

describe("the lobby's people", () => {
  beforeEach(() => {
    resetGreeting();
  });

  it("has the receptionist greet the Owner once, behind the desk", async () => {
    const scene = await renderScene(
      <Lobby
        board={boardPreview([])}
        stops={liftStops([], [])}
        cast={defaultLobbyCast}
        greeting="Hi, Ade. Good morning."
      />,
    );
    await frames(scene, 2);
    const receptionist = object(scene, "lobby-receptionist");
    expect(receptionist.visible).toBe(true);
    expect([receptionist.position.x, receptionist.position.z]).toEqual([
      ...receptionSeat,
    ]);
    expect(object(scene, "lobby-visitor")).toBeDefined();
    expect(object(scene, "receptionist-greeting").position.x).toBe(
      receptionSeat[0],
    );
    await act(async () => {
      await renderer?.unmount();
    });
    renderer = undefined;

    // Back in the lobby later, there is no second greeting.
    const again = await renderScene(
      <Lobby
        board={boardPreview([])}
        stops={liftStops([], [])}
        cast={defaultLobbyCast}
        greeting="Hi, Ade. Good morning."
      />,
    );
    await frames(again, 2);
    expect(() => object(again, "receptionist-greeting")).toThrow();
  });

  it("has no one until the cast loads", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={liftStops([], [])} />,
    );
    expect(() => object(scene, "lobby-people")).toThrow();
  });
});

describe("the Communications Agent's reception desk", () => {
  const reception = (sent: number, failing: readonly string[] = []) => (
    <Lobby
      board={boardPreview([])}
      stops={liftStops([], [])}
      reception={{ sent, failing }}
    />
  );

  it("has nothing on it until the Connections are read", async () => {
    const scene = await renderScene(
      <Lobby board={boardPreview([])} stops={liftStops([], [])} />,
    );
    expect(() => object(scene, "reception-desk")).toThrow();
  });

  it("drops an envelope from the Agent's hands into the out-tray for each message sent", async () => {
    const scene = await renderScene(reception(0));
    await frames(scene, 1);
    const pile = instanced(scene, "out-tray-envelopes");
    const dropping = object(scene, "dropping-envelope");
    expect(pile.count).toBe(0);
    expect(dropping.visible).toBe(false);

    await act(async () => {
      await scene.update(reception(1));
    });
    await frames(scene, 1);
    expect(dropping.visible).toBe(true);
    expect(
      dropping.position.distanceTo(new Vector3(...receptionHands)),
    ).toBeLessThan(0.1);
    expect(dropping.scale.toArray()).toEqual(envelopeSize);

    await frames(scene, Math.ceil(dropSeconds * 60) + 1);
    expect(dropping.visible).toBe(false);
    expect(pile.count).toBe(1);
    const landed = new Vector3().setFromMatrixPosition(matrixAt(pile, 0));
    expect(landed.x).toBeCloseTo(outTray.centre[0], 1);
    expect(landed.z).toBeCloseTo(outTray.centre[2], 1);
    expect(landed.y).toBeGreaterThan(outTray.top);
  });

  it("shows what was sent before it was drawn already in the tray, up to a pile's worth", async () => {
    const scene = await renderScene(reception(3));
    await frames(scene, 1);
    expect(instanced(scene, "out-tray-envelopes").count).toBe(3);
    expect(object(scene, "dropping-envelope").visible).toBe(false);
    await act(async () => {
      await scene.update(reception(40));
    });
    await frames(scene, 600);
    expect(instanced(scene, "out-tray-envelopes").count).toBe(maxPile);
  });

  it("lands envelopes at once with reduced motion", async () => {
    useSceneSettings.setState({ reducedMotion: true });
    const scene = await renderScene(reception(0));
    await frames(scene, 1);
    await act(async () => {
      await scene.update(reception(2));
    });
    await frames(scene, 1);
    expect(object(scene, "dropping-envelope").visible).toBe(false);
    expect(instanced(scene, "out-tray-envelopes").count).toBe(2);
  });

  it("shows a red marker on the desk while a Connection is failing, and none once it recovers", async () => {
    const scene = await renderScene(reception(0, ["Team chat"]));
    await frames(scene, 1);
    const sign = object(scene, "reception-marker-sign");
    if (!(sign instanceof Mesh)) {
      throw new Error("The marker's sign is not a mesh.");
    }
    const world = new Vector3();
    sign.getWorldPosition(world);
    expect(world.toArray()).toEqual([...receptionMarker.centre]);
    // It glows in state-critical, so it blooms.
    const glow = (sign.material as MeshBasicMaterial).color;
    expect(glow.r).toBeGreaterThan(new Color(palette["state-critical"]).r);
    expect(object(scene, "reception-marker-symbol-1")).toBeDefined();

    await act(async () => {
      await scene.update(reception(0));
    });
    expect(() => object(scene, "reception-marker")).toThrow();
  });

  it("keeps the lobby within its budgets with the desk's envelopes and marker", async () => {
    const scene = await renderScene(reception(maxPile, ["Team chat"]));
    await frames(scene, 1);
    let meshes = 0;
    scene.scene.instance.traverse((child) => {
      if (child instanceof Mesh && child.visible) {
        meshes += 1;
      }
    });
    // The desk adds a handful of draw calls: the pile, the dropping
    // envelope, and the marker's post, sign and symbol.
    expect(meshes).toBeLessThan(200);
  });
});
