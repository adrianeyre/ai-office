import { describe, expect, it } from "vitest";

import { agentName, agentNames } from "./names.ts";

describe("a new Agent's name", () => {
  it("is one no other Agent on the Floor has", () => {
    let seed = 0;
    const random = () => (seed++ % 97) / 97;
    const taken: string[] = [];
    // As many Agents as there are names: each gets one not yet taken.
    while (taken.length < agentNames.length) {
      const name = agentName(random, taken);
      expect(taken).not.toContain(name);
      expect(agentNames).toContain(name);
      taken.push(name);
    }
  });

  it("is numbered once every name is used", () => {
    const taken = [...agentNames, "Ada 2"];
    expect(agentName(() => 0, taken)).toBe("Ada 3");
  });
});
