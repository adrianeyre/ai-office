import { Button } from "@/components/ui/button.tsx";

import { useActorCalls } from "./seasonal-visitor.tsx";

// The 3D view's Call Actor button, at its foot on the right: in season it
// calls a seasonal actor out of the lift at once, and while one visits it
// sends it back to the lift and away. Actors still visit now and then by
// themselves; only one is ever out at a time.

export function ActorCallButton() {
  const { visiting, call, remove } = useActorCalls();
  if (visiting) {
    return (
      <Button
        variant="secondary"
        className="pointer-events-auto shadow-lg"
        disabled={remove === undefined}
        onClick={remove}
      >
        Remove Actor
      </Button>
    );
  }
  return call === undefined ? null : (
    <Button
      variant="secondary"
      className="pointer-events-auto shadow-lg"
      onClick={call}
    >
      Call Actor
    </Button>
  );
}
