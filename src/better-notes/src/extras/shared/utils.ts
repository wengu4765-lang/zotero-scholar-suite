/**
 * Small helpers shared across the content-side bundles.
 */

/**
 * Try an operation now and once more next tick if it throws (e.g. CodeMirror
 * rejects updates mid-cycle); the op must re-read state so the retry is fresh.
 */
export function tryOrRetryNextTick(op: () => void) {
  try {
    op();
  } catch (e) {
    setTimeout(() => {
      try {
        op();
      } catch (err) {
        console.error(err);
      }
    }, 0);
  }
}
