import { create } from "zustand";

// UI state that is not server data. Server data lives in TanStack Query.
export interface UiState {
  /** Whether the navigation is open on narrow screens (always shown on wide ones). */
  readonly navigationOpen: boolean;
  readonly toggleNavigation: () => void;
  readonly closeNavigation: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  navigationOpen: false,
  toggleNavigation: () => {
    set((state) => ({ navigationOpen: !state.navigationOpen }));
  },
  closeNavigation: () => {
    set({ navigationOpen: false });
  },
}));
