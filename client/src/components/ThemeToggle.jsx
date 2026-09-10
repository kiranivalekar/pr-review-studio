import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../lib/useTheme";
import { Segmented } from "./ui/Segmented";

const OPTIONS = [
  { value: "system", label: "Auto", icon: Monitor, hint: "Follow the operating system" },
  { value: "light", label: "Light", icon: Sun, hint: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
];

const CYCLE = ["system", "light", "dark"];
const ICONS = { system: Monitor, light: Sun, dark: Moon };
const LABELS = { system: "Auto", light: "Light", dark: "Dark" };

// Two shapes, one state: a segmented control where there's room to show all
// three choices at once, and a single cycling button where there isn't.
export function ThemeToggle({ compact = false }) {
  const [theme, setTheme] = useTheme();

  if (!compact) {
    return (
      <Segmented options={OPTIONS} value={theme} onChange={setTheme} size="sm" className="w-full" />
    );
  }

  const Icon = ICONS[theme];
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABELS[theme]} — switch to ${LABELS[next]}`}
      aria-label={`Theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`}
      className="grid size-9 place-items-center rounded-xl border border-hairline bg-surface/60 text-muted backdrop-blur transition-all duration-300 hover:border-hairline-strong hover:text-ink active:scale-95"
    >
      {/* Keyed on the theme so the icon re-mounts and plays its entrance. */}
      <Icon key={theme} size={16} strokeWidth={2} className="animate-scale-in" />
    </button>
  );
}
