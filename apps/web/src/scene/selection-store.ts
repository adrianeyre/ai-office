import { create } from "zustand";

// What the Owner has picked in the 3D Office, for the HTML panels to show.
// Agents (FR-63) and the inspectable objects of FR-58 (inspectable.ts) are
// selected the same way.

export type SelectableKind =
  | "agent"
  | "monitor"
  | "whiteboard"
  | "notice-board"
  | "wall-board"
  | "bookshelf"
  | "skills-bookshelf"
  | "grilling-session";

export interface Selection {
  readonly kind: SelectableKind;
  /** Its id, such as the Agent's or the Floor's. */
  readonly id: string;
}

export interface SelectionState {
  /** What is selected: its panel is open. */
  readonly selected: Selection | undefined;
  /** What the pointer is over, to highlight. */
  readonly hovered: Selection | undefined;
  /** The camera view to go back to when the selection's panel closes. */
  readonly returnView: string | undefined;
  /** Select something, keeping `returnView` to go back to (by default, none). */
  readonly select: (selection: Selection, returnView?: string) => void;
  readonly hover: (selection: Selection | undefined) => void;
  /** Close the selection's panel. */
  readonly clearSelection: () => void;
}

export function sameSelection(
  a: Selection | undefined,
  b: Selection | undefined,
): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  selected: undefined,
  hovered: undefined,
  returnView: undefined,
  select: (selection, returnView) => {
    const state = get();
    if (
      !sameSelection(state.selected, selection) ||
      state.returnView !== returnView
    ) {
      set({ selected: selection, returnView });
    }
  },
  hover: (selection) => {
    if (!sameSelection(get().hovered, selection)) {
      set({ hovered: selection });
    }
  },
  clearSelection: () => {
    if (get().selected !== undefined) {
      set({ selected: undefined, returnView: undefined });
    }
  },
}));

/** Nothing selected or hovered; for tests. */
export function resetSelection(): void {
  useSelectionStore.setState({
    selected: undefined,
    hovered: undefined,
    returnView: undefined,
  });
}
