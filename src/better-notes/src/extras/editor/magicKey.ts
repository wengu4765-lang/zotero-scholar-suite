import {
  EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Transaction,
} from "prosemirror-state";

import { Popup } from "./popup";
import { formatMessage } from "../shared/editorStrings";
import { MAGIC_COMMANDS } from "../shared/magicCommands";
import { PaletteList } from "../shared/paletteCore";
import { ResolvedPos } from "prosemirror-model";
import { toggleTaskList } from "./taskList";

export {
  initMagicKeyPlugin,
  setMagicKeyCommands,
  MagicKeyOptions,
  MagicCommand,
};

declare const _currentEditorInstance: {
  _editorCore: EditorCore;
};

interface MagicKeyOptions {
  insertTemplate?: () => void;
  refreshTemplates?: () => void;
  insertLink?: (type: "inbound" | "outbound") => void;
  copyLink?: (mode: "section" | "line") => void;
  openAttachment?: () => void;
  canOpenAttachment?: () => boolean;
  enable?: boolean;
  enableShortcut?: boolean;
}

interface MagicCommand {
  messageId?: string;
  searchParts?: string[];
  title?: string;
  icon?: string;
  command: (state: EditorState) => void | Transaction;
  enabled?: (state: EditorState) => boolean;
}

// Custom commands registered from the main context via setMagicKeyCommands;
// shared by all PluginState instances of this editor window.
let customCommands: MagicCommand[] = [];

function setMagicKeyCommands(commands: MagicCommand[]) {
  customCommands = commands || [];
}

class PluginState {
  state: EditorState;

  options: MagicKeyOptions;

  /**
   * Editor-side implementations for the shared command table; metadata
   * entries without an implementation here are not shown.
   */
  _commandActions: Record<string, Pick<MagicCommand, "command" | "enabled">> = {
    insertTemplate: {
      command: () => {
        this.options.insertTemplate?.();
      },
    },
    outboundLink: {
      command: () => {
        this.options.insertLink?.("outbound");
      },
    },
    inboundLink: {
      command: () => {
        this.options.insertLink?.("inbound");
      },
    },
    insertCitation: {
      command: () => {
        getPlugin("citation")?.insertCitation();
      },
    },
    openAttachment: {
      command: () => {
        this.options.openAttachment?.();
      },
      enabled: () => {
        return this.options.canOpenAttachment?.() || false;
      },
    },
    copySectionLink: {
      command: () => {
        this.options.copyLink?.("section");
      },
    },
    copyLineLink: {
      command: () => {
        this.options.copyLink?.("line");
      },
    },
    refreshTemplates: {
      command: () => {
        this.options.refreshTemplates?.();
      },
    },
    table: {
      command: (state) => {
        const input = prompt(
          "Enter the number of rows and columns, separated by a comma (e.g., 3,3)",
        );
        if (!input) {
          return state.tr;
        }
        const splitter = input.includes("x")
          ? "x"
          : input.includes(",")
            ? ","
            : " ";
        const [rows, cols] = input.split(splitter).map((n) => parseInt(n, 10));
        if (isNaN(rows) || isNaN(cols)) {
          return state.tr;
        }
        const { tr, selection } = state;
        const { $from, $to } = selection;
        const { pos } = $from;
        const table = state.schema.nodes.table.createAndFill(
          {},
          Array.from(
            { length: rows },
            () =>
              state.schema.nodes.table_row.createAndFill(
                {},
                Array.from(
                  { length: cols },
                  () => state.schema.nodes.table_cell.createAndFill()!,
                ),
              )!,
          ),
        )!;
        tr.replaceWith(pos, pos, table);
        _currentEditorInstance._editorCore.view.dispatch(tr);
      },
    },
    heading1: {
      command: () => {
        getPlugin()?.heading1.run();
      },
    },
    heading2: {
      command: () => {
        getPlugin()?.heading2.run();
      },
    },
    heading3: {
      command: () => {
        getPlugin()?.heading3.run();
      },
    },
    paragraph: {
      command: () => {
        getPlugin()?.paragraph.run();
      },
    },
    monospaced: {
      command: () => {
        getPlugin()?.codeBlock.run();
      },
    },
    bulletList: {
      command: () => {
        getPlugin()?.bulletList.run();
      },
    },
    orderedList: {
      command: () => {
        getPlugin()?.orderedList.run();
      },
    },
    todoList: {
      command: () => {
        toggleTaskList();
      },
    },
    blockquote: {
      command: () => {
        getPlugin()?.blockquote.run();
      },
    },
    mathBlock: {
      command: () => {
        getPlugin()?.math_display.run();
        setTimeout(() => {
          this._activateSelectedNodeEditor("math_display");
        }, 0);
      },
    },
    clearFormatting: {
      command: () => {
        getPlugin()?.clearFormatting.run();
      },
    },
  };

  _commands: MagicCommand[];

  get commands() {
    return [...this._commands, ...customCommands].filter((command) => {
      if (command.enabled) {
        return command.enabled(this.state);
      }
      return true;
    });
  }

  popup: Popup | null = null;

  paletteList: PaletteList | null = null;

  // Commands as rendered when the popup opened: enabled() is re-evaluated
  // live by the `commands` getter, so indexes must come from a snapshot.
  _openCommands: MagicCommand[] = [];

  get node() {
    const node =
      // @ts-ignore - private API
      _currentEditorInstance._editorCore.view.domSelection().anchorNode;
    if (node.nodeType === Node.TEXT_NODE) {
      return node.parentElement;
    }
    return node;
  }

  popupClass = "command-palette";

  constructor(state: EditorState, options: MagicKeyOptions) {
    this.state = state;
    this.options = options;

    const locale = window.navigator.language || "en-US";
    this._commands = MAGIC_COMMANDS.flatMap((meta) => {
      const action = this._commandActions[meta.id];
      return action
        ? [
            {
              messageId: meta.id,
              title: formatMessage(meta.id, locale),
              searchParts: meta.searchParts,
              ...action,
            },
          ]
        : [];
    });

    this.update(state);
  }

  update(state: EditorState, prevState?: EditorState) {
    this.state = state;

    if (!prevState) {
      return;
    }

    // Check if the selection has changed, then try to close the popup
    if (!prevState.selection.eq(state.selection)) {
      this._closePopup();
    }

    if (!this.options.enable) {
      return;
    }

    // If the document hasn't changed, we don't need to do anything
    if (prevState.doc.eq(state.doc)) {
      return;
    }

    // When `/` is pressed, we should open the command palette
    const selectionText = state.doc.textBetween(
      state.selection.from,
      state.selection.to,
    );
    if (!selectionText) {
      const { $from } = this.state.selection;
      const { parent } = $from;
      // Don't open the popup if we are in the document root
      if (parent.type.name === "doc") {
        return;
      }
      const textBeforeCursor = getTextBeforeCursor($from);
      if (textBeforeCursor.endsWith("/") && !textBeforeCursor.endsWith("//")) {
        this._openPopup(state);
      } else {
        this._closePopup();
      }
    }
  }

  destroy() {
    this.popup?.remove();
  }

  handleKeydown = async (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (this._hasPopup()) {
        this._closePopup();
      }
      return;
    }

    const isMac =
      typeof navigator != "undefined" ? /Mac/.test(navigator.platform) : false;
    if (
      this.options.enableShortcut &&
      ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
      event.key === "/"
    ) {
      if (!this._hasPopup()) {
        this._openPopup(this.state);
      } else {
        this._closePopup();
      }
      event.preventDefault();
      return;
    }
  };

  _openPopup(state: EditorState) {
    if (this._hasPopup()) {
      return;
    }
    // Snapshot: enabled() is evaluated once, when the popup opens.
    this._openCommands = this.commands;
    this.popup = new Popup(document, this.popupClass, [
      document.createRange().createContextualFragment(`
<style>
  .${this.popupClass} > .popup {
    max-width: 360px;
    max-height: 360px;
    overflow: hidden;
  }
  .${this.popupClass} > .popup input {
    padding: 0 7px;
    background: var(--material-background);
    border-radius: 5px;
    border: var(--material-border-quinary);
    width: 100%;
    outline: none;
    height: 28px;
    flex-shrink: 0;
  }
  .${this.popupClass} > .popup input:focus {
    outline: none;
    border-color: rgba(0, 0, 0, 0);
    box-shadow: 0 0 0 var(--width-focus-border) var(--color-focus-search);
  }
  .${this.popupClass} .popup-content {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
  }
  .${this.popupClass} .popup-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden auto;
  }
  .${this.popupClass} .popup-item {
    display: flex;
    align-items: flex-end;
    padding: 6px;
    cursor: pointer;
    border-radius: 5px;
  }
  .${this.popupClass} .popup-item[hidden] {
    display: none !important;
  }
  .${this.popupClass} .popup-item-title {
    flex: 1;
  }
  .${this.popupClass} .popup-item-key {
    margin-left: 12px;
    font-size: 0.9em;
    font-family: monospace;
  }
  .${this.popupClass} .popup-item:hover {
    background-color: var(--fill-senary);
  }
  .${this.popupClass} .popup-item.selected {
    background-color: var(--color-accent);
    color: #fff;
  }
</style>
<div class="popup-content">
  <input type="text" class="popup-input" placeholder="Search commands" />
  <div class="popup-list" tabindex="-1"></div>
</div>`),
    ]);

    this.popup.layoutPopup(this);

    this.paletteList = new PaletteList({
      execute: (index) => {
        this._executeCommand(index, state);
      },
      dismiss: (reason) => {
        this._closePopup();
        if (reason === "undo" && this.options.enable) {
          this.removeInputSlash(state);
        }
      },
    });
    this.paletteList.attach(
      this.popup.container.querySelector(".popup-input") as HTMLInputElement,
      this.popup.container.querySelector(".popup-list") as HTMLDivElement,
      this._openCommands.map((command) => ({
        id: command.messageId || command.title || "",
        title: command.title || "",
        icon: command.icon,
        searchParts: command.searchParts?.length
          ? command.searchParts
          : [command.title || ""],
      })),
    );
    // The items exist only after attach; re-anchor to the final size.
    this.popup.layoutPopup(this);
  }

  _closePopup() {
    if (!this._hasPopup()) {
      return;
    }
    document
      .querySelectorAll(`.${this.popupClass}`)
      .forEach((el) => el.remove());
    this.popup = null;
    this.paletteList = null;
    this._openCommands = [];
    window.BetterNotesEditorAPI.refocusEditor();
  }

  _hasPopup() {
    return !!document.querySelector(`.${this.popupClass}`);
  }

  _executeCommand(index: number, state: EditorState) {
    const command = this._openCommands[index];
    if (!command) {
      this._closePopup();
      return;
    }
    if (this.options.enable) {
      // Remove the current input `/`
      this.removeInputSlash(state);
    }

    const newState = _currentEditorInstance._editorCore.view.state;

    // Apply the command
    try {
      const mightBeTr = command.command(newState);
      if (mightBeTr) {
        _currentEditorInstance._editorCore.view.dispatch(mightBeTr);
      }
    } catch (error) {
      console.error("Error applying command", error);
    }

    this._closePopup();
  }

  _activateSelectedNodeEditor(nodeTypeName: string) {
    const view = _currentEditorInstance._editorCore.view;
    const { selection } = view.state;
    let nodeDOM: HTMLElement | null = null;

    if (
      selection instanceof NodeSelection &&
      selection.node.type.name === nodeTypeName
    ) {
      nodeDOM = view.nodeDOM(selection.from) as HTMLElement | null;
    }

    if (!nodeDOM) {
      nodeDOM =
        (document.querySelector(
          ".ProseMirror-selectednode",
        ) as HTMLElement | null) || null;
    }

    if (!nodeDOM) {
      return;
    }

    const target =
      (nodeDOM.querySelector(
        'textarea, input, [contenteditable="true"]',
      ) as HTMLElement | null) || nodeDOM;

    try {
      view.focus();
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      target.focus();
    } catch (error) {
      console.warn("BN: Failed to activate selected math block", error);
    }
  }

  removeInputSlash(state: EditorState) {
    const { $from } = state.selection;
    const { pos } = $from;
    const textBeforeCursor = getTextBeforeCursor($from);
    if (textBeforeCursor.endsWith("/") && !textBeforeCursor.endsWith("//")) {
      const tr = state.tr.delete(pos - 1, pos);
      _currentEditorInstance._editorCore.view.dispatch(tr);
    }
  }
}

function initMagicKeyPlugin(
  plugins: readonly Plugin[],
  options: MagicKeyOptions,
) {
  console.log("Init BN Magic Key Plugin");
  const key = new PluginKey("magicKeyPlugin");
  const plugin = new Plugin({
    key,
    state: {
      init(config, state) {
        return new PluginState(state, options);
      },
      apply: (tr, pluginState, oldState, newState) => {
        pluginState.update(newState, oldState);
        return pluginState;
      },
    },
    props: {
      handleDOMEvents: {
        keydown: (view, event) => {
          const pluginState = key.getState(view.state) as PluginState;
          pluginState.handleKeydown(event);
        },
      },
    },
    view: (editorView) => {
      return {
        update(view, prevState) {
          const pluginState = key.getState(view.state) as PluginState;
          pluginState.update(view.state, prevState);
        },
        destroy() {
          const pluginState = key.getState(editorView.state) as PluginState;
          pluginState.destroy();
        },
      };
    },
  });
  // Marker used by initPlugins to keep the reconfigure idempotent on reload.
  (plugin.spec as any).betterNotes = "magicKey";
  return [...plugins, plugin];
}

function getPlugin(key = "menu") {
  return _currentEditorInstance._editorCore.pluginState[key] as any;
}

function getTextBeforeCursor(from: ResolvedPos) {
  const cursorPosInNode = from.parentOffset;
  return from.parent.textContent.slice(0, cursorPosInNode);
}
