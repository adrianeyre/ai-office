import type { Avatar, LobbyCast, LobbyRole } from "@ai-office/shared";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";

import { avatarFigure } from "./avatar-figure.ts";
import { avatarLods } from "./avatar-geometry.ts";
import { bubbleHeight } from "./idle-activities.tsx";
import {
  createLobbyPerson,
  receptionistFirstRoutine,
  receptionistGreeting,
  receptionistRoutine,
  stillPoses,
  visitorFirstRoutine,
  visitorRoutine,
  type LobbyPerson,
  type LobbyPose,
} from "./lobby-people.ts";
import { useSceneSettings } from "./scene-settings.ts";

// The lobby's people in the scene (lobby-people.ts): the receptionist (the
// Communications Agent) behind the desk and, now and then, the visitor on
// the sofa, each as
// their Avatar, seated in their places as the lobby opens (no one is seen
// walking in). The receptionist greets the Owner once each time the
// Office opens, in a speech bubble over the desk; other bubbles ("zzz",
// "♪") show over whoever is dozing or listening. With reduced motion both
// stay still in their places, and no one walks.

/** Whether the receptionist has greeted the Owner since the Office opened. */
let greeted = false;

/** As if the Office had just opened; for tests. */
export function resetGreeting(): void {
  greeted = false;
}

/** One of the lobby's people, as their Avatar, posed as `person` has them. */
function LobbyFigure({
  role,
  avatar,
  person,
  still,
  onBubble,
}: {
  role: LobbyRole;
  avatar: Avatar;
  person: LobbyPerson;
  still: LobbyPose;
  /** Told what is over their head, whenever it changes. */
  onBubble: (
    bubble: { text: string; at: LobbyPose["position"] } | undefined,
  ) => void;
}) {
  const quality = useSceneSettings((settings) => settings.quality);
  const figure = useMemo(
    // Posed as they start, so no frame shows them standing (or at the
    // origin) before their routine places them.
    () => avatarFigure(avatar, avatarLods[quality], still.animation),
    [avatar, quality, still.animation],
  );
  useEffect(
    () => () => {
      figure.dispose();
    },
    [figure],
  );
  const group = useRef<Group>(null);
  const shown = useRef<string | undefined>(undefined);

  useFrame((_state, delta) => {
    const reducedMotion = useSceneSettings.getState().reducedMotion;
    if (!reducedMotion) {
      person.advance(delta);
    }
    const pose = reducedMotion ? still : person.pose();
    const current = group.current;
    if (current === null) {
      return;
    }
    current.visible = pose !== undefined;
    if (pose !== undefined) {
      current.position.set(pose.position[0], 0, pose.position[1]);
      current.rotation.set(0, pose.heading, 0);
      figure.play(pose.animation, reducedMotion);
      if (!reducedMotion) {
        figure.mixer.update(delta);
      }
    }
    const bubble = pose?.bubble;
    if (bubble !== shown.current) {
      shown.current = bubble;
      onBubble(
        bubble === undefined || pose === undefined
          ? undefined
          : { text: bubble, at: pose.position },
      );
    }
  });

  return (
    <group
      ref={group}
      name={`lobby-${role}`}
      position={[still.position[0], 0, still.position[1]]}
      rotation={[0, still.heading, 0]}
    >
      <primitive object={figure.mesh} />
    </group>
  );
}

function Bubble({
  name,
  at,
  speech = false,
  children,
}: {
  name: string;
  at: LobbyPose["position"];
  speech?: boolean;
  children: string;
}) {
  return (
    <group
      name={name}
      position={[at[0], bubbleHeight + (speech ? 0.35 : 0), at[1]]}
    >
      <Html center zIndexRange={[0, 0]} style={{ pointerEvents: "none" }}>
        <span
          aria-hidden
          data-lobby-bubble={name}
          className={
            speech
              ? "block rounded-lg bg-office-paper px-3 py-1.5 text-center text-sm font-medium whitespace-nowrap text-office-ink shadow-md"
              : "rounded-full bg-office-paper px-1.5 py-0.5 font-mono text-xs font-semibold text-office-ink italic shadow-sm"
          }
        >
          {children}
        </span>
      </Html>
    </group>
  );
}

/**
 * The receptionist and the visitor. `greeting` is what the receptionist
 * says as the Office opens, once its words are known.
 */
export function LobbyPeople({
  cast,
  greeting,
}: {
  cast: LobbyCast;
  greeting?: string | undefined;
}) {
  // Due once, the first time the lobby shows since the Office opened.
  const [greets] = useState(() => !greeted);
  useEffect(() => {
    greeted = true;
  }, []);
  const receptionist = useMemo(
    () =>
      createLobbyPerson(
        greets ? receptionistGreeting : receptionistFirstRoutine(Math.random),
        () => receptionistRoutine(Math.random),
      ),
    [greets],
  );
  const visitor = useMemo(
    () =>
      createLobbyPerson(visitorFirstRoutine(Math.random), () =>
        visitorRoutine(Math.random),
      ),
    [],
  );
  const [bubbles, setBubbles] = useState<
    Partial<Record<LobbyRole, { text: string; at: LobbyPose["position"] }>>
  >({});
  const bubbleOf =
    (role: LobbyRole) => (bubble: (typeof bubbles)[LobbyRole]) => {
      setBubbles((before) => ({ ...before, [role]: bubble }));
    };
  const [speaking, setSpeaking] = useState(false);
  useFrame(() => {
    const now =
      receptionist.routine() === receptionistGreeting &&
      !useSceneSettings.getState().reducedMotion;
    if (now !== speaking) {
      setSpeaking(now);
    }
  });

  return (
    <group name="lobby-people">
      <LobbyFigure
        role="receptionist"
        avatar={cast.receptionist.avatar}
        person={receptionist}
        still={stillPoses.receptionist}
        onBubble={bubbleOf("receptionist")}
      />
      <LobbyFigure
        role="visitor"
        avatar={cast.visitor.avatar}
        person={visitor}
        still={stillPoses.visitor}
        onBubble={bubbleOf("visitor")}
      />
      {speaking && greeting !== undefined && (
        <Bubble
          name="receptionist-greeting"
          at={stillPoses.receptionist.position}
          speech
        >
          {greeting}
        </Bubble>
      )}
      {(["receptionist", "visitor"] as const).map((role) => {
        const bubble = bubbles[role];
        return bubble === undefined ? null : (
          <Bubble key={role} name={`lobby-bubble-${role}`} at={bubble.at}>
            {bubble.text}
          </Bubble>
        );
      })}
    </group>
  );
}
