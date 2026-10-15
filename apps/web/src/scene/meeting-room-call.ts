import { create } from "zustand";

// The Meeting Room (over a Floor's 3D view, office-view.tsx): the Owner
// calls the whole Floor to the meeting room, to write a PRD, file issues,
// start work or hear a Status update with them there (meeting-room.tsx).
// The Floor gathers round the table as it does for a Grilling Session
// (grilling-walks.ts), the Manager seated with the whiteboard behind it,
// and stays until the Owner sends it back to its desks or leaves the
// Floor; closing the panel leaves them there. A Grilling Session started
// from the room keeps everyone where they are. The call is the page's
// alone: nothing is kept, and work never waits for it.

export interface MeetingRoomCallState {
  /** The Floor called to its meeting room, if any. */
  readonly floorId: string | undefined;
  /** Whether the Meeting Room's panel is open. */
  readonly panelOpen: boolean;
  /** Every Agent of `floorId` to the meeting room, and the panel opens. */
  readonly call: (floorId: string) => void;
  /** The panel closes; the Floor stays at the table. */
  readonly closePanel: () => void;
  /** The meeting is over: back to their desks, and the panel closes. */
  readonly end: () => void;
}

export const useMeetingRoomCall = create<MeetingRoomCallState>()((set) => ({
  floorId: undefined,
  panelOpen: false,
  call: (floorId) => {
    set({ floorId, panelOpen: true });
  },
  closePanel: () => {
    set({ panelOpen: false });
  },
  end: () => {
    set({ floorId: undefined, panelOpen: false });
  },
}));

/** The session id a Meeting Room call gathers under: no Grilling Session's. */
export const meetingRoomSessionId = 0;

/** Back to how it starts, for tests. */
export function resetMeetingRoomCall(): void {
  useMeetingRoomCall.setState({ floorId: undefined, panelOpen: false });
}
