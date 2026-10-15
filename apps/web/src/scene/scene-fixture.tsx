import {
  defaultFreshStartThreshold,
  developmentTemplateId,
  managerRole,
  parseFloorTemplateManifest,
  parseRoleDocument,
  type Floor,
} from "@ai-office/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { agentLooks } from "./agent-state.ts";
import type { CameraPose } from "./camera-rig.ts";
import { useCameraStore } from "./camera-store.ts";
import type { FloorAgent } from "./floor-layout.ts";
import { liftAt } from "./lift.ts";
import { useLiftStore } from "./lift-store.ts";
import { liftStops } from "./lift-stops.ts";
import { loadModels, provideModels } from "./models.ts";
import { boardPreview } from "./notice-board-preview.ts";
import { OfficeScene } from "./office-scene.tsx";
import { qualityLevels, type QualityLevel } from "./quality.ts";
import { useSceneSettings } from "./scene-settings.ts";

// The 3D scenes PRD §9's screenshot tests take (`e2e/scenes/`), served by
// Vite alone from `scene-fixtures.html`, with no server: a Floor added
// from one built-in Floor Template, with the template's own starting team
// and 3D theme, read from `templates/` as AI Office reads them. Everything
// is at fixed seeds: each Agent's Avatar is seeded from its id, no monitor
// is on, and reduced motion holds the Agents and the camera still, so the
// same template draws the same picture every time.
//
//   /scene-fixtures.html?template=online-store&quality=medium&view=theme
//
// `view` is the default overview, or `theme`: close up on the theme's
// zone along the left wall, in front of the lounge, where its props fill
// the picture.
//
// When the models have loaded and the scene has drawn a few frames, the
// page's body is marked `data-ready`.

const manifests = import.meta.glob<string>(
  "../../../../templates/*/template.yaml",
  { query: "?raw", import: "default", eager: true },
);
const roleFiles = import.meta.glob<string>(
  "../../../../templates/*/roles/*.md",
  { query: "?raw", import: "default", eager: true },
);

/** A built-in template's folder's files, by their path from `templates/`. */
const fileOf = (files: Record<string, string>, path: string) =>
  Object.entries(files).find(([key]) =>
    key.endsWith(`/templates/${path}`),
  )?.[1];

/** The Floor a template starts: its theme, and a Manager and its team. */
function templateFloor(templateId: string): {
  floor: Floor;
  team: FloorAgent[];
} {
  const manifestText = fileOf(manifests, `${templateId}/template.yaml`);
  if (manifestText === undefined) {
    throw new Error(`There is no built-in Floor Template "${templateId}".`);
  }
  const manifest = parseFloorTemplateManifest(manifestText);
  if (!manifest.ok) {
    throw new Error(manifest.problems.join("\n"));
  }
  const { name, theme, roles } = manifest.manifest;
  const team: FloorAgent[] = [
    { id: `${templateId}-manager`, role: managerRole, stage: null },
    ...roles.flatMap(({ role, count }) => {
      const text = fileOf(roleFiles, `${templateId}/roles/${role}.md`) ?? "";
      const parsed = parseRoleDocument(role, text);
      if (!parsed.ok) {
        throw new Error(`${role}: ${parsed.problems.join("\n")}`);
      }
      const { stage, deskDressing } = parsed.role;
      return Array.from({ length: count }, (_, index): FloorAgent => ({
        id: `${templateId}-${role}-${String(index + 1)}`,
        role,
        stage,
        deskDressing,
      }));
    }),
  ];
  const floor: Floor = {
    id: templateId,
    name,
    repository: `adrianeyre/${templateId}`,
    githubRepositoryId: 1,
    template: { id: templateId, name },
    theme,
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
    freshStartThreshold: defaultFreshStartThreshold,
    gitIdentity: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    archivedAt: null,
  };
  return { floor, team };
}

const params = new URLSearchParams(location.search);
const templateId = params.get("template") ?? developmentTemplateId;
const quality: QualityLevel =
  qualityLevels.find((level) => level === params.get("quality")) ?? "medium";

/** Close up on the theme's zone, from the front right, as the overview looks. */
const themeView: CameraPose = {
  position: [-2.2, 6.2, 13.0],
  target: [-8.8, 0.9, 6.2],
};

const { floor, team } = templateFloor(templateId);
const stops = liftStops([floor], []);
const looks = agentLooks({ team, monitors: new Map(), board: undefined });

// At the Floor already, the camera at its overview, everything held still.
useSceneSettings.setState({ quality, reducedMotion: true, showFps: false });
useLiftStore.setState({
  lift: liftAt({ order: 1, location: { kind: "floor", floorId: floor.id } }),
  pickerOpen: false,
});
if (params.get("view") === "theme") {
  useCameraStore.getState().placeByHand(themeView);
}

provideModels(
  await loadModels(async (url) => (await fetch(url)).arrayBuffer()),
);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The page has no #root.");
}
createRoot(root).render(
  <StrictMode>
    <OfficeScene
      quality={quality}
      showFps={false}
      board={boardPreview([])}
      stops={stops}
      theme={floor.theme}
      team={team}
      looks={looks}
      inspectables={[]}
    />
  </StrictMode>,
);

// Ready once the scene has drawn a few frames with everything in it.
let frames = 0;
const count = () => {
  frames += 1;
  if (frames < 30) {
    requestAnimationFrame(count);
  } else {
    document.body.dataset["ready"] = "true";
  }
};
requestAnimationFrame(count);
