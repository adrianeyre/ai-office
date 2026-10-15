import { useFloorNames } from "./floors.ts";
import { liftLocation } from "./scene/lift.ts";
import { useLiftStore } from "./scene/lift-store.ts";

/**
 * Where the Office's scene is: "Lobby", or the Floor's name the lift is at.
 * The Office's heading and the browser tab both name it.
 */
export function useOfficePlace(): string {
  const location = useLiftStore((state) => liftLocation(state.lift));
  const floorName = useFloorNames();
  return location.kind === "lobby" ? "Lobby" : floorName(location.floorId);
}
