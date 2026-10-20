/**
 * Guard against environment-driven scroll resets.
 */
import type { EditorView } from "@codemirror/view";
import { resizeObservers } from "./registries";

/** Tracked scroll state of one editor container. */
interface ScrollGuardState {
  stable: number;
  allowUntil: number;
  hidden: boolean;
}

const scrollGuards = new WeakMap<HTMLElement, ScrollGuardState>();

/** Let the next programmatic scroll through the reset guard. */
export function allowScrollChange(container: HTMLElement, stable?: number) {
  const guard = scrollGuards.get(container);
  if (guard) {
    guard.allowUntil = Date.now() + 500;
    if (typeof stable === "number") {
      guard.stable = stable;
    }
  }
}

/**
 * The environment occasionally resets the scroll to 0 behind CodeMirror's
 * back; restore the last stable position unless a user gesture explains it.
 */
export function guardScrollReset(container: HTMLElement, view: EditorView) {
  const guard: ScrollGuardState = {
    stable: 0,
    allowUntil: 0,
    hidden: view.scrollDOM.offsetHeight === 0,
  };
  scrollGuards.set(container, guard);

  const markUser = () => {
    guard.allowUntil = Date.now() + 800;
  };
  for (const type of ["wheel", "touchstart", "mousedown", "keydown"]) {
    view.scrollDOM.addEventListener(type, markUser, { passive: true });
  }

  view.scrollDOM.addEventListener(
    "scroll",
    () => {
      if (guard.hidden || view.scrollDOM.offsetHeight === 0) {
        return;
      }
      const top = view.scrollDOM.scrollTop;
      const allowed = Date.now() <= guard.allowUntil;
      if (top <= 1 && guard.stable > 100 && !allowed) {
        // Unexpected jump to the top; restore the last stable position.
        view.scrollDOM.scrollTop = guard.stable;
        return;
      }
      if (allowed) {
        // One-shot: covers the intended scroll only, so a stray reset right
        // after is still caught; user gestures re-arm on every event.
        guard.allowUntil = 0;
      }
      guard.stable = top;
    },
    { passive: true },
  );

  const observer = new ResizeObserver(() => {
    if (view.scrollDOM.offsetHeight === 0) {
      guard.hidden = true;
    } else if (guard.hidden) {
      guard.hidden = false;
      if (
        guard.stable > 0 &&
        Math.abs(view.scrollDOM.scrollTop - guard.stable) > 1
      ) {
        view.scrollDOM.scrollTop = guard.stable;
      }
    }
  });
  observer.observe(view.scrollDOM);
  resizeObservers.set(container, observer);
}
