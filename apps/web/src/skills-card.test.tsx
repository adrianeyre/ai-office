import type { Skill, SkillFile } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The office Skill library in Admin (PRD FR-71, FR-72, FR-76), against a
// stubbed server that behaves as the API does: an uploaded or imported
// Skill starts disabled, and is enabled by a review naming its digest.

const skillMd = (name: string, description = `What ${name} does.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n`;

const digestOf = (files: readonly SkillFile[]): string =>
  files
    .map(({ path, content }) => `${path}:${String(content.length)}`)
    .join("|")
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");

interface Sent {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(Response.json(body, { status }));

function stubServer(
  initial: Skill[] = [],
  options: {
    /** What the repository holds: one Skill per folder. */
    repository?: Record<string, SkillFile[]>;
  } = {},
) {
  let skills = structuredClone(initial);
  let next = initial.length;
  const sent: Sent[] = [];
  const summary = (skill: Skill) => ({
    ...skill,
    files: skill.files.map(({ path, content }) => ({
      path,
      bytes: content.length,
    })),
  });
  const added = (
    files: SkillFile[],
    source: Skill["source"],
    origin: Skill["origin"] = null,
  ): Skill => {
    next += 1;
    const name = /name: (\S+)/.exec(files[0]?.content ?? "")?.[1] ?? "";
    const skill: Skill = {
      id: `skill-${String(next)}`,
      name,
      description: `What ${name} does.`,
      source,
      origin,
      digest: digestOf(files),
      enabled: source === "editor",
      reviewedAt: source === "editor" ? "2026-10-09T12:00:00.000Z" : null,
      createdAt: "2026-10-09T12:00:00.000Z",
      updatedAt: "2026-10-09T12:00:00.000Z",
      files,
    };
    skills.push(skill);
    return skill;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (url.startsWith("/api/skills") && method !== "GET") {
        sent.push({
          method,
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      const id = decodeURIComponent(url.split("/")[3] ?? "");
      const skill = skills.find((each) => each.id === id);
      if (url === "/api/skills" && method === "POST") {
        const { files, source } = body as {
          files: SkillFile[];
          source: "upload" | "editor";
        };
        return json(added(files, source), 201);
      }
      if (url === "/api/skills/import") {
        const { url: repository, path } = body as {
          url: string;
          path?: string;
        };
        const folders = Object.keys(options.repository ?? {});
        if (path === undefined) {
          return json(
            {
              error: "skill_path_required",
              message:
                "The repository holds several Skills: name the folder of the one to import.",
              problems: folders,
            },
            422,
          );
        }
        return json(
          added(options.repository?.[path] ?? [], "git", {
            url: repository,
            ref: null,
            commit: "0123456789abcdef0123456789abcdef01234567",
            path,
          }),
          201,
        );
      }
      if (url.endsWith("/review") && skill !== undefined) {
        if ((body as { digest: string }).digest !== skill.digest) {
          return json(
            {
              error: "skill_changed",
              message:
                "The Skill changed after the contents you reviewed. Review it again.",
            },
            409,
          );
        }
        Object.assign(skill, {
          enabled: true,
          reviewedAt: "2026-10-09T12:01:00.000Z",
        });
        return json(skill);
      }
      if (method === "PATCH" && skill !== undefined) {
        const update = body as { enabled?: boolean; files?: SkillFile[] };
        if (update.enabled === true && skill.reviewedAt === null) {
          return json({ error: "skill_not_reviewed" }, 409);
        }
        Object.assign(
          skill,
          update.files === undefined
            ? update
            : { files: update.files, digest: digestOf(update.files) },
        );
        return json(skill);
      }
      if (method === "DELETE") {
        skills = skills.filter((each) => each.id !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/skills") {
        return json({ skills: skills.map(summary) });
      }
      if (skill !== undefined) {
        return json(skill);
      }
      if (url === "/api/session") {
        return json({
          csrfToken: "csrf-token-1",
          expiresAt: "2026-10-15T12:00:00.000Z",
        });
      }
      return json({}, 404);
    }),
  );
  return {
    sent,
    /** Changes a Skill behind the page's back, as another tab might. */
    change(id: string, files: SkillFile[]) {
      const skill = skills.find((each) => each.id === id);
      if (skill !== undefined) {
        Object.assign(skill, { files, digest: digestOf(files) });
      }
    },
  };
}

const pdfFiles: SkillFile[] = [
  { path: "SKILL.md", content: skillMd("pdf-processing") },
  { path: "scripts/extract.py", content: "print('every line of it')\n" },
];

const importedPdf: Skill = {
  id: "skill-pdf",
  name: "pdf-processing",
  description: "What pdf-processing does.",
  source: "git",
  origin: {
    url: "https://github.com/example-org/skills",
    ref: "main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    path: "skills/pdf-processing",
  },
  digest: digestOf(pdfFiles),
  enabled: false,
  reviewedAt: null,
  createdAt: "2026-10-09T11:00:00.000Z",
  updatedAt: "2026-10-09T11:00:00.000Z",
  files: pdfFiles,
};

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
  const heading = await screen.findByRole("heading", { name: "Skills" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Skills heading is not in a card.");
  }
  return within(element);
}

/** A file as a folder upload gives it: its path includes the folder. */
const folderFile = (path: string, content: BlobPart): File => {
  const file = new File([content], path.split("/").at(-1) ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Skill library in Admin", () => {
  it("says when there are none", async () => {
    stubServer();
    const view = await card();
    expect(await view.findByText(/No Skills yet/)).toBeTruthy();
  });

  it("shows an imported Skill's full contents for review before it can be enabled", async () => {
    const { sent } = stubServer([importedPdf]);
    const user = userEvent.setup();
    const view = await card();
    const row = within(
      await view.findByRole("listitem", { name: "pdf-processing" }),
    );
    expect(row.getByText("Needs review")).toBeTruthy();
    expect(row.getByText(/Imported from Git · 2 files/)).toBeTruthy();
    // Not enabled from the list: only from its review.
    expect(row.queryByRole("button", { name: /^Enable/ })).toBeNull();

    await user.click(
      row.getByRole("button", { name: "Review pdf-processing" }),
    );
    const review = within(
      await row.findByRole("region", { name: "Review pdf-processing" }),
    );
    expect(
      review.getByText(/Read every file below before enabling it/),
    ).toBeTruthy();
    // Every file, in full, and where it came from.
    expect(review.getByLabelText("SKILL.md").textContent).toBe(
      skillMd("pdf-processing"),
    );
    expect(review.getByLabelText("scripts/extract.py").textContent).toBe(
      "print('every line of it')\n",
    );
    expect(
      review.getByText("https://github.com/example-org/skills"),
    ).toBeTruthy();
    expect(
      review.getByText("0123456789abcdef0123456789abcdef01234567"),
    ).toBeTruthy();
    expect(review.getByText("skills/pdf-processing")).toBeTruthy();

    await user.click(
      review.getByRole("button", {
        name: "I have read it all: enable pdf-processing",
      }),
    );
    expect(await row.findByText("Enabled")).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/skills/skill-pdf/review",
        body: { digest: importedPdf.digest },
        csrf: "csrf-token-1",
      },
    ]);
    expect(
      row.getByRole("button", { name: "Disable pdf-processing" }),
    ).toBeTruthy();
  });

  it("asks for a fresh review when the Skill changed while it was read", async () => {
    const server = stubServer([importedPdf]);
    const user = userEvent.setup();
    const view = await card();
    const row = within(
      await view.findByRole("listitem", { name: "pdf-processing" }),
    );
    await user.click(
      row.getByRole("button", { name: "Review pdf-processing" }),
    );
    const review = within(
      await row.findByRole("region", { name: "Review pdf-processing" }),
    );
    await review.findByLabelText("scripts/extract.py");
    server.change("skill-pdf", [
      { path: "SKILL.md", content: skillMd("pdf-processing") },
      { path: "scripts/extract.py", content: "print('changed')\n" },
    ]);
    await user.click(
      review.getByRole("button", {
        name: "I have read it all: enable pdf-processing",
      }),
    );
    expect((await review.findByRole("alert")).textContent).toBe(
      "The Skill changed after the contents you reviewed. Review it again.",
    );
    // What it holds now, to be read again; still not enabled.
    expect(
      (await review.findByText("print('changed')")).textContent,
    ).toBeTruthy();
    expect(row.getByText("Needs review")).toBeTruthy();
  });

  it("imports a Skill from Git, offering the repository's Skills to choose from", async () => {
    const { sent } = stubServer([], {
      repository: {
        "skills/pdf-processing": pdfFiles,
        "skills/release-notes": [
          { path: "SKILL.md", content: skillMd("release-notes") },
        ],
      },
    });
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No Skills yet/);
    await user.click(view.getByRole("button", { name: "Import from Git" }));

    await user.type(
      view.getByLabelText("Repository URL"),
      "http://example.com/x",
    );
    await user.click(view.getByRole("button", { name: "Import Skill" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "The repository is an https:// URL.",
    );
    expect(sent).toEqual([]);

    await user.clear(view.getByLabelText("Repository URL"));
    await user.type(
      view.getByLabelText("Repository URL"),
      "https://github.com/example-org/skills",
    );
    await user.click(view.getByRole("button", { name: "Import Skill" }));
    const choices = within(
      await view.findByRole("list", { name: "Skills in the repository" }),
    );
    await user.click(
      choices.getByRole("button", { name: "skills/release-notes" }),
    );
    expect(
      view.getByLabelText<HTMLInputElement>("Skill folder in the repository")
        .value,
    ).toBe("skills/release-notes");
    await user.click(view.getByRole("button", { name: "Import Skill" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Added release-notes. It stays disabled until you review it in the library above.",
    );
    const row = within(
      await view.findByRole("listitem", { name: "release-notes" }),
    );
    expect(row.getByText("Needs review")).toBeTruthy();
    expect(sent.map(({ body }) => body)).toEqual([
      { url: "https://github.com/example-org/skills" },
      {
        url: "https://github.com/example-org/skills",
        path: "skills/release-notes",
      },
    ]);
  });

  it("uploads a Skill's folder as text, without the folder's own name", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No Skills yet/);
    const input = view.getByLabelText<HTMLInputElement>("Skill folder");
    expect(input.hasAttribute("webkitdirectory")).toBe(true);

    await user.upload(input, [
      folderFile("pdf-processing/SKILL.md", skillMd("pdf-processing")),
      folderFile("pdf-processing/scripts/extract.py", "print('hi')\n"),
      folderFile(
        "pdf-processing/.DS_Store",
        new Uint8Array([0, 0, 0, 1, 0xff]),
      ),
    ]);
    expect(
      await view.findByText("pdf-processing: SKILL.md, scripts/extract.py"),
    ).toBeTruthy();
    await user.click(view.getByRole("button", { name: "Upload Skill" }));
    expect((await view.findByRole("status")).textContent).toBe(
      "Added pdf-processing. It stays disabled until you review it in the library above.",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/skills",
        body: {
          source: "upload",
          folder: "pdf-processing",
          files: [
            { path: "SKILL.md", content: skillMd("pdf-processing") },
            { path: "scripts/extract.py", content: "print('hi')\n" },
          ],
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("refuses an upload that is not a valid, text-only Skill before sending it", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No Skills yet/);
    await user.upload(view.getByLabelText<HTMLInputElement>("Skill folder"), [
      folderFile("pdf/SKILL.md", skillMd("pdf-processing")),
      folderFile(
        "pdf/logo.png",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]),
      ),
    ]);
    const alert = await view.findByRole("alert");
    expect(
      [...alert.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual([
      '"logo.png" is not a text file; Skills hold text only.',
      'The Skill is named "pdf-processing", so its folder is "pdf-processing", not "pdf".',
    ]);
    expect(
      view.getByRole<HTMLButtonElement>("button", { name: "Upload Skill" })
        .disabled,
    ).toBe(true);
    expect(sent).toEqual([]);
  });

  it("writes a Skill in the editor, checking its frontmatter first", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No Skills yet/);
    await user.click(view.getByRole("button", { name: "Write one" }));
    const skillMdField = view.getByLabelText<HTMLTextAreaElement>("SKILL.md");
    expect(skillMdField.value).toContain("name: my-skill");

    await user.clear(skillMdField);
    await user.type(skillMdField, "---\nname: Release Notes\n---\n");
    await user.click(view.getByRole("button", { name: "Add Skill" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "A Skill's name uses only lowercase letters",
    );
    expect(sent).toEqual([]);

    await user.clear(skillMdField);
    await user.type(
      skillMdField,
      "---\nname: release-notes\ndescription: Writes release notes.\n---\n\nSteps.\n",
    );
    await user.click(view.getByRole("button", { name: "Add a file" }));
    await user.type(view.getByLabelText("File 1 path"), "template.md");
    await user.type(
      view.getByLabelText("Contents of template.md"),
      "## Changes",
    );
    await user.click(view.getByRole("button", { name: "Add Skill" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Added release-notes. It is enabled.",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/skills",
        body: {
          source: "editor",
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: release-notes\ndescription: Writes release notes.\n---\n\nSteps.\n",
            },
            { path: "template.md", content: "## Changes" },
          ],
        },
        csrf: "csrf-token-1",
      },
    ]);
    // A fresh editor for the next one.
    expect(
      view.getByLabelText<HTMLTextAreaElement>("SKILL.md").value,
    ).toContain("name: my-skill");
  });

  it("edits, disables and deletes a Skill, deleting only once confirmed", async () => {
    const reviewed: Skill = {
      ...importedPdf,
      enabled: true,
      reviewedAt: "2026-10-09T11:30:00.000Z",
    };
    const { sent } = stubServer([reviewed]);
    const user = userEvent.setup();
    const view = await card();
    const row = within(
      await view.findByRole("listitem", { name: "pdf-processing" }),
    );
    expect(row.getByText("Enabled")).toBeTruthy();

    await user.click(row.getByRole("button", { name: "Edit pdf-processing" }));
    const script = await row.findByLabelText<HTMLTextAreaElement>(
      "Contents of scripts/extract.py",
    );
    await user.clear(script);
    await user.type(script, "print('edited')");
    await user.click(row.getByRole("button", { name: "Save" }));
    await row.findByRole("button", { name: "Disable pdf-processing" });

    await user.click(
      row.getByRole("button", { name: "Disable pdf-processing" }),
    );
    expect(await row.findByText("Disabled")).toBeTruthy();

    await user.click(
      row.getByRole("button", { name: "Delete pdf-processing" }),
    );
    expect(sent.at(-1)?.method).toBe("PATCH");
    await user.click(
      row.getByRole("button", { name: "Yes, delete pdf-processing" }),
    );
    expect(await view.findByText(/No Skills yet/)).toBeTruthy();
    expect(sent.map(({ method, body }) => [method, body])).toEqual([
      [
        "PATCH",
        {
          files: [
            pdfFiles[0],
            { path: "scripts/extract.py", content: "print('edited')" },
          ],
        },
      ],
      ["PATCH", { enabled: false }],
      ["DELETE", undefined],
    ]);
  });
});
