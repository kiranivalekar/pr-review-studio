import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/Button";
import { useScrolled } from "../lib/useMotion";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#modes", label: "Review modes" },
];

// Landing-page nav. Starts transparent over the hero and frosts itself once the
// page scrolls, so the hero reads full-bleed on arrival.
export function TopNav() {
  const scrolled = useScrolled(16);

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <nav
        className={`flex w-full max-w-6xl items-center gap-3 rounded-2xl px-3 py-2.5 transition-all duration-500 ${
          scrolled ? "glass shadow-[var(--shadow-card)]" : "border border-transparent bg-transparent"
        }`}
      >
        <BrandMark size="sm" />

        <ul className="ml-4 hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              {/* Underline grows from the left on hover instead of blinking on. */}
              <a
                href={link.href}
                className="relative rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors duration-300 after:absolute after:inset-x-3 after:bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-brand after:transition-transform after:duration-300 hover:text-ink hover:after:scale-x-100"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle compact />
          <Link to="/prs">
            <Button variant="primary">
              Open queue
              <ArrowRight
                size={15}
                className="transition-transform duration-300 group-hover:translate-x-0.5"
              />
            </Button>
          </Link>
        </div>
      </nav>
    </header>
  );
}
