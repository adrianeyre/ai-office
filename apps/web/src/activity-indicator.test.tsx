import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityIndicator, showAfterMs } from "./activity-indicator.tsx";
import { endedVisibleMs, resetActivities, track } from "./activity.ts";

// The Activity indicator: a progress bar along the top and a panel saying
// what the Owner is waiting on, the request behind it, how long it has
// taken and how it ended; nothing for work answered within a moment.

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
      "Date",
    ],
  });
});

afterEach(() => {
  cleanup();
  resetActivities();
  vi.useRealTimers();
});

/** Work that is answered when the test says. */
function pending() {
  let answer: (response: Response) => void = () => undefined;
  const work = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { work, answer };
}

const panel = () => screen.queryByRole("region", { name: "Activity" });
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("the Activity indicator", () => {
  it("shows nothing for work answered within a moment", async () => {
    render(<ActivityIndicator />);
    const { work, answer } = pending();
    act(() => {
      void track({ label: "Saving it", detail: "PUT /api/it" }, work);
    });
    advance(showAfterMs - 100);
    await act(async () => {
      answer(new Response("{}"));
      await work;
    });
    advance(200);

    expect(panel()).toBeNull();
    expect(document.querySelector("[data-slot=activity-bar]")).toBeNull();
  });

  it("says what it is waiting on, the request, and for how long, with a progress bar", async () => {
    render(<ActivityIndicator />);
    const { work, answer } = pending();
    act(() => {
      void track(
        {
          label: "Saving the office's currency",
          detail: "PUT /api/office/currency",
        },
        work,
      );
    });
    advance(1_200);

    const shown = within(panel() ?? document.body);
    expect(shown.getByText("Working on 1 thing")).toBeDefined();
    expect(shown.getByText("Saving the office's currency…")).toBeDefined();
    expect(shown.getByText("PUT /api/office/currency")).toBeDefined();
    expect(shown.getByText(/Waiting for AI Office to answer/)).toBeDefined();
    expect(shown.getByText("1.2 s")).toBeDefined();
    const bar = shown.getByRole("progressbar", {
      name: "Saving the office's currency",
    });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(panel()?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("[data-slot=activity-bar]")).not.toBeNull();

    // A long wait is explained.
    advance(8_000);
    expect(shown.getByText(/Still working/)).toBeDefined();

    await act(async () => {
      answer(new Response("{}"));
      await work;
    });
    advance(100);
    expect(shown.getByText("Finished")).toBeDefined();
    expect(shown.getByText(/^Done/)).toBeDefined();
    expect(document.querySelector("[data-slot=activity-bar]")).toBeNull();

    advance(endedVisibleMs);
    expect(panel()).toBeNull();
  });

  it("always shows a failure, however quick, with the server's answer", async () => {
    render(<ActivityIndicator />);
    await act(async () => {
      await track(
        { label: "Deleting price", detail: "DELETE /api/gateway/prices/x" },
        Promise.resolve(new Response("", { status: 409 })),
      );
    });
    advance(100);

    const shown = within(panel() ?? document.body);
    expect(shown.getByText(/The server answered 409\./)).toBeDefined();
  });

  it("tells a screen reader what started and how it ended, not the ticking time", async () => {
    render(<ActivityIndicator />);
    const { work, answer } = pending();
    act(() => {
      void track({ label: "Adding Floor", detail: "POST /api/floors" }, work);
    });
    advance(1_000);
    const live = document.querySelector("[aria-live=polite]");
    expect(live?.textContent).toBe("Adding Floor…");
    advance(2_000);
    expect(live?.textContent).toBe("Adding Floor…");
    await act(async () => {
      answer(new Response("{}"));
      await work;
    });
    advance(100);
    expect(live?.textContent).toBe("Adding Floor: done.");
  });
});
