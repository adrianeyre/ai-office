import { useEffect, useRef } from "react";

/** How long the element is kept in view while the page around it loads. */
const settleMs = 5000;

/** What the Owner does that takes over the scrolling. */
const ownerInput = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * A ref for the element a link names with `#id`: when the address ends
 * with it, the element is brought into view as it is shown, even when it
 * is shown after the page (once its data has loaded). Cards above it may
 * still be loading and push it down, so it is kept in view as the page
 * grows, until the Owner scrolls, types or clicks, or the page has had a
 * moment to settle.
 */
export function useAnchor<T extends HTMLElement>(id: string) {
  const element = useRef<T>(null);
  useEffect(() => {
    const target = element.current;
    if (target === null || window.location.hash !== `#${id}`) {
      return;
    }
    const bring = () => {
      target.scrollIntoView({ block: "start" });
    };
    bring();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(bring);
    observer?.observe(document.body);
    const stop = () => {
      observer?.disconnect();
      clearTimeout(timer);
      for (const type of ownerInput) {
        window.removeEventListener(type, stop);
      }
    };
    const timer = setTimeout(stop, settleMs);
    for (const type of ownerInput) {
      window.addEventListener(type, stop, { passive: true });
    }
    return stop;
  }, [id]);
  return element;
}
