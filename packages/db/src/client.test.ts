import { describe, expect, it } from "vitest";

import { connect, databaseUrlFromEnv, ping } from "./client.ts";

describe("databaseUrlFromEnv", () => {
  it("returns DATABASE_URL", () => {
    expect(
      databaseUrlFromEnv({ DATABASE_URL: "postgres://localhost/ai_office" }),
    ).toBe("postgres://localhost/ai_office");
  });

  it.each([{}, { DATABASE_URL: "" }])(
    "refuses, naming DATABASE_URL, when it is %o",
    (env) => {
      expect(() => databaseUrlFromEnv(env)).toThrow(/DATABASE_URL/);
    },
  );
});

describe("ping", () => {
  it("reports an unreachable database as down instead of throwing", async () => {
    // Port 1 is never Postgres; the connection is refused at once.
    const connection = connect("postgres://nobody@127.0.0.1:1/ai_office");
    try {
      await expect(ping(connection.pool)).resolves.toBe(false);
    } finally {
      await connection.close();
    }
  });
});
