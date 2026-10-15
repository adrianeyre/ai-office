import { describe, expect, it } from "vitest";

import {
  ownerPasswordSchema,
  passwordProblems,
  setupRequestSchema,
} from "./index.ts";

describe("passwordProblems", () => {
  it.each([
    "Tr0ub4dor&3x", // 12 characters, all four classes
    "correct-horse-7", // three classes
    "CORRECT horse battery", // three classes
    "correct horse battery staple", // a passphrase of 20 or more
  ])("accepts %j", (password) => {
    expect(passwordProblems(password)).toEqual([]);
  });

  it("refuses a password under 12 characters", () => {
    expect(passwordProblems("Sh0rt&pass")).toEqual([
      "Use at least 12 characters.",
    ]);
  });

  it("counts characters as people do, not UTF-16 code units", () => {
    // Six emoji are 12 code units but 6 characters.
    expect(passwordProblems("😀😁😂🤣😃😄")).toEqual([
      "Use at least 12 characters.",
    ]);
    // A family emoji is 11 code units and one character.
    expect(passwordProblems("Ab1👨‍👩‍👧")).toEqual(["Use at least 12 characters."]);
  });

  it("refuses a password over 256 characters", () => {
    expect(passwordProblems(`Aa1!${"x".repeat(253)}`)).toEqual([
      "Use at most 256 characters.",
    ]);
  });

  it("refuses a short password that mixes fewer than three classes", () => {
    expect(passwordProblems("onlylowercase")).toEqual([
      "Mix at least three of lower case, upper case, digits and symbols, or use 20 or more characters.",
    ]);
    expect(passwordProblems("lowercase123")).toHaveLength(1);
  });

  it("refuses a password of few different characters, however long", () => {
    expect(passwordProblems("aaaaaaaaaaaaaaaaaaaaaaaa")).toEqual([
      "Use at least 6 different characters.",
    ]);
    expect(passwordProblems("Aa1!Aa1!Aa1!Aa1!")).toEqual([
      "Use at least 6 different characters.",
    ]);
  });
});

describe("ownerPasswordSchema", () => {
  it("reports every problem as an issue", () => {
    const result = ownerPasswordSchema.safeParse("aaaaaaaaaaaab");
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "Use at least 6 different characters.",
      "Mix at least three of lower case, upper case, digits and symbols, or use 20 or more characters.",
    ]);
  });

  it("is what the setup request's password must meet", () => {
    expect(setupRequestSchema.safeParse({ password: "short" }).success).toBe(
      false,
    );
    expect(
      setupRequestSchema.safeParse({ password: "Tr0ub4dor&3x" }).success,
    ).toBe(true);
    expect(setupRequestSchema.safeParse({}).success).toBe(false);
  });
});
