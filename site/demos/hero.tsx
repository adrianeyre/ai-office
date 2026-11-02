// The hero: one issue, from the queue to merged, on a Floor. A system
// story with no cursor, copied from the Stageshow skill's `hero-demo` gold
// (its pinned window in a quiet well and a terminal coming forward) with
// the motion of `subscriptions` (a value that changes on its own row).
//
// Beats, about 14 seconds:
// 1. An issue labelled `ai-office` lands at the top of the Floor's queue.
// 2. The Manager triages it: `needs-work`, and Ada, the coder, takes it.
// 3. Ada's live view comes forward: she reads, edits, tests and opens the
//    pull request, then the view goes back.
// 4. `needs-review` (Rex reviews it), then `needs-qa` (Quinn checks it).
// 5. Payoff: Merged, and a Notice says so. It holds, then the merged issue
//    leaves the queue, which is the reset.
//
// Real strings: the Floor, the issue, its label, who has it, the live
// view's four lines and the Notice. Everything else is filler.
import { GitMerge } from "lucide-react";
import {
  Avatar,
  Bar,
  Collapse,
  Stage,
  States,
  Text,
  Toast,
  Window,
  type Act,
  type Layout,
} from "../stageshow/kit";
import icon from "../../apps/web/src/brand/icon.svg";
import { usePageTheme } from "./theme";
import "./hero.css";

type Step = "queued" | "work" | "review" | "qa" | "merged";

interface S {
  /** The issue is in the queue. */
  queued: boolean;
  step: Step;
  /** The live view is in front, and how many of its lines have run. */
  live: boolean;
  lines: number;
  notice: boolean;
}

const START: S = {
  queued: false,
  step: "queued",
  live: false,
  lines: 0,
  notice: false,
};
const POSTER: S = { ...START, queued: true, step: "merged", notice: true };

const LABELS: Record<Step, { text: string; tone: string }> = {
  queued: { text: "ai-office", tone: "neutral" },
  work: { text: "needs-work", tone: "warning" },
  review: { text: "needs-review", tone: "info" },
  qa: { text: "needs-qa", tone: "violet" },
  merged: { text: "Merged", tone: "accent" },
};

const WHO: Record<Step, { name: string; line: string }> = {
  queued: { name: "", line: "The Manager is triaging it" },
  work: { name: "Ada", line: "Ada, coder, is working on it" },
  review: { name: "Rex", line: "PR #43 · Rex, reviewer, is reviewing it" },
  qa: { name: "Quinn", line: "PR #43 · Quinn, QA, is checking it" },
  merged: { name: "Ada", line: "PR #43 merged · CI passed" },
};

const LIVE = [
  { mark: "›", text: "Read src/settings/appearance.tsx" },
  { mark: "›", text: "Edit theme-toggle.tsx  +38 −4" },
  { mark: "✓", text: "pnpm test  214 passed" },
  { mark: "✓", text: "Opened pull request #43" },
];

async function script(a: Act<S>): Promise<void> {
  await a.wait(400);
  a.mark("arrive");
  await a.set({ queued: true });
  await a.wait(1300);
  a.mark("work");
  await a.set({ step: "work" });
  await a.wait(900);
  await a.set({ live: true });
  await a.wait(500);
  for (let i = 1; i <= LIVE.length; i++) {
    await a.set({ lines: i });
    await a.wait(i === LIVE.length ? 1100 : 750);
  }
  await a.set({ live: false });
  await a.wait(300);
  a.mark("review");
  await a.set({ step: "review" });
  await a.wait(1700);
  await a.set({ step: "qa" });
  await a.wait(1600);
  a.mark("merged");
  await a.set({ step: "merged" });
  await a.wait(500);
  await a.set({ notice: true });
  await a.wait(2600);
  // The merged issue leaves the queue and the Notice goes with it; the
  // live view's lines are cleared while it is out of sight.
  await a.set({ queued: false, notice: false });
  await a.wait(700);
  await a.snap({ step: "queued", lines: 0 });
}

/** Filler issues already in the queue, below the one the story is about. */
const QUEUE = [
  { title: 168, line: 104, label: 62 },
  { title: 136, line: 120, label: 70 },
  { title: 184, line: 92, label: 58 },
  { title: 150, line: 112, label: 66 },
  { title: 128, line: 98, label: 60 },
  { title: 172, line: 116, label: 70 },
];

function Issue({ s, layout }: { s: S; layout: Layout }) {
  return (
    <Collapse open={s.queued} reveal="clip">
      <div className="hero-issue" data-target="issue">
        <span className="hero-lead">
          <States
            value={s.step === "queued" ? "none" : WHO[s.step].name}
            states={{
              none: <Bar w={28} h={28} r={14} tone={2} />,
              Ada: <Avatar name="Ada" size={28} />,
              Rex: <Avatar name="Rex" size={28} />,
              Quinn: <Avatar name="Quinn" size={28} />,
            }}
          />
        </span>
        <span className="hero-issue-text">
          <span className="hero-issue-title">
            <span className="hero-number">#42</span> Add a dark mode toggle
          </span>
          <States
            className="hero-issue-line"
            align="start"
            value={s.step}
            states={{
              queued: WHO.queued.line,
              work: WHO.work.line,
              review: WHO.review.line,
              qa: WHO.qa.line,
              merged: WHO.merged.line,
            }}
          />
        </span>
        <States
          className="hero-label-slot"
          align={layout === "wide" ? "end" : "start"}
          value={s.step}
          states={{
            queued: <Label step="queued" />,
            work: <Label step="work" />,
            review: <Label step="review" />,
            qa: <Label step="qa" />,
            merged: <Label step="merged" />,
          }}
        />
      </div>
    </Collapse>
  );
}

function Label({ step }: { step: Step }) {
  const { text, tone } = LABELS[step];
  return (
    <span className="aio-label" data-tone={tone}>
      {step === "merged" && <GitMerge size={12} strokeWidth={2.25} />}
      {text}
    </span>
  );
}

export default function HeroDemo() {
  const theme = usePageTheme();
  return (
    <Stage<S>
      width={720}
      height={430}
      compact={{ below: 640, width: 358, height: 340 }}
      initial={START}
      poster={POSTER}
      script={script}
      theme={theme}
      className="aio hero-demo"
    >
      {(s, _rect, layout) => (
        <>
          <Window url="localhost:3045" className="hero-window">
            <div className="hero-app">
              {layout === "wide" && (
                <div className="hero-side">
                  <span className="hero-brand">
                    <img src={icon} alt="" width={20} height={20} />
                    <Text className="hero-brand-name">AI Office</Text>
                  </span>
                  {[58, 46, 64, 40].map((w, i) => (
                    <span key={i} className="hero-nav">
                      <Bar w={12} h={12} r={3} tone={2} />
                      <Bar w={w} h={6} tone={2} />
                    </span>
                  ))}
                  <span className="hero-nav" data-on>
                    <Bar w={12} h={12} r={3} tone={4} />
                    <Text className="hero-nav-floor">web-shop</Text>
                  </span>
                </div>
              )}
              <div className="hero-main">
                <div className="hero-head">
                  <Text className="hero-title">
                    {layout === "wide" ? "Issues" : "web-shop"}
                  </Text>
                  <span className="hero-tools">
                    <Bar w={64} h={24} r={8} tone={2} />
                    <Bar w={24} h={24} r={8} tone={2} />
                  </span>
                </div>
                <div className="hero-list">
                  <Issue s={s} layout={layout} />
                  {QUEUE.map((q, i) => (
                    <div key={i} className="hero-issue hero-issue--filler">
                      <Bar w={28} h={28} r={14} tone={1} />
                      <span className="hero-issue-text">
                        <Bar w={q.title} h={7} tone={3} />
                        <Bar w={q.line} h={6} tone={2} />
                      </span>
                      <Bar w={q.label} h={22} r={11} tone={1} />
                    </div>
                  ))}
                </div>
                <Toast
                  className="hero-notice"
                  show={s.notice}
                  icon={<GitMerge size={14} strokeWidth={2} />}
                >
                  Notice: PR #43 merged into main
                </Toast>
              </div>
            </div>
          </Window>

          <Window
            chrome="terminal"
            title="Ada · live view"
            className="hero-live"
            data-show={s.live || undefined}
          >
            <div className="hero-live-body">
              {LIVE.map((line, i) => (
                <Collapse key={line.text} open={s.lines > i} reveal="clip">
                  <div
                    className="hero-live-line"
                    data-ok={line.mark === "✓" || undefined}
                  >
                    <span className="hero-live-mark">{line.mark}</span>
                    {line.text}
                  </div>
                </Collapse>
              ))}
            </div>
          </Window>
        </>
      )}
    </Stage>
  );
}
