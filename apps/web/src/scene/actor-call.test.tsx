import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActorCallButton } from "./actor-call.tsx";
import { useActorCalls } from "./seasonal-visitor.tsx";

afterEach(() => {
  cleanup();
  useActorCalls.setState(
    { visiting: false, call: undefined, remove: undefined },
    true,
  );
});

describe("the Call Actor button", () => {
  it("is not there while no actor may visit", () => {
    render(<ActorCallButton />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("calls an actor, then removes it while it visits", async () => {
    const user = userEvent.setup();
    const call = vi.fn();
    const remove = vi.fn();
    useActorCalls.setState({ visiting: false, call, remove });
    render(<ActorCallButton />);
    await user.click(screen.getByRole("button", { name: "Call Actor" }));
    expect(call).toHaveBeenCalledOnce();
    useActorCalls.setState({ visiting: true });
    await user.click(
      await screen.findByRole("button", { name: "Remove Actor" }),
    );
    expect(remove).toHaveBeenCalledOnce();
  });
});
