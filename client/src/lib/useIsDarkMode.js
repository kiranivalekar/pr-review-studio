import { useEffect, useState } from "react";

// useTheme() toggles a "dark" class on <html> (see useTheme.js) — watch that class
// directly rather than threading theme state through every markdown-rendering
// component, since react-syntax-highlighter needs a real JS boolean, not a CSS variant.
export function useIsDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
