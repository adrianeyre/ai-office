// The pictures in the "Everything else" bento grid, one Stage per tile,
// copied from the Stageshow skill's `bento` gold. The grid itself, the tiles
// and their copy are page HTML (index.html, styles.css); each picture is
// mounted into its tile's slot, measures the slot's width and draws at 1:1,
// pinned to the tile's foot. The tile list, written before any was built:
//
//   Tile          Span   Kind        The one thing                  Moves
//   Notices       2 × 1  Hero UI     a PR waiting for you           Approve turns Merged
//   Providers     1 × 1  Stat        "12" AI Providers              (page type, still)
//   Token Caps    1 × 1  Component   a Floor's cap, today           the meter fills
//   Local models  1 × 1  Statement   Agents on Ollama               (page type, still)
//   Merge Policy  1 × 1  Component   automatic or send to me        the switch slides
//   Connections   2 × 1  Collection  where the Owner hears          (still)
//
// One window in the grid (the hero's). Each tile plays its one beat once,
// as it scrolls in, 110ms after the one before it in reading order.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Check, GitPullRequest } from "lucide-react";
import {
  Bar,
  BrandMark,
  Count,
  Meter,
  Segmented,
  Stage,
  States,
  Text,
  Window,
  type Act,
  type BrandName,
} from "../stageshow/kit";
import { usePageTheme } from "./theme";
import "./bento.css";

const STEP = 110;
const LEAD = 450;

interface Beat {
  on: boolean;
}
const before: Beat = { on: false };
const after: Beat = { on: true };
const beat =
  (i: number) =>
  async (a: Act<Beat>): Promise<void> => {
    await a.wait(LEAD + i * STEP);
    await a.set({ on: true });
  };

/** The slot's width, kept as the tile reflows, so the Stage draws at 1:1. */
function useSlotWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  useLayoutEffect(() => {
    const node = ref.current?.parentElement;
    if (!node) return;
    const measure = () => {
      setWidth(Math.max(1, Math.round(node.getBoundingClientRect().width)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

/* ---------------- Notices (hero) ---------------- */

const EARLIER = [
  [168, 120],
  [140, 96],
  [184, 132],
];

export function NoticesTile() {
  const theme = usePageTheme();
  const [ref, width] = useSlotWidth();
  const compact = width < 560;
  return (
    <div ref={ref}>
      <Stage<Beat>
        width={width}
        height={compact ? 328 : 318}
        initial={before}
        poster={after}
        play="once"
        script={beat(0)}
        theme={theme}
        className="aio bt-stage"
      >
        {(s) => (
          <Window
            title="Notice Board"
            className="bt-window"
            data-compact={compact || undefined}
          >
            <div className="bt-notices">
              <div className="bt-notice" data-real>
                <span className="bt-notice-icon">
                  <GitPullRequest size={16} strokeWidth={2} />
                </span>
                <span className="bt-notice-text">
                  <Text className="bt-notice-title">
                    PR #43 is waiting for your approval
                  </Text>
                  <Text className="bt-notice-line">
                    web-shop · CI passed · 2 approvals
                  </Text>
                </span>
                <span className="bt-button" data-on={s.on || undefined}>
                  <States
                    value={s.on ? "done" : "ask"}
                    states={{
                      ask: "Approve and merge",
                      done: (
                        <span className="bt-done">
                          <Check size={14} strokeWidth={2.5} /> Merged
                        </span>
                      ),
                    }}
                  />
                </span>
              </div>
              {EARLIER.map(([title, line], i) => (
                <div key={i} className="bt-notice">
                  <Bar w={32} h={32} r={9} tone={1} />
                  <span className="bt-notice-text bt-notice-text--filler">
                    <Bar w={title} h={7} tone={3} />
                    <Bar w={line} h={6} tone={2} />
                  </span>
                </div>
              ))}
            </div>
          </Window>
        )}
      </Stage>
    </div>
  );
}

/* ---------------- Token Caps (component) ---------------- */

const millions = (n: number): string => `${(n / 1000).toFixed(2)}M`;

export function TokenCapTile() {
  const theme = usePageTheme();
  const [ref, width] = useSlotWidth();
  return (
    <div ref={ref}>
      <Stage<Beat>
        width={width}
        height={172}
        initial={before}
        poster={after}
        play="once"
        script={beat(2)}
        theme={theme}
        className="aio bt-stage"
      >
        {(s) => (
          <div className="bt-card bt-cap">
            <div className="bt-cap-head">
              <Text className="bt-strong">web-shop</Text>
              <Text className="bt-muted">Today</Text>
            </div>
            <div className="bt-cap-figure">
              <Count
                className="bt-cap-value"
                value={s.on ? 1420 : 960}
                format={millions}
                duration={900}
              />
              <Text className="bt-muted">of 2.00M tokens</Text>
            </div>
            <Meter value={s.on ? 0.71 : 0.48} className="bt-cap-meter" />
          </div>
        )}
      </Stage>
    </div>
  );
}

/* ---------------- Merge Policy (component) ---------------- */

export function MergePolicyTile() {
  const theme = usePageTheme();
  const [ref, width] = useSlotWidth();
  return (
    <div ref={ref}>
      <Stage<Beat>
        width={width}
        height={178}
        initial={before}
        poster={after}
        play="once"
        script={beat(4)}
        theme={theme}
        className="aio bt-stage"
      >
        {(s) => (
          <div className="bt-card bt-policy">
            <Text className="bt-strong">Merge Policy</Text>
            <Segmented
              className="bt-seg"
              items={["Send to me", "Merge automatically"]}
              value={s.on ? 1 : 0}
            />
            <Text className="bt-muted">
              Once CI passes and reviewers approve
            </Text>
          </div>
        )}
      </Stage>
    </div>
  );
}

/* ---------------- Connections (collection) ---------------- */

/** The Connections with a mark of their own, in two rows. */
const MARKS: { brand: BrandName; label: string }[][] = [
  [
    { brand: "slack", label: "Slack" },
    { brand: "gmail", label: "Email" },
    { brand: "notion", label: "Notion" },
    { brand: "google-docs", label: "Google Docs" },
    { brand: "google-sheets", label: "Google Sheets" },
  ],
  [
    { brand: "google-slides", label: "Google Slides" },
    { brand: "google-drive", label: "Google Drive" },
    { brand: "google-calendar", label: "Google Calendar" },
  ],
];

export function ConnectionsTile() {
  const theme = usePageTheme();
  const [ref, width] = useSlotWidth();
  return (
    <div ref={ref}>
      <Stage width={width} height={154} theme={theme} className="aio bt-stage">
        {() => (
          <div className="bt-marks">
            {MARKS.map((row, i) => (
              <div key={i} className="bt-marks-row">
                {row.map((m) => (
                  <span key={m.label} className="bt-mark">
                    <BrandMark brand={m.brand} size={28} />
                    <Text>{m.label}</Text>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </Stage>
    </div>
  );
}
