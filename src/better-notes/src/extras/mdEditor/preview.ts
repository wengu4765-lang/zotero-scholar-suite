/**
 * Hover previews for the Zotero node chips.
 */
import type { EditorView } from "@codemirror/view";
import { HoverIntent } from "../shared/hoverIntent";
import type { MarkdownEditorCallbacks } from "./types";
import { chipData } from "./zNodes";
import { actionPopups } from "./registries";

/**
 * Hover previews for the chips, in the note editor's own popup markup and
 * styles.
 */
export class PreviewManager {
  private popup: HTMLDivElement | null = null;

  private popupHovered = false;

  private hoverIntent = new HoverIntent<HTMLElement>({
    open: (chip) => this.open(chip),
    pinned: () => this.popupHovered,
    close: () => this.close(),
  });

  private listeners: [EventTarget, string, (e: any) => void][] = [];

  constructor(
    readonly container: HTMLElement,
    readonly view: EditorView,
    readonly callbacks: MarkdownEditorCallbacks,
  ) {
    this.listen(view.dom, "mouseover", (event: MouseEvent) => {
      const chip = (event.target as HTMLElement)?.closest?.(
        ".bn-md-node",
      ) as HTMLElement | null;
      if (chip) {
        this.hoverIntent.hover(chip);
      }
    });
    this.listen(view.dom, "mouseout", (event: MouseEvent) => {
      const chip = (event.target as HTMLElement)?.closest?.(".bn-md-node");
      if (!chip || chip !== this.hoverIntent.target) {
        return;
      }
      const to = event.relatedTarget as HTMLElement | null;
      if (to && (chip.contains(to) || this.popup?.contains(to))) {
        return;
      }
      this.hoverIntent.unhover();
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

  private open(chip: HTMLElement) {
    const data = chipData.get(chip);
    if (!data || !this.callbacks.getPreview) {
      return;
    }
    // Don't stack the hover preview onto an open action popup.
    if (actionPopups.get(this.container)?.popup) {
      return;
    }
    this.close();
    const popup = document.createElement("div");
    popup.className = "popup-container bn-md-preview";
    popup.innerHTML = `<div class="popup popup-top primary-editor"><div class="bn-md-preview-body"></div></div>`;
    popup.style.display = "none";
    // Layout-critical styles are inlined so the popup geometry never
    // depends on the injected stylesheet (which only themes it).
    const inner = popup.querySelector(".popup") as HTMLDivElement;
    Object.assign(inner.style, {
      position: "fixed",
      // Hug the content (up to max-width).
      width: "max-content",
      maxWidth: "360px",
      zIndex: "100",
      boxSizing: "border-box",
      // The note-editor's .popup base style is display: flex; stack
      // vertically regardless of the injected stylesheet's state.
      flexDirection: "column",
      // Keep overflow off the .popup: its popover-arrow pseudo-elements
      // would count as scrollable and the scrollbar wraps text mid-word.
      overflow: "visible",
    });
    const body = popup.querySelector(".bn-md-preview-body") as HTMLDivElement;
    Object.assign(body.style, {
      maxWidth: "350px",
      maxHeight: "350px",
      overflow: "hidden auto",
    });
    // Parent to the body: fixed positioning needs no ancestor forming a
    // containing block (transforms, contain, filters).
    document.body.appendChild(popup);
    this.popup = popup;

    popup.addEventListener("mouseenter", () => {
      this.popupHovered = true;
    });
    popup.addEventListener("mouseleave", () => {
      this.popupHovered = false;
      if (this.hoverIntent.target !== chip) {
        this.hoverIntent.scheduleClose();
      }
    });
    popup.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const href =
        target.localName === "a" ? target.getAttribute("href") : null;
      event.preventDefault();
      event.stopPropagation();
      if (href) {
        try {
          this.callbacks.openURL?.(href);
        } catch (e) {
          console.error(e);
        }
      }
      this.close();
    });

    try {
      this.callbacks.getPreview(data.kind, data.raw, (html: string) => {
        if (this.popup !== popup || !chip.isConnected) {
          return;
        }
        body.append(document.createRange().createContextualFragment(html));
        popup.style.removeProperty("display");
        this.layout(chip, popup);
        // Images load asynchronously and change the popup size; re-anchor.
        inner.querySelectorAll("img").forEach((img) => {
          img.addEventListener(
            "load",
            () => {
              if (this.popup === popup && chip.isConnected) {
                this.layout(chip, popup);
              }
            },
            { once: true },
          );
        });
      });
    } catch (e) {
      console.error(e);
    }
  }

  private layout(chip: HTMLElement, popup: HTMLDivElement) {
    const inner = popup.querySelector(".popup") as HTMLDivElement;
    // The popup is position: fixed, so lay it out in viewport coordinates —
    // anchor-ancestor-independent (it is closed on scroll and doc changes).
    const chipRect = chip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const padding = 10;
    const height = inner.offsetHeight;
    const width = inner.offsetWidth;

    let top = chipRect.top - height - padding;
    if (top < 0) {
      inner.classList.remove("popup-top");
      inner.classList.add("popup-bottom");
      top = chipRect.bottom + padding;
    } else {
      inner.classList.remove("popup-bottom");
      inner.classList.add("popup-top");
    }

    let left = chipRect.left + chipRect.width / 2 - width / 2;
    left = Math.max(2, Math.min(left, viewportWidth - width - 2));

    inner.style.top = `${Math.round(top)}px`;
    inner.style.left = `${Math.round(left)}px`;
  }

  close() {
    this.popup?.remove();
    this.popup = null;
    this.popupHovered = false;
  }

  destroy() {
    this.close();
    for (const [target, type, listener] of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners = [];
  }
}
