import {
  floorThemes,
  type FloorTheme,
  type Notice,
  type Role,
} from "@ai-office/shared";
import { randomAvatar, seededRandom } from "@ai-office/shared/avatar";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import {
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  SkinnedMesh,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from "three";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { agentLook, maxTicketsShown, type AgentLook } from "./agent-state.ts";
import { keyboardAt } from "./avatar-animations.ts";
import { avatarTriangleBudget } from "./avatar-geometry.ts";
import { avatarOf, deskItemAt, mascotAt } from "./desk-agents.tsx";
import { placeDeskItems } from "./desk-item-layout.ts";
import { desk } from "./desk-set.ts";
import { contactShadowBlur, Floor } from "./floor.tsx";
import {
  floorLayout,
  floorLogo,
  wallBoard,
  wallPosters,
  type FloorAgent,
} from "./floor-layout.ts";
import { liftStops } from "./lift-stops.ts";
import { material } from "./materials.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import {
  monitorScreens,
  screenRows,
  type MonitorScreen,
} from "./monitor-preview.ts";
import { boardPreview, type BoardPreview } from "./notice-board-preview.ts";
import { triangles } from "./piece-geometry.ts";
import { qualityPresets } from "./quality.ts";
import { noSeason, resetSeason, useSeason } from "./season.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk, readModelFile } from "./test-models.ts";

// A Floor in React Three Fiber, rendered without WebGL by its test
// renderer: its rooms and a desk for each Agent, the asset pack's models
// merged in once loaded, Low's contact shadows, and its cost per frame.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const workRoles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];

/** A Manager and `size - 1` Agents in the Roles in turn. */
const team = (size: number): FloorAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role:
      index === 0
        ? "manager"
        : (workRoles[index % workRoles.length] ?? "coder"),
  }));

const stops = liftStops([], []);

let renderer: Renderer | undefined;
let models: LoadedModels;

async function renderFloor(
  agents: readonly FloorAgent[],
  monitors?: ReadonlyMap<string, MonitorScreen>,
  board?: BoardPreview,
  states?: { looks: ReadonlyMap<string, AgentLook>; needsOwner: boolean },
  theme?: FloorTheme,
): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(
    <Floor
      floorId="web-shop"
      theme={theme}
      team={agents}
      monitors={monitors}
      board={board}
      looks={states?.looks}
      needsOwner={states?.needsOwner}
      stops={stops}
    />,
  );
  return renderer;
}

/** Every Agent at work, its screen full of its output. */
const allAtWork = (agents: readonly FloorAgent[]) =>
  monitorScreens(
    agents.map(({ id }) => id),
    agents.flatMap(({ id }, index) => [
      {
        id: index * 100 + 1,
        occurredAt: "2026-10-09T12:00:00.000Z",
        event: {
          type: "agent.status_changed" as const,
          version: 1 as const,
          floorId: "web-shop",
          agentId: id,
          status: "working" as const,
          issue: 4,
        },
      },
      ...Array.from({ length: screenRows }, (_, line) => ({
        id: index * 100 + 2 + line,
        occurredAt: "2026-10-09T12:00:00.000Z",
        event: {
          type: "sandbox.text" as const,
          version: 1 as const,
          floorId: "web-shop",
          agentId: id,
          issue: 4,
          sandboxId: `sbx-${id}`,
          text: "Running the tests…",
        },
      })),
    ]),
  );

function object(scene: Renderer, name: string): Object3D {
  const found = scene.scene.instance.getObjectByName(name);
  if (found === undefined) {
    throw new Error(`The scene has nothing named "${name}".`);
  }
  return found;
}

/** The meshes in a group, by name. */
const meshesIn = (scene: Renderer, group: string) =>
  object(scene, group).children.filter(
    (child): child is Mesh => child instanceof Mesh,
  );

/** The triangles a group's meshes draw. */
const trianglesIn = (scene: Renderer, group: string) =>
  meshesIn(scene, group).reduce(
    (sum, mesh) => sum + triangles(mesh.geometry),
    0,
  );

beforeAll(async () => {
  models = await loadModelsFromDisk();
});

beforeEach(() => {
  resetSceneSettings();
  resetSeason();
  provideModels(models);
});

afterEach(async () => {
  await act(async () => {
    await renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("a Floor in the scene", () => {
  it("hangs the company logo on its left wall, facing the room", async () => {
    const scene = await renderFloor(team(4));
    const logo = object(scene, "floor-logo");
    expect(logo.position.toArray()).toEqual([...floorLogo.position]);
    // Turned to face +x, into the room.
    const facing = new Vector3(0, 0, 1).applyQuaternion(logo.quaternion);
    expect(facing.x).toBeCloseTo(1);
    // jsdom loads no images, so it never shows here.
    expect(logo.visible).toBe(false);
  });

  it("hangs its adventure game posters in their frames, as one mesh", async () => {
    const scene = await renderFloor(team(4));
    const posters = object(scene, "wall-posters");
    expect(posters).toBeInstanceOf(Mesh);
    // A face for each poster: two triangles each, in one draw call.
    expect(triangles((posters as Mesh).geometry)).toBe(2 * wallPosters.length);
    // jsdom has no canvas to draw their art on, so it never shows here.
    expect(posters.visible).toBe(false);
    // Their frames are among the Floor's pieces.
    const frames = floorLayout(team(4)).pieces.filter(({ name }) =>
      name.startsWith("poster frame"),
    );
    expect(frames).toHaveLength(wallPosters.length);
  });

  it("draws its rooms and desks as one mesh per shared material", async () => {
    const scene = await renderFloor(team(4));
    const pieces = meshesIn(scene, "pieces");
    const names = pieces.map(({ name }) => name);
    expect(names).toContain("desk-top/wood");
    expect(names).toContain("screen-off/screen");
    expect(names).toContain("glass/glass");
    expect(names).toContain("stage-qa/paint");
    for (const mesh of pieces) {
      const [token, surface] = mesh.name.split("/") as [never, never];
      expect(mesh.material).toBe(material(token, surface));
    }
    // A material may be drawn twice: once casting shadows, once not.
    expect(pieces.length).toBeLessThanOrEqual(2 * new Set(names).size);
    expect(object(scene, "lift")).toBeDefined();
  });

  it("merges the asset pack's models in, in the palette's shared materials", async () => {
    const scene = await renderFloor(team(4));
    const placed = meshesIn(scene, "models");
    expect(placed.map(({ name }) => name).sort()).toEqual(
      [
        "ceramic/plastic",
        "chair/fabric",
        "desk-top/wood",
        "floor-wood/wood",
        "metal-dark/metal",
        "metal-light/metal",
        "paper/paint",
        "plant/plastic",
        "screen-off/screen",
        "sofa/fabric",
        "wall-feature/paint",
      ].sort(),
    );
    for (const mesh of placed) {
      const [token, surface] = mesh.name.split("/") as [never, never];
      expect(mesh.material).toBe(material(token, surface));
      expect(mesh.castShadow).toBe(true);
    }
    // The coffee machine is on the canteen's worktop, by the back wall.
    const metal = placed.find(({ name }) => name === "metal-light/metal");
    metal?.geometry.computeBoundingBox();
    expect(metal?.geometry.boundingBox?.max.x).toBeGreaterThan(9);
  });

  it("is dressed in its theme, its props merged into the shared materials", async () => {
    const office = await renderFloor(team(6));
    const officeTriangles = trianglesIn(office, "pieces");
    await act(async () => {
      await office.unmount();
    });
    const scene = await renderFloor(
      team(6),
      undefined,
      undefined,
      undefined,
      "data-centre",
    );
    // The racks' cabinets and servers, and their lit status lights.
    expect(trianglesIn(scene, "pieces")).toBeGreaterThan(officeTriangles);
    const lights = meshesIn(scene, "pieces").find(
      ({ name }) => name === "state-ok/lamp",
    );
    expect(lights?.material).toBe(material("state-ok", "lamp"));
    for (const mesh of meshesIn(scene, "pieces")) {
      const [token, surface] = mesh.name.split("/") as [never, never];
      expect(mesh.material).toBe(material(token, surface));
    }
  });

  it("draws its pieces at once, and its models when they have loaded", async () => {
    provideModels(undefined);
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        fetched.push(url.pathname);
        return new Response(await readModelFile(url));
      }),
    );
    const scene = await renderFloor(team(4));
    expect(meshesIn(scene, "pieces").length).toBeGreaterThan(0);
    await act(async () => {
      await vi.waitFor(() => {
        expect(meshesIn(scene, "models").length).toBeGreaterThan(0);
      });
    });
    expect(fetched.sort()).toEqual(
      [
        "bookcase",
        "books",
        "coffee-machine",
        "fridge",
        "laptop",
        "potted-plant",
      ].map((name) => `/src/scene/models/${name}.glb`),
    );
  });

  it("adds a desk when an Agent joins, and takes one away when one leaves", async () => {
    const scene = await renderFloor(team(4));
    const screens = () =>
      meshesIn(scene, "pieces")
        .filter(({ name }) => name === "screen-off/screen")
        .reduce((sum, mesh) => sum + triangles(mesh.geometry), 0);
    const four = screens();
    await act(async () => {
      await scene.update(
        <Floor floorId="web-shop" team={team(5)} stops={stops} />,
      );
    });
    // The fifth Agent is a designer: two more monitors.
    const five = screens();
    expect(five).toBeGreaterThan(four);
    await act(async () => {
      await scene.update(
        <Floor floorId="web-shop" team={team(3)} stops={stops} />,
      );
    });
    expect(screens()).toBeLessThan(four);
  });

  it("lights its working Agents' monitors, and leaves the rest off", async () => {
    const agents = team(4);
    const [, coder, reviewer] = agents;
    const monitors = new Map(
      [...allAtWork(agents)].filter(([id]) => id === coder?.id),
    );
    const scene = await renderFloor(agents, monitors);
    const displays = object(scene, "monitor-displays") as InstancedMesh;
    const writing = object(scene, "monitor-writing") as InstancedMesh;
    expect(displays.count).toBe(1);
    expect(writing.count).toBe(screenRows);
    // The reviewer starts work: its monitor lights up too.
    await act(async () => {
      await scene.update(
        <Floor
          floorId="web-shop"
          team={agents}
          monitors={
            new Map(
              [...allAtWork(agents)].filter(
                ([id]) => id === coder?.id || id === reviewer?.id,
              ),
            )
          }
          stops={stops}
        />,
      );
    });
    expect(displays.count).toBe(2);
  });

  it("pins its own Notices on its wall board, over the board's felt", async () => {
    const agents = team(4);
    const notice = (id: string, kind: Notice["kind"], minute: number) => ({
      id,
      kind,
      title:
        kind === "action" ? "PR #14 awaiting your approval" : "PR #3 opened",
      floorId: "web-shop",
      agentId: null,
      issue: null,
      pullRequest: null,
      ciRunUrl: null,
      actions: [],
      createdAt: `2026-10-09T12:0${String(minute)}:00.000Z`,
      dismissedAt: null,
      actedAt: null,
      actedOn: null,
      links: [],
      positions: [],
    });
    const scene = await renderFloor(
      agents,
      undefined,
      boardPreview([notice("a", "action", 2), notice("b", "info", 1)]),
    );
    // An action card with two pins, an info card with one, as in the lobby.
    expect((object(scene, "wall-board-sheets") as InstancedMesh).count).toBe(2);
    expect((object(scene, "wall-board-pins") as InstancedMesh).count).toBe(3);
    // On the wall board's felt, in front of it.
    const [x, y, z] = wallBoard.centre;
    const felt = floorLayout(agents).pieces.find(
      ({ name }) => name === "wall board, felt",
    );
    const feltFace = (felt?.position[2] ?? 0) + (felt?.size[2] ?? 0) / 2;
    const sheets = object(scene, "wall-board-sheets") as InstancedMesh;
    sheets.updateWorldMatrix(true, false);
    const matrix = new Matrix4();
    for (let index = 0; index < sheets.count; index += 1) {
      sheets.getMatrixAt(index, matrix);
      const at = new Vector3()
        .setFromMatrixPosition(matrix)
        .applyMatrix4(sheets.matrixWorld);
      expect(Math.abs(at.x - x)).toBeLessThan(wallBoard.width / 2);
      expect(Math.abs(at.y - y)).toBeLessThan(wallBoard.height / 2);
      expect(at.z).toBeGreaterThan(feltFace);
      expect(at.z).toBeLessThan(z + 0.05);
    }
    // With no Notices known, the board is bare.
    await act(async () => {
      await scene.update(
        <Floor floorId="web-shop" team={agents} stops={stops} />,
      );
    });
    expect(scene.scene.instance.getObjectByName("wall-board")).toBeUndefined();
  });

  it("seats each Agent at its desk as its Avatar, facing its monitor", async () => {
    const agents = team(6).map((agent, index) =>
      index === 2
        ? { ...agent, avatar: randomAvatar(seededRandom("their own")) }
        : agent,
    );
    const layout = floorLayout(agents);
    const scene = await renderFloor(agents);
    for (const each of layout.desks) {
      const seated = object(scene, `agent-${each.agentId}`);
      const at = seated.getWorldPosition(new Vector3());
      expect(at.x).toBeCloseTo(each.seat[0], 6);
      expect(at.z).toBeCloseTo(each.seat[2], 6);
      // Avatars face +z; turned, it faces its screens.
      const facing = new Vector3(0, 0, 1).applyQuaternion(
        seated.getWorldQuaternion(new Quaternion()),
      );
      const toScreen = new Vector3(...each.screens.centre)
        .sub(at)
        .setY(0)
        .normalize();
      expect(facing.dot(toScreen)).toBeGreaterThan(0.99);
      const skinned = seated.getObjectByName("avatar");
      expect(skinned).toBeInstanceOf(SkinnedMesh);
    }
    // The Agent's own Avatar, or one seeded from its id without one.
    const own = agents[2];
    const ownColours = (
      object(scene, `agent-${own?.id ?? ""}`).getObjectByName(
        "avatar",
      ) as SkinnedMesh
    ).geometry.getAttribute("color");
    expect(own?.avatar).toBeDefined();
    expect(avatarOf({ id: "agent-1" })).toEqual(
      randomAvatar(seededRandom("agent-1")),
    );
    expect(ownColours.count).toBeGreaterThan(0);
  });

  it("types while its Agent works, its hands at the keyboard, and sits back otherwise", async () => {
    const agents = team(3);
    const [, coder, reviewer] = agents;
    const monitors = new Map(
      [...allAtWork(agents)].filter(([id]) => id === coder?.id),
    );
    const scene = await renderFloor(agents, monitors);
    await act(async () => {
      await scene.advanceFrames(30, 1 / 60);
    });
    const handOf = (id: string) => {
      const seated = object(scene, `agent-${id}`);
      const hand = seated.getObjectByName("rightHand");
      const local = seated.worldToLocal(
        hand?.getWorldPosition(new Vector3()) ?? new Vector3(),
      );
      return local;
    };
    const typing = handOf(coder?.id ?? "");
    expect(typing.y).toBeGreaterThan(keyboardAt.y);
    expect(typing.y).toBeLessThan(keyboardAt.y + 0.08);
    expect(typing.z).toBeGreaterThan(keyboardAt.z - 0.15);
    // The reviewer is not working: its hands are in its lap, nearer.
    const resting = handOf(reviewer?.id ?? "");
    expect(resting.z).toBeLessThan(typing.z - 0.1);
  });

  it("moves its Agents' Avatars each frame, and holds them still with reduced motion", async () => {
    const agents = team(2);
    const [, coder] = agents;
    const scene = await renderFloor(agents, allAtWork(agents));
    const hand = () =>
      object(scene, `agent-${coder?.id ?? ""}`)
        .getObjectByName("leftHand")
        ?.quaternion.clone() ?? new Quaternion();
    await act(async () => {
      await scene.advanceFrames(1, 1 / 60);
    });
    const before = hand();
    await act(async () => {
      await scene.advanceFrames(10, 1 / 60);
    });
    expect(hand().angleTo(before)).toBeGreaterThan(0.001);

    await act(async () => {
      useSceneSettings.getState().setReducedMotion(true);
      await Promise.resolve();
    });
    const held = hand();
    await act(async () => {
      await scene.advanceFrames(10, 1 / 60);
    });
    expect(hand().angleTo(held)).toBeLessThan(1e-6);
  });

  it("draws each quality setting's LOD of its Avatars", async () => {
    const agents = team(2);
    const scene = await renderFloor(agents);
    const avatarTriangles = () =>
      triangles(
        (
          object(scene, `agent-${agents[1]?.id ?? ""}`).getObjectByName(
            "avatar",
          ) as SkinnedMesh
        ).geometry,
      );
    const counts: number[] = [];
    for (const quality of ["low", "medium", "high"] as const) {
      await act(async () => {
        useSceneSettings.getState().setQuality(quality);
        await Promise.resolve();
      });
      counts.push(avatarTriangles());
      expect(avatarTriangles()).toBeLessThanOrEqual(
        avatarTriangleBudget[quality],
      );
    }
    expect(counts[0]).toBeLessThan(counts[1] ?? 0);
    expect(counts[1]).toBeLessThan(counts[2] ?? 0);
  });

  it("puts each Agent's desk mascot on its desk, all in one mesh", async () => {
    const agents = team(5);
    const layout = floorLayout(agents);
    const scene = await renderFloor(agents);
    const mascots = object(scene, "desk-mascots") as Mesh;
    expect(mascots.children).toHaveLength(0);
    mascots.geometry.computeBoundingBox();
    const box = mascots.geometry.boundingBox;
    // On the desk tops, and no taller than a small prop.
    expect(box?.min.y).toBeCloseTo(desk.top, 2);
    expect(box?.max.y).toBeLessThan(desk.top + 0.13);
    for (const each of layout.desks) {
      const [x, , z] = mascotAt(each.seat, each.turns);
      // On its own desk's top.
      expect(x).toBeGreaterThan(each.desk.x[0]);
      expect(x).toBeLessThan(each.desk.x[1]);
      expect(z).toBeGreaterThan(each.desk.z[0]);
      expect(z).toBeLessThan(each.desk.z[1]);
    }
  });

  it("puts each Agent's chosen desk items on its desk, all in one mesh, and none where none are chosen", async () => {
    const plain = team(3);
    const bare = await renderFloor(plain);
    expect(bare.scene.instance.getObjectByName("desk-items")).toBeUndefined();
    await bare.unmount();
    const agents = plain.map((agent, index) => ({
      ...agent,
      avatar: {
        ...randomAvatar(seededRandom(agent.id)),
        deskItems:
          index === 0
            ? []
            : (["laptop", "pen", "desk-lamp", "globe", "trophy"] as const)
                .slice(0, index * 2 + 1)
                .map((each) => each),
      },
    }));
    const layout = floorLayout(agents);
    const scene = await renderFloor(agents);
    const items = object(scene, "desk-items") as Mesh;
    items.geometry.computeBoundingBox();
    const box = items.geometry.boundingBox;
    // On the desk tops, the desk lamp the tallest.
    expect(box?.min.y).toBeCloseTo(desk.top, 2);
    expect(box?.max.y).toBeLessThan(desk.top + 0.45);
    for (const each of layout.desks) {
      const agent = agents.find(({ id }) => id === each.agentId);
      for (const placement of placeDeskItems(
        { role: each.role },
        agent?.avatar.deskItems ?? [],
      )) {
        const [x, , z] = deskItemAt(each.seat, each.turns, placement);
        // On its own desk's top.
        expect(x).toBeGreaterThan(each.desk.x[0]);
        expect(x).toBeLessThan(each.desk.x[1]);
        expect(z).toBeGreaterThan(each.desk.z[0]);
        expect(z).toBeLessThan(each.desk.z[1]);
      }
    }
  });

  it("dresses up in season: decorations, twinkling lights, nibbles, and Agents in costume", async () => {
    const agents = team(4);
    const plain = await renderFloor(agents);
    expect(
      plain.scene.instance.getObjectByName("seasonal-decorations"),
    ).toBeUndefined();
    const plainAgent = triangles(
      (plain.scene.instance.getObjectByName("avatar") as Mesh).geometry,
    );
    await plain.unmount();
    useSeason.setState({
      ...noSeason,
      events: ["halloween", "new-year"],
      costumes: true,
      partyHats: true,
      nibbles: true,
    });
    const scene = await renderFloor(agents);
    const decorations = object(scene, "seasonal-decorations") as Mesh;
    expect(triangles(decorations.geometry)).toBeGreaterThan(0);
    expect(
      scene.scene.instance.getObjectByName("seasonal-lights state-warning"),
    ).toBeInstanceOf(InstancedMesh);
    // Costumed and hatted, each Agent has more to it.
    expect(
      triangles((object(scene, "avatar") as Mesh).geometry),
    ).toBeGreaterThan(plainAgent);
  });

  it("puts a contact shadow under each Agent on Low and High, and none on Medium", async () => {
    const agents = team(4);
    useSceneSettings.getState().setQuality("low");
    const scene = await renderFloor(agents);
    const blobs = () =>
      scene.scene.instance.getObjectByName("agent-contact-shadows") as
        InstancedMesh | undefined;
    expect(blobs()?.count).toBe(agents.length);
    for (const [quality, shown] of [
      ["medium", false],
      ["high", true],
    ] as const) {
      await act(async () => {
        useSceneSettings.getState().setQuality(quality);
        await Promise.resolve();
      });
      expect(blobs() !== undefined).toBe(shown);
      expect(qualityPresets[quality].contactShadows.agents).toBe(shown);
    }
  });

  it("puts a soft contact shadow under each desk and chair on Low, and none on Medium or High", async () => {
    const agents = team(6);
    const layout = floorLayout(agents);
    useSceneSettings.getState().setQuality("low");
    const scene = await renderFloor(agents);
    const blobs = object(scene, "contact-shadows") as InstancedMesh;
    expect(blobs.count).toBe(layout.contactShadows.length);
    expect(blobs.count).toBeGreaterThanOrEqual(2 * agents.length);
    // The first is under the first desk, 30 cm of blur past each edge.
    const matrix = new Matrix4();
    blobs.getMatrixAt(0, matrix);
    const scale = new Vector3().setFromMatrixScale(matrix);
    const [first] = layout.desks;
    expect(scale.x).toBeCloseTo(
      (first?.desk.x[1] ?? 0) - (first?.desk.x[0] ?? 0) + 2 * contactShadowBlur,
      6,
    );
    expect(qualityPresets.low.contactShadows.props).toBe(true);
    // Over the carpet under the desks, not hidden in it.
    const carpet = layout.pieces.find(
      ({ name }) => name === "carpet under the desks",
    );
    const carpetTop = (carpet?.position[1] ?? 0) + (carpet?.size[1] ?? 0) / 2;
    expect(new Vector3().setFromMatrixPosition(matrix).y).toBeGreaterThan(
      carpetTop,
    );

    for (const quality of ["medium", "high"] as const) {
      await act(async () => {
        useSceneSettings.getState().setQuality(quality);
        await Promise.resolve();
      });
      expect(
        scene.scene.instance.getObjectByName("contact-shadows"),
      ).toBeUndefined();
    }
  });
});

describe("a Floor's cost", () => {
  it.each(floorThemes)(
    "is within Medium's per-frame budgets with 12 Agents at work, leaving room for their Avatars, in the %s theme",
    async (theme) => {
      const agents = team(12);
      // Every state shown at once (FR-62): a full pile of tickets on every
      // desk, a marker over every Agent, half paused and half capped, and the
      // Manager's red light on.
      const looks = new Map(
        agents.map(({ id }, index) => [
          id,
          agentLook({
            working: true,
            enabled: index % 2 === 1,
            capped: index % 2 === 1,
            awaitingReview: 0,
            queued: 25,
          }),
        ]),
      );
      // And a full wall board.
      const scene = await renderFloor(
        agents,
        allAtWork(agents),
        boardPreview(
          Array.from({ length: 9 }, (_, index) => ({
            id: `notice-${String(index)}`,
            kind: index % 2 === 0 ? ("action" as const) : ("info" as const),
            title: "Token Cap warning: Ada has used 85% of its daily Token Cap",
            floorId: "web-shop",
            agentId: null,
            issue: null,
            pullRequest: null,
            ciRunUrl: null,
            actions: [],
            createdAt: `2026-10-09T12:0${String(index)}:00.000Z`,
            dismissedAt: null,
            actedAt: null,
            actedOn: null,
            links: [],
            positions: [],
          })),
        ),
        { looks, needsOwner: true },
        theme,
      );
      expect((object(scene, "wall-board-sheets") as InstancedMesh).count).toBe(
        9,
      );
      expect((object(scene, "ticket-piles") as InstancedMesh).count).toBe(
        12 * maxTicketsShown,
      );
      expect(
        (object(scene, "agent-markers-paused") as InstancedMesh).count +
          (object(scene, "agent-markers-capped") as InstancedMesh).count,
      ).toBe(12);
      expect(object(scene, "managers-light")).toBeDefined();
      expect(
        (object(scene, "monitor-writing") as InstancedMesh).count,
      ).toBeGreaterThanOrEqual(12 * screenRows);
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
      const drawCalls = meshes + shadowCasters + 12;
      expect(drawCalls).toBeLessThanOrEqual(200);
      expect(triangleCount).toBeLessThanOrEqual(300_000);
      expect(trianglesIn(scene, "models")).toBeGreaterThan(0);
      // The count includes the twelve Agents, each one skinned mesh at
      // Medium's LOD, within its budget, as one draw call (and a shadow).
      const avatars: Mesh[] = [];
      scene.scene.instance.traverse((child) => {
        if (child instanceof SkinnedMesh) {
          avatars.push(child as Mesh);
        }
      });
      expect(avatars).toHaveLength(12);
      for (const avatar of avatars) {
        expect(triangles(avatar.geometry)).toBeLessThanOrEqual(
          avatarTriangleBudget.medium,
        );
        expect(avatar.castShadow).toBe(true);
        expect(Array.isArray(avatar.material)).toBe(false);
      }
    },
  );
});
