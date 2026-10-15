import { create } from "zustand";

// Fast forward (over a Floor's 3D view, office-view.tsx): once the Owner
// presses Status update or Meeting Room, a fast-forward button shows beside
// it, and pressing it puts the Manager and the Agents in their places in
// the meeting room at once rather than waiting for them to walk there.
// The scene (floor.tsx) says whether anyone is on the way, and carries
// out the fast forward as soon as anyone is: pressed before the walk
// starts (the server is still answering), it waits for it. The button
// goes once everyone is there, or its request comes to nothing.

/** The buttons that gather the Floor in the meeting room. */
export type Gathering = "status-update" | "meeting-room";

export interface MeetingFastForwardState {
  /** The button the Owner pressed last, while its Floor gathers. */
  readonly called: Gathering | undefined;
  /** Whether anyone on the shown Floor is on the way to the meeting room. */
  readonly gathering: boolean;
  /** The Owner pressed fast forward: carried out once anyone is on the way. */
  readonly skipping: boolean;
  readonly call: (gathering: Gathering) => void;
  readonly fastForward: () => void;
  /** The request came to nothing: the button goes. */
  readonly dismiss: () => void;
  readonly setGathering: (gathering: boolean) => void;
}

export const useMeetingFastForwardStore = create<MeetingFastForwardState>()(
  (set) => ({
    called: undefined,
    gathering: false,
    skipping: false,
    call: (called) => {
      set({ called, skipping: false });
    },
    fastForward: () => {
      set({ skipping: true });
    },
    dismiss: () => {
      set({ called: undefined, skipping: false });
    },
    setGathering: (gathering) => {
      set((state) =>
        // Everyone is there: the button has done its job.
        state.gathering && !gathering
          ? { gathering, called: undefined, skipping: false }
          : { gathering },
      );
    },
  }),
);

/** Back to how it starts, for tests. */
export function resetMeetingFastForward(): void {
  useMeetingFastForwardStore.setState({
    called: undefined,
    gathering: false,
    skipping: false,
  });
}
