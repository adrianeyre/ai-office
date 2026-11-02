// The Manager chat: the Owner hands a Floor's Manager a Batch, and it
// answers with a Plan to approve. Copied from the Stageshow skill's
// `ai-chat` gold (the question sent, Thinking, the answer streaming in with
// its height), with the card answered from its own button as in `ai-cards`.
// It plays once, as it scrolls into view, and holds its payoff.
//
// Beats, about 10 seconds:
// 1. "complete issues 1 to 5" is typed and sent.
// 2. Thinking, then the Manager's reply streams in.
// 3. The Plan arrives under it: the order and who takes what.
// 4. Payoff: the cursor approves it, and the button confirms on itself.
//
// Real strings: the Floor, the command, the reply, three of the Plan's
// rows and its button.
import { Check } from "lucide-react";
import {
  Avatar,
  Bar,
  Collapse,
  Field,
  Stage,
  States,
  Stream,
  Text,
  Window,
  type Act,
} from "../stageshow/kit";
import { usePageTheme } from "./theme";
import "./chat.css";

const ASK = "complete issues 1 to 5";
const REPLY =
  "Here is the Plan for this Batch. #3 needs the schema from #1, so it waits for it; the rest run side by side. Approve it and I'll call the Kickoff.";
const WORDS = REPLY.split(" ").length;

const PLAN = [
  { issue: "#1", title: "Product schema", agent: "Ada" },
  { issue: "#2", title: "Search filters", agent: "Ben" },
  { issue: "#3", title: "Import from CSV", agent: "Ada", after: "after #1" },
];

interface S {
  draft: string;
  sent: boolean;
  phase: "idle" | "thinking" | "answer";
  words: number;
  plan: boolean;
  approved: boolean;
}

const START: S = {
  draft: "",
  sent: false,
  phase: "idle",
  words: 0,
  plan: false,
  approved: false,
};
const POSTER: S = {
  draft: "",
  sent: true,
  phase: "answer",
  words: WORDS,
  plan: true,
  approved: true,
};

async function script(a: Act<S>): Promise<void> {
  await a.wait(700);
  a.mark("type");
  await a.type("draft", ASK, { interval: 45 });
  await a.wait(350);
  a.mark("send");
  a.put({ sent: true, draft: "" });
  await a.wait(450);
  a.put({ phase: "thinking" });
  await a.wait(1000);
  a.mark("stream");
  a.put({ phase: "answer" });
  for (let i = 1; i <= WORDS; i++) {
    a.put({ words: i });
    await a.wait(45);
  }
  await a.wait(300);
  a.mark("plan");
  await a.set({ plan: true });
  await a.wait(900);
  await a.move({ at: "approve", x: 0.93, y: 0.78 });
  await a.wait(250);
  await a.click();
  await a.set({ approved: true });
  a.mark("approved");
  await a.move("rest");
  await a.wait(2400);
}

function Plan({ s }: { s: S }) {
  return (
    <div className="mc-plan">
      <div className="mc-plan-head">
        <Text className="mc-strong">Plan</Text>
        <Text className="mc-muted">5 issues</Text>
      </div>
      {PLAN.map((row) => (
        <div key={row.issue} className="mc-plan-row">
          <Text className="mc-issue">{row.issue}</Text>
          <Text className="mc-plan-title">{row.title}</Text>
          {row.after !== undefined && (
            <span className="mc-after">{row.after}</span>
          )}
          <span className="mc-who">
            <Avatar name={row.agent} size={18} />
            <Text>{row.agent}</Text>
          </span>
        </div>
      ))}
      <div className="mc-plan-row mc-plan-row--filler">
        <Bar w={18} h={6} tone={3} />
        <Bar w={104} h={6} tone={2} />
        <span className="mc-who">
          <Bar w={18} h={18} r={9} tone={2} />
          <Bar w={28} h={6} tone={2} />
        </span>
      </div>
      <div className="mc-actions">
        <span
          className="mc-button"
          data-target="approve"
          data-on={s.approved || undefined}
        >
          <States
            value={s.approved ? "done" : "ask"}
            states={{
              ask: "Approve plan",
              done: (
                <span className="mc-done">
                  <Check size={14} strokeWidth={2.5} /> Approved
                </span>
              ),
            }}
          />
        </span>
      </div>
    </div>
  );
}

export default function ChatDemo() {
  const theme = usePageTheme();
  return (
    <Stage<S>
      width={640}
      height={540}
      compact={{ below: 600, width: 358, height: 600 }}
      initial={START}
      poster={POSTER}
      script={script}
      play="once"
      theme={theme}
      cursor={{ at: "rest" }}
      className="aio mc"
    >
      {(s) => (
        <>
          <div className="aio-fade mc-fade">
            <Window title="web-shop · Manager" className="mc-win">
              <div className="mc-body">
                <div className="mc-thread">
                  <div
                    className="mc-turn--past"
                    data-gone={s.plan || undefined}
                  >
                    <Bar w={150} h={30} r={15} tone={1} className="mc-past-q" />
                    <Bar w="78%" h={8} r={4} tone={2} />
                  </div>
                  <Collapse open={s.sent} reveal="drop" from="below">
                    <div className="mc-q">
                      <Text>{ASK}</Text>
                    </div>
                  </Collapse>
                  <Collapse open={s.phase === "thinking"}>
                    <Text className="mc-thinking">Thinking</Text>
                  </Collapse>
                  <Collapse open={s.phase === "answer"}>
                    <div className="mc-a">
                      <Stream
                        className="mc-stream"
                        text={REPLY}
                        count={s.words}
                      />
                    </div>
                  </Collapse>
                  <Collapse open={s.plan} reveal="drop">
                    <Plan s={s} />
                  </Collapse>
                </div>
                <Field
                  className="mc-composer"
                  value={s.draft}
                  placeholder="Message the Manager"
                  focused={!s.sent}
                />
              </div>
            </Window>
          </div>
          <span className="mc-rest" data-target="rest" />
        </>
      )}
    </Stage>
  );
}
