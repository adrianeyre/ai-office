import type { OfficeEvent } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import { palette, type PaletteToken } from "@ai-office/shared/palette";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import {
  Color,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Object3D,
} from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Vec3 } from "./camera-rig.ts";
import { monitor } from "./desk-set.ts";
import {
  floorLayout,
  type FloorAgent,
  type FloorDesk,
} from "./floor-layout.ts";
import {
  monitorScreens,
  screenColumns,
  screenRows,
  type MonitorScreen,
} from "./monitor-preview.ts";
import {
  display,
  MonitorScreens,
  rowPitch,
  screenGlow,
  screenLayers,
} from "./monitor-screens.tsx";
import { turnPoint } from "./pieces.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";

// The desks' monitors in React Three Fiber, without WebGL: a working
// Agent's screens glow and fill with its lines, which scroll up as new
// ones come; an idle Agent's stay off.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const team: FloorAgent[] = [
  { id: "max", role: "manager" },
  { id: "ada", role: "coder" },
  { id: "dee", role: "designer" },
  { id: "rex", role: "reviewer" },
];
const { desks, pieces } = floorLayout(team);
const deskOf = (agentId: string): FloorDesk => {
  const desk = desks.find((each) => each.agentId === agentId);
  if (desk === undefined) {
    throw new Error(`No desk for ${agentId}.`);
  }
  return desk;
};

const stored = (id: number, event: OfficeEvent): StreamedEvent => ({
  id,
  occurredAt: new Date(Date.UTC(2026, 9, 9, 12, 0, id)).toISOString(),
  event,
});

const working = (id: number, agentId: string) =>
  stored(id, {
    type: "agent.status_changed",
    version: 1,
    floorId: "web-shop",
    agentId,
    status: "working",
    issue: 4,
  });

const idle = (id: number, agentId: string) =>
  stored(id, {
    type: "agent.status_changed",
    version: 1,
    floorId: "web-shop",
    agentId,
    status: "idle",
  });

const text = (id: number, agentId: string, words: string) =>
  stored(id, {
    type: "sandbox.text",
    version: 1,
    floorId: "web-shop",
    agentId,
    issue: 4,
    sandboxId: `sbx-${agentId}`,
    text: words,
  });

/**
 * `count` lines of output from `agentId`, one event each, from id `from`:
 * each as long as its id plus 3 characters, so each line is told apart by
 * its length.
 */
const output = (from: number, agentId: string, count: number) =>
  Array.from({ length: count }, (_, index) =>
    text(from + index, agentId, "x".repeat(from + index + 3)),
  );

const screensOf = (events: readonly StreamedEvent[]) =>
  monitorScreens(
    team.map(({ id }) => id),
    events,
  );

let renderer: Renderer | undefined;

async function renderMonitors(
  screens: ReadonlyMap<string, MonitorScreen>,
): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(
    <MonitorScreens desks={desks} screens={screens} />,
  );
  return renderer;
}

async function update(
  scene: Renderer,
  screens: ReadonlyMap<string, MonitorScreen>,
) {
  await act(async () => {
    await scene.update(<MonitorScreens desks={desks} screens={screens} />);
  });
}

/** Runs `count` frames of 1/60 s, one at a time. */
async function frames(scene: Renderer, count: number) {
  for (let frame = 0; frame < count; frame += 1) {
    await act(() => scene.advanceFrames(1, 1 / 60));
  }
}

function object(scene: Renderer, name: string): Object3D {
  const found = scene.scene.instance.getObjectByName(name);
  if (found === undefined) {
    throw new Error(`The scene has nothing named "${name}".`);
  }
  return found;
}

const displays = (scene: Renderer) =>
  object(scene, "monitor-displays") as InstancedMesh;
const writing = (scene: Renderer) =>
  object(scene, "monitor-writing") as InstancedMesh;

interface Placed {
  readonly position: Vector3;
  readonly size: Vector3;
  readonly colour: Color;
}

/** Each instance's centre, size and colour, in the frame `frame` gives (world by default). */
function instances(mesh: InstancedMesh, frame = new Matrix4()): Placed[] {
  return Array.from({ length: mesh.count }, (_, index) => {
    const matrix = new Matrix4();
    mesh.getMatrixAt(index, matrix);
    const local = frame.clone().multiply(matrix);
    const colour = new Color();
    mesh.getColorAt(index, colour);
    return {
      position: new Vector3().setFromMatrixPosition(local),
      size: new Vector3().setFromMatrixScale(local),
      colour,
    };
  });
}

/** From world space into a screen's own: x right and y up on its face, z towards the chair. */
const intoScreen = (centre: Vec3, desk: FloorDesk) =>
  new Matrix4()
    .compose(
      new Vector3(...centre),
      new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0),
        (desk.turns * Math.PI) / 2,
      ),
      new Vector3(1, 1, 1),
    )
    .invert();

/** The instances on one screen, in its own frame, nearest the screen's centre. */
function onScreen(mesh: InstancedMesh, desk: FloorDesk, screen = 0) {
  const centre = desk.screenCentres[screen] ?? [0, 0, 0];
  return instances(mesh, intoScreen(centre, desk)).filter(
    ({ position }) =>
      Math.abs(position.x) < monitor.width / 2 &&
      Math.abs(position.y) < monitor.height / 2 &&
      Math.abs(position.z) < 0.05,
  );
}

/** Instance matrices are 32-bit floats: equal to a micrometre. */
const tolerance = 1e-6;
const near = (values: readonly number[]) =>
  values.map((value) => expect.closeTo(value, 6) as number);

const hex = (token: PaletteToken, scale = 1) =>
  new Color(palette[token]).multiplyScalar(scale).getHexString();

/** The width of a full line of writing. */
const lineWidth = display.width - 2 * display.padding;

/** The y on a screen of a line settled on `row`, from the top. */
const rowY = (row: number) =>
  display.height / 2 - display.padding - (row + 0.5) * rowPitch;

beforeEach(() => {
  resetSceneSettings();
  useSceneSettings.getState().setReducedMotion(false);
});

afterEach(async () => {
  await act(async () => {
    await renderer?.unmount();
  });
  renderer = undefined;
});

describe("the desks' monitors in the scene", () => {
  it("stay off while their Agents are idle", async () => {
    const scene = await renderMonitors(
      screensOf([working(1, "ada"), text(2, "ada", "done"), idle(3, "ada")]),
    );
    expect(displays(scene).count).toBe(0);
    expect(writing(scene).count).toBe(0);
  });

  it("glow over each of a working Agent's screens, on the face its chair sees", async () => {
    const scene = await renderMonitors(
      screensOf([working(1, "ada"), working(2, "dee")]),
    );
    // The coder's one screen and the designer's two; not the idle Manager's or reviewer's.
    expect(displays(scene).count).toBe(3);
    const placed = instances(displays(scene));
    const expected = [deskOf("ada"), deskOf("dee")].flatMap((desk) =>
      desk.screenCentres.map((centre) => {
        const facing = turnPoint([0, 0, 1], desk.turns, [0, 0]);
        return new Vector3(...centre).addScaledVector(
          new Vector3(...facing),
          screenLayers.display,
        );
      }),
    );
    expect(placed.map(({ position }) => position.toArray())).toEqual(
      expected.map((position) => near(position.toArray())),
    );
    for (const { size, colour } of placed) {
      expect(size.x).toBeCloseTo(display.width, 6);
      expect(size.y).toBeCloseTo(display.height, 6);
      // `screen-glow` at the spec's screen emissive: bright enough to bloom.
      expect(colour.getHexString()).toBe(hex("screen-glow", screenGlow.base));
      expect(Math.max(colour.r, colour.g, colour.b)).toBeGreaterThan(0.9);
    }
    // Each over a screen of the desk, in front of it, towards the chair.
    const screenPieces = pieces.filter(({ name }) =>
      /^desk of (ada|dee), monitors?, (left |right )?screen$/.test(name),
    );
    expect(screenPieces.map(({ position }) => position)).toEqual([
      ...deskOf("ada").screenCentres,
      ...deskOf("dee").screenCentres,
    ]);
    for (const [index, { position }] of placed.entries()) {
      const desk = index === 0 ? deskOf("ada") : deskOf("dee");
      const centre = screenPieces[index]?.position ?? [0, 0, 0];
      const seat = new Vector3(...desk.seat);
      expect(position.distanceTo(seat)).toBeLessThan(
        new Vector3(...centre).distanceTo(seat),
      );
    }
  });

  it("write the Agent's lines on its display, top down, each in its kind's colour", async () => {
    const scene = await renderMonitors(
      screensOf([
        working(1, "ada"),
        text(2, "ada", "Running the tests.\n    12 passed"),
        stored(3, {
          type: "sandbox.tool_call",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          issue: 4,
          sandboxId: "sbx-ada",
          name: "Bash",
          args: "pnpm test",
        }),
      ]),
    );
    const lines = onScreen(writing(scene), deskOf("ada")).filter(
      ({ position }) => position.z > screenLayers.display,
    );
    expect(lines).toHaveLength(3);
    expect(lines.map(({ position }) => position.y)).toEqual(
      [0, 1, 2].map((row) => expect.closeTo(rowY(row), 6) as number),
    );
    expect(lines.map(({ colour }) => colour.getHexString())).toEqual([
      hex("ink"),
      hex("ink"),
      hex("state-info"),
    ]);
    for (const { position, size } of lines) {
      // On the display, inside its padding.
      expect(position.x - size.x / 2).toBeGreaterThanOrEqual(
        -display.width / 2 + display.padding - tolerance,
      );
      expect(position.x + size.x / 2).toBeLessThanOrEqual(
        display.width / 2 - display.padding + tolerance,
      );
    }
    // The indented line starts further in.
    const [first, second] = lines;
    expect(
      (second?.position.x ?? 0) - (second?.size.x ?? 0) / 2,
    ).toBeGreaterThan((first?.position.x ?? 0) - (first?.size.x ?? 0) / 2);
  });

  it("show the same lines on each of a designer's two screens", async () => {
    const scene = await renderMonitors(
      screensOf([working(1, "dee"), ...output(2, "dee", 3)]),
    );
    const left = onScreen(writing(scene), deskOf("dee"), 0);
    const right = onScreen(writing(scene), deskOf("dee"), 1);
    expect(left).toHaveLength(3);
    expect(right.map(({ position }) => position.toArray())).toEqual(
      left.map(({ position }) => near(position.toArray())),
    );
  });

  it("scroll up as new lines come, the newest settling at the bottom", async () => {
    const before = [working(1, "ada"), ...output(2, "ada", screenRows)];
    const scene = await renderMonitors(screensOf(before));
    /** The lines drawn, top down: where each is, and which it is (its length in characters). */
    const drawn = () =>
      onScreen(writing(scene), deskOf("ada"))
        .sort((a, b) => b.position.y - a.position.y)
        .map(({ position, size }) => ({
          y: position.y,
          characters: Math.round((size.x / lineWidth) * screenColumns),
        }));
    const lengths = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => from + index + 3);
    const settledRows = near(
      Array.from({ length: screenRows }, (_, row) => rowY(row)),
    );
    expect(drawn().map(({ y }) => y)).toEqual(settledRows);
    expect(drawn().map(({ characters }) => characters)).toEqual(
      lengths(2, screenRows),
    );

    await update(scene, screensOf([...before, ...output(20, "ada", 2)]));
    // At first every line is where it was: the new ones are still below.
    expect(drawn().map(({ y }) => y)).toEqual(settledRows);
    expect(drawn().map(({ characters }) => characters)).toEqual(
      lengths(2, screenRows),
    );
    // Then they move up, never more than a row more than a screen holds…
    await frames(scene, 1);
    const oldNewest = drawn().find(
      ({ characters }) => characters === 2 + screenRows - 1 + 3,
    );
    expect(oldNewest?.y).toBeGreaterThan(rowY(screenRows - 1));
    for (let frame = 0; frame < 30; frame += 1) {
      await frames(scene, 1);
      const lines = drawn();
      expect(lines.length).toBeLessThanOrEqual(screenRows + 1);
      for (const { y } of lines) {
        expect(y).toBeGreaterThanOrEqual(rowY(screenRows - 0.5) - tolerance);
        expect(y).toBeLessThanOrEqual(rowY(-0.5) + tolerance);
      }
    }
    // …and settle with the newest at the bottom, the two oldest gone.
    await frames(scene, 60);
    expect(drawn().map(({ y }) => y)).toEqual(settledRows);
    expect(drawn().map(({ characters }) => characters)).toEqual([
      ...lengths(4, screenRows - 2),
      ...lengths(20, 2),
    ]);
  });

  it("fill from the top before they scroll, as a terminal does", async () => {
    const scene = await renderMonitors(
      screensOf([working(1, "ada"), ...output(2, "ada", 2)]),
    );
    await update(scene, screensOf([working(1, "ada"), ...output(2, "ada", 3)]));
    // Room for it: the new line is at once on the next row, nothing moves.
    expect(
      onScreen(writing(scene), deskOf("ada")).map(({ position }) => position.y),
    ).toEqual([0, 1, 2].map((row) => expect.closeTo(rowY(row), 6) as number));
  });

  it("glow brighter for a moment as a line comes, then settle back", async () => {
    const before = [working(1, "ada")];
    const scene = await renderMonitors(screensOf(before));
    const brightness = () => {
      const [placed] = instances(displays(scene));
      return placed?.colour.b ?? 0;
    };
    const base = brightness();
    await update(scene, screensOf([...before, text(2, "ada", "hello")]));
    expect(brightness()).toBeCloseTo(
      (base * (screenGlow.base + screenGlow.pulse)) / screenGlow.base,
      5,
    );
    await frames(scene, 5);
    expect(brightness()).toBeLessThan(
      (base * (screenGlow.base + screenGlow.pulse)) / screenGlow.base,
    );
    expect(brightness()).toBeGreaterThan(base);
    await frames(scene, 180);
    expect(brightness()).toBeCloseTo(base, 5);
  });

  it("with reduced motion, show new lines at once, with a steady glow", async () => {
    useSceneSettings.getState().setReducedMotion(true);
    const before = [working(1, "ada"), ...output(2, "ada", screenRows)];
    const scene = await renderMonitors(screensOf(before));
    const [first] = instances(displays(scene));
    await update(scene, screensOf([...before, ...output(20, "ada", 3)]));
    const lines = onScreen(writing(scene), deskOf("ada")).sort(
      (a, b) => b.position.y - a.position.y,
    );
    expect(lines.map(({ position }) => position.y)).toEqual(
      near(Array.from({ length: screenRows }, (_, row) => rowY(row))),
    );
    // The newest is already at the bottom.
    expect(lines.at(-1)?.size.x).toBeCloseTo(
      (lineWidth * (22 + 3)) / screenColumns,
      6,
    );
    const [after] = instances(displays(scene));
    expect(after?.colour.getHexString()).toBe(first?.colour.getHexString());
  });

  it("go off when the Agent stops, and start empty when it works again", async () => {
    const events = [working(1, "ada"), ...output(2, "ada", 3)];
    const scene = await renderMonitors(screensOf(events));
    expect(displays(scene).count).toBe(1);
    await update(scene, screensOf([...events, idle(9, "ada")]));
    expect(displays(scene).count).toBe(0);
    expect(writing(scene).count).toBe(0);
    await update(
      scene,
      screensOf([...events, idle(9, "ada"), working(10, "ada")]),
    );
    expect(displays(scene).count).toBe(1);
    expect(writing(scene).count).toBe(0);
  });

  it("make room when a desk is added", async () => {
    const many: FloorAgent[] = Array.from({ length: 12 }, (_, index) => ({
      id: `agent-${String(index)}`,
      role: index === 0 ? "manager" : "designer",
    }));
    const events = many.flatMap(({ id }, index) => [
      working(index * 100 + 1, id),
      ...output(index * 100 + 2, id, screenRows),
    ]);
    const screens = monitorScreens(
      many.map(({ id }) => id),
      events,
    );
    renderer = await ReactThreeTestRenderer.create(
      <MonitorScreens desks={floorLayout(many).desks} screens={screens} />,
    );
    // The Manager's one screen, and eleven designers' two each.
    expect(displays(renderer).count).toBe(23);
    expect(writing(renderer).count).toBe(23 * screenRows);
  });
});
