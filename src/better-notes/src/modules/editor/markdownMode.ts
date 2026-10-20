import type { BetterNotesMarkdownEditor } from "../../extras/mdEditor";
import { ICONS } from "../../utils/config";
import { md2note, note2md } from "../../utils/convert";
import {
  copyNoteLink,
  getEditorAPI,
  getEditorCore,
  getLineAtCursor,
  getLineCount,
  getPositionAtLine,
  getTextBetween,
  setEditorViewBackend,
} from "../../utils/editor";
import { showHint } from "../../utils/hint";
import { itemPicker } from "../../utils/itemPicker";
import { openLinkCreator } from "../../utils/linkCreator";
import { getString } from "../../utils/locale";
import {
  copyEmbeddedImagesInHTML,
  getNoteTreeFlattened,
  importImageToNote,
} from "../../utils/note";
import {
  getPref,
  registerPrefObserver,
  unregisterPrefObserver,
} from "../../utils/prefs";
import { getFileContent, getItemDataURL } from "../../utils/str";
import { waitUtilAsync } from "../../utils/wait";
import { getRegisteredMagicKeyCommands } from "./magicKey";

export {
  initEditorMarkdownMode,
  isMarkdownMode,
  toggleMarkdownMode,
  getMarkdownSource,
  setMarkdownSource,
  convertPastedHTMLToMarkdown,
  registerMarkdownModePrefObserver,
  unregisterMarkdownModePrefObserver,
  registerMarkdownEditorBackend,
  unregisterMarkdownEditorBackend,
};

const SAVE_DEBOUNCE_MS = 1000;

interface MarkdownModeState {
  active: boolean;
  // The note this session edits; the window-keyed state outlives editor
  // handles and item switches, so it can't be read from a handle.
  noteItem: Zotero.Item;
  container?: HTMLDivElement;
  // Accessors over the actual source editor (CodeMirror, or the plain
  // textarea fallback), set when the mode is entered.
  getValue?: () => string | undefined;
  setValue?: (value: string, keepView: boolean) => void;
  getSelection?: () => { anchor: number; head: number } | undefined;
  setSelection?: (
    anchor: number,
    head: number,
    scrollIntoView?: boolean,
  ) => void;
  getScroll?: () => number | undefined;
  setScroll?: (top: number) => void;
  focusEditor?: () => void;
  // Live-tracked scroll position: a detached scroller reads 0, so the last
  // real value is mirrored here while scrolling.
  lastScrollTop: number;
  saveTimer?: number;
  // Serializes md->note saves so a slow conversion can't be overtaken by a
  // later one and write stale content.
  saving: Promise<void>;
  // The markdown that matches the current note content (last loaded or saved).
  // getValue() !== lastSyncedMD means there are unsaved md edits.
  lastSyncedMD: string;
  // The full note HTML our last save produced, used to tell our own save's
  // notifier echo apart from a real external change.
  lastSavedNoteHTML: string;
  notifierID?: string;
  pageHideListener?: () => void;
  // Watches for the overlay being dropped by an editor UI re-render (an
  // editor reinit re-renders at no fixed delay) and re-establishes the mode.
  watchTimer?: number;
  // The markdown formatting toolbar section (lives in the editor toolbar,
  // outside the overlay).
  mdToolbar?: HTMLElement;
  // Pending citation-dialog result listener (see insertCitationViaDialog).
  citationListener?: (event: MessageEvent) => void;
}

const states = new WeakMap<Window, MarkdownModeState>();

// A manual toggle overrides the useMarkdownByDefault preference only while
// the pane keeps showing that note; any other note follows the preference.
const modeOverrides = new WeakMap<
  Window,
  { noteID: number; markdown: boolean }
>();

/** The effective mode override for the note this editor handle shows. */
function modeOverrideFor(editor: Zotero.EditorInstance) {
  const override = modeOverrides.get(editor._iframeWindow);
  return override?.noteID === editor._item.id ? override.markdown : undefined;
}

/**
 * The note this iframe currently shows: the last registered live instance
 * for the window (inits interleave, so hook order is unreliable).
 */
function currentWindowNoteID(win: Window): number | undefined {
  const list = Zotero.Notes._editorInstances;
  for (let i = list.length - 1; i >= 0; i--) {
    const candidate = list[i];
    if (candidate._iframeWindow === win) {
      return candidate._item?.id;
    }
  }
  return undefined;
}

let togglePrefObserver: symbol | undefined;

/** Live-apply the toggle-button preference to all open editors. */
function registerMarkdownModePrefObserver() {
  togglePrefObserver = registerPrefObserver("editor.showMarkdownToggle", () => {
    for (const editor of Zotero.Notes._editorInstances) {
      try {
        updateMarkdownToggleButton(editor);
      } catch (e) {
        // The editor may be mid-teardown.
      }
    }
  });
}

function unregisterMarkdownModePrefObserver() {
  if (togglePrefObserver) {
    unregisterPrefObserver(togglePrefObserver);
    togglePrefObserver = undefined;
  }
}

function updateMarkdownToggleButton(editor: Zotero.EditorInstance) {
  const win = editor._iframeWindow;
  if (Components.utils.isDeadWrapper(win)) {
    return;
  }
  const toolbarStart = win.document.querySelector(".toolbar .start");
  if (!toolbarStart) {
    return;
  }
  const existing = toolbarStart.querySelector(
    ".bn-md-toggle",
  ) as HTMLElement | null;
  if (!getPref("editor.showMarkdownToggle")) {
    existing?.remove();
    return;
  }
  const instanceID = (editor as any).instanceID as string;
  if (existing) {
    if (existing.dataset.bnInstance === instanceID) {
      existing.classList.toggle("active", isMarkdownMode(editor));
      return;
    }
    // The button survives the reused iframe document across item switches,
    // but its click handler is bound to the superseded instance; re-bind.
    existing.remove();
  }
  const button = ztoolkit.UI.createElement(win.document, "button", {
    classList: ["toolbar-button", "bn-md-toggle"],
    attributes: {
      "data-bn-instance": instanceID,
    },
    properties: {
      innerHTML: ICONS.markdown,
      title: getString("editor-toolbar-markdownMode"),
    },
    listeners: [
      {
        type: "click",
        listener: () => {
          toggleMarkdownMode(editor).catch((e) =>
            ztoolkit.log("[BN markdown mode] toggle error", e),
          );
        },
      },
    ],
  });
  if (isMarkdownMode(editor)) {
    button.classList.add("active");
  }
  // Keep the tab's left-pane toggle at the far left, like the other pane
  // controls; the mode toggle goes after it.
  const paneToggle = toolbarStart.querySelector(".bn-toggle-left-pane");
  if (paneToggle) {
    paneToggle.after(button);
  } else {
    toolbarStart.prepend(button);
  }
}

async function initEditorMarkdownMode(editor: Zotero.EditorInstance) {
  if (editor._disableUI || editor._readOnly) {
    return;
  }
  const win = editor._iframeWindow;
  try {
    await waitUtilAsync(
      () =>
        Components.utils.isDeadWrapper(win) ||
        !!win.document.querySelector(".toolbar .start"),
    );
  } catch (e) {
    return;
  }
  if (Components.utils.isDeadWrapper(win)) {
    return;
  }
  const doc = win.document;

  // A late init of a note this iframe no longer shows (inits interleave on
  // a reused document); the current note's own init manages the state.
  const currentNoteID = currentWindowNoteID(win);
  if (currentNoteID !== undefined && currentNoteID !== editor._item.id) {
    return;
  }

  // The iframe document survives reinits and item switches (no pagehide).
  // Keep prior state serving this note with a live view; else flush + drop.
  const staleState = states.get(win);
  if (staleState) {
    const sameNote = staleState.noteItem.id === editor._item.id;
    const connected = !!staleState.container?.isConnected;
    if (!(sameNote && connected && staleState.active)) {
      if (staleState.active) {
        if (sameNote) {
          // Keep the reading position for the re-entered mode below.
          addon.data.markdownMode.viewState.set(
            staleState.noteItem.id,
            captureMarkdownViewState(staleState),
          );
        }
        captureMarkdownHistory(win, staleState);
        // Flush unsaved markdown to the note the state belongs to.
        let value: string | undefined;
        try {
          value = staleState.getValue?.();
        } catch (e) {
          // The view is unreadable; nothing to flush.
        }
        if (typeof value === "string" && value !== staleState.lastSyncedMD) {
          const staleNote = staleState.noteItem;
          staleState.saving = staleState.saving.then(() =>
            saveContentToNote(staleNote, value).then(
              () => undefined,
              (e) => ztoolkit.log("[BN markdown mode] stale save error", e),
            ),
          );
        }
      }
      cancelScheduledSave(staleState);
      unregisterListeners(staleState);
      if (staleState.pageHideListener) {
        win.removeEventListener("pagehide", staleState.pageHideListener);
      }
      staleState.active = false;
      if (staleState.container?.isConnected) {
        try {
          getMdEditorAPI(win)?.destroy(staleState.container);
        } catch (e) {
          // The highlighter may be gone already.
        }
        staleState.container.remove();
      }
      staleState.mdToolbar?.remove();
      states.delete(win);
    }
  }

  // Overlay or body class left behind without state (e.g. by a previous
  // plugin load, whose in-memory state died with it).
  const orphanOverlay = doc.querySelector(".bn-md-editor");
  if (orphanOverlay && states.get(win)?.container !== orphanOverlay) {
    orphanOverlay.remove();
    doc.querySelector(".toolbar .bn-md-toolbar")?.remove();
  }
  if (
    doc.body.classList.contains("bn-md-mode") &&
    !doc.querySelector(".bn-md-editor")
  ) {
    doc.body.classList.remove("bn-md-mode");
  }

  updateMarkdownToggleButton(editor);

  // A manual toggle on this pane wins; otherwise follow the preference.
  // When the mode survived above, enterMarkdownMode is a no-op.
  if (modeOverrideFor(editor) ?? !!getPref("editor.useMarkdownByDefault")) {
    await enterMarkdownMode(editor);
  }
}

function isMarkdownMode(editor: Zotero.EditorInstance) {
  return !!states.get(editor._iframeWindow)?.active;
}

async function toggleMarkdownMode(editor: Zotero.EditorInstance) {
  if (isMarkdownMode(editor)) {
    await exitMarkdownMode(editor);
  } else {
    await enterMarkdownMode(editor);
  }
}

/** The markdown source currently shown by the editor's markdown mode. */
function getMarkdownSource(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return undefined;
  }
  return state.getValue?.();
}

/** Replace the markdown source; the change is saved to the note (debounced). */
function setMarkdownSource(editor: Zotero.EditorInstance, value: string) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return false;
  }
  state.setValue?.(value, false);
  scheduleSave(editor);
  return true;
}

function getMdEditorAPI(win: Window) {
  return (win as any).wrappedJSObject
    ?.BetterNotesMarkdownEditor as typeof BetterNotesMarkdownEditor;
}

async function injectMarkdownEditorScript(win: Window) {
  // Editor iframes outlive plugin reloads; key the script to this plugin
  // instance so a reload replaces a stale copy (ignoreIfExists would pin it).
  const existing = win.document.getElementById("betternotes-md-editor");
  if (existing?.getAttribute("data-bn-uid") === addon.data.uid) {
    return;
  }
  existing?.remove();
  // A copy injected by a pre-rename plugin version may also linger.
  win.document.getElementById("betternotes-md-highlighter")?.remove();
  ztoolkit.UI.appendElement(
    {
      tag: "script",
      id: "betternotes-md-editor",
      attributes: {
        "data-bn-uid": addon.data.uid,
      },
      properties: {
        innerHTML: await getFileContent(
          rootURI + "chrome/content/scripts/mdEditor.js",
        ),
      },
    },
    win.document.head,
  );
}

async function enterMarkdownMode(editor: Zotero.EditorInstance) {
  const win = editor._iframeWindow;
  const noteItem = editor._item;
  const staleHandle = () => {
    // A handle for a note this iframe no longer shows must not overlay it.
    const currentNoteID = currentWindowNoteID(win);
    return currentNoteID !== undefined && currentNoteID !== noteItem.id;
  };
  if (
    editor._disableUI ||
    editor._readOnly ||
    isMarkdownMode(editor) ||
    staleHandle()
  ) {
    return;
  }

  // Flush pending rich-text changes so the markdown is generated from the
  // latest content.
  editor.saveSync();

  // Capture the rich-text selection endpoints as block index + preceding
  // text, to refine the position within the markdown block.
  let anchorInfo: RichTextEndpoint | undefined;
  let headInfo: RichTextEndpoint | undefined;
  try {
    const selection = getEditorCore(editor).view.state.selection;
    anchorInfo = captureRichTextEndpoint(editor, selection.anchor);
    headInfo =
      selection.head === selection.anchor
        ? anchorInfo
        : captureRichTextEndpoint(editor, selection.head);
  } catch (e) {
    ztoolkit.log("[BN markdown mode] selection capture error", e);
  }

  let md: string;
  try {
    md = await noteToMD(noteItem);
  } catch (e) {
    ztoolkit.log("[BN markdown mode] enter error", e);
    showHint(getString("markdownMode-loadError"));
    return;
  }
  if (
    Components.utils.isDeadWrapper(win) ||
    isMarkdownMode(editor) ||
    staleHandle()
  ) {
    return;
  }
  const doc = win.document;
  const editorElem = doc.querySelector(".editor");
  if (!editorElem || doc.querySelector(".bn-md-editor")) {
    return;
  }

  const state: MarkdownModeState = {
    active: true,
    noteItem,
    saving: Promise.resolve(),
    lastSyncedMD: md,
    lastSavedNoteHTML: noteItem.getNote(),
    lastScrollTop: 0,
  };
  states.set(editor._iframeWindow, state);
  modeOverrides.set(editor._iframeWindow, {
    noteID: noteItem.id,
    markdown: true,
  });

  const container = ztoolkit.UI.appendElement(
    {
      tag: "div",
      classList: ["bn-md-editor"],
    },
    editorElem,
  ) as HTMLDivElement;
  state.container = container;

  // Preferred editor: syntax-highlighting CodeMirror, injected on demand.
  let usingCM = false;
  try {
    await injectMarkdownEditorScript(win);
    const api = getMdEditorAPI(win);
    if (api) {
      usingCM = !!api.create(
        container,
        md,
        Components.utils.cloneInto(
          {
            onChange: () => {
              scheduleSave(editor);
            },
            onSave: () => {
              flushSave(editor);
            },
            getPreview: (
              kind: string,
              raw: string,
              setContent: (html: string) => void,
            ) => {
              getNodePreviewContent(editor, kind, raw, setContent);
            },
            getNodeActions: (
              kind: string,
              raw: string,
              neighborsJSON: string,
              setActions: (actionsJSON: string) => void,
            ) => {
              getMarkdownNodeActions(
                editor,
                kind,
                raw,
                neighborsJSON,
                setActions,
              );
            },
            onNodeAction: (
              id: string,
              kind: string,
              raw: string,
              applyEdit: (newText: string, trimBefore?: boolean) => void,
            ) => {
              handleMarkdownNodeAction(editor, id, kind, raw, applyEdit).catch(
                (e) => ztoolkit.log("[BN markdown mode] node action error", e),
              );
            },
            getMagicCommands: (setCommands: (commandsJSON: string) => void) => {
              try {
                getMarkdownMagicCommands(editor, setCommands);
              } catch (e) {
                ztoolkit.log("[BN markdown mode] magic commands error", e);
              }
            },
            onMagicCommand: (id: string) => {
              handleMarkdownMagicCommand(editor, container, id).catch((e) =>
                ztoolkit.log("[BN markdown mode] magic command error", e),
              );
            },
            openURL: (url: string) => {
              Zotero.getActiveZoteroPane().loadURI(url);
            },
            convertPaste: (
              html: string,
              plain: string,
              setResult: (md: string) => void,
            ) => {
              convertPastedHTMLToMarkdown(editor, html).then(
                (md) => setResult(md),
                (e) => {
                  ztoolkit.log("[BN markdown mode] paste convert error", e);
                  // Fall back to the plain-text flavor.
                  setResult(plain);
                },
              );
            },
          },
          win,
          { wrapReflectors: true, cloneFunctions: true },
        ),
        // Undo history of the previous markdown-mode session on this note.
        addon.data.markdownMode.history.get(noteItem.id),
        JSON.stringify({
          magicKey: !!getPref("editor.useMagicKey"),
          magicKeyShortcut: !!getPref("editor.useMagicKeyShortcut"),
        }),
      );
    }
  } catch (e) {
    ztoolkit.log("[BN markdown mode] highlighter init error", e);
  }

  if (usingCM) {
    state.getValue = () => {
      try {
        return getMdEditorAPI(win)?.getValue(container);
      } catch (e) {
        return undefined;
      }
    };
    state.setValue = (value, keepView) => {
      try {
        getMdEditorAPI(win)?.setValue(container, value, keepView);
      } catch (e) {
        ztoolkit.log("[BN markdown mode] setValue error", e);
      }
    };
    state.getSelection = () => {
      try {
        const selection = getMdEditorAPI(win)?.getSelection(container);
        return selection
          ? { anchor: selection.anchor, head: selection.head }
          : undefined;
      } catch (e) {
        return undefined;
      }
    };
    state.setSelection = (anchor, head, scrollIntoView = true) => {
      try {
        getMdEditorAPI(win)?.setSelection(
          container,
          anchor,
          head,
          scrollIntoView,
        );
      } catch (e) {
        ztoolkit.log("[BN markdown mode] setSelection error", e);
      }
    };
    state.getScroll = () => {
      try {
        return getMdEditorAPI(win)?.getScroll(container);
      } catch (e) {
        return undefined;
      }
    };
    state.setScroll = (top) => {
      try {
        getMdEditorAPI(win)?.setScroll(container, top);
      } catch (e) {
        // The iframe may be gone.
      }
    };
    state.focusEditor = () => {
      try {
        getMdEditorAPI(win)?.focus(container);
      } catch (e) {
        // The iframe may be gone.
      }
    };
    const scroller = container.querySelector(
      ".cm-scroller",
    ) as HTMLElement | null;
    scroller?.addEventListener(
      "scroll",
      () => {
        // A hidden/detached scroller reads 0; don't let that clobber the
        // tracked position right before the restore captures it.
        if (scroller.offsetHeight > 0) {
          const top = state.getScroll?.();
          if (typeof top === "number") {
            state.lastScrollTop = top;
          }
        }
      },
      { passive: true },
    );
  } else {
    // Fallback: plain textarea without highlighting.
    setupFallbackTextarea(editor, state, container, md);
  }

  doc.body.classList.add("bn-md-mode");
  doc.querySelector(".toolbar .bn-md-toggle")?.classList.add("active");
  try {
    buildMarkdownToolbar(editor, state, container);
  } catch (e) {
    ztoolkit.log("[BN markdown mode] toolbar error", e);
  }

  // Reflect external changes (sync, templates, other editors of the same
  // note) into the markdown view when there are no unsaved md edits.
  state.notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event, type, ids, extraData) => {
        if (
          event === "modify" &&
          type === "item" &&
          (ids as (number | string)[]).includes(noteItem.id)
        ) {
          // Echo: after our save the hidden view re-saves its normalized
          // serialization; reloading for it would move cursor and scroll.
          const sourceEditorID = (extraData as any)?.[noteItem.id]
            ?.noteEditorID;
          if (sourceEditorID && sourceEditorID === (editor as any).instanceID) {
            state.lastSavedNoteHTML = noteItem.getNote();
            return;
          }
          refreshFromNote(editor).catch((e) =>
            ztoolkit.log("[BN markdown mode] refresh error", e),
          );
        }
      },
    },
    ["item"],
  );

  // The iframe is torn down without notice when the tab/window closes or the
  // editor is reinitialized; flush unsaved markdown before that.
  state.pageHideListener = () => {
    let value: string | undefined;
    try {
      value = state.getValue?.();
    } catch (e) {
      // The view may already be dead (e.g. the editor was replaced and this
      // fires at destruction); don't record a bogus view state then.
    }
    if (typeof value === "string") {
      // Keep the reading position for when the note is reopened in md mode.
      addon.data.markdownMode.viewState.set(
        noteItem.id,
        captureMarkdownViewState(state),
      );
      captureMarkdownHistory(win, state);
    }
    cancelScheduledSave(state);
    unregisterListeners(state);
    state.active = false;
    if (typeof value === "string" && value !== state.lastSyncedMD) {
      // The conversion survives the iframe; chain onto the save queue so an
      // in-flight save can't overwrite this with older content.
      state.saving = state.saving.then(() =>
        saveContentToNote(noteItem, value).then(
          () => undefined,
          (e) => ztoolkit.log("[BN markdown mode] pagehide save error", e),
        ),
      );
    }
    states.delete(editor._iframeWindow);
  };
  win.addEventListener("pagehide", state.pageHideListener);

  // An editor re-render can drop the overlay while the mode is active;
  // watch for that and re-establish (init re-enters with the saved view).
  state.watchTimer = ztoolkit.getGlobal("setInterval")(() => {
    if (
      !addon.data.alive ||
      !state.active ||
      Components.utils.isDeadWrapper(win)
    ) {
      if (state.watchTimer) {
        ztoolkit.getGlobal("clearInterval")(state.watchTimer);
        state.watchTimer = undefined;
      }
      return;
    }
    if (!state.container?.isConnected) {
      ztoolkit.getGlobal("clearInterval")(state.watchTimer);
      state.watchTimer = undefined;
      // Only re-establish while the pane still shows this note; an item
      // switch is handled by the new editor's own initialization.
      if (currentWindowNoteID(win) === noteItem.id) {
        initEditorMarkdownMode(editor).catch((e) =>
          ztoolkit.log("[BN markdown mode] restore error", e),
        );
      }
    }
  }, 1000) as unknown as number;

  state.focusEditor?.();
  try {
    // A view state saved at an unexpected teardown wins: the rich-text
    // selection resets then, which would map the markdown view to the top.
    const savedView = addon.data.markdownMode.viewState.get(noteItem.id);
    addon.data.markdownMode.viewState.delete(noteItem.id);
    if (savedView) {
      // If the scroll position was lost (a dropped overlay reads 0) but
      // there is a real selection, center the view on it instead.
      const scrollLost =
        !savedView.scrollTop && (savedView.anchor > 0 || savedView.head > 0);
      state.setSelection?.(savedView.anchor, savedView.head, scrollLost);
      if (!scrollLost) {
        state.setScroll?.(savedView.scrollTop);
        state.lastScrollTop = savedView.scrollTop;
      }
    } else if (anchorInfo) {
      const anchorOffset = markdownOffsetForLine(
        md,
        anchorInfo.lineIndex,
        anchorInfo.snippet,
      );
      const headOffset =
        headInfo && headInfo !== anchorInfo
          ? markdownOffsetForLine(md, headInfo.lineIndex, headInfo.snippet)
          : anchorOffset;
      state.setSelection?.(anchorOffset, headOffset);
    }
  } catch (e) {
    ztoolkit.log("[BN markdown mode] selection restore error", e);
  }
}

/**
 * Save the serialized editor state (doc + undo history) so re-entering the
 * mode keeps the undo history; call while the view is still alive.
 */
function captureMarkdownHistory(win: Window, state: MarkdownModeState) {
  if (!state.container || Components.utils.isDeadWrapper(win)) {
    return;
  }
  let json: string | undefined;
  try {
    json = getMdEditorAPI(win)?.getStateJSON(state.container);
  } catch (e) {
    // The view may already be dead; keep any previously captured history.
    return;
  }
  if (!json) {
    return;
  }
  const map = addon.data.markdownMode.history;
  map.delete(state.noteItem.id);
  map.set(state.noteItem.id, json);
  // Serialized states carry the full doc and edit history; bound the
  // per-session cache, dropping the least recently saved notes.
  while (map.size > 20) {
    map.delete(map.keys().next().value!);
  }
}

/** Selection + scroll of an active or recently orphaned markdown view. */
function captureMarkdownViewState(state: MarkdownModeState) {
  let selection;
  try {
    selection = state.getSelection?.();
  } catch (e) {
    // Ignore; fall back to the tracked scroll only.
  }
  const liveScroll = state.getScroll?.();
  return {
    anchor: selection?.anchor ?? 0,
    head: selection?.head ?? 0,
    // A detached scroller reads 0; prefer the last tracked position then.
    scrollTop: liveScroll || state.lastScrollTop,
  };
}

interface RichTextEndpoint {
  lineIndex: number;
  snippet: string;
}

function captureRichTextEndpoint(
  editor: Zotero.EditorInstance,
  position: number,
): RichTextEndpoint {
  const lineIndex = lineIndexAtPosition(editor, position);
  let snippet = "";
  const blockStart = getPositionAtLine(editor, lineIndex, "start") + 1;
  if (position > blockStart) {
    snippet = getTextBetween(editor, blockStart, position);
  }
  return { lineIndex, snippet };
}

function lineIndexAtPosition(editor: Zotero.EditorInstance, position: number) {
  const count = getLineCount(editor);
  for (let i = 0; i < count; i++) {
    if (position <= getPositionAtLine(editor, i, "end")) {
      return i;
    }
  }
  return Math.max(0, count - 1);
}

function setupFallbackTextarea(
  editor: Zotero.EditorInstance,
  state: MarkdownModeState,
  container: HTMLDivElement,
  md: string,
) {
  const textarea = ztoolkit.UI.appendElement(
    {
      tag: "textarea",
      classList: ["bn-md-textarea"],
      attributes: {
        spellcheck: "false",
      },
      listeners: [
        {
          type: "input",
          listener: () => {
            scheduleSave(editor);
          },
        },
        {
          type: "keydown",
          listener: (e) => {
            const event = e as KeyboardEvent;
            if (event.key === "Tab") {
              event.preventDefault();
              insertTextAtCursor(event.target as HTMLTextAreaElement, "  ");
              scheduleSave(editor);
            } else if (
              event.key.toLowerCase() === "s" &&
              (Zotero.isMac ? event.metaKey : event.ctrlKey)
            ) {
              event.preventDefault();
              flushSave(editor);
            }
          },
        },
      ],
    },
    container,
  ) as HTMLTextAreaElement;
  textarea.value = md;

  state.getValue = () => {
    if (Components.utils.isDeadWrapper(textarea)) {
      return undefined;
    }
    return textarea.value;
  };
  state.setValue = (value, keepView) => {
    if (Components.utils.isDeadWrapper(textarea)) {
      return;
    }
    if (keepView) {
      const { selectionStart, selectionEnd, scrollTop } = textarea;
      textarea.value = value;
      textarea.selectionStart = Math.min(selectionStart, value.length);
      textarea.selectionEnd = Math.min(selectionEnd, value.length);
      textarea.scrollTop = scrollTop;
    } else {
      textarea.value = value;
    }
  };
  state.getSelection = () => {
    if (Components.utils.isDeadWrapper(textarea)) {
      return undefined;
    }
    // Textareas store an ordered range plus a direction; convert to
    // anchor/head so the direction survives the round trip.
    const { selectionStart, selectionEnd, selectionDirection } = textarea;
    return selectionDirection === "backward"
      ? { anchor: selectionEnd, head: selectionStart }
      : { anchor: selectionStart, head: selectionEnd };
  };
  state.setSelection = (anchor, head) => {
    if (Components.utils.isDeadWrapper(textarea)) {
      return;
    }
    const max = textarea.value.length;
    const anchorPos = Math.max(0, Math.min(anchor, max));
    const headPos = Math.max(0, Math.min(head, max));
    textarea.setSelectionRange(
      Math.min(anchorPos, headPos),
      Math.max(anchorPos, headPos),
      headPos < anchorPos ? "backward" : "forward",
    );
  };
  state.getScroll = () => {
    if (Components.utils.isDeadWrapper(textarea)) {
      return undefined;
    }
    return textarea.scrollTop;
  };
  state.setScroll = (top) => {
    if (!Components.utils.isDeadWrapper(textarea)) {
      textarea.scrollTop = top;
    }
  };
  state.focusEditor = () => {
    if (!Components.utils.isDeadWrapper(textarea)) {
      textarea.focus();
    }
  };
  textarea.addEventListener(
    "scroll",
    () => {
      state.lastScrollTop = textarea.scrollTop;
    },
    { passive: true },
  );
}

async function exitMarkdownMode(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return;
  }
  modeOverrides.set(editor._iframeWindow, {
    noteID: state.noteItem.id,
    markdown: false,
  });
  addon.data.markdownMode.viewState.delete(state.noteItem.id);
  // Capture the markdown selection before teardown so it can be restored in
  // the rich-text view.
  let mdValue: string | undefined;
  let mdSelection: { anchor: number; head: number } | undefined;
  try {
    mdValue = state.getValue?.();
    mdSelection = state.getSelection?.();
  } catch (e) {
    ztoolkit.log("[BN markdown mode] selection capture error", e);
  }
  // Keep the undo history for the next markdown-mode session on this note.
  captureMarkdownHistory(editor._iframeWindow, state);
  // Flush unsaved changes and let the hidden editor apply them: the reveal
  // shows the fresh document and the restore positions against it.
  await flushSaveAndSettle(editor);
  state.active = false;
  unregisterListeners(state);
  states.delete(editor._iframeWindow);

  const win = editor._iframeWindow;
  if (!Components.utils.isDeadWrapper(win)) {
    const doc = win.document;
    if (state.pageHideListener) {
      win.removeEventListener("pagehide", state.pageHideListener);
    }
    if (state.citationListener) {
      win.removeEventListener("message", state.citationListener);
      state.citationListener = undefined;
    }
    if (state.container) {
      try {
        getMdEditorAPI(win)?.destroy(state.container);
      } catch (e) {
        // The highlighter may never have been injected.
      }
      state.container.remove();
    }
    state.mdToolbar?.remove();
    doc.body.classList.remove("bn-md-mode");
    doc.querySelector(".toolbar .bn-md-toggle")?.classList.remove("active");
    editor.focus();
    if (typeof mdValue === "string" && mdSelection) {
      restoreRichTextSelection(editor, mdValue, mdSelection).catch((e) =>
        ztoolkit.log("[BN markdown mode] selection restore error", e),
      );
    }
  }
}

/**
 * Map a markdown selection back to the rich-text view: block index from the
 * block layout, in-block position from the preceding plain text.
 */
async function restoreRichTextSelection(
  editor: Zotero.EditorInstance,
  md: string,
  selection: { anchor: number; head: number },
) {
  const blocks = segmentMarkdownBlocks(md);
  if (!blocks.length) {
    return;
  }
  const anchor = markdownLocationAtOffset(blocks, md, selection.anchor);
  const head =
    selection.head === selection.anchor
      ? anchor
      : markdownLocationAtOffset(blocks, md, selection.head);
  if (Components.utils.isDeadWrapper(editor._iframeWindow)) {
    return;
  }
  const core = getEditorCore(editor);
  const EditorAPI = getEditorAPI(editor);
  EditorAPI.setSelectionAtBlockTextOffset(
    anchor.blockIndex,
    anchor.textOffset,
    head.blockIndex,
    head.textOffset,
  )(core.view.state, core.view.dispatch);
}

function markdownLocationAtOffset(
  blocks: MDBlock[],
  md: string,
  offset: number,
) {
  let blockIndex = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].start <= offset) {
      blockIndex = i;
    } else {
      break;
    }
  }
  const block = blocks[blockIndex];
  const before = md.slice(
    block.start,
    Math.max(block.start, Math.min(offset, block.end)),
  );
  return { blockIndex, textOffset: estimatePlainTextOffset(before) };
}

function unregisterListeners(state: MarkdownModeState) {
  if (state.notifierID) {
    Zotero.Notifier.unregisterObserver(state.notifierID);
    state.notifierID = undefined;
  }
  if (state.watchTimer) {
    ztoolkit.getGlobal("clearInterval")(state.watchTimer);
    state.watchTimer = undefined;
  }
}

function scheduleSave(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return;
  }
  cancelScheduledSave(state);
  state.saveTimer = ztoolkit.getGlobal("setTimeout")(() => {
    state.saveTimer = undefined;
    saveMarkdown(editor).catch((e) =>
      ztoolkit.log("[BN markdown mode] save error", e),
    );
  }, SAVE_DEBOUNCE_MS) as unknown as number;
}

function cancelScheduledSave(state: MarkdownModeState) {
  if (state.saveTimer) {
    ztoolkit.getGlobal("clearTimeout")(state.saveTimer);
    state.saveTimer = undefined;
  }
}

/** Flush unsaved markdown; resolves to whether a save actually happened. */
async function flushSave(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state) {
    return false;
  }
  cancelScheduledSave(state);
  return await saveMarkdown(editor);
}

/**
 * The hidden editor's ProseMirror doc as an identity token: any applied
 * update replaces it, marking whether an update has landed.
 */
function richTextDocRef(editor: Zotero.EditorInstance): unknown {
  try {
    return getEditorCore(editor).view.state.doc;
  } catch (e) {
    return undefined;
  }
}

/**
 * Wait (bounded) until the hidden rich-text editor applies an update — a
 * flushed save reaches it asynchronously via the notifier.
 */
async function waitForRichTextUpdate(
  editor: Zotero.EditorInstance,
  beforeDoc: unknown,
) {
  if (beforeDoc === undefined) {
    return;
  }
  try {
    await waitUtilAsync(() => richTextDocRef(editor) !== beforeDoc, 20, 1000);
  } catch (e) {
    // Timed out; proceed with the current document.
  }
}

/**
 * Flush unsaved markdown and, if something was saved, wait until the hidden
 * rich-text editor has applied the resulting update.
 */
async function flushSaveAndSettle(editor: Zotero.EditorInstance) {
  const beforeDoc = richTextDocRef(editor);
  if (await flushSave(editor)) {
    await waitForRichTextUpdate(editor, beforeDoc);
  }
}

async function saveMarkdown(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return false;
  }
  let saved = false;
  const run = async () => {
    const content = state.getValue?.();
    if (typeof content !== "string" || content === state.lastSyncedMD) {
      return;
    }
    const noteItem = state.noteItem;
    try {
      state.lastSavedNoteHTML = await saveContentToNote(noteItem, content);
      state.lastSyncedMD = content;
      saved = true;
    } catch (e) {
      ztoolkit.log("[BN markdown mode] save error", e);
      showHint(getString("markdownMode-saveError"));
    }
  };
  state.saving = state.saving.then(run);
  await state.saving;
  return saved;
}

/**
 * Convert markdown to note HTML and persist it. Touches nothing in the
 * iframe, so it can finish after teardown; editors update via the notifier.
 */
async function saveContentToNote(noteItem: Zotero.Item, content: string) {
  const html = await md2note(
    {
      content,
      filedir: Zotero.getTempDirectory().path,
      filename: "",
      lastmodify: new Date(),
      meta: null,
    },
    noteItem,
    { isImport: true },
  );
  const noteStatus = addon.api.sync.getNoteStatus(noteItem.id)!;
  noteItem.setNote(noteStatus.meta + html + noteStatus.tail);
  await noteItem.saveTx({
    notifierData: {
      autoSyncDelay: Zotero.Notes.AUTO_SYNC_DELAY,
    },
  });
  // Read back after the save so any normalization applied while saving is
  // part of the recorded echo state.
  return noteItem.getNote();
}

async function refreshFromNote(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return;
  }
  const noteItem = state.noteItem;
  const currentHTML = noteItem.getNote();
  if (currentHTML === state.lastSavedNoteHTML) {
    // Echo of our own save.
    return;
  }
  if (state.getValue?.() !== state.lastSyncedMD) {
    // There are unsaved markdown edits; don't clobber them. The next save
    // wins, like the sync feature's "md ahead" case.
    return;
  }
  let md: string;
  try {
    md = await noteToMD(noteItem);
  } catch (e) {
    ztoolkit.log("[BN markdown mode] refresh error", e);
    return;
  }
  // Re-check: the mode may have been exited or edited during the conversion.
  if (!state.active || state.getValue?.() !== state.lastSyncedMD) {
    return;
  }
  state.lastSavedNoteHTML = currentHTML;
  state.lastSyncedMD = md;
  if (state.getValue?.() === md) {
    return;
  }
  state.setValue?.(md, true);
}

// Icons from the note editor (zotero note-editor res/icons), so the
// markdown toolbar looks native.
const MD_TOOLBAR_ICONS: Record<string, string> = {
  formatText: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_468_18264)"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 16L7 4H5L0 16H2.16667L3.41667 13H8.58333L9.83333 16H12ZM7.95833 11.5L6 6.8L4.04167 11.5H7.95833ZM18.0001 14.6493C17.3649 15.4828 16.4795 16 15.5001 16C13.5671 16 12.0001 13.9853 12.0001 11.5C12.0001 9.01472 13.5671 7 15.5001 7C16.4795 7 17.3649 7.51716 18.0001 8.35066V7H20.0001V16H18.0001V14.6493ZM18.0001 11.5C18.0001 13.1569 17.1047 14.5 16.0001 14.5C14.8955 14.5 14.0001 13.1569 14.0001 11.5C14.0001 9.84315 14.8955 8.5 16.0001 8.5C17.1047 8.5 18.0001 9.84315 18.0001 11.5Z" fill="currentColor"/></g><defs><clipPath id="clip0_468_18264"><rect width="20" height="20" fill="white"/></clipPath></defs></svg>`,
  bold: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M4 8V4.5V2H7.5H12C13.933 2 15.5 3.567 15.5 5.5C15.5 7.433 13.933 9 12 9C14.2091 9 16 10.7909 16 13C16 15.2091 14.2091 17 12 17H7.5H4V14.5V10.5V8ZM7.5 10.5V14.5H10.5C11.6046 14.5 12.5 13.6046 12.5 12.5C12.5 11.3954 11.6046 10.5 10.5 10.5H7.5ZM7.5 8V4.5H10.25C11.2165 4.5 12 5.2835 12 6.25C12 7.2165 11.2165 8 10.25 8H7.5Z" fill="currentColor"/></svg>`,
  italic: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 2H15V4H12.0164L11.9839 4.17889L10.0164 15H13V17H5V15H7.98361L8.01613 14.8211L9.98361 4H7V2Z" fill="currentColor"/></svg>`,
  underline: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 2H4V11C4 14.5836 6.71815 17 10 17C13.2819 17 16 14.5836 16 11V2H14V11C14 13.4164 12.241 15 10 15C7.75901 15 6 13.4164 6 11V2ZM4 19V17.75H16V19H4Z" fill="currentColor"/></svg>`,
  strikethrough: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 2C8.85166 2 7.64614 2.28406 6.6953 2.91795C5.71482 3.5716 5 4.61209 5 6C5 6.77149 5.16552 7.44802 5.49725 8.02784C5.71987 8.41695 6.00217 8.73606 6.31739 9H2V10.25H9.10026C9.38748 10.3245 9.66916 10.3907 9.93645 10.4535L9.93646 10.4536L10.021 10.4734C11.1302 10.7344 12.0126 10.9532 12.6404 11.3471C12.9309 11.5294 13.1326 11.7308 13.2668 11.9653C13.3999 12.198 13.5 12.5215 13.5 13C13.5 13.9401 13.1463 14.4997 12.6183 14.8653C12.0364 15.2682 11.1404 15.5 10 15.5C7.79256 15.5 6.5 14.2197 6.5 13H4.5C4.5 15.7803 7.20744 17.5 10 17.5C11.3596 17.5 12.7136 17.2318 13.7567 16.5097C14.8537 15.7503 15.5 14.5599 15.5 13C15.5 12.2285 15.3345 11.552 15.0028 10.9722C14.8462 10.6985 14.6602 10.4595 14.4539 10.25H18V9H12.2582C11.6828 8.80946 11.0947 8.67127 10.5635 8.54645L10.5635 8.54645L10.479 8.52658C9.36982 8.26559 8.48741 8.04685 7.85962 7.65294C7.56905 7.47062 7.36738 7.26916 7.23322 7.03466C7.1001 6.80198 7 6.47851 7 6C7 5.38791 7.28518 4.9284 7.8047 4.58205C8.35386 4.21594 9.14834 4 10 4C10.8517 4 11.6461 4.21594 12.1953 4.58205C12.7148 4.9284 13 5.38791 13 6H15C15 4.61209 14.2852 3.5716 13.3047 2.91795C12.3539 2.28406 11.1483 2 10 2Z" fill="currentColor"/></svg>`,
  subscript: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.809 9.5L1.95605 2H4.33823L8.00008 7.65923L11.6619 2H14.0441L9.19117 9.5L14.0441 17H11.6619L8.00008 11.3408L4.33823 17H1.95605L6.809 9.5ZM17.4697 15.2197L15 17.6893V19H15.5H20V17.5H17.3107L18.5303 16.2803C19.3008 15.5099 20 14.5711 20 13.5C20 12.9749 19.8289 12.3634 19.4242 11.8688C19.0004 11.3508 18.3498 11 17.5 11C16.6502 11 15.9996 11.3508 15.5758 11.8688C15.1711 12.3634 15 12.9749 15 13.5H16.5C16.5 13.2751 16.5789 13.0116 16.7367 12.8187C16.8754 12.6492 17.0998 12.5 17.5 12.5C17.9002 12.5 18.1246 12.6492 18.2633 12.8187C18.4211 13.0116 18.5 13.2751 18.5 13.5C18.5 13.9289 18.1992 14.4901 17.4697 15.2197Z" fill="currentColor"/></svg>`,
  superscript: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M17.4697 4.21967L15 6.68934V8H15.5H20V6.5H17.3107L18.5303 5.28033C19.3008 4.50988 20 3.57109 20 2.5C20 1.97495 19.8289 1.36341 19.4242 0.868822C19.0004 0.350834 18.3498 0 17.5 0C16.6502 0 15.9996 0.350834 15.5758 0.868822C15.1711 1.36341 15 1.97495 15 2.5H16.5C16.5 2.27505 16.5789 2.01159 16.7367 1.81868C16.8754 1.64917 17.0998 1.5 17.5 1.5C17.9002 1.5 18.1246 1.64917 18.2633 1.81868C18.4211 2.01159 18.5 2.27505 18.5 2.5C18.5 2.92891 18.1992 3.49012 17.4697 4.21967ZM6.809 9.5L1.95605 2H4.33823L8.00008 7.65923L11.6619 2H14.0441L9.19117 9.5L14.0441 17H11.6619L8.00008 11.3408L4.33823 17H1.95605L6.809 9.5Z" fill="currentColor"/></svg>`,
  code: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.11621 16L7.00009 15.1161L1.88398 10L7.00009 4.88388L6.11621 4L0.116211 10L6.11621 16ZM13.884 16L13.0001 15.1161L18.1162 10L13.0001 4.88388L13.884 4L19.884 10L13.884 16Z" fill="currentColor"/></svg>`,
  clearFormat: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.3377 10.0105L7 2H5L0 14H2.16667L3.41667 11H8.58333L8.80831 11.5399L10.3377 10.0105ZM6 4.8L4.04167 9.5H7.95833L6 4.8ZM14.6161 7.5C15.1043 7.01184 15.8957 7.01185 16.3839 7.5L19.5 10.6161C19.9882 11.1043 19.9882 11.8957 19.5 12.3839L13.3839 18.5C12.8957 18.9882 12.1043 18.9882 11.6161 18.5L8.5 15.3839C8.01184 14.8957 8.01185 14.1043 8.5 13.6161L14.6161 7.5ZM11 12.8839L9.38388 14.5L12.5 17.6161L14.1161 16L11 12.8839ZM11.8839 12L15 15.1161L18.6161 11.5L15.5 8.38388L11.8839 12Z" fill="currentColor"/></svg>`,
  link: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_1132_37385)"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 8.125C0 5.70875 1.95875 3.75 4.375 3.75H9.625C12.0412 3.75 14 5.70875 14 8.125C14 10.5412 12.0412 12.5 9.625 12.5H8.60669C8.5376 12.3045 8.5 12.0941 8.5 11.875C8.5 11.6559 8.5376 11.4455 8.60669 11.25H9.625C11.3509 11.25 12.75 9.85089 12.75 8.125C12.75 6.39911 11.3509 5 9.625 5H4.375C2.64911 5 1.25 6.39911 1.25 8.125C1.25 9.85089 2.64911 11.25 4.375 11.25H4.78433C4.76165 11.4552 4.75 11.6637 4.75 11.875C4.75 12.0863 4.76165 12.2948 4.78433 12.5H4.375C1.95875 12.5 0 10.5412 0 8.125ZM10.3751 7.49999H11.3934C11.4625 7.69547 11.5001 7.90584 11.5001 8.12499C11.5001 8.34413 11.4625 8.5545 11.3934 8.74999H10.3751C8.64919 8.74999 7.25008 10.1491 7.25008 11.875C7.25008 13.6009 8.64919 15 10.3751 15H15.6251C17.351 15 18.7501 13.6009 18.7501 11.875C18.7501 10.1491 17.351 8.74999 15.6251 8.74999H15.2157C15.2384 8.54478 15.2501 8.33624 15.2501 8.12499C15.2501 7.91373 15.2384 7.7052 15.2157 7.49999H15.6251C18.0413 7.49999 20.0001 9.45874 20.0001 11.875C20.0001 14.2912 18.0413 16.25 15.6251 16.25H10.3751C7.95883 16.25 6.00008 14.2912 6.00008 11.875C6.00008 9.45874 7.95883 7.49999 10.3751 7.49999Z" fill="currentColor"/></g><defs><clipPath id="clip0_1132_37385"><rect width="20" height="20" fill="white"/></clipPath></defs></svg>`,
  cite: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_1132_37395)"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 11H17V9.75H3V11ZM3 6.75H17V8H3V6.75ZM3 12.75H12V14H3V12.75ZM6 4.5H3.5V2L4.5 0H5.5L4.5 2H6V4.5ZM1 0H2L1 2H2.5V4.5H0V2L1 0ZM16.5 15.5H14V18H15.5L14.5 20H15.5L16.5 18V15.5ZM18 20H19L20 18V15.5H17.5V18H19L18 20Z" fill="currentColor"/></g><defs><clipPath id="clip0_1132_37395"><rect width="20" height="20" fill="white"/></clipPath></defs></svg>`,
  magnifier: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.75 7.5C12.75 10.3995 10.3995 12.75 7.5 12.75C4.60051 12.75 2.25 10.3995 2.25 7.5C2.25 4.60051 4.60051 2.25 7.5 2.25C10.3995 2.25 12.75 4.60051 12.75 7.5ZM11.6331 12.5169C10.5097 13.4435 9.06986 14 7.5 14C3.91015 14 1 11.0899 1 7.5C1 3.91015 3.91015 1 7.5 1C11.0899 1 14 3.91015 14 7.5C14 9.06984 13.4435 10.5097 12.517 11.6331L19 18.1161L18.1162 19L11.6331 12.5169Z" fill="currentColor"/></svg>`,
  removeColor: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2ZM1 3C1 1.89543 1.89543 1 3 1H13C14.1046 1 15 1.89543 15 3V13C15 14.1046 14.1046 15 13 15H3C1.89543 15 1 14.1046 1 13V3ZM12 11.292L11.2923 12L8.00011 8.70699L4.70796 12L4 11.2922L7.29311 7.99999L4 4.70774L4.70798 4L8.00011 7.29299L11.2922 4L12 4.70796L8.70711 7.99999L12 11.292Z" fill="currentColor" fill-opacity="0.85"/></svg>`,
};

// The note editor's node-popup icons (res/icons/16), for the chip popups.
const MD_POPUP_ICONS: Record<string, string> = {
  page: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 0H9.70711L15 5.29289V16H2V0ZM3 1V15H14V6H9V1H3ZM10 1.70711L13.2929 5H10V1.70711Z" fill="currentColor"/></svg>`,
  showItem: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.70711 0H0V16H9.87876L8.87876 15H1V1H7V6H12V8.2928L13 9.29304V5.29289L7.70711 0ZM11.2929 5L8 1.70711V5H11.2929ZM11.293 9L7.79297 12.5L11.293 16L12 15.2928L9.70717 13H18V12H9.70719L12 9.70719L11.293 9Z" fill="currentColor"/></svg>`,
  cite: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_1153_36703)"><path fill-rule="evenodd" clip-rule="evenodd" d="M5 4V2H4L4.5 0.5H3.5L3 2V4H5ZM0 2V4H2V2H1L1.5 0.5H0.5L0 2ZM14 9H2V8H14V9ZM14 6H2V7H14V6ZM9 10H2V11H9V10ZM13 12H11V14H12L11.5 15.5H12.5L13 14V12ZM16 12H14V14H15L14.5 15.5H15.5L16 14V12Z" fill="currentColor"/></g><defs><clipPath id="clip0_1153_36703"><rect width="16" height="16" fill="white"/></clipPath></defs></svg>`,
  hide: `<svg width="16" height="12" viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 0.707046L13.2929 12L14 11.2929L2.70705 0L2 0.707046Z" fill="currentColor"/><path d="M0.581543 5.99999C1.06648 4.80201 1.83317 3.74823 2.79944 2.92083L3.50889 3.63027C2.73879 4.27498 2.1093 5.0824 1.67338 5.99999C2.79758 8.3664 5.20911 10 8.00003 10C8.57782 10 9.13935 9.92999 9.67657 9.79795L10.4851 10.6065C9.70287 10.8619 8.86758 11 8.00003 11C4.64265 11 1.76831 8.93183 0.581543 5.99999Z" fill="currentColor"/><path d="M6.32325 2.20211L5.51471 1.39357C6.29703 1.13812 7.13239 1 8.00002 1C11.3574 1 14.2317 3.06818 15.4185 6.00001C14.9335 7.19806 14.1668 8.25189 13.2004 9.07931L12.491 8.36986C13.2612 7.72513 13.8907 6.91767 14.3267 6.00001C13.2025 3.6336 10.7909 2 8.00002 2C7.42214 2 6.86053 2.07004 6.32325 2.20211Z" fill="currentColor"/><path d="M11 6C11 6.26879 10.9647 6.52933 10.8983 6.77721L9.99616 5.87502C9.93419 4.87 9.13 4.06581 8.12498 4.00384L7.22279 3.10165C7.47067 3.03535 7.73121 3 8 3C9.65685 3 11 4.34315 11 6Z" fill="currentColor"/><path d="M5.1016 5.22298L6.00386 6.12524C6.06594 7.13005 6.86995 7.93406 7.87476 7.99614L8.77702 8.8984C8.52919 8.96467 8.26872 9 8 9C6.34315 9 5 7.65685 5 6C5 5.73128 5.03533 5.47081 5.1016 5.22298Z" fill="currentColor"/></svg>`,
  unlink: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_1153_36699)"><path d="M12 3H11V1H12V3ZM5 13H4V15H5V13ZM15 3H13V4H15V3ZM3 12H0.999998V13H3V12ZM13 6.05V7.05C13.6076 7.17337 14.1476 7.5181 14.5153 8.01726C14.883 8.51643 15.0522 9.13441 14.9899 9.75125C14.9275 10.3681 14.6383 10.9398 14.1782 11.3553C13.7181 11.7709 13.12 12.0006 12.5 12H8.5C7.88088 11.9994 7.284 11.7691 6.82493 11.3537C6.36587 10.9383 6.07728 10.3673 6.01505 9.7513C5.95281 9.13531 6.12136 8.51814 6.48806 8.0193C6.85475 7.52045 7.39351 7.17542 8 7.051V6.051C7.12491 6.17583 6.32973 6.62787 5.77485 7.31596C5.21997 8.00404 4.94669 8.87696 5.01012 9.75862C5.07356 10.6403 5.469 11.4651 6.11667 12.0666C6.76435 12.6682 7.61606 13.0017 8.5 13H12.5C13.3852 13.0036 14.2387 12.6708 14.8879 12.0691C15.5371 11.4674 15.9336 10.6415 15.9971 9.7586C16.0606 8.87569 15.7865 8.00161 15.2301 7.31313C14.6737 6.62465 13.8766 6.17317 13 6.05ZM7.5 3H3.5C2.61481 2.99643 1.7613 3.32916 1.11209 3.9309C0.46288 4.53264 0.0664231 5.35848 0.0029043 6.2414C-0.0606146 7.12431 0.213545 7.99839 0.769934 8.68687C1.32632 9.37535 2.12342 9.82683 3 9.95V8.95C2.39242 8.82663 1.85236 8.4819 1.48465 7.98274C1.11695 7.48357 0.947836 6.86559 1.01014 6.24875C1.07245 5.63191 1.36173 5.06023 1.82183 4.64469C2.28193 4.22914 2.88002 3.99938 3.5 4H7.5C8.11912 4.00059 8.716 4.23089 9.17506 4.64631C9.63413 5.06173 9.92271 5.63272 9.98495 6.2487C10.0472 6.86469 9.87863 7.48186 9.51194 7.9807C9.14524 8.47955 8.60649 8.82458 8 8.949V9.949C8.87508 9.82417 9.67026 9.37213 10.2251 8.68404C10.78 7.99596 11.0533 7.12304 10.9899 6.24138C10.9264 5.35972 10.531 4.53492 9.88332 3.93336C9.23565 3.33181 8.38394 2.99826 7.5 3Z" fill="currentColor"/></g><defs><clipPath id="clip0_1153_36699"><rect width="16" height="16" fill="white"/></clipPath></defs></svg>`,
};

// Chip popup labels: the note editor's own fluent strings (the iframe has
// them localized), with English fallbacks if formatting fails.
const MD_POPUP_LABELS: Record<string, [string, string]> = {
  open: ["note-editor-go-to-page", "Go to Page"],
  showItem: ["note-editor-show-item", "Show Item"],
  edit: ["note-editor-edit-citation", "Edit Citation"],
  remove: ["note-editor-remove-citation", "Hide Citation"],
  unlink: ["note-editor-unlink", "Unlink"],
  addCitation: ["note-editor-add-citation", "Add Citation"],
};

async function popupLabel(win: Window, key: string) {
  const [l10nID, fallback] = MD_POPUP_LABELS[key];
  try {
    const label = await (win.document as any).l10n?.formatValue(l10nID);
    if (label) {
      return label as string;
    }
  } catch (e) {
    // Fall through to the English fallback.
  }
  return fallback;
}

// The note editor's custom color icons (custom-icons.js), as templates.
function mdTextColorIcon(color?: string) {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 14L11 2H9L4 14H6.16667L7.41667 11H12.5833L13.8333 14H16ZM10 4.8L8.04167 9.5H11.9583L10 4.8ZM2.25 17.75V16.25H17.75V17.75H2.25ZM1 15H2.25H17.75H19V16.25V17.75V19H17.75H2.25H1V17.75V16.25V15Z" fill="currentColor"/><path d="M1 15H19V19H1V15Z" fill="${color || "transparent"}"/></svg>`;
}

function mdHighlighterIcon(color?: string) {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.3839 1.5C12.8957 1.01184 12.1043 1.01184 11.6161 1.5L4.5 8.61611C4.01185 9.10427 4.01184 9.89572 4.5 10.3839L5.05806 10.9419L2 14H6L7.05806 12.9419L7.61612 13.5C8.10427 13.9882 8.89573 13.9882 9.38388 13.5L16.5 6.38388C16.9882 5.89573 16.9882 5.10427 16.5 4.61611L13.3839 1.5ZM9.38388 5.5L12.5 2.38388L15.6161 5.5L12.5 8.61611L9.38388 5.5ZM8.5 6.38388L5.38388 9.5L8.5 12.6161L11.6161 9.5L8.5 6.38388ZM2.25 16.25H17.75V17.75H2.25V16.25ZM1 19V15H19V19H1Z" fill="currentColor"/><path d="M1 15H19V19H1V15Z" fill="${color || "transparent"}"/></svg>`;
}

function mdColorSwatchIcon(color: string) {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3C1 1.89543 1.89543 1 3 1H13C14.1046 1 15 1.89543 15 3V13C15 14.1046 14.1046 15 13 15H3C1.89543 15 1 14.1046 1 13V3Z" fill="${color}"/><path d="M1.5 3C1.5 2.17157 2.17157 1.5 3 1.5H13C13.8284 1.5 14.5 2.17157 14.5 3V13C14.5 13.8284 13.8284 14.5 13 14.5H3C2.17157 14.5 1.5 13.8284 1.5 13V3Z" stroke="black" stroke-opacity="0.1"/></svg>`;
}

// The note editor's color palettes (note-editor core/schema/colors.js).
const MD_TEXT_COLORS: [string, string][] = [
  ["Red", "#ff2020"],
  ["Orange", "#ff7700"],
  ["Yellow", "#ffcb00"],
  ["Green", "#4eb31c"],
  ["Purple", "#7953e3"],
  ["Magenta", "#eb52f7"],
  ["Blue", "#05a2ef"],
  ["Gray", "#7e8386"],
];
const MD_HIGHLIGHT_COLORS: [string, string][] = [
  ["Red", "#ff666680"],
  ["Orange", "#f1983780"],
  ["Yellow", "#ffd40080"],
  ["Green", "#5fb23680"],
  ["Purple", "#a28ae580"],
  ["Magenta", "#e56eee80"],
  ["Blue", "#2ea8e580"],
  ["Gray", "#aaaaaa80"],
];

type ElementSpec = Record<string, any>;

/** A native-looking toolbar dropdown: a button toggling a popup. */
function dropdownSpec(
  className: string,
  buttonHTML: string,
  title: string,
  buildPopupChildren: () => ElementSpec[],
): ElementSpec {
  return {
    tag: "div",
    classList: ["dropdown", className],
    children: [
      {
        tag: "button",
        classList: ["toolbar-button", "bn-md-command"],
        properties: { innerHTML: buttonHTML, title },
        listeners: [
          {
            type: "mousedown",
            listener: (e: Event) => e.preventDefault(),
          },
          {
            type: "click",
            listener: (e: Event) => {
              const button = e.currentTarget as HTMLElement;
              const dropdown = button.parentElement as HTMLElement;
              const doc = dropdown.ownerDocument;
              const existing = dropdown.querySelector(".popup");
              if (existing) {
                existing.remove();
                button.classList.remove("active");
                return;
              }
              // Close any other open markdown-toolbar popup
              dropdown
                .closest(".bn-md-toolbar")
                ?.querySelectorAll(".popup")
                .forEach((el) => {
                  el.parentElement
                    ?.querySelector("button")
                    ?.classList.remove("active");
                  el.remove();
                });
              const popup = ztoolkit.UI.createElement(doc, "div", {
                classList: ["popup"],
                children: buildPopupChildren(),
              } as any) as HTMLDivElement;
              const closeMenu = () => {
                popup.remove();
                button.classList.remove("active");
                doc.removeEventListener("mousedown", onOutside, true);
              };
              const onOutside = (event: Event) => {
                if (!dropdown.contains(event.target as Node)) {
                  closeMenu();
                }
              };
              popup.addEventListener("click", (event) => {
                if ((event.target as HTMLElement).closest("button")) {
                  closeMenu();
                }
              });
              dropdown.appendChild(popup);
              button.classList.add("active");
              doc.addEventListener("mousedown", onOutside, true);
            },
          },
        ],
      },
    ],
  };
}

function menuButtonSpec(
  classList: string[],
  innerHTML: string,
  title: string,
  onPick: () => void,
): ElementSpec {
  return {
    tag: "button",
    classList,
    attributes: { role: "menuitem" },
    properties: { innerHTML, title },
    listeners: [
      {
        type: "mousedown",
        listener: (e: Event) => e.preventDefault(),
      },
      {
        type: "click",
        listener: onPick,
      },
    ],
  };
}

/**
 * The markdown formatting toolbar, mirroring the note editor's own toolbar
 * with the native icons and popup styles.
 */
function buildMarkdownToolbar(
  editor: Zotero.EditorInstance,
  state: MarkdownModeState,
  container: HTMLDivElement,
) {
  const win = editor._iframeWindow;
  const doc = win.document;
  const toolbar = doc.querySelector(".toolbar");
  if (!toolbar) {
    return;
  }
  toolbar.querySelector(".bn-md-toolbar")?.remove();

  const apply = (command: string) => {
    try {
      getMdEditorAPI(win)?.applyCommand(container, command);
    } catch (e) {
      ztoolkit.log("[BN markdown mode] command error", e);
    }
  };

  const plainButtonSpec = (
    icon: string,
    title: string,
    onClick: () => void,
  ): ElementSpec => ({
    tag: "button",
    classList: ["toolbar-button", "bn-md-command"],
    properties: { innerHTML: icon, title },
    listeners: [
      {
        type: "mousedown",
        listener: (e: Event) => e.preventDefault(),
      },
      { type: "click", listener: onClick },
    ],
  });

  // The "Aa" text-format menu, mirroring the native text-dropdown (its
  // class makes the note-editor stylesheet lay it out).
  const textDropdown = dropdownSpec(
    "text-dropdown",
    MD_TOOLBAR_ICONS.formatText,
    getString("editor-toolbar-md-heading"),
    () => [
      {
        tag: "div",
        classList: ["inline-options"],
        children: [
          {
            tag: "div",
            classList: ["line"],
            children: [
              ["bold", MD_TOOLBAR_ICONS.bold, "editor-toolbar-md-bold"],
              ["italic", MD_TOOLBAR_ICONS.italic, "editor-toolbar-md-italic"],
              [
                "underline",
                MD_TOOLBAR_ICONS.underline,
                "editor-toolbar-md-underline",
              ],
              [
                "strikethrough",
                MD_TOOLBAR_ICONS.strikethrough,
                "editor-toolbar-md-strikethrough",
              ],
            ].map(([command, icon, key]) =>
              menuButtonSpec(
                ["toolbar-button"],
                icon,
                getString(key as any),
                () => apply(command),
              ),
            ),
          },
          {
            tag: "div",
            classList: ["line"],
            children: [
              [
                "subscript",
                MD_TOOLBAR_ICONS.subscript,
                "editor-toolbar-md-subscript",
              ],
              [
                "superscript",
                MD_TOOLBAR_ICONS.superscript,
                "editor-toolbar-md-superscript",
              ],
              ["code", MD_TOOLBAR_ICONS.code, "editor-toolbar-md-code"],
            ].map(([command, icon, key]) =>
              menuButtonSpec(
                ["toolbar-button"],
                icon,
                getString(key as any),
                () => apply(command),
              ),
            ),
          },
        ],
      },
      {
        tag: "div",
        classList: ["block-options"],
        children: [
          menuButtonSpec(
            ["option"],
            `<p>${getString("editor-toolbar-md-paragraph")}</p>`,
            "",
            () => apply("paragraph"),
          ),
          ...[1, 2, 3].map((level) =>
            menuButtonSpec(
              ["option"],
              `<h${level}>${getString("editor-toolbar-md-heading")} ${level}</h${level}>`,
              "",
              () => apply(`heading${level}`),
            ),
          ),
          menuButtonSpec(
            ["option"],
            `<span>• ${getString("editor-toolbar-md-bulletList")}</span>`,
            "",
            () => apply("bulletList"),
          ),
          menuButtonSpec(
            ["option"],
            `<span>1. ${getString("editor-toolbar-md-orderedList")}</span>`,
            "",
            () => apply("orderedList"),
          ),
          menuButtonSpec(
            ["option"],
            `<span>❝ ${getString("editor-toolbar-md-blockquote")}</span>`,
            "",
            () => apply("blockquote"),
          ),
        ],
      },
    ],
  );

  const colorDropdown = (
    className: string,
    icon: string,
    titleKey: string,
    command: string,
    palette: [string, string][],
  ) =>
    dropdownSpec(className, icon, getString(titleKey as any), () => [
      menuButtonSpec(
        ["option"],
        `<div class="icon">${MD_TOOLBAR_ICONS.removeColor}</div><div class="name">${getString("editor-toolbar-md-removeColor")}</div>`,
        "",
        () => apply("removeColor"),
      ),
      { tag: "div", classList: ["separator"] },
      ...palette.map(([name, code]) =>
        menuButtonSpec(
          ["option"],
          `<div class="icon">${mdColorSwatchIcon(code)}</div><div class="name">${name}</div>`,
          "",
          () => apply(`${command}:${code}`),
        ),
      ),
    ]);

  const bar = ztoolkit.UI.createElement(doc, "div", {
    classList: ["bn-md-toolbar"],
    children: [
      textDropdown,
      colorDropdown(
        "color-dropdown",
        mdTextColorIcon(),
        "editor-toolbar-md-textColor",
        "textColor",
        MD_TEXT_COLORS,
      ),
      colorDropdown(
        "color-dropdown",
        mdHighlighterIcon(),
        "editor-toolbar-md-highlightColor",
        "highlightColor",
        MD_HIGHLIGHT_COLORS,
      ),
      plainButtonSpec(
        MD_TOOLBAR_ICONS.clearFormat,
        getString("editor-toolbar-md-clearFormat"),
        () => apply("clearFormat"),
      ),
      plainButtonSpec(
        MD_TOOLBAR_ICONS.link,
        getString("editor-toolbar-md-link"),
        () => apply("link"),
      ),
      plainButtonSpec(
        MD_TOOLBAR_ICONS.cite,
        getString("editor-toolbar-md-citation"),
        () => {
          insertCitationViaDialog(editor, container).catch((e) =>
            ztoolkit.log("[BN markdown mode] citation error", e),
          );
        },
      ),
      plainButtonSpec(
        MD_TOOLBAR_ICONS.magnifier,
        getString("editor-toolbar-md-search"),
        () => apply("search"),
      ),
    ],
  } as any) as HTMLElement;

  const middle = toolbar.querySelector(".middle");
  if (middle) {
    middle.after(bar);
  } else {
    toolbar.append(bar);
  }
  state.mdToolbar = bar;
}

/** The citation node's note-HTML serialization for citation data. */
function citationSpanHTML(citation: {
  citationItems: any[];
  properties: Record<string, any>;
}) {
  const formatted = Zotero.EditorInstanceUtilities.formatCitation(citation);
  return `<span class="citation" data-citation="${encodeURIComponent(
    JSON.stringify(citation),
  )}">${formatted}</span>`;
}

/** Insert a citation node built from citation data at the source cursor. */
function insertCitationMarkdown(
  editor: Zotero.EditorInstance,
  container: HTMLDivElement,
  citation: { citationItems: any[]; properties: Record<string, any> },
) {
  try {
    getMdEditorAPI(editor._iframeWindow)?.insertText(
      container,
      citationSpanHTML(citation),
    );
  } catch (e) {
    ztoolkit.log("[BN markdown mode] citation insert error", e);
  }
}

/**
 * "Add citation" via the editor's own citation dialog: opened for a
 * synthetic node ID, its setCitation result is inserted as markdown.
 */
async function insertCitationViaDialog(
  editor: Zotero.EditorInstance,
  container: HTMLDivElement,
) {
  const win = editor._iframeWindow;
  const state = states.get(editor._iframeWindow);
  const nodeID = `bn-md-cite-${Zotero.Utilities.randomString(8)}`;
  const instanceID = (editor as any).instanceID;

  // Like the native citation button: prefill with the item of the reader
  // the note is attached to, when one is active.
  const citationData = { citationItems: [] as any[], properties: {} };
  try {
    const mainWin = Zotero.getMainWindow();
    const reader =
      mainWin && Zotero.Reader.getByTabID(mainWin.Zotero_Tabs.selectedID);
    if (reader?.itemID) {
      const item = (Zotero.Items.get(reader.itemID) as Zotero.Item)
        ?.parentItem as Zotero.Item;
      if (item) {
        citationData.citationItems.push({
          id: item.id,
          uris: [Zotero.URI.getItemURI(item)],
          // @ts-ignore not in zotero-types
          itemData: Zotero.Utilities.Item.itemToCSLJSON(item),
        });
      }
    }
  } catch (e) {
    // No reader context; open the dialog empty.
  }

  // Intercept the dialog result: accept posts a setCitation message for our
  // synthetic node to the editor iframe (the rich-text view ignores it).
  if (state?.citationListener) {
    win.removeEventListener("message", state.citationListener);
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as any;
    if (data?.instanceID !== instanceID) {
      return;
    }
    const message = data.message;
    if (message?.action !== "setCitation" || message.nodeID !== nodeID) {
      return;
    }
    win.removeEventListener("message", onMessage);
    if (state?.citationListener === onMessage) {
      state.citationListener = undefined;
    }
    const citation = message.citation;
    if (!citation?.citationItems?.length) {
      // Cancelled
      return;
    }
    insertCitationMarkdown(editor, container, citation);
  };
  win.addEventListener("message", onMessage);
  if (state) {
    state.citationListener = onMessage;
  }

  try {
    await (editor as any)._openCitationDialog(
      nodeID,
      citationData,
      [editor._item.libraryID],
      true,
    );
  } catch (e) {
    win.removeEventListener("message", onMessage);
    if (state?.citationListener === onMessage) {
      state.citationListener = undefined;
    }
    ztoolkit.log("[BN markdown mode] citation dialog error", e);
    // Fallback: Zotero's plain item picker.
    await insertCitationViaPicker(editor, container);
  }
}

/** Fallback "add citation" using the select-items dialog. */
async function insertCitationViaPicker(
  editor: Zotero.EditorInstance,
  container: HTMLDivElement,
) {
  const ids = await itemPicker();
  if (!ids?.length) {
    return;
  }
  const items = (await Zotero.Items.getAsync(ids)).filter((item) =>
    item.isRegularItem(),
  );
  if (!items.length) {
    return;
  }
  insertCitationMarkdown(editor, container, {
    citationItems: items.map((item) => ({
      uris: [Zotero.URI.getItemURI(item)],
      // @ts-ignore not in zotero-types
      itemData: Zotero.Utilities.Item.itemToCSLJSON(item),
    })),
    properties: {},
  });
}

/** Parse a chip's URL-encoded JSON data attribute (data-citation etc.). */
function parseNodeDataJSON(raw: string, attr: string) {
  const value = new RegExp(`\\b${attr}="([^"]+)"`).exec(raw)?.[1];
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(decodeURIComponent(unescapeHTMLAttr(value)));
  } catch (e) {
    return null;
  }
}

/**
 * Whether a citation cites what an annotation quotes (the note editor's
 * isCitationAndAnnotationPair): same item and same locator.
 */
function isAnnotationCitationPair(annotation: any, citation: any) {
  const annotationItem = annotation?.citationItem;
  const citationItems = citation?.citationItems;
  if (!annotationItem || citationItems?.length !== 1) {
    return false;
  }
  const citationItem = citationItems[0];
  const uris: string[] = annotationItem.uris || [];
  if (!uris.some((uri) => (citationItem.uris || []).includes(uri))) {
    return false;
  }
  return (
    (annotationItem.locator || "") === (citationItem.locator || "") &&
    (annotationItem.label || "") === (citationItem.label || "")
  );
}

/** The note editor's "show item": select the items in the library pane. */
function showItemsInLibrary(ids: number[]) {
  const win = Zotero.getMainWindow();
  if (win) {
    (win as any).ZoteroPane.selectItems(ids);
    win.focus();
  }
}

/**
 * Action buttons for a chip's click popup, mirroring the note editor's
 * citation/highlight/image popups (same actions, same conditions).
 */
function getMarkdownNodeActions(
  editor: Zotero.EditorInstance,
  kind: string,
  raw: string,
  neighborsJSON: string,
  setActions: (actionsJSON: string) => void,
) {
  (async () => {
    const win = editor._iframeWindow;
    let neighbors: any = {};
    try {
      neighbors = JSON.parse(neighborsJSON) || {};
    } catch (e) {
      // No neighbor info; the pair-dependent actions default conservatively.
    }
    const actions: { id: string; icon: string; title: string }[] = [];
    if (kind === "citation") {
      const citation = parseNodeDataJSON(raw, "data-citation");
      const citationItem = citation?.citationItems?.[0];
      if (!citationItem) {
        setActions("[]");
        return;
      }
      const beforeAnnotation =
        neighbors.before &&
        ["annotation", "image"].includes(neighbors.before.kind)
          ? parseNodeDataJSON(neighbors.before.raw, "data-annotation")
          : null;
      const hasPairBefore = isAnnotationCitationPair(
        beforeAnnotation,
        citation,
      );
      if (
        !hasPairBefore &&
        citationItem.locator &&
        (!citationItem.label || citationItem.label === "page")
      ) {
        actions.push({
          id: "openCitationPage",
          icon: MD_POPUP_ICONS.page,
          title: await popupLabel(win, "open"),
        });
      }
      actions.push({
        id: "showItem",
        icon: MD_POPUP_ICONS.showItem,
        title: await popupLabel(win, "showItem"),
      });
      actions.push({
        id: "editCitation",
        icon: MD_POPUP_ICONS.cite,
        title: await popupLabel(win, "edit"),
      });
      if (hasPairBefore) {
        actions.push({
          id: "removeCitation",
          icon: MD_POPUP_ICONS.hide,
          title: await popupLabel(win, "remove"),
        });
      }
    } else if (kind === "annotation" || kind === "image") {
      const annotation = parseNodeDataJSON(raw, "data-annotation");
      if (!annotation) {
        // A plain image without annotation metadata has no popup (like the
        // native image popup, which only serves annotation images).
        setActions("[]");
        return;
      }
      if (annotation.attachmentURI) {
        actions.push({
          id: "openAnnotation",
          icon: MD_POPUP_ICONS.page,
          title: await popupLabel(win, "open"),
        });
      }
      actions.push({
        id: "unlink",
        icon: MD_POPUP_ICONS.unlink,
        title: await popupLabel(win, "unlink"),
      });
      if (annotation.citationItem) {
        const afterCitation =
          neighbors.after?.kind === "citation"
            ? parseNodeDataJSON(neighbors.after.raw, "data-citation")
            : null;
        if (!isAnnotationCitationPair(annotation, afterCitation)) {
          actions.push({
            id: "addCitationAfter",
            icon: MD_POPUP_ICONS.cite,
            title: await popupLabel(win, "addCitation"),
          });
        }
      }
    }
    setActions(JSON.stringify(actions));
  })().catch((e) => ztoolkit.log("[BN markdown mode] node actions error", e));
}

/** Run a chip popup action (the note editor's popup behaviors). */
async function handleMarkdownNodeAction(
  editor: Zotero.EditorInstance,
  id: string,
  kind: string,
  raw: string,
  applyEdit: (newText: string, trimBefore?: boolean) => void,
) {
  switch (id) {
    case "openCitationPage": {
      // Like the editorInstance openCitationPage handler: a page locator
      // opens the item's PDF at that page, otherwise show it in the library.
      const citation = parseNodeDataJSON(raw, "data-citation");
      const citationItem = citation?.citationItems?.[0];
      if (!citationItem) {
        return;
      }
      const item = await (Zotero as any).EditorInstance.getItemFromURIs(
        citationItem.uris || [],
      );
      if (!item) {
        return;
      }
      if (citationItem.locator) {
        const attachments = (await item.getBestAttachments()).filter(
          (attachment: Zotero.Item) => attachment.isPDFAttachment(),
        );
        if (attachments.length) {
          (Zotero.getActiveZoteroPane() as any)?.viewPDF(attachments[0].id, {
            pageLabel: citationItem.locator,
          });
        }
      } else {
        showItemsInLibrary([item.id]);
      }
      break;
    }
    case "showItem": {
      const citation = parseNodeDataJSON(raw, "data-citation");
      const ids: number[] = [];
      for (const citationItem of citation?.citationItems || []) {
        const item = await (Zotero as any).EditorInstance.getItemFromURIs(
          citationItem.uris || [],
        );
        if (item) {
          ids.push(item.id);
        }
      }
      if (ids.length) {
        showItemsInLibrary(ids);
      }
      break;
    }
    case "editCitation": {
      await editCitationViaDialog(editor, raw, applyEdit);
      break;
    }
    case "removeCitation": {
      // Native "hide citation" also removes the gap to the annotation.
      applyEdit("", true);
      break;
    }
    case "openAnnotation": {
      // Like the editorInstance openAnnotation handler.
      const annotation = parseNodeDataJSON(raw, "data-annotation");
      if (!annotation?.attachmentURI) {
        return;
      }
      let position = annotation.position;
      if (typeof position === "string") {
        try {
          position = JSON.parse(position);
        } catch (e) {
          // Leave as-is; the reader tolerates a missing position.
        }
      }
      if ((editor as any).onNavigate) {
        (editor as any).onNavigate(annotation.attachmentURI, { position });
      } else {
        const item = await Zotero.URI.getURIItem(annotation.attachmentURI);
        if (item) {
          (Zotero.getActiveZoteroPane() as any)?.viewPDF(item.id, {
            position,
          });
        }
      }
      break;
    }
    case "unlink": {
      // Keep the content, drop the annotation link: strip the wrapping span
      // (highlight/underline), or the data-annotation attribute of an image.
      if (kind === "image") {
        applyEdit(raw.replace(/\s*data-annotation="[^"]*"/i, ""));
      } else {
        applyEdit(raw.replace(/^<span\b[^>]*>/i, "").replace(/<\/span>$/i, ""));
      }
      break;
    }
    case "addCitationAfter": {
      const annotation = parseNodeDataJSON(raw, "data-annotation");
      if (!annotation?.citationItem) {
        return;
      }
      const citation = {
        citationItems: [JSON.parse(JSON.stringify(annotation.citationItem))],
        properties: {},
      };
      applyEdit(`${raw} ${citationSpanHTML(citation)}`);
      break;
    }
  }
}

/**
 * "Edit Citation" via the editor's own citation dialog; the updated
 * citation replaces the chip's markdown source.
 */
async function editCitationViaDialog(
  editor: Zotero.EditorInstance,
  raw: string,
  applyEdit: (newText: string) => void,
) {
  const citation = parseNodeDataJSON(raw, "data-citation");
  if (!citation?.citationItems?.length) {
    return;
  }
  const win = editor._iframeWindow;
  const state = states.get(editor._iframeWindow);
  const nodeID = `bn-md-cite-${Zotero.Utilities.randomString(8)}`;
  const instanceID = (editor as any).instanceID;

  if (state?.citationListener) {
    win.removeEventListener("message", state.citationListener);
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as any;
    if (data?.instanceID !== instanceID) {
      return;
    }
    const message = data.message;
    if (message?.action !== "setCitation" || message.nodeID !== nodeID) {
      return;
    }
    win.removeEventListener("message", onMessage);
    if (state?.citationListener === onMessage) {
      state.citationListener = undefined;
    }
    const updated = message.citation;
    if (!updated?.citationItems?.length) {
      // Emptied out; keep the chip (deleting it is a plain source edit).
      return;
    }
    applyEdit(citationSpanHTML(updated));
  };
  win.addEventListener("message", onMessage);
  if (state) {
    state.citationListener = onMessage;
  }

  try {
    // Like the native openCitationPopup handler: set citationItem.id for
    // local items — each dialog bubble needs an id or itemData.
    const citationData = JSON.parse(JSON.stringify(citation));
    for (const citationItem of citationData.citationItems) {
      const item = await (Zotero as any).EditorInstance.getItemFromURIs(
        citationItem.uris || [],
      );
      if (item) {
        citationItem.id = item.id;
      }
    }
    // openedEmpty=false, like the native edit: accepting posts the result,
    // cancelling posts nothing.
    await (editor as any)._openCitationDialog(
      nodeID,
      citationData,
      [editor._item.libraryID],
      false,
    );
  } catch (e) {
    win.removeEventListener("message", onMessage);
    if (state?.citationListener === onMessage) {
      state.citationListener = undefined;
    }
    ztoolkit.log("[BN markdown mode] citation dialog error", e);
  }
}

/**
 * Wait for a pending markdown mode (default preference or toggle), so a
 * jump doesn't land in the rich-text view that is about to be covered.
 */
async function markdownModeSettled(editor: Zotero.EditorInstance) {
  if (editor._disableUI || editor._readOnly) {
    return;
  }
  const expected =
    modeOverrideFor(editor) ?? !!getPref("editor.useMarkdownByDefault");
  // Ready means entered AND the source accessors are wired up (active is
  // flipped early in enterMarkdownMode, before the view exists).
  const ready = () => {
    const state = states.get(editor._iframeWindow);
    return !!state?.active && !!state.getValue;
  };
  if (!expected || ready()) {
    return;
  }
  try {
    await waitUtilAsync(() => !addon.data.alive || ready(), 100, 5000);
  } catch (e) {
    // The mode never came up (e.g. a load error); fall back to rich text.
  }
}

/**
 * The note line at the markdown cursor; undefined when the mode is not up,
 * letting the caller fall back to the rich-text cursor.
 */
function markdownLineAtCursor(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return undefined;
  }
  let md: string | undefined;
  let selection: { anchor: number; head: number } | undefined;
  try {
    md = state.getValue?.();
    selection = state.getSelection?.();
  } catch (e) {
    return undefined;
  }
  if (typeof md !== "string" || !selection) {
    return undefined;
  }
  const blocks = segmentMarkdownBlocks(md);
  if (!blocks.length) {
    return undefined;
  }
  return markdownLocationAtOffset(blocks, md, selection.head).blockIndex;
}

/**
 * Move the markdown selection to the note's block index; false when the
 * view is not up (or unreadable), letting the rich-text scroll run instead.
 */
function jumpMarkdownToLine(editor: Zotero.EditorInstance, lineIndex: number) {
  const state = states.get(editor._iframeWindow);
  if (!state?.active) {
    return false;
  }
  let md: string | undefined;
  try {
    md = state.getValue?.();
  } catch (e) {
    // The view may be mid-teardown; fall through to the rich view.
  }
  if (typeof md !== "string") {
    return false;
  }
  const offset = markdownOffsetForLine(md, lineIndex, "");
  state.setSelection?.(offset, offset, true);
  return true;
}

/**
 * Register the markdown view as the editor API's view backend: cursor reads
 * and jumps target the markdown view while the mode is active (or pending).
 */
function registerMarkdownEditorBackend() {
  setEditorViewBackend({
    scrollToLine: async (editor, lineIndex) => {
      await markdownModeSettled(editor);
      return jumpMarkdownToLine(editor, lineIndex);
    },
    lineAtCursor: (editor) => markdownLineAtCursor(editor),
    scrollToSection: async (editor, sectionName) => {
      await markdownModeSettled(editor);
      if (!isMarkdownMode(editor)) {
        return false;
      }
      // Resolve the section to its line like the rich-text jump does.
      const sectionTree = await getNoteTreeFlattened(editor._item);
      const sectionNode = sectionTree.find(
        (node) => node.model.name.trim() === sectionName.trim(),
      );
      if (sectionNode) {
        jumpMarkdownToLine(editor, sectionNode.model.lineIndex);
      }
      return true;
    },
  });
}

function unregisterMarkdownEditorBackend() {
  setEditorViewBackend(undefined);
}

/**
 * Align the hidden rich-text selection with the markdown cursor — a bridge
 * for custom commands reading rich-text APIs. Call after flushSaveAndSettle.
 */
function syncRichSelectionFromMarkdown(editor: Zotero.EditorInstance) {
  const state = states.get(editor._iframeWindow);
  let md: string | undefined;
  let selection: { anchor: number; head: number } | undefined;
  try {
    md = state?.getValue?.();
    selection = state?.getSelection?.();
  } catch (e) {
    return;
  }
  if (typeof md !== "string" || !selection) {
    return;
  }
  const blocks = segmentMarkdownBlocks(md);
  if (!blocks.length) {
    return;
  }
  const anchor = markdownLocationAtOffset(blocks, md, selection.anchor);
  const head =
    selection.head === selection.anchor
      ? anchor
      : markdownLocationAtOffset(blocks, md, selection.head);
  if (Components.utils.isDeadWrapper(editor._iframeWindow)) {
    return;
  }
  try {
    const core = getEditorCore(editor);
    const EditorAPI = getEditorAPI(editor);
    EditorAPI.setSelectionAtBlockTextOffset(
      anchor.blockIndex,
      anchor.textOffset,
      head.blockIndex,
      head.textOffset,
    )(core.view.state, core.view.dispatch);
  } catch (e) {
    ztoolkit.log("[BN markdown mode] selection sync error", e);
  }
}

/**
 * The privileged part of the palette: the "open attachment" gate and the
 * custom commands; formatting commands live in the markdown editor.
 */
function getMarkdownMagicCommands(
  editor: Zotero.EditorInstance,
  setCommands: (commandsJSON: string) => void,
) {
  let openAttachment = false;
  try {
    const parentItem = editor._item.parentItem as Zotero.Item | undefined;
    openAttachment = !!parentItem && parentItem.numAttachments() > 0;
  } catch (e) {
    // Standalone note; leave disabled.
  }
  const custom = getRegisteredMagicKeyCommands()
    .filter((options) => {
      if (!options.enabled) {
        return true;
      }
      try {
        return !!options.enabled(editor);
      } catch (e) {
        ztoolkit.log("[BN markdown mode] magic command enabled error", e);
        return false;
      }
    })
    .map((options) => ({
      id: `custom:${options.id}`,
      title: options.title,
      icon: options.icon,
      searchParts: options.searchParts?.length
        ? options.searchParts
        : [options.id],
    }));
  setCommands(JSON.stringify({ openAttachment, custom }));
}

/**
 * Run a privileged magic-key command, mirroring the rich-text palette;
 * note edits flow back into the markdown view via the change notifier.
 */
async function handleMarkdownMagicCommand(
  editor: Zotero.EditorInstance,
  container: HTMLDivElement,
  id: string,
) {
  const custom = id.startsWith("custom:")
    ? getRegisteredMagicKeyCommands().find(
        (options) => `custom:${options.id}` === id,
      )
    : undefined;
  switch (custom ? "custom" : id) {
    case "insertTemplate": {
      await flushSave(editor);
      addon.hooks.onShowTemplatePicker("insert", {
        noteId: editor._item.id,
        lineIndex: getLineAtCursor(editor),
      });
      break;
    }
    case "refreshTemplates": {
      await flushSave(editor);
      addon.hooks.onRefreshTemplatesInNote(editor);
      break;
    }
    case "outboundLink":
    case "inboundLink": {
      await flushSave(editor);
      openLinkCreator(editor._item, {
        lineIndex: getLineAtCursor(editor),
        mode: id === "outboundLink" ? "outbound" : "inbound",
      });
      break;
    }
    case "insertCitation": {
      await insertCitationViaDialog(editor, container);
      break;
    }
    case "openAttachment": {
      const attachment = await editor._item.parentItem?.getBestAttachment();
      if (!attachment) {
        return;
      }
      Zotero.getActiveZoteroPane().viewAttachment([attachment.id]);
      Zotero.Notifier.trigger("open", "file", attachment.id);
      break;
    }
    case "copySectionLink":
    case "copyLineLink": {
      await flushSave(editor);
      await copyNoteLink(editor, id === "copySectionLink" ? "section" : "line");
      break;
    }
    case "custom": {
      await flushSaveAndSettle(editor);
      syncRichSelectionFromMarkdown(editor);
      await custom!.handler(editor);
      break;
    }
  }
}

async function noteToMD(noteItem: Zotero.Item) {
  return await note2md(noteItem, Zotero.getTempDirectory().path, {
    keepNoteLink: true,
    withYAMLHeader: false,
    skipSavingImages: true,
    skipTemplate: true,
  });
}

/**
 * Convert pasted HTML to the mode's markdown dialect: node metadata is
 * kept, and images from other notes are copied to this note first.
 */
async function convertPastedHTMLToMarkdown(
  editor: Zotero.EditorInstance,
  html: string,
) {
  const noteItem = editor._item;
  const refNotes = await resolvePastedImageSourceNotes(html, noteItem);
  let fixedHTML = await copyEmbeddedImagesInHTML(html, noteItem, refNotes);
  fixedHTML = await importPastedDataImages(fixedHTML, noteItem);
  return await note2md(noteItem, Zotero.getTempDirectory().path, {
    keepNoteLink: true,
    withYAMLHeader: false,
    skipSavingImages: true,
    skipTemplate: true,
    noteContent: fixedHTML,
  });
}

/**
 * Import unresolvable pasted images (data: URIs, foreign attachment keys)
 * into the note now; a data: URL left in the markdown gets corrupted.
 */
async function importPastedDataImages(html: string, noteItem: Zotero.Item) {
  if (!/<img\s/i.test(html)) {
    return html;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const targetKeys = new Set(
    Zotero.Items.get(noteItem.getAttachments()).map((item) => item.key),
  );
  let changed = false;
  const images = Array.from(doc.querySelectorAll("img")) as HTMLImageElement[];
  for (const img of images) {
    const key = img.getAttribute("data-attachment-key");
    if (key && targetKeys.has(key)) {
      continue;
    }
    const src = img.getAttribute("src") || "";
    if (!src.startsWith("data:")) {
      // http/file images convert as regular markdown images (the save-time
      // import fetches them); just drop an unresolvable attachment key.
      if (key) {
        img.removeAttribute("data-attachment-key");
        changed = true;
      }
      continue;
    }
    changed = true;
    let newKey: string | void = undefined;
    try {
      newKey = await importImageToNote(noteItem, src, "b64");
    } catch (e) {
      ztoolkit.log("[BN markdown mode] pasted image import error", e);
    }
    if (newKey) {
      img.setAttribute("data-attachment-key", newKey);
      img.removeAttribute("src");
    } else {
      img.remove();
    }
  }
  return changed ? doc.body.innerHTML : html;
}

/**
 * Source notes of pasted embedded images, resolved from attachment keys
 * (the clipboard doesn't say which note the content came from).
 */
async function resolvePastedImageSourceNotes(
  html: string,
  targetNote: Zotero.Item,
) {
  const refNotes = new Map<number, Zotero.Item>();
  const keys = new Set(
    Array.from(html.matchAll(/data-attachment-key="([^"]+)"/g), (m) => m[1]),
  );
  const resolve = async (libraryID: number, key: string) => {
    try {
      // The async lookup loads items that are not in the in-memory cache.
      return (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key)) as
        | Zotero.Item
        | false;
    } catch (e) {
      return false as const;
    }
  };
  for (const key of keys) {
    let attachment = await resolve(targetNote.libraryID, key);
    if (!attachment) {
      for (const library of Zotero.Libraries.getAll()) {
        if (library.libraryID === targetNote.libraryID) {
          continue;
        }
        attachment = await resolve(library.libraryID, key);
        if (attachment) {
          break;
        }
      }
    }
    const parent = attachment && (attachment.parentItem as Zotero.Item);
    if (parent && parent.isNote() && parent.id !== targetNote.id) {
      refNotes.set(parent.id, parent);
    }
  }
  return Array.from(refNotes.values());
}

/**
 * Hover-preview content for a chip, mirroring the rich-text editor: note
 * content, citation metadata, annotation quote, or the image itself.
 */
function getNodePreviewContent(
  editor: Zotero.EditorInstance,
  kind: string,
  raw: string,
  setContent: (html: string) => void,
) {
  (async () => {
    switch (kind) {
      case "notelink": {
        const link = unescapeHTMLAttr(
          /\bzhref="([^"]+)"/.exec(raw)?.[1] ||
            /\bhref="([^"]+)"/.exec(raw)?.[1] ||
            "",
        );
        const note = link && addon.api.convert.link2note(link);
        if (!note) {
          setContent(`<p style="color: red;">Invalid note link</p>`);
          return;
        }
        const content = await addon.api.convert.link2html(link, {
          noteItem: note,
          dryRun: true,
          usePosition: true,
        });
        setContent(content);
        break;
      }
      case "citation": {
        const dataCitation = /\bdata-citation="([^"]+)"/.exec(raw)?.[1];
        if (!dataCitation) {
          return;
        }
        const citation = JSON.parse(
          decodeURIComponent(unescapeHTMLAttr(dataCitation)),
        );
        const ids = (citation?.citationItems || [])
          .map((item: { uris: string[] }) =>
            Zotero.URI.getURIItemID(item.uris?.[0] || ""),
          )
          .filter((id: unknown) => typeof id === "number");
        const items = Zotero.Items.get(ids as number[]);
        if (!items.length) {
          setContent(`<p>Cited item is not in this library.</p>`);
          return;
        }
        setContent(
          items
            .map(
              (item) =>
                `<p><strong>${escapeHTML(item.getDisplayTitle())}</strong><br/>` +
                `${escapeHTML(
                  [item.getField("firstCreator"), item.getField("date")]
                    .filter(Boolean)
                    .join(", "),
                )}</p>`,
            )
            .join(""),
        );
        break;
      }
      case "annotation": {
        const dataAnnotation = /\bdata-annotation="([^"]+)"/.exec(raw)?.[1];
        if (!dataAnnotation) {
          return;
        }
        const annotation = JSON.parse(
          decodeURIComponent(unescapeHTMLAttr(dataAnnotation)),
        );
        const color = escapeHTML(annotation.color || "#faa700");
        const parts = [];
        if (annotation.text) {
          parts.push(
            `<blockquote style="border-inline-start: 3px solid ${color}; margin: 0; padding-inline-start: 8px;">${escapeHTML(
              annotation.text,
            )}</blockquote>`,
          );
        }
        if (annotation.comment) {
          parts.push(`<p>${escapeHTML(annotation.comment)}</p>`);
        }
        if (annotation.pageLabel) {
          parts.push(
            `<p style="opacity: 0.6;">Page ${escapeHTML(annotation.pageLabel)}</p>`,
          );
        }
        if (!parts.length) {
          parts.push(`<p style="opacity: 0.6;">Annotation</p>`);
        }
        setContent(parts.join(""));
        break;
      }
      case "image": {
        const key = /\bdata-attachment-key="([^"]+)"/.exec(raw)?.[1];
        const attachment =
          key && Zotero.Items.getByLibraryAndKey(editor._item.libraryID, key);
        if (!attachment) {
          setContent(`<p>Image attachment not found.</p>`);
          return;
        }
        const dataURL = await getItemDataURL(attachment as Zotero.Item);
        setContent(`<img src="${dataURL}" alt=""/>`);
        break;
      }
    }
  })().catch((e) => ztoolkit.log("[BN markdown mode] preview error", e));
}

function escapeHTML(text: string) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHTMLAttr(text: string) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function insertTextAtCursor(textarea: HTMLTextAreaElement, text: string) {
  const { selectionStart, selectionEnd, value } = textarea;
  textarea.value =
    value.slice(0, selectionStart) + text + value.slice(selectionEnd);
  textarea.selectionStart = textarea.selectionEnd =
    selectionStart + text.length;
}

interface MDBlock {
  start: number;
  end: number;
}

/**
 * Split markdown into blocks mirroring the note's top-level elements: blank
 * lines separate blocks, except inside fences, loose lists, and quotes.
 */
function segmentMarkdownBlocks(md: string): MDBlock[] {
  const blocks: MDBlock[] = [];
  const bulletRe = /^\s{0,3}[-*+]\s/;
  const orderedRe = /^\s{0,3}\d{1,9}[.)]\s/;
  const quoteRe = /^\s{0,3}>/;
  const indentRe = /^\s{2,}\S/;
  const fenceRe = /^\s{0,3}(`{3,}|~{3,})/;

  let offset = 0;
  let current: MDBlock | null = null;
  let currentType: "ul" | "ol" | "quote" | "other" = "other";
  let gapSinceCurrent = false;
  let fence: string | null = null;

  for (const line of md.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;

    if (fence && current) {
      current.end = end;
      const match = line.match(fenceRe);
      if (
        match &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (!line.trim()) {
      gapSinceCurrent = gapSinceCurrent || !!current;
      continue;
    }

    const type = bulletRe.test(line)
      ? "ul"
      : orderedRe.test(line)
        ? "ol"
        : quoteRe.test(line)
          ? "quote"
          : "other";
    let merge = false;
    if (current && !gapSinceCurrent) {
      merge = true;
    } else if (current && gapSinceCurrent) {
      merge = indentRe.test(line) || (type !== "other" && type === currentType);
    }
    if (merge && current) {
      current.end = end;
    } else {
      current = { start, end };
      currentType = type;
      blocks.push(current);
    }
    gapSinceCurrent = false;

    const fenceMatch = line.match(fenceRe);
    if (fenceMatch) {
      fence = fenceMatch[1];
    }
  }
  return blocks;
}

/**
 * Markdown offset for a rich-text cursor: block start at the given index,
 * moved past the longest suffix of the text preceding the cursor.
 */
function markdownOffsetForLine(md: string, lineIndex: number, snippet: string) {
  if (lineIndex < 0) {
    return 0;
  }
  const blocks = segmentMarkdownBlocks(md);
  if (!blocks.length) {
    return 0;
  }
  const block = blocks[Math.min(lineIndex, blocks.length - 1)];
  const blockText = md.slice(block.start, block.end);
  return block.start + refineOffsetInBlock(blockText, snippet);
}

function refineOffsetInBlock(blockText: string, snippet: string): number {
  if (!snippet.trim()) {
    return 0;
  }
  // The markdown adds markup around the plain text, so search for
  // progressively shorter suffixes of the preceding text until one matches.
  for (let len = Math.min(30, snippet.length); len >= 3; len--) {
    const probe = snippet.slice(-len);
    const idx = blockText.indexOf(probe);
    if (idx >= 0) {
      return idx + probe.length;
    }
  }
  return 0;
}

/**
 * Approximate how many plain-text characters (as the rich-text editor counts
 * them) precede the cursor, by stripping markdown syntax from the source.
 */
function estimatePlainTextOffset(mdBefore: string): number {
  let s = mdBefore;
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^[ \t]+/gm, "");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\\([^A-Za-z0-9])/g, "$1");
  s = s.replace(/~~|[*_`]/g, "");
  s = s.replace(/\n/g, "");
  return s.length;
}
