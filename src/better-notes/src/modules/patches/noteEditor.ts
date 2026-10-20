import { PatchHelper, wait } from "zotero-plugin-toolkit";
import type { OutlinePane } from "../../elements/workspace/outlinePane";
import {
  getWorkspaceByUID,
  WorkspaceTab,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../../utils/workspace";
import { config } from "../../../package.json";

// Note tab DOM can survive a plugin reload, while closures and listeners from
// the previous load belong to a destroyed sandbox and throw when invoked;
// bindings are keyed to this token so every load rebinds fresh ones
const LOAD_TOKEN: object = {};

export function patchNoteEditorCE(win: _ZoteroTypes.MainWindow) {
  const NoteEditorProto =
    win.document.createXULElement("note-editor").constructor.prototype;

  new PatchHelper().setData({
    target: NoteEditorProto,
    // @ts-ignore
    funcSign: "setBottomPlaceholderHeight",
    patcher: (origin) =>
      // @ts-ignore
      function (height: number | null = null) {
        // @ts-ignore
        const noteEditor = this as any;

        if (!noteEditor.tabID) {
          // @ts-ignore
          return origin.apply(this, [height]);
        }

        try {
          initNoteTabOutline(win, noteEditor);
        } catch (e) {
          ztoolkit.log("BN: init note tab outline failed", e);
        }

        const box = noteEditor.querySelector(
          ".bn-note-editor-box",
        ) as XULBoxElement;
        if (!box) {
          // @ts-ignore
          return origin.apply(this, [height]);
        }
        noteEditor._bottomPlaceholder = height;
        if (typeof height !== "number") {
          height = 0;
        }
        box.style.height = `calc(100% - ${height}px)`;
        noteEditor.setToggleContextPaneButtonMode();
      },
    enabled: true,
    pluginID: config.addonID,
  });

  updateExistingNoteTabs(win);
}

function initNoteTabOutline(win: _ZoteroTypes.MainWindow, noteEditor: any) {
  if (!noteEditor._bnPatched) {
    noteEditor._bnPatched = true;
    createNoteTabOutline(win, noteEditor);
  }

  const outlineContainer = noteEditor.querySelector(
    "#bn-outline-container",
  ) as OutlinePane;
  const splitter = noteEditor.querySelector(
    "#bn-outline-splitter",
  ) as XULSplitterElement;
  if (!outlineContainer || !splitter) {
    return;
  }

  if (noteEditor._bnLoadToken !== LOAD_TOKEN) {
    noteEditor._bnLoadToken = LOAD_TOKEN;
    bindSplitterEvents(win, noteEditor, outlineContainer, splitter);
  }

  // Fires on every layout update of the tab, healing a stale container
  syncOutlineState(win, noteEditor, outlineContainer, splitter);
}

function createNoteTabOutline(win: _ZoteroTypes.MainWindow, noteEditor: any) {
  const sideBarState = win.Zotero_Tabs.getSidebarState("note");

  const box = noteEditor.querySelector("box");
  box.classList.add("bn-note-editor-box");
  box.style.width = "100%";
  // Adjust when toolbar changes
  box.style.minWidth = "328px";
  noteEditor.style.height = "100%";

  const hbox = win.document.createXULElement("hbox") as XULBoxElement;
  hbox.setAttribute("id", "bn-note-editor-tab-container");
  hbox.style.height = "100%";

  const outlineContainer = win.document.createXULElement(
    "bn-outline",
  ) as OutlinePane;
  outlineContainer.setAttribute("id", "bn-outline-container");
  outlineContainer.toggleAttribute("collapsed", !sideBarState.open);
  // The saved width can be 0 or garbage; never restore an invisible sidebar
  outlineContainer.style.width = `${
    sideBarState.width >= SIDEBAR_MIN_WIDTH
      ? sideBarState.width
      : SIDEBAR_DEFAULT_WIDTH
  }px`;

  const splitter = win.document.createXULElement(
    "splitter",
  ) as XULSplitterElement;
  splitter.setAttribute("id", "bn-outline-splitter");
  splitter.setAttribute("collapse", "before");

  hbox.appendChild(outlineContainer);
  hbox.appendChild(splitter);
  hbox.appendChild(box);

  noteEditor.appendChild(hbox);

  box.querySelector("#editor-view").docShell.windowDraggingAllowed = true;

  wait
    .waitUntilAsync(() => noteEditor._editorInstance, 100, 30000)
    .then(() => {
      outlineContainer.item = noteEditor.item;
      outlineContainer._editorElement = noteEditor;
      outlineContainer.render();
    })
    .catch((e) => {
      ztoolkit.log("BN: outline render skipped", noteEditor.tabID, e);
    });
}

function bindSplitterEvents(
  win: _ZoteroTypes.MainWindow,
  noteEditor: any,
  outlineContainer: OutlinePane,
  splitter: XULSplitterElement,
) {
  const splitterHandler = () => {
    // Everything measures 0x0 while the tab is hidden or mid-layout; only a
    // rendered splitter beside a 0-width pane is a real collapse
    const splitterRect = splitter.getBoundingClientRect();
    if (!splitterRect.width && !splitterRect.height) {
      return;
    }
    const width = outlineContainer.getBoundingClientRect().width;
    // Fires on plain mouseover too, where a collapsed pane measures 0; store
    // that as closed, keeping the saved width, so a later reopen is visible
    if (width < SIDEBAR_MIN_WIDTH) {
      outlineContainer.setAttribute("collapsed", "true");
      win.Zotero_Tabs.updateSidebarLayout({ width: false });
    } else {
      outlineContainer.removeAttribute("collapsed");
      win.Zotero_Tabs.updateSidebarLayout({ width });
    }
    win.ZoteroContextPane.update();
    updateToggleOutlineButton(noteEditor);
  };

  // The stored handler may be a dead wrapper from a previous load; removal
  // failures are ignored (a dead listener that still fires throws inertly)
  try {
    const old = (splitter as any)._bnSplitterHandler;
    if (old) {
      splitter.removeEventListener("command", old);
      splitter.removeEventListener("mousemove", old);
    }
  } catch (e) {
    ztoolkit.log("BN: failed to remove stale splitter listener", e);
  }
  (splitter as any)._bnSplitterHandler = splitterHandler;
  splitter.addEventListener("command", splitterHandler);
  splitter.addEventListener("mousemove", splitterHandler);
}

function updateToggleOutlineButton(noteEditor: any) {
  const workspace = getWorkspaceByUID(noteEditor.tabID) as WorkspaceTab;
  if (workspace) {
    workspace.updateToggleOutlineButton();
  }
}

function syncOutlineState(
  win: _ZoteroTypes.MainWindow,
  noteEditor: any,
  outlineContainer: OutlinePane,
  splitter: XULSplitterElement,
) {
  if (splitter.getAttribute("state") === "dragging") {
    return;
  }
  const state = win.Zotero_Tabs.getSidebarState("note");
  outlineContainer.toggleAttribute("collapsed", !state.open);
  splitter.setAttribute("state", state.open ? "" : "collapsed");
  if (state.open) {
    outlineContainer.style.width = `${
      state.width >= SIDEBAR_MIN_WIDTH ? state.width : SIDEBAR_DEFAULT_WIDTH
    }px`;
  }
  updateToggleOutlineButton(noteEditor);
}

async function updateExistingNoteTabs(win: _ZoteroTypes.MainWindow) {
  const noteTabs = [...win.Zotero_Tabs._tabs].filter((tab) =>
    tab.type?.startsWith("note"),
  );

  for (const tab of noteTabs) {
    try {
      // Recreate tab to update sidebar state
      const item = Zotero.Items.get(tab.data.itemID);
      if (!item || !item.isNote()) {
        continue;
      }

      const editor = Zotero.Notes.getByTabID(tab.id);
      if (editor?._initPromise) {
        await editor._initPromise;
      }

      // The tab may have been closed or moved while we awaited above. Re-read
      // its position and skip if it's gone, so we never close/reopen (and later
      // select) a stale tab id.
      const currentIndex = win.Zotero_Tabs._tabs.indexOf(tab);
      if (currentIndex < 0 || !win.Zotero_Tabs._getTab(tab.id).tab) {
        continue;
      }
      const isSelected = win.Zotero_Tabs.selectedID === tab.id;

      win.Zotero_Tabs.close(tab.id);

      await wait.waitUntilAsync(() => !win.Zotero_Tabs._getTab(tab.id).tab);

      await Zotero.Notes.open(
        item.id,
        {},
        {
          title: tab.title,
          tabIndex: currentIndex,
          openInBackground: !isSelected,
          parentItemKey: tab.data.parentItemKey,
        },
      );
    } catch (e) {
      ztoolkit.log("BN: Failed to recreate note tab", tab?.id, e);
    }
  }
}
