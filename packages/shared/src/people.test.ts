import { describe, expect, it } from "vitest";

import { avatarSchema } from "./avatar.ts";
import {
  defaultLobbyCast,
  defaultOwnerProfile,
  greeting,
  isTimeZone,
  ownerProfileSchema,
  partOfDay,
} from "./people.ts";

describe("the Owner's profile", () => {
  it("is in British time by default", () => {
    expect(defaultOwnerProfile.timeZone).toBe("Europe/London");
    expect(ownerProfileSchema.parse(defaultOwnerProfile)).toEqual(
      defaultOwnerProfile,
    );
  });

  it("knows IANA time zones, and nothing else", () => {
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("Asia/Tokyo")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("the receptionist's greeting", () => {
  const profile = { ...defaultOwnerProfile, forename: "Adrian" };

  it("says morning, afternoon or evening by the Owner's time zone", () => {
    // 11:30 in London in October (BST) is 10:30 UTC.
    const at = new Date("2026-10-10T10:30:00Z");
    expect(partOfDay(at, "Europe/London")).toBe("morning");
    expect(partOfDay(at, "Asia/Tokyo")).toBe("evening");
    expect(partOfDay(new Date("2026-10-10T13:00:00Z"), "Europe/London")).toBe(
      "afternoon",
    );
  });

  it("greets by nickname, else forename, else no name", () => {
    const at = new Date("2026-01-10T09:00:00Z");
    expect(greeting({ ...profile, nickname: "Ade" }, at)).toBe(
      "Hi, Ade. Good morning.",
    );
    expect(greeting(profile, at)).toBe("Hi, Adrian. Good morning.");
    expect(greeting(defaultOwnerProfile, at)).toBe("Hi there. Good morning.");
  });
});

describe("the lobby's default cast", () => {
  it("has valid Avatars", () => {
    expect(avatarSchema.parse(defaultLobbyCast.receptionist.avatar)).toEqual(
      defaultLobbyCast.receptionist.avatar,
    );
    expect(avatarSchema.parse(defaultLobbyCast.visitor.avatar)).toEqual(
      defaultLobbyCast.visitor.avatar,
    );
  });
});
