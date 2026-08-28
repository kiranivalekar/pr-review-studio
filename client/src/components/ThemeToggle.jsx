import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../lib/useTheme";

const CYCLE = ["system", "light", "dark"];
const ICONS = { system: Monitor, light: Sun, dark: Moon };
const LABELS = { system: "System", light: "Light", dark: "Dark" };

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const Icon = ICONS[theme];

  const cycleTheme = () => {
    const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={`Theme: ${LABELS[theme]} (click to change)`}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
    >
      <Icon size={16} strokeWidth={2} />
      {LABELS[theme]}
    </button>
  );
}
