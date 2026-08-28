import { useLayoutEffect, useRef } from "react";

export function Textarea({ className = "", value, ...props }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea ref={ref} value={value} className={`resize-none overflow-hidden ${className}`} {...props} />
  );
}
