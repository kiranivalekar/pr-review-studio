import { useCallback, useEffect, useRef, useState } from "react";

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

// Counts from 0 to `value` on an eased curve. Re-runs whenever the target
// changes, so a stat that loads late animates in instead of snapping.
export function useCountUp(value, { duration = 1100 } = {}) {
  const [display, setDisplay] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    const target = Number(value) || 0;
    if (target === 0 || prefersReducedMotion()) {
      setDisplay(target);
      return;
    }

    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      // easeOutExpo — fast out of the gate, settles precisely on the number.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplay(Math.round(target * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, duration]);

  return display;
}

// Cycles through `words`, typing and deleting one character at a time. Under
// reduced motion it holds the first word instead of animating.
export function useTypewriter(words, { typeMs = 62, deleteMs = 32, holdMs = 1700 } = {}) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState(words[0] ?? "");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion() || words.length <= 1) return;

    const word = words[index % words.length];

    if (!deleting && text === word) {
      const id = setTimeout(() => setDeleting(true), holdMs);
      return () => clearTimeout(id);
    }
    if (deleting && text === "") {
      setDeleting(false);
      setIndex((i) => (i + 1) % words.length);
      return;
    }

    const id = setTimeout(
      () => setText(deleting ? word.slice(0, text.length - 1) : word.slice(0, text.length + 1)),
      deleting ? deleteMs : typeMs
    );
    return () => clearTimeout(id);
  }, [text, deleting, index, words, typeMs, deleteMs, holdMs]);

  return text;
}

// Feeds the pointer position into `--mx`/`--my` for the `.spotlight` effect.
// Writes straight to the style attribute — going through React state here would
// re-render the card on every mousemove.
export function useSpotlight() {
  const ref = useRef(null);

  const onMouseMove = useCallback((event) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    el.style.setProperty("--my", `${event.clientY - rect.top}px`);
  }, []);

  return { ref, onMouseMove };
}

// True once the window has scrolled past `offset` — drives the nav's shrink /
// frost transition.
export function useScrolled(offset = 12) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > offset);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [offset]);

  return scrolled;
}
