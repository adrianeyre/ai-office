import { defaultSeasonalEvents, type SeasonalEvents } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  render,
  screen,
  within,
  type BoundFunctions,
  type queries,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The seasonal events in General Settings, against a stubbed server.

function stubServer() {
  const state: { seasonal: SeasonalEvents } = {
    seasonal: structuredClone(defaultSeasonalEvents),
  };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/seasonal-events" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as SeasonalEvents;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.seasonal = body;
        return Promise.resolve(Response.json(state.seasonal));
      }
      if (url === "/api/office/seasonal-events") {
        return Promise.resolve(Response.json(state.seasonal));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { puts };
}

async function card() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: ["/general-settings"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", {
    name: "Seasonal events",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Seasonal events heading is not in a card.");
  }
  return within(element);
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An event's day box or month box, for its first or last day. */
const dateBox = (
  event: BoundFunctions<typeof queries>,
  end: "First day" | "Last day",
  part: "Day" | "Month",
) =>
  within(
    event.getByRole("group", { name: end }),
  ).getByLabelText<HTMLInputElement>(part);

describe("the seasonal events in General Settings", () => {
  it("shows each event with its dates, extras and every actor on a turntable", async () => {
    stubServer();
    const view = await card();
    const event = (name: string) => within(view.getByRole("group", { name }));
    const form = await view.findByRole("form", { name: "Seasonal events" });
    expect(
      [...form.querySelectorAll(":scope > fieldset > legend")].map(
        (legend) => legend.textContent,
      ),
    ).toEqual(["Christmas", "Halloween", "Easter", "New Year"]);
    expect(dateBox(event("Christmas"), "First day", "Day").value).toBe("1");
    expect(dateBox(event("Christmas"), "First day", "Month").value).toBe("12");
    expect(dateBox(event("New Year"), "Last day", "Day").value).toBe("7");
    expect(dateBox(event("New Year"), "Last day", "Month").value).toBe("1");
    const actors = (name: string) =>
      within(event(name).getByRole("list"))
        .getAllByRole("checkbox")
        .map((box) => box.parentElement?.textContent);
    expect(actors("Christmas")).toEqual(["Santa", "Elf", "The Grinch"]);
    expect(actors("Halloween")).toEqual([
      "Skeleton",
      "Vampire",
      "Ghost",
      "Slasher",
      "Night Stalker",
      "Creepy Clown",
      "Werewolf",
      "Witch",
      "Mummy",
      "Zombie",
      "Monster",
      "Grim Reaper",
    ]);
    expect(actors("Easter")).toEqual(["Easter Bunny"]);
    expect(actors("New Year")).toEqual(["Drunk Man", "Drunk Woman"]);
    // Each actor's turntable; jsdom has no WebGL, so it says so.
    expect(
      event("Christmas").getByRole("img", {
        name: "Santa: drag to turn it round",
      }).textContent,
    ).toBe("This browser cannot show Santa: it has no WebGL 2.");
    expect(
      event("Christmas").getByLabelText<HTMLTextAreaElement>("What Santa says")
        .value,
    ).toBe("Ho! Ho! Ho! Merry Christmas, Have you been good this year?");
    for (const name of [
      "Christmas trees",
      "Christmas lights",
      "Decorations",
      "Party food on the meeting room table",
    ]) {
      expect(event("Christmas").getByRole("checkbox", { name })).toBeTruthy();
    }
    for (const name of [
      "Decorations",
      "Agents wear party hats",
      "Nibbles on the meeting room table",
    ]) {
      expect(event("New Year").getByRole("checkbox", { name })).toBeTruthy();
    }
  });

  it("saves the events together: an event off, an actor off, new dates, new lines", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const save = await view.findByRole<HTMLButtonElement>("button", {
      name: "Save seasonal events",
    });
    expect(save.disabled).toBe(true);
    const easter = within(view.getByRole("group", { name: "Easter" }));
    await user.click(easter.getByRole("checkbox", { name: "Easter is on" }));
    const halloween = within(view.getByRole("group", { name: "Halloween" }));
    await user.click(halloween.getByRole("checkbox", { name: "Creepy Clown" }));
    const christmas = within(view.getByRole("group", { name: "Christmas" }));
    await user.click(
      christmas.getByRole("checkbox", { name: "Christmas lights" }),
    );
    const day = dateBox(christmas, "First day", "Day");
    await user.clear(day);
    await user.type(day, "5");
    const month = dateBox(christmas, "Last day", "Month");
    await user.clear(month);
    await user.type(month, "1");
    const grinch = christmas.getByLabelText("What The Grinch says");
    await user.clear(grinch);
    await user.type(grinch, "Bah, Humbug!, ");
    await user.click(save);
    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. The Office dresses up on the days set.",
    );
    const expected = structuredClone(defaultSeasonalEvents);
    expected.events.easter.enabled = false;
    expected.events.halloween.actors["creepy-clown"] = false;
    expected.events.christmas.extras.lights = false;
    expected.events.christmas.start = "12-05";
    expected.events.christmas.end = "01-26";
    expected.events.christmas.says.grinch = ["Bah", "Humbug!"];
    expect(puts).toEqual([{ body: expected, csrf: "csrf-token-1" }]);
  });

  it("refuses a day that is not a day, or an actor with nothing to say, and saves nothing", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const christmas = within(
      await view.findByRole("group", { name: "Christmas" }),
    );
    const day = dateBox(christmas, "Last day", "Day");
    await user.clear(day);
    await user.type(day, "32");
    const save = view.getByRole("button", { name: "Save seasonal events" });
    await user.click(save);
    expect((await view.findByRole("alert")).textContent).toBe(
      "Give each day as a day from 1 to 31 and a month from 1 to 12.",
    );
    await user.clear(day);
    await user.type(day, "26");
    await user.clear(christmas.getByLabelText("What Santa says"));
    await user.click(save);
    expect((await view.findByRole("alert")).textContent).toBe(
      "Give each actor at least one thing to say.",
    );
    expect(puts).toEqual([]);
  });
});
