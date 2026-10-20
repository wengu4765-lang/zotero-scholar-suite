/**
 * Magic-key palette host for the markdown editor: shared command set and
 * list UI (extras/shared), CodeMirror anchoring and command execution here.
 */
import type { EditorView } from "@codemirror/view";
import type { EditorState, Transaction } from "@codemirror/state";
import { formatMessage } from "../shared/editorStrings";
import { MAGIC_COMMANDS } from "../shared/magicCommands";
import { PaletteEntry, PaletteList } from "../shared/paletteCore";
import type { MagicKeyOptions, MarkdownEditorCallbacks } from "./types";
import { actionPopups, previewManagers, views } from "./registries";
import { tryOrRetryNextTick } from "../shared/utils";
import { applyCommand, insertTableSkeleton } from "./commands";

/** One palette row: the shared display data plus the action to run. */
type MagicEntry = PaletteEntry & { run: () => void };

/**
 * Canonical command ids whose markdown implementation goes by another name
 * in applyCommand; unlisted format commands map to their own id.
 */
const MD_FORMAT_ALIASES: Record<string, string> = {
  monospaced: "codeBlock",
  todoList: "taskList",
  clearFormatting: "clearFormat",
};

export class MagicKeyManager {
  popup: HTMLDivElement | null = null;

  private entries: MagicEntry[] = [];

  private paletteList: PaletteList | null = null;

  private openedBySlash = false;

  private listeners: [EventTarget, string, (e: any) => void][] = [];

  constructor(
    readonly container: HTMLElement,
    readonly view: EditorView,
    readonly callbacks: MarkdownEditorCallbacks,
    readonly options: MagicKeyOptions,
  ) {
    this.listen(document, "mousedown", (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (this.popup && target && !this.popup.contains(target)) {
        this.close(false);
      }
    });
    this.listen(view.scrollDOM, "scroll", () => this.close(false));
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: (e: any) => void,
  ) {
    target.addEventListener(type, listener);
    this.listeners.push([target, type, listener]);
  }

  /** Open on a freshly typed `/` (not `//`), like the rich-text palette. */
  handleDocChange(update: {
    state: EditorState;
    transactions: readonly Transaction[];
  }) {
    if (this.popup) {
      this.close(false);
      return;
    }
    if (
      !this.options.enable ||
      !update.transactions.some((tr) => tr.isUserEvent("input.type"))
    ) {
      return;
    }
    const main = update.state.selection.main;
    if (!main.empty) {
      return;
    }
    const head = main.head;
    if (
      update.state.sliceDoc(Math.max(0, head - 1), head) !== "/" ||
      update.state.sliceDoc(Math.max(0, head - 2), head) === "//"
    ) {
      return;
    }
    // Open outside the update cycle; verify the cursor hasn't moved on.
    setTimeout(() => {
      const view = views.get(this.container);
      if (view && !this.popup && view.state.selection.main.head === head) {
        this.open(true);
      }
    }, 0);
  }

  toggle() {
    if (this.popup) {
      this.close();
    } else {
      this.open(false);
    }
  }

  open(bySlash: boolean) {
    previewManagers.get(this.container)?.close();
    actionPopups.get(this.container)?.close();
    this.close(false);
    this.openedBySlash = bySlash;
    const render = (commandsJSON?: string) => {
      let info: any = {};
      try {
        info = commandsJSON ? JSON.parse(commandsJSON) : {};
      } catch (e) {
        console.error(e);
      }
      this.render(info || {});
    };
    if (!this.callbacks.getMagicCommands) {
      render();
      return;
    }
    try {
      this.callbacks.getMagicCommands(render);
    } catch (e) {
      console.error(e);
      render();
    }
  }

  private buildEntries(info: {
    openAttachment?: boolean;
    custom?: {
      id: string;
      title: string;
      icon?: string;
      searchParts?: string[];
    }[];
  }) {
    const locale = window.navigator.language || "en-US";
    const entries: MagicEntry[] = [];
    for (const command of MAGIC_COMMANDS) {
      if (command.id === "openAttachment" && !info.openAttachment) {
        continue;
      }
      entries.push({
        id: command.id,
        title: formatMessage(command.id, locale),
        searchParts: command.searchParts,
        run:
          command.kind === "format"
            ? () => {
                if (command.id === "table") {
                  insertTableSkeleton(this.container);
                } else {
                  applyCommand(
                    this.container,
                    MD_FORMAT_ALIASES[command.id] ?? command.id,
                  );
                }
              }
            : () => {
                try {
                  this.callbacks.onMagicCommand?.(command.id);
                } catch (e) {
                  console.error(e);
                }
              },
      });
    }
    for (const command of info.custom || []) {
      if (!command?.id || !command.title) {
        continue;
      }
      entries.push({
        id: command.id,
        title: command.title,
        icon: command.icon,
        searchParts: command.searchParts?.length
          ? command.searchParts
          : [command.id],
        run: () => {
          try {
            this.callbacks.onMagicCommand?.(command.id);
          } catch (e) {
            console.error(e);
          }
        },
      });
    }
    return entries;
  }

  private render(info: {
    openAttachment?: boolean;
    custom?: {
      id: string;
      title: string;
      icon?: string;
      searchParts?: string[];
    }[];
  }) {
    const view = views.get(this.container);
    if (!view) {
      return;
    }
    this.entries = this.buildEntries(info);
    if (!this.entries.length) {
      return;
    }

    const popup = document.createElement("div");
    popup.className = "popup-container bn-md-magic";
    popup.innerHTML = `<div class="popup popup-bottom"><div class="popup-content"><input type="text" class="popup-input" placeholder="Search commands" /><div class="popup-list" tabindex="-1"></div></div></div>`;
    const inner = popup.querySelector(".popup") as HTMLDivElement;
    Object.assign(inner.style, {
      position: "fixed",
      width: "max-content",
      zIndex: "100",
      boxSizing: "border-box",
    });
    document.body.appendChild(popup);
    this.popup = popup;

    this.paletteList = new PaletteList({
      execute: (index) => this.execute(index),
      dismiss: (reason) => {
        const bySlash = this.openedBySlash;
        this.close();
        if (reason === "undo" && bySlash) {
          this.removeSlash();
        }
      },
    });
    this.layout(view, inner);
    this.paletteList.attach(
      popup.querySelector(".popup-input") as HTMLInputElement,
      popup.querySelector(".popup-list") as HTMLDivElement,
      this.entries,
    );
    // Items exist only after attach; re-anchor to the final size.
    this.layout(view, inner);
  }

  private layout(view: EditorView, inner: HTMLDivElement) {
    // Anchor at the cursor, below the line (above when out of room).
    const head = view.state.selection.main.head;
    const rect = view.coordsAtPos(head) || {
      left: 0,
      top: 0,
      bottom: 0,
    };
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const height = inner.offsetHeight;
    const width = inner.offsetWidth;
    const padding = 10;

    let top = rect.bottom + padding;
    if (top + height > viewportHeight && rect.top - height - padding >= 0) {
      inner.classList.remove("popup-bottom");
      inner.classList.add("popup-top");
      top = rect.top - height - padding;
    }
    const left = Math.max(2, Math.min(rect.left, viewportWidth - width - 2));
    inner.style.top = `${Math.round(top)}px`;
    inner.style.left = `${Math.round(left)}px`;
  }

  private execute(index: number) {
    const entry = this.entries[index];
    const bySlash = this.openedBySlash;
    this.close();
    if (!entry) {
      return;
    }
    if (bySlash) {
      this.removeSlash();
    }
    entry.run();
  }

  /** Remove the `/` that opened the palette, like the rich-text palette. */
  private removeSlash() {
    tryOrRetryNextTick(() => {
      const view = views.get(this.container);
      if (!view) {
        return;
      }
      const head = view.state.selection.main.head;
      if (
        view.state.sliceDoc(Math.max(0, head - 1), head) === "/" &&
        view.state.sliceDoc(Math.max(0, head - 2), head) !== "//"
      ) {
        view.dispatch({ changes: { from: head - 1, to: head } });
      }
    });
  }

  close(refocus = true) {
    if (!this.popup) {
      return;
    }
    this.popup.remove();
    this.popup = null;
    this.paletteList = null;
    this.entries = [];
    if (refocus) {
      views.get(this.container)?.focus();
    }
  }

  destroy() {
    this.close(false);
    for (const [target, type, listener] of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners = [];
  }
}
