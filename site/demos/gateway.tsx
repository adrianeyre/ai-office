// The AI Gateway: Agents' model calls spread across the Owner's AI
// Accounts. A system story with no cursor, copied from the Stageshow
// skill's `subscriptions` gold: a window with a satellite card straddling
// its sidebar, rows opening at the top of a list and a value rolling on the
// row the story is about. It plays once, as it scrolls into view, and holds
// its payoff.
//
// Beats, about 9 seconds:
// 1. Ada's call goes to Claude · Work; its 5-hour usage rolls up.
// 2. Rex's call goes to ChatGPT · Pro.
// 3. Ada's next call takes Claude · Work past its pause threshold: Paused.
// 4. Payoff: Ada's next call is served by Claude · Personal instead, and
//    holds there.
//
// Real strings: the page's title, each request's Agent, Model, AI Account
// and tokens, and the satellite's three AI Accounts and their usage.
import {
  Avatar,
  Badge,
  Bar,
  Collapse,
  Count,
  Meter,
  Stage,
  States,
  Text,
  Window,
  type Act,
} from "../stageshow/kit";
import { usePageTheme } from "./theme";
import "./gateway.css";

interface Request {
  agent: string;
  model: string;
  account: string;
  tokens: string;
}

const REQUESTS: Request[] = [
  {
    agent: "Ada",
    model: "claude-opus-5-5",
    account: "Claude · Work",
    tokens: "18,204",
  },
  { agent: "Rex", model: "gpt-5.5", account: "ChatGPT · Pro", tokens: "9,870" },
  {
    agent: "Ada",
    model: "claude-opus-5-5",
    account: "Claude · Work",
    tokens: "21,530",
  },
  {
    agent: "Ada",
    model: "claude-opus-5-5",
    account: "Claude · Personal",
    tokens: "17,962",
  },
];

interface S {
  /** How many of REQUESTS have arrived, newest at the top. */
  arrived: number;
  /** Each AI Account's 5-hour usage, in per cent. */
  work: number;
  personal: number;
  pro: number;
}

const START: S = { arrived: 0, work: 84, personal: 31, pro: 12 };
const POSTER: S = { arrived: 4, work: 91, personal: 34, pro: 14 };

async function script(a: Act<S>): Promise<void> {
  await a.wait(800);
  a.mark("first");
  await a.set({ arrived: 1 });
  await a.wait(500);
  await a.set({ work: 88 });
  await a.wait(1300);
  await a.set({ arrived: 2 });
  await a.wait(500);
  await a.set({ pro: 14 });
  await a.wait(1300);
  a.mark("paused");
  await a.set({ arrived: 3 });
  await a.wait(500);
  await a.set({ work: 91 });
  await a.wait(1500);
  a.mark("payoff");
  await a.set({ arrived: 4 });
  await a.wait(500);
  await a.set({ personal: 34 });
  await a.wait(2500);
}

const percent = (n: number): string => `${String(Math.round(n))}%`;

/** Earlier requests, already in the table before the story. */
const EARLIER = [
  [30, 88, 74, 40],
  [24, 70, 84, 36],
  [32, 88, 64, 42],
  [26, 70, 80, 34],
];

function Requests({ s }: { s: S }) {
  return (
    <div className="gw-table">
      <div className="gw-row gw-row--head">
        <span>Agent</span>
        <span>Model</span>
        <span>AI Account</span>
        <span className="gw-num">Tokens</span>
      </div>
      {/* Newest first: each request opens at the top and carries the rest */}
      {REQUESTS.map((r, i) => ({ r, i }))
        .reverse()
        .map(({ r, i }) => (
          <Collapse key={i} open={s.arrived > i} reveal="clip">
            <div
              className="gw-row"
              data-target={`req-${String(i)}`}
              data-fallback={i === 3 || undefined}
            >
              <span className="gw-agent">
                <Avatar name={r.agent} size={20} />
                <Text>{r.agent}</Text>
              </span>
              <Text className="gw-model">{r.model}</Text>
              <Text className="gw-account">{r.account}</Text>
              <Text className="gw-num">{r.tokens}</Text>
            </div>
          </Collapse>
        ))}
      {EARLIER.map(([agent, model, account, tokens], i) => (
        <div key={`earlier-${String(i)}`} className="gw-row gw-row--filler">
          <span className="gw-agent">
            <Bar w={20} h={20} r={10} tone={2} />
            <Bar w={agent} h={6} tone={3} />
          </span>
          <Bar w={model} h={6} tone={2} />
          <Bar w={account} h={6} tone={2} />
          <Bar w={tokens} h={6} tone={2} className="gw-num" />
        </div>
      ))}
    </div>
  );
}

function Accounts({ s }: { s: S }) {
  const paused = s.work >= 90;
  const rows = [
    {
      name: "Claude · Work",
      value: s.work,
      status: (
        <States
          align="end"
          value={paused ? "paused" : "active"}
          states={{
            active: <Badge tone="success">Active</Badge>,
            paused: <Badge tone="warning">Paused at 90%</Badge>,
          }}
        />
      ),
      tone: paused ? ("warning" as const) : ("accent" as const),
    },
    {
      name: "Claude · Personal",
      value: s.personal,
      status: <Badge tone="success">Active</Badge>,
      tone: "accent" as const,
    },
    {
      name: "ChatGPT · Pro",
      value: s.pro,
      status: <Badge tone="success">Active</Badge>,
      tone: "accent" as const,
    },
  ];
  return (
    <section className="gw-accounts">
      <div className="gw-accounts-head">
        <Text className="gw-strong">AI Accounts</Text>
        <Text className="gw-muted">5-hour usage</Text>
      </div>
      {rows.map((row) => (
        <div key={row.name} className="gw-account">
          <div className="gw-account-line">
            <Text className="gw-account-name">{row.name}</Text>
            {row.status}
          </div>
          <div className="gw-account-line">
            <Meter
              value={row.value / 100}
              tone={row.tone}
              className="gw-meter"
            />
            <Count className="gw-percent" value={row.value} format={percent} />
          </div>
        </div>
      ))}
    </section>
  );
}

export default function GatewayDemo() {
  const theme = usePageTheme();
  return (
    <Stage<S>
      width={720}
      height={440}
      compact={{ below: 640, width: 358, height: 540 }}
      initial={START}
      poster={POSTER}
      script={script}
      play="once"
      theme={theme}
      className="aio gw"
    >
      {(s, _rect, layout) => (
        <>
          <div className="aio-fade gw-fade">
            <Window url="localhost:3045/gateway" className="gw-window">
              <div className="gw-app">
                {layout === "wide" && (
                  <div className="gw-side">
                    {[52, 64, 44, 58, 48].map((w, i) => (
                      <span
                        key={i}
                        className="gw-nav"
                        data-on={i === 2 || undefined}
                      >
                        <Bar w={12} h={12} r={3} tone={i === 2 ? 4 : 2} />
                        <Bar w={w} h={6} tone={i === 2 ? 4 : 2} />
                      </span>
                    ))}
                  </div>
                )}
                <div className="gw-main">
                  <div className="gw-head">
                    <Text className="gw-title">Gateway requests</Text>
                    <Bar w={72} h={24} r={8} tone={2} />
                  </div>
                  <Requests s={s} />
                </div>
              </div>
            </Window>
          </div>
          <Accounts s={s} />
        </>
      )}
    </Stage>
  );
}
