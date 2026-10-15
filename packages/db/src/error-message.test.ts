import { describe, expect, it } from "vitest";

import { errorMessage } from "./error-message.ts";

const refused = (address: string) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
    code: "ECONNREFUSED",
  });

describe("errorMessage", () => {
  it("names the driver's error inside Drizzle's wrapper", () => {
    const wrapped = new Error("Failed query: select 1", {
      cause: refused("127.0.0.1:3048"),
    });
    expect(errorMessage(wrapped)).toBe("connect ECONNREFUSED 127.0.0.1:3048");
  });

  it("joins every attempt when localhost resolves to several addresses", () => {
    const aggregate = Object.assign(
      new AggregateError([refused("::1:3048"), refused("127.0.0.1:3048")], ""),
      { code: "ECONNREFUSED" },
    );
    expect(errorMessage(new Error("Failed query", { cause: aggregate }))).toBe(
      "connect ECONNREFUSED ::1:3048; connect ECONNREFUSED 127.0.0.1:3048",
    );
  });

  it("falls back to the code, then the name, when there is no message", () => {
    expect(
      errorMessage(Object.assign(new Error(""), { code: "ECONNRESET" })),
    ).toBe("ECONNRESET");
    expect(errorMessage(new TypeError(""))).toBe("TypeError");
  });
});
