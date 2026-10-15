import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  PendingReply,
  waitedLabel,
  WaitingNote,
} from "./chat-pending-reply.tsx";

afterEach(cleanup);

describe("a reply being waited for", () => {
  it("is thinking, with dots, until its first words; then writing, with a cursor", () => {
    const { rerender, container } = render(
      <PendingReply name="Mira" text="" />,
    );
    expect(container.textContent).toBe("Mira is thinking…");
    expect(container.querySelectorAll("[data-typing-dot]")).toHaveLength(3);
    expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    rerender(<PendingReply name="Mira" text="Start" />);
    expect(container.textContent).toBe("Mira is writing…Start ▍");
    expect(container.querySelector("[data-typing-dot]")).toBeNull();
  });

  it("says how long it has waited once the wait is noticeable", () => {
    expect(waitedLabel(2)).toBeUndefined();
    expect(waitedLabel(12)).toBe("12s");
    expect(waitedLabel(65)).toBe("1m 05s");
  });

  it("is said under the message box, with a spinner, while it is answered", () => {
    render(
      <WaitingNote answering live>
        Mira is answering…
      </WaitingNote>,
    );
    const note = screen.getByRole("status", { name: "Connection" });
    expect(note.textContent).toBe("Mira is answering…");
    expect(note.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  it("shows no spinner once the chat is live and nothing is waited for", () => {
    render(
      <WaitingNote answering={false} live>
        Live
      </WaitingNote>,
    );
    expect(
      screen
        .getByRole("status", { name: "Connection" })
        .querySelector('[data-slot="spinner"]'),
    ).toBeNull();
  });
});
