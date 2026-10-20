/**
 * Click popup with actions for the Zotero node chips.
 */
import type { EditorView } from "@codemirror/view";
import type { MarkdownEditorCallbacks, ZNodeKind } from "./types";
import { chipData, zNodeField, ZNodeWidget } from "./zNodes";
import { previewManagers, views } from "./registries";
import { tryOrRetryNextTick } from "../shared/utils";

/**
 * Re-locate a chip's source range: the captured position revalidated
 * against the current doc, else the nearest occurrence of the raw text.
 */
function locateChipRange(view: EditorView, from: number, raw: string) {
  if (
    from >= 0 &&
    from + raw.length <= view.state.doc.length &&
    view.state.sliceDoc(from, from + raw.length) === raw
  ) {
    return { from, to: from + raw.length };
  }
  const text = view.state.doc.toString();
  let best = -1;
  for (
    let idx = text.indexOf(raw);
    idx >= 0;
    idx = text.indexOf(raw, idx + 1)
  ) {
    if (best < 0 || Math.abs(idx - from) < Math.abs(best - from)) {
      best = idx;
    }
  }
  return best >= 0 ? { from: best, to: best + raw.length } : null;
}

/**
 * Click popup with actions for a chip, in the note editor's own popup
 * markup and styles; the available actions come from the privileged side.
 */
export class ActionPopupManager {
  popup: HTMLDivElement | null = null;

  private listeners: [EventTarget, string, (e: any) => void][] = [];

  constructor(
    readonly container: HTMLElement,
    readonly view: EditorView,
    readonly callbacks: MarkdownEditorCallbacks,
  ) {
    this.listen(view.dom, "click", (event: MouseEvent) => {
      const chip = (event.target as HTMLElement)?.closest?.(
        ".bn-md-node",
      ) as HTMLElement | null;
      if (!chip || !this.callbacks.getNodeActions) {
        return;
      }
      event.preventDefault();
      this.open(chip);
    });
    this.listen(document, "mousedown", (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (this.popup && target && !this.popup.contains(target)) {
        this.close();
      }
    });
    this.listen(document, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.close();
      }
    });
    this.listen(view.scrollDOM, "scroll", () => this.close());
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: (e: any) => void,
  ) {
    target.addEventListener(type, listener);
    this.listeners.push([target, type, listener]);
  }

  /**
   * Adjacent chips separated only by whitespace/<br> — the markdown
   * counterpart of the note editor's annotation-citation pair scan.
   */
  private findNeighbors(from: number) {
    const result: {
      before?: { kind: ZNodeKind; raw: string };
      after?: { kind: ZNodeKind; raw: string };
    } = {};
    const state = this.view.state;
    const chips: { from: number; to: number; kind: ZNodeKind; raw: string }[] =
      [];
    state.field(zNodeField).between(0, state.doc.length, (f, t, value) => {
      const widget = (value.spec as any)?.widget as ZNodeWidget | undefined;
      if (widget) {
        chips.push({ from: f, to: t, kind: widget.kind, raw: widget.raw });
      }
    });
    const index = chips.findIndex((chip) => chip.from === from);
    if (index < 0) {
      return result;
    }
    const isPlainGap = (a: number, b: number) => {
      const gap = state.sliceDoc(a, b);
      return /^(?:\s|<br\s*\/?>)*$/i.test(gap) && !/\n[ \t]*\n/.test(gap);
    };
    const before = chips[index - 1];
    if (before && isPlainGap(before.to, from)) {
      result.before = { kind: before.kind, raw: before.raw };
    }
    const after = chips[index + 1];
    if (after && isPlainGap(chips[index].to, after.from)) {
      result.after = { kind: after.kind, raw: after.raw };
    }
    return result;
  }

  private open(chip: HTMLElement) {
    const data = chipData.get(chip);
    if (!data || !this.callbacks.getNodeActions) {
      return;
    }
    previewManagers.get(this.container)?.close();
    this.close();
    let from = -1;
    try {
      from = this.view.posAtDOM(chip);
    } catch (e) {
      // Position lookup can fail for a detached chip.
    }
    const neighbors = from >= 0 ? this.findNeighbors(from) : {};

    const popup = document.createElement("div");
    popup.className = "popup-container bn-md-action";
    popup.innerHTML = `<div class="popup popup-bottom"></div>`;
    popup.style.display = "none";
    // Fixed positioning in viewport coordinates, like the preview popup;
    // the note-editor stylesheet provides the look (background, buttons).
    const inner = popup.querySelector(".popup") as HTMLDivElement;
    Object.assign(inner.style, {
      position: "fixed",
      width: "max-content",
      zIndex: "100",
      boxSizing: "border-box",
      overflow: "visible",
    });
    document.body.appendChild(popup);
    this.popup = popup;

    const container = this.container;
    const raw = data.raw;
    const applyEdit = (newText: string, trimBefore?: boolean) => {
      if (typeof newText !== "string") {
        return;
      }
      tryOrRetryNextTick(() => {
        const view = views.get(container);
        if (!view) {
          return;
        }
        const range = locateChipRange(view, from, raw);
        if (!range) {
          return;
        }
        let start = range.from;
        if (trimBefore) {
          const lookBehind = view.state.sliceDoc(
            Math.max(0, start - 64),
            start,
          );
          const gap = /(?:\s|<br\s*\/?>)+$/i.exec(lookBehind)?.[0];
          if (gap) {
            start -= gap.length;
          }
        }
        view.dispatch({
          changes: { from: start, to: range.to, insert: newText },
        });
      });
    };

    try {
      this.callbacks.getNodeActions(
        data.kind,
        raw,
        JSON.stringify(neighbors),
        (actionsJSON: string) => {
          if (this.popup !== popup || !chip.isConnected) {
            return;
          }
          let actions: { id: string; icon?: string; title?: string }[] = [];
          try {
            actions = JSON.parse(actionsJSON) || [];
          } catch (e) {
            console.error(e);
          }
          if (!actions.length) {
            this.close();
            return;
          }
          for (const action of actions) {
            const button = document.createElement("button");
            button.dataset.action = action.id;
            const icon = document.createElement("div");
            icon.className = "icon";
            icon.innerHTML = action.icon || "";
            const title = document.createElement("div");
            title.className = "title";
            title.textContent = action.title || action.id;
            button.append(icon, title);
            button.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.close();
              try {
                this.callbacks.onNodeAction?.(
                  action.id,
                  data.kind,
                  raw,
                  applyEdit,
                );
              } catch (e) {
                console.error(e);
              }
            });
            inner.appendChild(button);
          }
          popup.style.removeProperty("display");
          this.layout(chip, popup);
        },
      );
    } catch (e) {
      console.error(e);
    }
  }

  private layout(chip: HTMLElement, popup: HTMLDivElement) {
    // Below the chip like the note editor's node popups, flipped above when
    // there is no room. Viewport coordinates (position: fixed).
    const inner = popup.querySelector(".popup") as HTMLDivElement;
    const chipRect = chip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const padding = 10;
    const height = inner.offsetHeight;
    const width = inner.offsetWidth;

    let top = chipRect.bottom + padding;
    if (top + height > viewportHeight && chipRect.top - height - padding >= 0) {
      inner.classList.remove("popup-bottom");
      inner.classList.add("popup-top");
      top = chipRect.top - height - padding;
    } else {
      inner.classList.remove("popup-top");
      inner.classList.add("popup-bottom");
    }

    let left = chipRect.left + chipRect.width / 2 - width / 2;
    left = Math.max(2, Math.min(left, viewportWidth - width - 2));

    inner.style.top = `${Math.round(top)}px`;
    inner.style.left = `${Math.round(left)}px`;
  }

  close() {
    this.popup?.remove();
    this.popup = null;
  }

  destroy() {
    this.close();
    for (const [target, type, listener] of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners = [];
  }
}
