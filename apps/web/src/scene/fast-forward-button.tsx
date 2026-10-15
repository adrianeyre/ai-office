import { FastForward } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button.tsx";

import {
  useMeetingFastForwardStore,
  type Gathering,
} from "./meeting-fast-forward.ts";
import { useSceneSettings } from "./scene-settings.ts";

/** How long the button waits for a walk that never starts. */
const giveUpMs = 60_000;

const whatFor = {
  "status-update": "the Status update",
  "meeting-room": "the Meeting Room",
} as const;

/**
 * Fast forward, to the right of the Status update or Meeting Room button the
 * Owner pressed (meeting-fast-forward.ts): everyone in the meeting room at
 * once. Pressed before anyone sets off, it spins until they do. With
 * reduced motion no one walks, so it never shows.
 */
export function FastForwardButton({ gathering }: { gathering: Gathering }) {
  const called = useMeetingFastForwardStore((state) => state.called);
  const skipping = useMeetingFastForwardStore((state) => state.skipping);
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const shown = called === gathering && !reducedMotion;
  useEffect(() => {
    if (!shown) {
      return;
    }
    const timer = setTimeout(() => {
      useMeetingFastForwardStore.getState().dismiss();
    }, giveUpMs);
    return () => {
      clearTimeout(timer);
    };
  }, [shown]);
  if (!shown) {
    return null;
  }
  const label = `Fast forward: everyone to the meeting room now for ${whatFor[gathering]}`;
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className="pointer-events-auto shadow-lg"
      aria-label={label}
      title={label}
      pending={skipping}
      onClick={() => {
        useMeetingFastForwardStore.getState().fastForward();
      }}
    >
      <FastForward aria-hidden />
    </Button>
  );
}
