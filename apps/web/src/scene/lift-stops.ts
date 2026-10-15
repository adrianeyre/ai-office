import type { Floor, Notice } from "@ai-office/shared";

// Where the lift goes (PRD FR-57: Floors are "reached by a lift or a floor
// picker"): the lobby first, then each Floor in use, in the order the API
// lists them. Each stop counts its open action Notices, for the floor
// picker's indicator and the lamps by the lift doors.

/** A place in the Office the scene can show. */
export type OfficeLocation =
  | { readonly kind: "lobby" }
  | { readonly kind: "floor"; readonly floorId: string };

export const lobby: OfficeLocation = { kind: "lobby" };

export function sameLocation(a: OfficeLocation, b: OfficeLocation): boolean {
  return a.kind === "lobby"
    ? b.kind === "lobby"
    : b.kind === "floor" && a.floorId === b.floorId;
}

export interface LiftStop {
  /** Its place in the lift's run: 0 for the lobby, then 1, 2… for the Floors. */
  readonly order: number;
  readonly location: OfficeLocation;
  /** The Floor's name, or "Lobby". */
  readonly name: string;
  /** The Floor's repository, `owner/name`; none for the lobby. */
  readonly repository: string | undefined;
  /**
   * Open action Notices about it: a Floor's own, or for the lobby those
   * about the whole Office (no Floor).
   */
  readonly actionNotices: number;
}

const isOpenAction = (notice: Notice) =>
  notice.kind === "action" &&
  notice.dismissedAt === null &&
  notice.actedAt === null;

/** The lift's stops: the lobby, then every Floor in use. */
export function liftStops(
  floors: readonly Floor[],
  notices: readonly Notice[],
): LiftStop[] {
  const actions = new Map<string | null, number>();
  for (const notice of notices.filter(isOpenAction)) {
    actions.set(notice.floorId, (actions.get(notice.floorId) ?? 0) + 1);
  }
  return [
    {
      order: 0,
      location: lobby,
      name: "Lobby",
      repository: undefined,
      actionNotices: actions.get(null) ?? 0,
    },
    ...floors
      .filter(({ archivedAt }) => archivedAt === null)
      .map((floor, index) => ({
        order: index + 1,
        location: { kind: "floor", floorId: floor.id } as const,
        name: floor.name,
        repository: floor.repository,
        actionNotices: actions.get(floor.id) ?? 0,
      })),
  ];
}

/** The stop for a location, if the lift goes there. */
export function stopAt(
  stops: readonly LiftStop[],
  location: OfficeLocation,
): LiftStop | undefined {
  return stops.find((stop) => sameLocation(stop.location, location));
}
