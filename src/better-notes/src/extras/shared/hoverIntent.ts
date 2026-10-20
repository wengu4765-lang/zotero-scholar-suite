/**
 * Hover-intent timing shared by the preview popups: open after a dwell,
 * close shortly after leaving unless the popup itself is hovered.
 */

export interface HoverIntentHost<T> {
  /** Open the popup for the dwelled-on target. */
  open(target: T): void;
  /** True while the popup should stay open regardless (e.g. it is hovered). */
  pinned(): boolean;
  /** Close the popup. */
  close(): void;
}

export class HoverIntent<T> {
  private current: T | null = null;

  constructor(
    readonly host: HoverIntentHost<T>,
    readonly openDelay = 300,
    readonly closeDelay = 300,
  ) {}

  /** The currently hovered target, if any. */
  get target() {
    return this.current;
  }

  /** The pointer entered a target; open after the dwell if it stays. */
  hover(target: T) {
    if (this.current === target) {
      return;
    }
    this.current = target;
    setTimeout(() => {
      if (this.current === target) {
        this.host.open(target);
      }
    }, this.openDelay);
  }

  /** Track a target without scheduling an open (key-toggled popups). */
  track(target: T) {
    this.current = target;
  }

  /** The pointer left the current target. */
  unhover() {
    this.current = null;
    this.scheduleClose();
  }

  /** Close soon unless a target is re-hovered or the popup pins it open. */
  scheduleClose() {
    setTimeout(() => {
      if (!this.current && !this.host.pinned()) {
        this.host.close();
      }
    }, this.closeDelay);
  }
}
