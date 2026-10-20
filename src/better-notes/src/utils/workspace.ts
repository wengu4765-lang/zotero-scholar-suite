import { config } from "../../package.json";
import { OutlinePane } from "../elements/workspace/outlinePane";

export {
  getWorkspaceByUID,
  getWorkspaceUID,
  OutlineType,
  VirtualWorkspace,
  WorkspaceTab,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
};

// Keep in sync with min-width of bn-outline in styles/workspace/outline.css
const SIDEBAR_MIN_WIDTH = 140;
// Same as SIDEBAR_DEFAULT_WIDTH in Zotero's tabs.js
const SIDEBAR_DEFAULT_WIDTH = 240;

enum OutlineType {
  empty = 0,
  treeView,
  mindMap,
  bubbleMap,
}

function getWorkspaceUID(element: Element): string | undefined {
  const win = element.ownerDocument.defaultView as any;
  // There can be fake Zotero_Tabs added by contextPane.ts
  if (win?.Zotero_Tabs?.getTabInfo) {
    return win.Zotero_Tabs.getTabInfo().id;
  }
  const workspace = element.closest("bn-workspace") as HTMLElement | undefined;
  if (workspace?.dataset.uid) {
    return workspace.dataset.uid;
  }
  return undefined;
}

function getWorkspaceByUID(uid: string): VirtualWorkspace | undefined {
  if (uid.startsWith("tab-")) {
    return new WorkspaceTab(uid);
  }
  const workspace = addon.data.workspace.instances[uid]?.deref();
  if (!workspace?.ownerDocument) {
    delete addon.data.workspace.instances[uid];
    return undefined;
  }
  return workspace as unknown as VirtualWorkspace;
}

interface VirtualWorkspace {
  uid: string;
  item: Zotero.Item | undefined;
  editor: Zotero.EditorInstance;

  scrollEditorTo(options: { lineIndex?: number; sectionName?: string }): void;

  toggleOutline(open?: boolean): void;

  toggleContext(open?: boolean): void;

  scrollToPane(key: string): void;

  getPreviewEditor(itemID: number): EditorElement | undefined;
}

class WorkspaceTab implements VirtualWorkspace {
  uid: string;
  _addon: typeof addon;

  constructor(tabID: string) {
    this.uid = tabID;
    // @ts-ignore
    this._addon = Zotero[config.addonInstance];
  }

  get _tabContent(): XULBoxElement {
    const tabContent = Zotero.getMainWindow().document.querySelector(
      `#${this.uid}`,
    );
    if (!tabContent) {
      throw new Error(`WorkspaceTab: Tab content ${this.uid} not found.`);
    }
    return tabContent as XULBoxElement;
  }

  get item(): Zotero.Item | undefined {
    return Zotero.Items.get(
      Zotero.getMainWindow().Zotero_Tabs.getTabInfo(this.uid).data.itemID,
    );
  }

  get editor(): Zotero.EditorInstance {
    return Zotero.Notes.getByTabID(this.uid)!;
  }

  scrollEditorTo(options: { lineIndex?: number; sectionName?: string }): void {
    if (typeof options.lineIndex === "number") {
      this._addon.api.editor.scroll(this.editor, options.lineIndex);
    }
    if (typeof options.sectionName === "string") {
      this._addon.api.editor.scrollToSection(this.editor, options.sectionName);
    }
  }

  toggleContext(open?: boolean): void {
    Zotero.getMainWindow().ZoteroContextPane.collapsed = !open;
  }

  toggleOutline(width?: number): void;
  toggleOutline(open?: boolean): void;
  toggleOutline(param?: boolean | number): void {
    const win = Zotero.getMainWindow();
    const outlineContainer = this._tabContent.querySelector(
      "#bn-outline-container",
    ) as OutlinePane;

    if (!outlineContainer) {
      return;
    }

    let open: boolean;
    if (typeof param === "number") {
      open = param > 0;
    } else {
      open = param ?? outlineContainer.hasAttribute("collapsed");
    }

    let width: number | false = false;
    if (open) {
      if (typeof param === "number") {
        width = Math.max(param, SIDEBAR_MIN_WIDTH);
      } else {
        const savedWidth = win.Zotero_Tabs.getSidebarState("note").width;
        width =
          savedWidth >= SIDEBAR_MIN_WIDTH ? savedWidth : SIDEBAR_DEFAULT_WIDTH;
      }
      outlineContainer.style.width = `${width}px`;
    }

    outlineContainer.toggleAttribute("collapsed", !open);
    // Dragging the splitter to the collapse point sets state="collapsed",
    // which keeps the pane hidden regardless of its `collapsed` attribute
    this._tabContent
      .querySelector("#bn-outline-splitter")
      ?.setAttribute("state", open ? "" : "collapsed");

    win.Zotero_Tabs.updateSidebarLayout({ width });
    win.ZoteroContextPane.update();

    this.updateToggleOutlineButton();
  }

  setOutlineWidth(width: number): void {
    const outlineContainer = this._tabContent.querySelector(
      "#bn-outline-container",
    ) as OutlinePane;
    if (!outlineContainer) {
      return;
    }
    // Only resize; the open state is managed by toggleOutline. Clamp so a
    // stale zero width can never make an open sidebar invisible.
    outlineContainer.style.width = `${Math.max(width, SIDEBAR_MIN_WIDTH)}px`;
  }

  updateToggleOutlineButton(): void {
    const open =
      Zotero.getMainWindow().Zotero_Tabs.getSidebarState("note").open;
    const toggleButtonInEditor =
      this.editor?._iframeWindow?.document?.querySelector(
        ".toolbar-button.bn-toggle-left-pane",
      ) as HTMLElement;
    if (toggleButtonInEditor) {
      toggleButtonInEditor.style.display = open ? "none" : "inherit";
    }
    // We don't need to hide the outline button in the outline pane,
    // because it's hidden when outline pane is collapsed.
  }

  scrollToPane(key: string) {
    const itemDetails =
      Zotero.getMainWindow().ZoteroContextPane.context._getItemContext(
        this.uid,
      );
    return itemDetails.scrollToPane(key);
  }

  getPreviewEditor(itemID: number): EditorElement | undefined {
    const itemDetails =
      Zotero.getMainWindow().ZoteroContextPane.context._getItemContext(
        this.uid,
      );
    return itemDetails.querySelector(
      `note-editor[data-id="${itemID}"]`,
    ) as EditorElement;
  }
}
