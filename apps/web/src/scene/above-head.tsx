import {
  contextUsageBand,
  contextUsageBandTokens,
  contextUsagePercent,
  contextUsageText,
} from "@ai-office/shared";
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState, type RefObject } from "react";

import { cn } from "@/lib/utils.ts";

import type { CapState } from "../wall-board.ts";
import {
  aboveHeadHeight,
  dailyCapState,
  freshStartSeconds,
  tokensThisMonthText,
  tokensTodayText,
  type AboveHead,
  type FreshStartSignal,
} from "./above-head.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { backgroundOf } from "./stage-colours.ts";

// The display above each Agent's head in the 3D Office (PRD FR-62, FR-85;
// above-head.ts says what it shows), in HTML so its text stays sharp and
// readable however far the camera is: drei's `Html` keeps it over the
// Agent, facing the camera, as the Agent sits or walks. Like the scene's
// other labels it is hidden from assistive technology; the Agent card and
// the Agent live view say the same in 2D.

/**
 * The tokens line's colours against the daily cap: the bubble's own paper
 * while under it, or an amber or red band across the line, each with its
 * readable text.
 */
const tokenLineClasses: Readonly<Record<CapState, string>> = {
  neutral: "",
  warning: "bg-office-state-warning text-office-ink",
  reached: "bg-office-state-critical text-office-paper",
};

/** One line in the bubble: the Context Usage bar, or the tokens today. */
const line = "flex items-center justify-center gap-1 rounded-sm px-1";

/** The Context Usage bar: its fill and its percentage; emptying, at a Fresh Start. */
function ContextUsageBar({
  usage,
  draining,
}: {
  usage: number | null;
  /** The Fresh Start emptying it, while it does. */
  draining: FreshStartSignal | undefined;
}) {
  const shown = draining?.contextUsage ?? usage;
  const band = contextUsageBand(shown);
  const percent = shown === null ? 0 : contextUsagePercent(shown);
  return (
    <span
      data-context-usage={draining === undefined ? band : "fresh-start"}
      className={line}
    >
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-office-ink/20">
        <span
          key={draining?.id}
          data-fill
          className={cn(
            "block h-full rounded-full",
            backgroundOf(contextUsageBandTokens[band]),
          )}
          style={
            draining === undefined
              ? { width: `${String(percent)}%` }
              : {
                  width: 0,
                  ["--fresh-start-from" as string]: `${String(percent)}%`,
                  animation: `fresh-start-drain ${String(freshStartSeconds)}s ease-in forwards`,
                }
          }
        />
      </span>
      <span className="tabular-nums">
        {draining === undefined ? contextUsageText(usage) : "Fresh Start"}
      </span>
    </span>
  );
}

/**
 * What floats above one Agent, in one speech bubble with its tail pointing
 * down at the Agent: its Context Usage bar while it has a session going (or
 * while a Fresh Start empties it), over its tokens today, which hovering
 * adds this month's to.
 */
export function AboveHeadDisplay({
  agentId,
  display,
  freshStart,
  reducedMotion,
}: {
  agentId: string;
  display: AboveHead | undefined;
  /** The Agent's latest Fresh Start; one newer than when this was drawn empties the bar. */
  freshStart?: FreshStartSignal | undefined;
  /** No animation: a Fresh Start just shows the bar as it now is. */
  reducedMotion: boolean;
}) {
  // A Fresh Start already seen when the display was drawn is not played.
  const [seen, setSeen] = useState(freshStart?.id);
  const [playing, setPlaying] = useState<FreshStartSignal | undefined>();
  if (freshStart?.id !== seen) {
    setSeen(freshStart?.id);
    setPlaying(reducedMotion ? undefined : freshStart);
  }
  useEffect(() => {
    if (playing === undefined) {
      return;
    }
    const done = setTimeout(() => {
      setPlaying(undefined);
    }, freshStartSeconds * 1000);
    return () => {
      clearTimeout(done);
    };
  }, [playing]);
  const [hovered, setHovered] = useState(false);

  const draining = reducedMotion ? undefined : playing;
  const usage = display?.contextUsage;
  const tokens = display?.tokens;
  if (draining === undefined && usage === undefined && tokens === undefined) {
    return null;
  }
  const state =
    tokens === undefined
      ? undefined
      : dailyCapState(tokens.today, tokens.dailyCap);
  return (
    <div
      aria-hidden
      data-above-head={agentId}
      className="relative mb-1 flex flex-col items-stretch gap-0.5 rounded-md bg-office-paper px-1 py-0.5 font-mono text-xs font-semibold whitespace-nowrap text-office-ink shadow-sm select-none"
    >
      {(draining !== undefined || usage !== undefined) && (
        <ContextUsageBar usage={usage ?? null} draining={draining} />
      )}
      {tokens !== undefined && state !== undefined && (
        <span
          data-tokens-today={state}
          className={cn(line, "pointer-events-auto", tokenLineClasses[state])}
          onPointerEnter={() => {
            setHovered(true);
          }}
          onPointerLeave={() => {
            setHovered(false);
          }}
        >
          {tokensTodayText(tokens.today)}
        </span>
      )}
      {tokens !== undefined && hovered && (
        <span
          data-tokens-this-month
          className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-sm bg-office-ink px-1.5 py-0.5 text-office-paper shadow-sm"
        >
          {tokensThisMonthText(tokens.thisMonth, tokens.monthlyCap)}
        </span>
      )}
      {/* The bubble's tail, pointing down at the Agent. */}
      <span
        data-bubble-tail
        className="absolute top-full left-1/2 size-0 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-office-paper"
      />
    </div>
  );
}

/**
 * The display above an Agent, as a child of its figure's group, so it
 * goes where the Agent goes. Nothing while the scene settings switch it
 * off.
 */
export function AgentAboveHead({
  agentId,
  display,
  freshStart,
  labelsIn,
}: {
  agentId: string;
  display: AboveHead | undefined;
  freshStart?: FreshStartSignal | undefined;
  /** Where the display goes in the page; beside the canvas by default. */
  labelsIn?: RefObject<HTMLElement> | undefined;
}) {
  const shown = useSceneSettings((settings) => settings.showAboveHead);
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  // Where the display goes: the element the canvas takes its events from,
  // as drei's other labels do. Until it is connected, nothing: a display
  // drawn earlier would be moved there once it is, and drei makes the move
  // with a second React root on the same element, which the first one's
  // late commit empties.
  const connected = useThree((state) => state.events.connected as unknown);
  const canvasTarget = useMemo(
    () =>
      connected instanceof HTMLElement ? { current: connected } : undefined,
    [connected],
  );
  const target = labelsIn ?? canvasTarget;
  if (!shown || target === undefined) {
    return null;
  }
  return (
    <group name={`above-head-${agentId}`} position={[0, aboveHeadHeight, 0]}>
      <Html
        center
        zIndexRange={[0, 0]}
        style={{ pointerEvents: "none" }}
        portal={target}
      >
        <AboveHeadDisplay
          agentId={agentId}
          display={display}
          freshStart={freshStart}
          reducedMotion={reducedMotion}
        />
      </Html>
    </group>
  );
}
