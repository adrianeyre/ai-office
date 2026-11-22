// The hero: the web-shop Floor's planning wall. Issue cards walk the
// Stages, needs-work → needs-review → needs-qa → needs-docs →
// ready-to-merge, one move at a time; at ready-to-merge a card is stamped
// merged, a Notice says so, and it comes down while the next issue is
// pinned up in needs-work.
//
// A picture, like every demo: its slot is aria-hidden and its figcaption
// says what it shows. The page's "Pause the wall" button (outside the
// slot, so it can take focus) stops and restarts it (WCAG 2.2.2); with
// reduced motion it never moves. It also rests while it is off screen or
// the tab is hidden.
//
// The issues and the Agents' names are demonstration data on the
// demonstration Floor the other demos use.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Bell, Check } from "lucide-react";
import "./wall.css";

/** Whether the viewer asked for reduced motion: then the wall stays still. */
const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The Stages' columns, left to right, with the Agent who has a card there. */
const COLUMNS = [
  { label: "needs-work", stage: "work", agent: "Ada", role: "coder" },
  { label: "needs-review", stage: "review", agent: "Rex", role: "reviewer" },
  { label: "needs-qa", stage: "qa", agent: "Quinn", role: "QA" },
  { label: "needs-docs", stage: "docs", agent: "Iris", role: "docs" },
  { label: "ready-to-merge", stage: "ok", agent: "", role: "" },
] as const;

const LAST = COLUMNS.length - 1;
/** Cards a column holds at once. */
const SLOTS = 3;

/** The issues pinned up, in turn; the wall takes them round and round. */
const ISSUES = [
  { number: 42, title: "Add a dark mode toggle" },
  { number: 44, title: "Basket total ignores discounts" },
  { number: 45, title: "Paginate the orders page" },
  { number: 47, title: "Document the returns API" },
  { number: 48, title: "Alt text on product images" },
  { number: 50, title: "Import products from CSV" },
  { number: 51, title: "Retry failed webhooks" },
  { number: 53, title: "Email receipt template" },
  { number: 55, title: "Search suggestions as you type" },
  { number: 56, title: "Alert when stock runs low" },
  { number: 58, title: "Shipping rates for the EU" },
  { number: 59, title: "Fix the flaky checkout test" },
] as const;

interface Ticket {
  /** Unique on the wall, across laps. */
  key: number;
  issue: (typeof ISSUES)[number];
  col: number;
  /** When it reached its column, so the column keeps its order. */
  since: number;
  stamped: boolean;
  leaving: boolean;
}

interface Wall {
  tickets: Ticket[];
  next: number;
  clock: number;
  notice: string;
}

/** The wall as the page first shows it, and as reduced motion keeps it. */
function opening(): Wall {
  const cols = [4, 3, 3, 2, 1, 1, 0, 0];
  const tickets = cols.map((col, index) => ({
    key: index,
    issue: ISSUES[index % ISSUES.length],
    col,
    since: index,
    stamped: col === LAST,
    leaving: false,
  }));
  return {
    tickets,
    next: cols.length,
    clock: cols.length,
    notice: `PR #${String(ISSUES[0].number + 1)} merged by the App · CI passed`,
  };
}

const inColumn = (wall: Wall, col: number) =>
  wall.tickets.filter((t) => t.col === col && !t.leaving);

/** One move on the wall: the next thing that would happen on a Floor. */
function step(wall: Wall): Wall {
  const clock = wall.clock + 1;

  // A card that came down is taken off the wall.
  if (wall.tickets.some((t) => t.leaving)) {
    return {
      ...wall,
      clock,
      tickets: wall.tickets.filter((t) => !t.leaving),
    };
  }

  // A stamped card comes down.
  const stamped = wall.tickets.find((t) => t.stamped);
  if (stamped !== undefined) {
    return {
      ...wall,
      clock,
      tickets: wall.tickets.map((t) =>
        t === stamped ? { ...t, leaving: true } : t,
      ),
    };
  }

  // A card at ready-to-merge is merged.
  const ready = inColumn(wall, LAST)
    .sort((a, b) => a.since - b.since)
    .at(0);
  if (ready !== undefined) {
    return {
      ...wall,
      clock,
      notice: `PR #${String(ready.issue.number + 1)} merged by the App · CI passed`,
      tickets: wall.tickets.map((t) =>
        t === ready ? { ...t, stamped: true } : t,
      ),
    };
  }

  // The furthest card that can move on, moves on.
  for (let col = LAST - 1; col >= 0; col -= 1) {
    if (inColumn(wall, col + 1).length >= SLOTS) continue;
    const mover = inColumn(wall, col)
      .sort((a, b) => a.since - b.since)
      .at(0);
    if (mover !== undefined) {
      return {
        ...wall,
        clock,
        tickets: wall.tickets.map((t) =>
          t === mover ? { ...t, col: col + 1, since: clock } : t,
        ),
      };
    }
  }

  // Room in needs-work: the next issue is pinned up.
  if (inColumn(wall, 0).length < SLOTS) {
    const issue = ISSUES[wall.next % ISSUES.length];
    return {
      ...wall,
      clock,
      next: wall.next + 1,
      tickets: [
        ...wall.tickets,
        {
          key: wall.next,
          issue,
          col: 0,
          since: clock,
          stamped: false,
          leaving: false,
        },
      ],
    };
  }
  return { ...wall, clock };
}

/** Each card's slot in its column, oldest at the top. */
function slots(tickets: readonly Ticket[]): Map<number, number> {
  const result = new Map<number, number>();
  for (let col = 0; col <= LAST; col += 1) {
    tickets
      .filter((t) => t.col === col)
      .sort((a, b) => a.since - b.since)
      .forEach((t, index) => result.set(t.key, Math.min(index, SLOTS - 1)));
  }
  return result;
}

/** A card's slight lean on the wall, the same for it every lap. */
const tilt = (key: number) => ((key * 37) % 7) / 5 - 0.6;

const TICK_MS = 1500;

export default function WallDemo() {
  const [wall, setWall] = useState(opening);
  const [running, setRunning] = useState(() => !prefersReducedMotion());
  const [visible, setVisible] = useState(true);
  const root = useRef<HTMLDivElement>(null);

  // The page's button outside the picture pauses it.
  useEffect(() => {
    const button =
      document.querySelector<HTMLButtonElement>("[data-wall-toggle]");
    if (button === null) return;
    button.hidden = prefersReducedMotion();
    const label = button.querySelector("span");
    const use = button.querySelector("use");
    button.setAttribute("aria-pressed", String(!running));
    if (label !== null) {
      label.textContent = running ? "Pause the wall" : "Play the wall";
    }
    use?.setAttribute("href", running ? "#i-pause" : "#i-play");
    const toggle = () => {
      setRunning((value) => !value);
    };
    button.addEventListener("click", toggle);
    return () => {
      button.removeEventListener("click", toggle);
    };
  }, [running]);

  // Rest while off screen.
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.at(-1)?.isIntersecting ?? true);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!running || !visible) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setWall(step);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, visible]);

  const slotOf = slots(wall.tickets);

  return (
    <div className="wl" ref={root} data-running={running ? "" : undefined}>
      <div className="wl-lanes">
        {COLUMNS.map((column, col) => (
          <div
            key={column.label}
            className="wl-head"
            style={{ "--col": col } as CSSProperties}
            data-stage={column.stage}
          >
            <span className="wl-dot" />
            {column.label}
          </div>
        ))}
        {wall.tickets.map((ticket) => {
          const column = COLUMNS[ticket.col];
          return (
            <div
              key={ticket.key}
              className="wl-card"
              data-leaving={ticket.leaving ? "" : undefined}
              data-stage={column.stage}
              style={
                {
                  "--col": ticket.col,
                  "--slot": slotOf.get(ticket.key) ?? 0,
                  "--tilt": `${String(tilt(ticket.key))}deg`,
                } as CSSProperties
              }
            >
              <div className="wl-body" key={String(ticket.col)}>
                <p className="wl-number">
                  #{ticket.issue.number}
                  <span className="wl-dot" />
                </p>
                <p className="wl-title">{ticket.issue.title}</p>
                <p className="wl-who">
                  {column.agent === "" ? (
                    <>
                      <Check className="wl-check" aria-hidden="true" />
                      CI passed
                    </>
                  ) : (
                    <>
                      <span className="wl-avatar">{column.agent[0]}</span>
                      {column.agent}
                    </>
                  )}
                </p>
                {ticket.stamped && <span className="wl-stamp">Merged</span>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="wl-notice" key={wall.notice}>
        <Bell className="wl-bell" aria-hidden="true" />
        <span className="wl-notice-kind">Notice</span>
        <span className="wl-notice-text">{wall.notice}</span>
      </p>
      <p className="wl-caption">Sample Floor: web-shop, with sample issues</p>
    </div>
  );
}
