import { seasonalActorIds } from "@ai-office/shared";
import { randomAvatar, seededRandom } from "@ai-office/shared/avatar";
import { describe, expect, it } from "vitest";

import {
  avatarGeometry,
  avatarLods,
  avatarTriangleBudget,
} from "./avatar-geometry.ts";
import { avatarRig } from "./avatar-rig.ts";
import { triangles } from "./piece-geometry.ts";
import {
  actorLooks,
  costumeDress,
  costumeOf,
  costumes,
  partyHatDress,
} from "./seasonal-dress.ts";
import type { QualityLevel } from "./quality.ts";

const qualities: QualityLevel[] = ["low", "medium", "high"];

describe("the seasonal actors and costumes", () => {
  it("build every actor, at every quality, within an Avatar's budget and standing human height", () => {
    for (const actor of seasonalActorIds) {
      const { avatar, dress } = actorLooks[actor];
      const rig = avatarRig(avatar);
      for (const quality of qualities) {
        const geometry = avatarGeometry(
          avatar,
          avatarLods[quality],
          rig,
          dress,
        );
        const count = triangles(geometry);
        expect(count, `${actor} at ${quality}`).toBeGreaterThan(0);
        expect(count, `${actor} at ${quality}`).toBeLessThanOrEqual(
          avatarTriangleBudget[quality],
        );
        const positions = geometry.getAttribute("position").array;
        expect([...positions].every(Number.isFinite), `${actor}: no NaN`).toBe(
          true,
        );
        geometry.computeBoundingBox();
        expect(geometry.boundingBox?.max.y).toBeGreaterThan(1.2);
        expect(geometry.boundingBox?.max.y).toBeLessThan(2.4);
        geometry.dispose();
      }
    }
  });

  it("dress an Agent in the same costume and party hat every time, within its budget", () => {
    expect(costumeOf("agent-1")).toBe(costumeOf("agent-1"));
    const worn = new Set(
      Array.from({ length: 40 }, (_, index) =>
        costumeOf(`agent-${String(index)}`),
      ),
    );
    expect(worn.size).toBe(costumes.length);
    const avatar = randomAvatar(seededRandom("costumes"));
    const rig = avatarRig(avatar);
    const plain = triangles(avatarGeometry(avatar, 2, rig));
    for (const dress of [
      ...costumes.map((costume) => costumeDress(costume)),
      partyHatDress("agent-1"),
    ]) {
      const dressed = triangles(avatarGeometry(avatar, 2, rig, dress));
      expect(dressed).toBeGreaterThan(plain);
      expect(dressed).toBeLessThanOrEqual(avatarTriangleBudget.low);
    }
  });
});
