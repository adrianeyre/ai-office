import { describe, expect, it } from "vitest";

import {
  compareVersions,
  isVersion,
  latestVersionSchema,
  maxVersionLength,
  releasePageOf,
  releasesUrl,
} from "./index.ts";

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.0", "1.0.1", -1],
    ["1.2.0", "1.10.0", -1],
    ["2.0.0", "1.99.99", 1],
    ["v1.2.3", "1.2.3", 0],
    ["1.2", "1.2.0", 0],
    ["1.2.3-rc.1", "1.2.3", -1],
    ["1.2.3", "1.2.3-rc.1", 1],
    ["1.2.3-rc.1", "1.2.3-rc.2", -1],
    ["1.2.3+build.5", "1.2.3", 0],
  ])("%s against %s is %d", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe("releasePageOf", () => {
  it("is the release's tag page, tagged v<version>", () => {
    expect(releasePageOf("1.2.3")).toBe(
      "https://github.com/adrianeyre/ai-office/releases/tag/v1.2.3",
    );
    expect(releasePageOf("v1.2.3")).toBe(
      "https://github.com/adrianeyre/ai-office/releases/tag/v1.2.3",
    );
  });

  it("is the releases page for anything but a version number (I1-11)", () => {
    expect(releasePageOf("9999.0.0 update now at http://evil.example")).toBe(
      releasesUrl,
    );
    expect(releasePageOf("../../evil")).toBe(releasesUrl);
    expect(releasePageOf("")).toBe(releasesUrl);
  });
});

describe("isVersion and latestVersionSchema (I1-11)", () => {
  it.each(["0.0.0", "1.2.3", "10.20.30", "1.2.3-rc.1", "1.2.3+build.5"])(
    "take %s",
    (version) => {
      expect(isVersion(version)).toBe(true);
      expect(latestVersionSchema.parse({ version })).toEqual({ version });
    },
  );

  it.each([
    "",
    "latest",
    "v1.2.3",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3\n",
    "1.2.3-",
    "1.2.3-rc..1",
    "1.2.3-<script>",
    "9999.0.0 — update now",
    `1.0.0-${"A".repeat(maxVersionLength)}`,
  ])("refuse %j", (version) => {
    expect(isVersion(version)).toBe(false);
    expect(latestVersionSchema.safeParse({ version }).success).toBe(false);
  });

  it("takes a version as long as the longest allowed, and not one longer", () => {
    const longest = `1.0.0-${"a".repeat(maxVersionLength - 6)}`;
    expect(longest).toHaveLength(maxVersionLength);
    expect(isVersion(longest)).toBe(true);
    expect(isVersion(`${longest}a`)).toBe(false);
  });
});
