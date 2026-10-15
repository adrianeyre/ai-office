import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StartupVersionCheck,
  VersionCard,
  forgetStartupVersionCheck,
} from "./version-check.tsx";

// The version check, against a stubbed server: Admin's "Check for latest
// version" says whether the version running is the latest, and the check
// as the app opens says something only when it is not.

type Latest =
  { version: string } | { status: number; error: string; message: string };

function stubServer(...answers: Latest[]) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/version/latest") {
        asked.push(url);
        const answer = answers[Math.min(asked.length, answers.length) - 1];
        if (answer === undefined) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve(
          "version" in answer
            ? Response.json(answer)
            : Response.json(
                { error: answer.error, message: answer.message },
                { status: answer.status },
              ),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { asked };
}

function renderWithQueries(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

const newer = (version: string) => {
  const [major = "0", ...rest] = version.split(".");
  return [String(Number(major) + 1), ...rest].join(".");
};

beforeEach(() => {
  forgetStartupVersionCheck();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Admin's version section", () => {
  it("shows the version running, the one the footer shows", () => {
    stubServer();
    renderWithQueries(<VersionCard />);
    expect(screen.getByRole("heading", { name: "Version" })).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent === `You are on AI Office ${__APP_VERSION__}.`,
      ),
    ).toBeTruthy();
  });

  it("says the version running is up to date", async () => {
    const user = userEvent.setup();
    const { asked } = stubServer({ version: __APP_VERSION__ });
    renderWithQueries(<VersionCard />);
    const opener = screen.getByRole("button", {
      name: "Check for latest version",
    });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", {
      name: "Check for latest version",
    });
    expect(
      (await within(dialog).findByText(/is up to date\./)).textContent,
    ).toBe(`AI Office ${__APP_VERSION__} is up to date.`);
    expect(asked).toHaveLength(1);
    expect(
      within(dialog).queryByRole("heading", { name: "How to update" }),
    ).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("says a newer version is out, and how to update to it", async () => {
    const user = userEvent.setup();
    const latest = newer(__APP_VERSION__);
    stubServer({ version: latest });
    renderWithQueries(<VersionCard />);
    await user.click(
      screen.getByRole("button", { name: "Check for latest version" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Check for latest version",
    });
    expect(
      (await within(dialog).findByText(/is out of date\./)).textContent,
    ).toBe(`AI Office ${__APP_VERSION__} is out of date.`);
    expect(
      within(dialog).getByText(new RegExp(`is ${latest}\\.`)),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("heading", { name: "How to update" }),
    ).toBeTruthy();
    expect(within(dialog).getByText(/docker compose up --build/)).toBeTruthy();
    const release = within(dialog).getByRole("link", {
      name: `What's new in AI Office ${latest}, its release on GitHub, opens in a new tab`,
    });
    expect(release.getAttribute("href")).toBe(
      `https://github.com/adrianeyre/ai-office/releases/tag/v${latest}`,
    );
    expect(release.getAttribute("target")).toBe("_blank");
    expect(release.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says the check failed when GitHub cannot be reached, and checks again", async () => {
    const user = userEvent.setup();
    const { asked } = stubServer(
      {
        status: 502,
        error: "version_check_failed",
        message: "GitHub could not be reached.",
      },
      { version: __APP_VERSION__ },
    );
    renderWithQueries(<VersionCard />);
    await user.click(
      screen.getByRole("button", { name: "Check for latest version" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Check for latest version",
    });
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "AI Office couldn't find out the latest version. GitHub could not be reached.",
    );

    await user.click(
      within(dialog).getByRole("button", { name: "Check again" }),
    );
    expect(await within(dialog).findByText(/is up to date\./)).toBeTruthy();
    expect(asked).toHaveLength(2);
  });
});

describe("an answer that is not a version number (I1-11)", () => {
  const hostile = "9999.0.0 update now at http://evil.example";

  it("is shown as a check that failed, never as the latest version or a link", async () => {
    const user = userEvent.setup();
    stubServer({ version: hostile });
    renderWithQueries(<VersionCard />);
    await user.click(
      screen.getByRole("button", { name: "Check for latest version" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Check for latest version",
    });
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "AI Office couldn't find out the latest version. The answer was not a version number.",
    );
    expect(dialog.textContent).not.toContain("evil.example");
    expect(within(dialog).queryByRole("link", { name: /What's new/ })).toBe(
      null,
    );
  });

  it("opens no dialog as the app opens", async () => {
    const { asked } = stubServer({ version: hostile });
    renderWithQueries(<StartupVersionCheck />);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the check as the app opens", () => {
  it("opens a dialog when a newer version is out", async () => {
    const latest = newer(__APP_VERSION__);
    const { asked } = stubServer({ version: latest });
    renderWithQueries(<StartupVersionCheck />);

    const dialog = await screen.findByRole("dialog", {
      name: "A newer version of AI Office is out",
    });
    expect(within(dialog).getByText(/is out of date\./).textContent).toBe(
      `AI Office ${__APP_VERSION__} is out of date.`,
    );
    expect(asked).toHaveLength(1);

    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["the version running is the latest", { version: __APP_VERSION__ }],
    [
      "GitHub cannot be reached",
      {
        status: 502,
        error: "version_check_failed",
        message: "GitHub could not be reached.",
      },
    ],
  ] satisfies [string, Latest][])("says nothing when %s", async (_, answer) => {
    const { asked } = stubServer(answer);
    renderWithQueries(<StartupVersionCheck />);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    // Let the answer arrive.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says nothing when the server cannot be reached", async () => {
    stubServer();
    renderWithQueries(<StartupVersionCheck />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks once per page load", async () => {
    const { asked } = stubServer({ version: __APP_VERSION__ });
    const first = renderWithQueries(<StartupVersionCheck />);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    first.unmount();
    renderWithQueries(<StartupVersionCheck />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(1);
  });
});
