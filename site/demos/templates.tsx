// Floor Templates: a grid of one thing, one in focus. A still, copied from
// the Stageshow skill's `many-of-one` gold: the same card at the same size
// running off every edge, the focus card brought forward by depth and the
// only one with words. Each card carries its template's own icon, as the
// app's template picker does (the `icon` in each templates/*/template.yaml).
//
// Real strings: every built-in template's name, and the Local template's
// AI Provider, one line and its Roles.
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
import { Badge, Stage, Text } from "../stageshow/kit";
import { usePageTheme } from "./theme";
import "./templates.css";

const COLS = 5;
const ROWS = 3;
const FOCUS = { col: 2, row: 1 };

/** The other built-in templates, in the grid's reading order, with icons. */
const TEMPLATES: { name: string; icon: LucideIcon }[] = [
  { name: "Development", icon: Code },
  { name: "Online store", icon: ShoppingBag },
  { name: "Website & marketing", icon: Megaphone },
  { name: "Content & blog", icon: PenLine },
  { name: "Documentation", icon: BookOpen },
  { name: "Design system", icon: Palette },
  { name: "Data & analytics", icon: ChartColumn },
  { name: "Infrastructure", icon: Server },
  { name: "Mobile app", icon: Smartphone },
  { name: "Blank", icon: Square },
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
            const template = TEMPLATES[i % TEMPLATES.length];
            const Icon = template.icon;
            return (
              <div key={i} className="ft-card">
                <div className="ft-top">
                  <span className="ft-icon">
                    <Icon size={18} strokeWidth={2} />
                  </span>
                </div>
                <Text className="ft-name ft-name-other">{template.name}</Text>
              </div>
            );
          })}
        </div>
      )}
    </Stage>
  );
}
