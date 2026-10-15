import type { Role } from "@ai-office/shared";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { act as domAct, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Vector3, type Object3D } from "three";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  aboveHeadHeight,
  freshStartSeconds,
  type AboveHead,
  type FreshStartSignal,
} from "./above-head.ts";
import { AboveHeadDisplay } from "./above-head.tsx";
import { agentLooks } from "./agent-state.ts";
import { DeskAgents } from "./desk-agents.tsx";
import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import { HandoffWalks } from "./handoff-tickets.tsx";
import { createHandoffWalker, type HandoffTicket } from "./handoff-walks.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk } from "./test-models.ts";

// The display above each Agent's head (PRD FR-62, FR-85): its Context
// Usage bar while it is busy, filled and coloured by band with the
// percentage, and its tokens today, coloured against its daily Token Cap,
// with this month's on hover; the bar empties with a short animation at a
// Fresh Start (none with reduced motion). In the scene, it goes wherever
// its Agent goes, and the scene settings switch it off.

const tokens = (today: number, dailyCap: number | null = 1_000_000) => ({
  today,
  dailyCap,
  thisMonth: 3_400_000,
  monthlyCap: 100_000_000,
});

const busy: AboveHead = { contextUsage: 0.62, tokens: tokens(128_000) };
const idle: AboveHead = { contextUsage: undefined, tokens: tokens(128_000) };

const fill = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-fill]");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the display above an Agent's head", () => {
  it("shows a busy Agent's Context Usage bar, filled and coloured, over its tokens today", () => {
    const { container } = render(
      <AboveHeadDisplay agentId="ada" display={busy} reducedMotion={false} />,
    );
    const bar = container.querySelector<HTMLElement>("[data-context-usage]");
    expect(bar?.dataset["contextUsage"]).toBe("amber");
    expect(bar?.textContent).toBe("62%");
    expect(fill(container)?.style.width).toBe("62%");
    expect(fill(container)?.className).toContain("bg-office-state-warning");
    expect(screen.getByText("128k today").dataset["tokensToday"]).toBe(
      "neutral",
    );
    // In the scene, as its other labels, not for assistive technology.
    expect(
      container
        .querySelector("[data-above-head='ada']")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("puts the bar and the tokens in one bubble, the bar over the tokens, with one background and one tail", () => {
    const { container } = render(
      <AboveHeadDisplay agentId="ada" display={busy} reducedMotion={false} />,
    );
    const bubble = container.querySelector<HTMLElement>(
      "[data-above-head='ada']",
    );
    expect(bubble?.className).toContain("bg-office-paper");
    expect(bubble?.className).toContain("flex-col");
    // Its lines, in order, and only the bubble paints the paper.
    expect(
      [...(bubble?.children ?? [])]
        .filter((child) => !child.hasAttribute("data-bubble-tail"))
        .map((child) =>
          child.hasAttribute("data-context-usage") ? "bar" : child.textContent,
        ),
    ).toEqual(["bar", "128k today"]);
    expect(container.querySelectorAll(".bg-office-paper")).toHaveLength(1);
    expect(container.querySelectorAll("[data-bubble-tail]")).toHaveLength(1);
  });

  it("colours the bar green below 60%, amber from 60% and red from 85%", () => {
    const bands = [0.59, 0.6, 0.84, 0.85].map((contextUsage) => {
      const { container, unmount } = render(
        <AboveHeadDisplay
          agentId="ada"
          display={{ contextUsage, tokens: undefined }}
          reducedMotion={false}
        />,
      );
      const band = container.querySelector<HTMLElement>("[data-context-usage]")
        ?.dataset["contextUsage"];
      const colour = /bg-office-\S+/.exec(
        fill(container)?.className ?? "",
      )?.[0];
      unmount();
      return [band, colour];
    });
    expect(bands).toEqual([
      ["green", "bg-office-state-ok"],
      ["amber", "bg-office-state-warning"],
      ["amber", "bg-office-state-warning"],
      ["red", "bg-office-state-critical"],
    ]);
  });

  it("says Unknown, with no fill, when the Model's context window is not known", () => {
    const { container } = render(
      <AboveHeadDisplay
        agentId="ada"
        display={{ contextUsage: null, tokens: undefined }}
        reducedMotion={false}
      />,
    );
    expect(container.textContent).toBe("Unknown");
    expect(fill(container)?.style.width).toBe("0%");
  });

  it("hides the bar while the Agent is idle, and keeps its tokens", () => {
    const { container } = render(
      <AboveHeadDisplay
        agentId="dieter"
        display={idle}
        reducedMotion={false}
      />,
    );
    expect(container.querySelector("[data-context-usage]")).toBeNull();
    expect(container.textContent).toBe("128k today");
  });

  it("colours the tokens against the daily cap: neutral at 79%, amber at 80% and 99%, red at 100%, neutral with no cap", () => {
    const states = (
      [
        [790_000, 1_000_000],
        [800_000, 1_000_000],
        [990_000, 1_000_000],
        [1_000_000, 1_000_000],
        [9_000_000, null],
      ] as const
    ).map(([today, cap]) => {
      const { unmount } = render(
        <AboveHeadDisplay
          agentId="ada"
          display={{ contextUsage: undefined, tokens: tokens(today, cap) }}
          reducedMotion={false}
        />,
      );
      const label = screen.getByText(/ today$/);
      const result = [
        label.textContent,
        label.dataset["tokensToday"],
        // Under the cap, the line is the bubble's own paper.
        /bg-office-\S+/.exec(label.className)?.[0] ?? "the bubble's",
      ];
      unmount();
      return result;
    });
    expect(states).toEqual([
      ["790k today", "neutral", "the bubble's"],
      ["800k today", "warning", "bg-office-state-warning"],
      ["990k today", "warning", "bg-office-state-warning"],
      ["1M today", "reached", "bg-office-state-critical"],
      ["9M today", "neutral", "the bubble's"],
    ]);
  });

  it("shows this month's tokens against the monthly cap while hovered", async () => {
    const user = userEvent.setup();
    render(
      <AboveHeadDisplay agentId="ada" display={idle} reducedMotion={false} />,
    );
    expect(screen.queryByText("3.4M of 100M this month")).toBeNull();
    await user.hover(screen.getByText("128k today"));
    expect(screen.getByText("3.4M of 100M this month")).toBeDefined();
    await user.unhover(screen.getByText("128k today"));
    expect(screen.queryByText("3.4M of 100M this month")).toBeNull();
  });

  it("shows nothing until there is something to show", () => {
    const { container } = render(
      <AboveHeadDisplay
        agentId="ada"
        display={undefined}
        reducedMotion={false}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  describe("at a Fresh Start", () => {
    const freshStart = (id: number): FreshStartSignal => ({
      id,
      agentId: "ada",
      contextUsage: 0.86,
    });
    // The session ends with the Fresh Start: no Context Usage until the next.
    const emptied: AboveHead = {
      contextUsage: undefined,
      tokens: tokens(128_000),
    };

    it("briefly empties the bar from where it was, then hides it until the next session", () => {
      vi.useFakeTimers();
      const { container, rerender } = render(
        <AboveHeadDisplay
          agentId="ada"
          display={{ contextUsage: 0.86, tokens: tokens(128_000) }}
          reducedMotion={false}
        />,
      );
      rerender(
        <AboveHeadDisplay
          agentId="ada"
          display={emptied}
          freshStart={freshStart(7)}
          reducedMotion={false}
        />,
      );
      const bar = container.querySelector<HTMLElement>("[data-context-usage]");
      expect(bar?.dataset["contextUsage"]).toBe("fresh-start");
      expect(bar?.textContent).toBe("Fresh Start");
      const draining = fill(container);
      expect(draining?.style.animation).toContain("fresh-start-drain");
      expect(draining?.style.animation).toContain(
        `${String(freshStartSeconds)}s`,
      );
      expect(draining?.style.getPropertyValue("--fresh-start-from")).toBe(
        "86%",
      );
      expect(draining?.className).toContain("bg-office-state-critical");

      domAct(() => {
        vi.advanceTimersByTime(freshStartSeconds * 1000);
      });
      expect(container.querySelector("[data-context-usage]")).toBeNull();
      expect(container.textContent).toBe("128k today");
    });

    it("does not animate with reduced motion", () => {
      const { container, rerender } = render(
        <AboveHeadDisplay
          agentId="ada"
          display={{ contextUsage: 0.86, tokens: tokens(128_000) }}
          reducedMotion
        />,
      );
      rerender(
        <AboveHeadDisplay
          agentId="ada"
          display={emptied}
          freshStart={freshStart(7)}
          reducedMotion
        />,
      );
      expect(container.querySelector("[data-context-usage]")).toBeNull();
      expect(container.innerHTML).not.toContain("fresh-start-drain");
    });

    it("does not play a Fresh Start that happened before it was drawn", () => {
      const { container } = render(
        <AboveHeadDisplay
          agentId="ada"
          display={emptied}
          freshStart={freshStart(7)}
          reducedMotion={false}
        />,
      );
      expect(container.querySelector("[data-context-usage]")).toBeNull();
    });
  });
});

describe("the display above each Agent's head, in the scene", () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = ReactThreeTestRenderer;
  type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

  const roles: Role[] = ["manager", "coder", "reviewer"];
  const team: FloorAgent[] = roles.map((role) => ({ id: role, role }));
  const layout = floorLayout(team);
  const looks = agentLooks({ team, monitors: new Map(), board: undefined });
  const displays: ReadonlyMap<string, AboveHead> = new Map([
    ["manager", idle],
    ["coder", busy],
    ["reviewer", { contextUsage: undefined, tokens: tokens(990_000) }],
  ]);
  const handoff: HandoffTicket = {
    id: 1,
    floorId: "web-shop",
    issue: 14,
    stage: "needs-review",
    fromAgentId: "coder",
    toAgentId: "reviewer",
  };

  let models: LoadedModels;
  let renderer: Renderer | undefined;

  beforeAll(async () => {
    models = await loadModelsFromDisk();
  });

  beforeEach(() => {
    resetSceneSettings();
    provideModels(models);
  });

  afterEach(async () => {
    await act(async () => {
      await renderer?.unmount();
    });
    renderer = undefined;
    document.body.innerHTML = "";
  });

  const labelsIn = { current: document.body };
  const scene = (
    walker: ReturnType<typeof createHandoffWalker>,
    handoffs: readonly HandoffTicket[],
  ) => (
    <>
      <HandoffWalks
        walker={walker}
        layout={layout}
        handoffs={handoffs}
        labelsIn={labelsIn}
      />
      <DeskAgents
        desks={layout.desks}
        team={team}
        looks={looks}
        walker={walker}
        aboveHead={displays}
        labelsIn={labelsIn}
      />
    </>
  );

  function object(name: string): Object3D {
    const found = renderer?.scene.instance.getObjectByName(name);
    if (found === undefined) {
      throw new Error(`The scene has nothing named "${name}".`);
    }
    return found;
  }

  const worldOf = (name: string) => {
    const found = object(name);
    found.updateWorldMatrix(true, false);
    return found.getWorldPosition(new Vector3());
  };

  const play = async (seconds: number) => {
    await act(async () => {
      await renderer?.advanceFrames(Math.round(seconds / 0.1), 0.1);
    });
  };

  it("floats over each Agent, in HTML, and goes with it as it walks", async () => {
    const walker = createHandoffWalker("web-shop");
    renderer = await ReactThreeTestRenderer.create(scene(walker, []));
    await play(0.2);
    expect(screen.getByText("62%")).toBeDefined();
    expect(screen.getAllByText("128k today")).toHaveLength(2);
    expect(screen.getByText("990k today").dataset["tokensToday"]).toBe(
      "warning",
    );

    const over = () => {
      const agent = worldOf("agent-coder");
      const display = worldOf("above-head-coder");
      return { agent, display };
    };
    const seated = over();
    expect(seated.display.x).toBeCloseTo(seated.agent.x, 6);
    expect(seated.display.z).toBeCloseTo(seated.agent.z, 6);
    expect(seated.display.y - seated.agent.y).toBeCloseTo(aboveHeadHeight, 6);

    await act(async () => {
      await renderer?.update(scene(walker, [handoff]));
    });
    await play(3);
    const walking = over();
    expect(walking.agent.distanceTo(seated.agent)).toBeGreaterThan(0.5);
    expect(walking.display.x).toBeCloseTo(walking.agent.x, 6);
    expect(walking.display.z).toBeCloseTo(walking.agent.z, 6);
    expect(walking.display.y - walking.agent.y).toBeCloseTo(aboveHeadHeight, 6);
  });

  it("waits for the canvas's event target before drawing, so drei never moves it", async () => {
    // The test renderer connects no events: without a place given, none.
    renderer = await ReactThreeTestRenderer.create(
      <DeskAgents
        desks={layout.desks}
        team={team}
        looks={looks}
        aboveHead={displays}
      />,
    );
    await play(0.2);
    expect(document.querySelector("[data-above-head]")).toBeNull();
    expect(renderer.scene.instance.getObjectByName("above-head-coder")).toBe(
      undefined,
    );
  });

  it("is switched off, bar and tokens alike, by the scene settings", async () => {
    useSceneSettings.getState().setShowAboveHead(false);
    renderer = await ReactThreeTestRenderer.create(
      scene(createHandoffWalker("web-shop"), []),
    );
    await play(0.2);
    expect(document.querySelector("[data-above-head]")).toBeNull();
    expect(renderer.scene.instance.getObjectByName("above-head-coder")).toBe(
      undefined,
    );

    await act(async () => {
      useSceneSettings.getState().setShowAboveHead(true);
      await Promise.resolve();
    });
    await play(0.2);
    expect(document.querySelectorAll("[data-above-head]")).toHaveLength(3);
  });
});
