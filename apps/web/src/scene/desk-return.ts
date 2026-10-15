import { create } from "zustand";

// "Return to desks" (over a Floor's 3D view, office-view.tsx): the Owner
// calls every Agent away on an idle activity back to its desk. The scene
// (floor.tsx) says whether anyone is away on one, for the button to show,
// and carries out each request; the overlay pauses a running Grilling
// Session itself, which walks the Floor back from the meeting room. Work
// (Kickoffs, Wrap-ups, Handoffs and fact-finding) is never called off.

export interface DeskReturnState {
  /** How many times the Owner has asked, so the scene sees each new ask. */
  readonly requests: number;
  /** Whether any of the shown Floor's Agents is away on an idle activity. */
  readonly wandering: boolean;
  /** Everyone back to their desks. */
  readonly returnToDesks: () => void;
  readonly setWandering: (wandering: boolean) => void;
}

export const useDeskReturnStore = create<DeskReturnState>()((set) => ({
  requests: 0,
  wandering: false,
  returnToDesks: () => {
    set((state) => ({ requests: state.requests + 1 }));
  },
  setWandering: (wandering) => {
    set({ wandering });
  },
}));

/** Back to how it starts, for tests. */
export function resetDeskReturn(): void {
  useDeskReturnStore.setState({ requests: 0, wandering: false });
}
