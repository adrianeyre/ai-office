import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeRequest,
  endedVisibleMs,
  resetActivities,
  track,
  useActivities,
} from "./activity.ts";
import { renderHook, act } from "@testing-library/react";

// What the Owner is waiting on: each request a click sends, in words,
// from when it is sent until it is answered.

afterEach(() => {
  vi.useRealTimers();
  resetActivities();
});

describe("describeRequest", () => {
  it.each([
    ["PUT", "/api/office/currency", "Saving the office's currency"],
    ["PUT", "/api/office/prompt-budget", "Saving prompt budget"],
    ["DELETE", "/api/gateway/prices/gpt-5", "Deleting price"],
    ["POST", "/api/gateway-keys", "Making an API key"],
    [
      "POST",
      "/api/floors/web-shop/agents/ada/gateway-key/rotate",
      "Rotate gateway key",
    ],
    ["PATCH", "/api/floors/web-shop", "Saving floor"],
    ["POST", "/api/login", "Signing in"],
    [
      "POST",
      "/api/notices/4f1b2c3d-0000-4000-8000-000000000000/dismiss",
      "Dismiss notice",
    ],
  ])("%s %s is “%s”", (method, url, label) => {
    expect(describeRequest(method, url)).toEqual({
      label,
      detail: `${method} ${url}`,
    });
  });

  it("names the request without its query", () => {
    expect(describeRequest("POST", "/api/ai-accounts/refresh?all=1")).toEqual({
      label: "Refresh AI account",
      detail: "POST /api/ai-accounts/refresh",
    });
  });
});

describe("track", () => {
  const what = { label: "Saving it", detail: "PUT /api/it" };

  it("shows work from when it is sent until a while after it is answered", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useActivities());
    let answer: (response: Response) => void = () => undefined;
    const work = new Promise<Response>((resolve) => {
      answer = resolve;
    });

    act(() => {
      void track(what, work);
    });
    expect(result.current).toMatchObject([{ ...what, status: "running" }]);

    await act(async () => {
      answer(new Response("{}", { status: 200 }));
      await work;
    });
    expect(result.current).toMatchObject([{ status: "done" }]);

    act(() => {
      vi.advanceTimersByTime(endedVisibleMs);
    });
    expect(result.current).toEqual([]);
  });

  it("counts an answer that is not ok, and a request never sent, as failures", async () => {
    const { result } = renderHook(() => useActivities());
    await act(async () => {
      await track(what, Promise.resolve(new Response("", { status: 400 })));
      await track(
        { label: "Deleting it", detail: "DELETE /api/it" },
        Promise.reject(new TypeError("Failed to fetch")),
      ).catch(() => undefined);
    });

    expect(result.current).toMatchObject([
      {
        label: "Saving it",
        status: "failed",
        problem: "The server answered 400.",
      },
      { label: "Deleting it", status: "failed", problem: "Failed to fetch" },
    ]);
  });

  it("hands back what the work resolves with", async () => {
    const response = new Response("{}");
    await expect(track(what, Promise.resolve(response))).resolves.toBe(
      response,
    );
  });
});
