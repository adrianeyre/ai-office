// Floor Templates: a grid of one thing, one in focus. A still, copied from
// the Stageshow skill's `many-of-one` gold: the same card at the same size
// running off every edge, the focus card brought forward by depth and the
// only one with words. Each card carries its template's own icon, as the
// app's template picker does (the `icon` in each templates/*/template.yaml).
//
// Real strings: the Local template's name, its AI Provider, one line and
// its Roles.
import {
  BookOpen,
  ChartColumn,
  Code,
  Cpu,
  Megaphone,
  Palette,
  PenLine,
  Server,
  ShoppingBag,
  Smartphone,
  Square,
  type LucideIcon,
} from "lucide-react";
import { Badge, Bar, Stage, Text } from "../stageshow/kit";
import { usePageTheme } from "./theme";
import "./templates.css";

const COLS = 5;
const ROWS = 3;
const FOCUS = { col: 2, row: 1 };

/** The other templates' icons, in the grid's reading order. */
const ICONS: LucideIcon[] = [
  Code,
  ShoppingBag,
  Megaphone,
  PenLine,
  BookOpen,
  Palette,
  ChartColumn,
  Server,
  Smartphone,
  Square,
];

const WIDTHS = [
  [84, 120],
  [70, 104],
  [96, 128],
  [62, 96],
  [78, 116],
];

export default function TemplatesDemo() {
  const theme = usePageTheme();
  return (
    <Stage
      width={640}
      height={380}
      compact={{ below: 600, width: 358, height: 380 }}
      theme={theme}
      className="aio ft"
    >
      {() => (
        <div className="ft-grid">
          {Array.from({ length: ROWS * COLS }, (_, i) => {
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            if (col === FOCUS.col && row === FOCUS.row) {
              return (
                <div key={i} className="ft-card" data-focus>
                  <div className="ft-top">
                    <span className="ft-icon">
                      <Cpu size={18} strokeWidth={2} />
                    </span>
                    <Badge tone="accent">Ollama</Badge>
                  </div>
                  <Text className="ft-name">Local</Text>
                  <Text className="ft-line">Agents on models you run</Text>
                  <div className="ft-roles">
                    {["coder", "reviewer", "QA"].map((role) => (
                      <span key={role} className="ft-role">
                        {role}
                      </span>
                    ))}
                  </div>
                </div>
              );
            }
            const Icon = ICONS[i % ICONS.length] ?? Square;
            const [name, line] = WIDTHS[(i * 3) % WIDTHS.length] ?? [80, 110];
            return (
              <div key={i} className="ft-card">
                <div className="ft-top">
                  <span className="ft-icon">
                    <Icon size={18} strokeWidth={2} />
                  </span>
                </div>
                <Bar w={name} h={8} r={4} tone={3} />
                <Bar w={line} h={6} r={3} tone={2} />
                <div className="ft-roles">
                  <Bar w={40} h={18} r={9} tone={1} />
                  <Bar w={48} h={18} r={9} tone={1} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Stage>
  );
}
