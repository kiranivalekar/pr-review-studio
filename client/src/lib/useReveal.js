import { useEffect, useRef } from "react";

// Adds the `in` class to `.reveal` descendants (and to the element itself) the
// first time they scroll into view, then stops observing them — a reveal is a
// one-shot entrance, not a scroll-linked effect, so re-animating on scroll-up
// would just look twitchy.
export function useReveal({ threshold = 0.14, rootMargin = "0px 0px -8% 0px" } = {}) {
  const ref = useRef(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const targets = [root, ...root.querySelectorAll(".reveal")].filter((el) =>
      el.classList.contains("reveal")
    );
    if (targets.length === 0) return;

    // No IntersectionObserver (or motion turned off): show everything immediately
    // rather than leaving content stuck at opacity 0.
    if (typeof IntersectionObserver === "undefined") {
      targets.forEach((el) => el.classList.add("in"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      },
      { threshold, rootMargin }
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  return ref;
}
