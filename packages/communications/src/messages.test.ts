import { describe, expect, it } from "vitest";

import {
  connectionOfNotice,
  connectionPath,
  type NoticeView,
} from "./messages.ts";

const linking = (url: string) =>
  ({
    links: [{ label: "Connection", url }],
  }) as Partial<NoticeView> as NoticeView;

describe("the Connection a Notice is about", () => {
  it("is read from its link to the Connections page, at General Settings' address or the old one", () => {
    expect(connectionPath("c1")).toBe(
      "/general-settings/connections?connection=c1",
    );
    expect(
      connectionOfNotice(
        linking(`https://office.example${connectionPath("c1")}`),
      ),
    ).toBe("c1");
    // Raised before General Settings had its own address.
    expect(
      connectionOfNotice(
        linking("https://office.example/admin/connections?connection=c2"),
      ),
    ).toBe("c2");
    expect(
      connectionOfNotice(
        linking("https://office.example/general-settings?connection=c3"),
      ),
    ).toBeUndefined();
  });
});
