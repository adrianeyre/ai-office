import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { FastForwardButton } from "./fast-forward-button.tsx";
import {
  resetMeetingFastForward,
  useMeetingFastForwardStore,
} from "./meeting-fast-forward.ts";
import { useSceneSettings } from "./scene-settings.ts";

// Fast forward beside Status update and Meeting Room: shown once the Owner
// presses one, it puts the Floor in the meeting room at once, and goes
// once everyone is there or the request comes to nothing.

afterEach(() => {
  cleanup();
  resetMeetingFastForward();
  useSceneSettings.getState().setReducedMotion(false);
});

const fastForward = () =>
  screen.queryByRole<HTMLButtonElement>("button", { name: /^Fast forward/ });

describe("the fast-forward button", () => {
  it("shows beside the button pressed only, once it is pressed", () => {
    render(
      <>
        <FastForwardButton gathering="status-update" />
        <FastForwardButton gathering="meeting-room" />
      </>,
    );
    expect(fastForward()).toBeNull();
    act(() => {
      useMeetingFastForwardStore.getState().call("meeting-room");
    });
    expect(fastForward()?.getAttribute("aria-label")).toBe(
      "Fast forward: everyone to the meeting room now for the Meeting Room",
    );
  });

  it("asks the scene to fast forward, spinning until anyone sets off, and goes once everyone is there", async () => {
    render(<FastForwardButton gathering="status-update" />);
    act(() => {
      useMeetingFastForwardStore.getState().call("status-update");
    });
    const button = fastForward();
    expect(button).not.toBeNull();
    if (button !== null) {
      await userEvent.click(button);
    }
    expect(useMeetingFastForwardStore.getState().skipping).toBe(true);
    expect(fastForward()?.getAttribute("aria-busy")).toBe("true");
    act(() => {
      useMeetingFastForwardStore.getState().setGathering(true);
      useMeetingFastForwardStore.getState().setGathering(false);
    });
    expect(fastForward()).toBeNull();
    expect(useMeetingFastForwardStore.getState().skipping).toBe(false);
  });

  it("goes when the request comes to nothing", () => {
    render(<FastForwardButton gathering="status-update" />);
    act(() => {
      useMeetingFastForwardStore.getState().call("status-update");
    });
    expect(fastForward()).not.toBeNull();
    act(() => {
      useMeetingFastForwardStore.getState().dismiss();
    });
    expect(fastForward()).toBeNull();
  });

  it("never shows with reduced motion: no one walks", () => {
    useSceneSettings.getState().setReducedMotion(true);
    render(<FastForwardButton gathering="status-update" />);
    act(() => {
      useMeetingFastForwardStore.getState().call("status-update");
    });
    expect(fastForward()).toBeNull();
  });
});
