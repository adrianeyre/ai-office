import { floorSkillToggles, type Database } from "@ai-office/db";
import { isSandboxRole, type SandboxRole } from "@ai-office/shared";
import { and, eq } from "drizzle-orm";

// Where the Floor admin's per-Role Skill settings live (PRD FR-75): the
// `floor_skill_toggles` table, or memory for tests. A Skill is on for a
// Role until it is turned off.

/** One Skill turned on or off for one Role on one Floor. */
export interface FloorSkillToggleRecord {
  readonly skillName: string;
  readonly role: SandboxRole;
  readonly enabled: boolean;
}

export interface FloorSkillToggleStore {
  /** Every setting on a Floor. */
  list(floorId: string): Promise<FloorSkillToggleRecord[]>;
  /** Turns a Skill on or off for a Role, answering whether that changed it. */
  set(
    floorId: string,
    toggle: FloorSkillToggleRecord,
    at: Date,
  ): Promise<boolean>;
}

/** Whether `skillName` is on for `role`, by `toggles`. */
export const skillOnFor = (
  toggles: readonly FloorSkillToggleRecord[],
  skillName: string,
  role: string,
): boolean =>
  toggles.find(
    (toggle) => toggle.skillName === skillName && toggle.role === role,
  )?.enabled ?? true;

const keyOf = (floorId: string, skillName: string, role: string) =>
  JSON.stringify([floorId, skillName, role]);

/** Keeps the settings in memory: for tests. */
export function memoryFloorSkillToggleStore(): FloorSkillToggleStore {
  const all = new Map<string, FloorSkillToggleRecord & { floorId: string }>();
  return {
    list(floorId) {
      return Promise.resolve(
        [...all.values()]
          .filter((toggle) => toggle.floorId === floorId)
          .map(({ skillName, role, enabled }) => ({
            skillName,
            role,
            enabled,
          })),
      );
    },
    set(floorId, toggle) {
      const key = keyOf(floorId, toggle.skillName, toggle.role);
      const was = all.get(key)?.enabled ?? true;
      all.set(key, { floorId, ...toggle });
      return Promise.resolve(was !== toggle.enabled);
    },
  };
}

/** Keeps the settings in `floor_skill_toggles`. */
export function databaseFloorSkillToggleStore(
  db: Database,
): FloorSkillToggleStore {
  return {
    async list(floorId) {
      const rows = await db
        .select()
        .from(floorSkillToggles)
        .where(eq(floorSkillToggles.floorId, floorId));
      return rows.flatMap(({ skillName, role, enabled }) =>
        isSandboxRole(role) ? [{ skillName, role, enabled }] : [],
      );
    },
    async set(floorId, toggle, at) {
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select({ enabled: floorSkillToggles.enabled })
          .from(floorSkillToggles)
          .where(
            and(
              eq(floorSkillToggles.floorId, floorId),
              eq(floorSkillToggles.skillName, toggle.skillName),
              eq(floorSkillToggles.role, toggle.role),
            ),
          )
          .for("update");
        await tx
          .insert(floorSkillToggles)
          .values({ floorId, ...toggle, updatedAt: at })
          .onConflictDoUpdate({
            target: [
              floorSkillToggles.floorId,
              floorSkillToggles.skillName,
              floorSkillToggles.role,
            ],
            set: { enabled: toggle.enabled, updatedAt: at },
          });
        return (before?.enabled ?? true) !== toggle.enabled;
      });
    },
  };
}
