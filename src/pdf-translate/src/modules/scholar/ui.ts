/**
 * Zotero Scholar Suite — UI wiring: menus, reader toolbar / context menu,
 * main toolbar source switcher, shortcuts, source manager window.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import {
  activateProfile,
  createFromPreset,
  deleteProfile,
  describeEndpoint,
  duplicateProfile,
  exportProfiles,
  getActiveProfileId,
  getEffectiveProfileId,
  getProfile,
  importProfiles,
  listProfiles,
  moveProfile,
  onProfilesChanged,
  watchTranslateSource,
  PRESETS,
  PROFILE_TYPES,
  profileTypeLabel,
  reorderProfiles,
  saveProfile,
  SourceProfile,
  getVisionProfileId,
  setVisionProfile,
  resolveVisionProfile,
} from "./profiles";
import { testProfile, testVisionProfile } from "./profileService";
import { VISION_FORMATS } from "./vision";
import { OCR_PROMPT } from "./fulltext/figureText";
import {
  cancelFullText,
  destroyEngine,
  fullTextTranslate,
  fullTextTranslateContext,
  getCurrentFullTextJob,
  getMaxFileSizeBytes,
  getFigureTextSettings,
  itemHasPDF,
} from "./fulltextZotero";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const ICON = `chrome://${config.addonRef}/content/icons/favicon.png`;
const TOOLBAR_BTN_ID = "scholar-suite-source-button";

let managerWin: Window | null = null;
const readerSelects = new Set<WeakRef<HTMLSelectElement>>();
let unlisten: (() => void) | null = null;
let unwatchSource: (() => void) | null = null;

/* ---------------- public API (Zotero.PDFTranslate.api.profiles / fullText) ---------------- */

export const profilesAPI = {
  list: listProfiles,
  get: getProfile,
  save: (p: Partial<SourceProfile>, key?: string) => saveProfile(p, key),
  createFromPreset,
  duplicate: duplicateProfile,
  remove: deleteProfile,
  reorder: reorderProfiles,
  move: moveProfile,
  activate: activateProfile,
  getActiveId: getEffectiveProfileId,
  getStoredActiveId: getActiveProfileId,
  test: (p: string | Partial<SourceProfile>, key?: string) => {
    if (typeof p === "string") return testProfile(p, key);
    const base = p.id ? getProfile(p.id) : undefined;
    const merged = { ...(base || {}), ...p } as SourceProfile;
    if (!isFinite(merged.temperature)) merged.temperature = base?.temperature ?? 0.3;
    return testProfile(merged, key);
  },
  exportJSON: exportProfiles,
  importJSON: importProfiles,
  presets: () => PRESETS.map((x) => ({ ...x })),
  types: () => PROFILE_TYPES.map((x) => ({ ...x })),
  typeLabel: profileTypeLabel,
  describeEndpoint: (p: SourceProfile) => describeEndpoint(p),
  onChange: (fn: () => void) => onProfilesChanged(fn),
  openManager: () => openSourceManager(),
  /* vision (figure OCR) source */
  visionFormats: () => VISION_FORMATS.map((x) => ({ ...x })),
  getVisionId: getVisionProfileId,
  setVision: (id: string) => setVisionProfile(id),
  resolveVision: () => {
    const r = resolveVisionProfile();
    return { id: r.profile?.id || "", name: r.profile?.name || "", explicit: r.explicit, reason: r.reason || "" };
  },
  ocrPrompt: () => OCR_PROMPT,
  testVision: (p: string | Partial<SourceProfile>, dataURL: string, key?: string) => {
    if (typeof p === "string") return testVisionProfile(p, dataURL, OCR_PROMPT, key);
    const base = p.id ? getProfile(p.id) : undefined;
    const merged = { ...(base || {}), ...p } as SourceProfile;
    return testVisionProfile(merged, dataURL, OCR_PROMPT, key);
  },
};

export const fullTextAPI = {
  run: fullTextTranslate,
  runContext: fullTextTranslateContext,
  cancel: cancelFullText,
  current: getCurrentFullTextJob,
  maxFileSizeBytes: getMaxFileSizeBytes,
  figureTextSettings: getFigureTextSettings,
};

/* ---------------- source manager window ---------------- */

export function openSourceManager() {
  if (managerWin && !managerWin.closed) {
    managerWin.focus();
    return managerWin;
  }
  managerWin = (Zotero.getMainWindow() as any).openDialog(
    `chrome://${config.addonRef}/content/sourceManager.html`,
    "scholar-suite-source-manager",
    "chrome,centerscreen,resizable,dialog=no,width=1000,height=680",
  );
  return managerWin;
}

/* ---------------- menus ---------------- */

export function registerScholarMenus() {
  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-scholar-item`,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-scholar-fulltext`,
        icon: ICON,
        onShowing: (event: any, context: any) => {
          const items: Zotero.Item[] = context.items || [];
          context.setVisible(items.length > 0 && items.some((i) => itemHasPDF(i)));
        },
        onCommand: async (event: any, context: any) => {
          const items: Zotero.Item[] = (context.items || []).filter((i: Zotero.Item) => itemHasPDF(i));
          for (const it of items) {
            const r = await fullTextTranslate(it);
            if (r.reason === "cancelled" || r.reason === "busy") break;
          }
        },
      },
    ],
  } as any);

  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-scholar-tools`,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      { menuType: "separator" },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-scholar-sourceManager`,
        icon: ICON,
        onCommand: () => openSourceManager(),
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-scholar-fulltextCurrent`,
        onCommand: () => fullTextTranslateContext(),
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-scholar-fulltextCancel`,
        onShowing: (event: any, context: any) => {
          context.setVisible(!!getCurrentFullTextJob());
        },
        onCommand: () => cancelFullText(),
      },
    ],
  } as any);
}

/* ---------------- reader integration ---------------- */

function fillSourceSelect(sel: HTMLSelectElement) {
  const doc = sel.ownerDocument;
  const list = listProfiles();
  const effective = getEffectiveProfileId();
  sel.textContent = "";
  if (!effective) {
    const o = doc.createElement("option");
    o.value = "";
    o.textContent = "（未使用模型源）";
    sel.appendChild(o);
  }
  for (const p of list) {
    const o = doc.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name}${p.model ? " · " + p.model : ""}`;
    sel.appendChild(o);
  }
  const m = doc.createElement("option");
  m.value = "__manage__";
  m.textContent = "管理模型源…";
  sel.appendChild(m);
  sel.value = effective;
}

export function createSourceSelect(doc: Document): HTMLSelectElement {
  const sel = doc.createElementNS(HTML_NS, "select") as HTMLSelectElement;
  sel.className = "scholar-source-select";
  sel.title = "切换翻译模型源（Zotero Scholar Suite）";
  sel.setAttribute(
    "style",
    "max-width:180px;height:24px;margin:0 4px;font-size:12px;border-radius:4px;border:1px solid var(--fill-quinary, #ccc);background:var(--material-background, #fff);color:inherit;",
  );
  fillSourceSelect(sel);
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v === "__manage__") {
      fillSourceSelect(sel);
      openSourceManager();
      return;
    }
    if (v) activateProfile(v);
  });
  readerSelects.add(new WeakRef(sel));
  return sel;
}

function refreshAllSelects() {
  for (const ref of Array.from(readerSelects)) {
    const sel = ref.deref();
    if (!sel || !sel.isConnected) {
      readerSelects.delete(ref);
      continue;
    }
    try {
      fillSourceSelect(sel);
    } catch (e) {
      readerSelects.delete(ref);
    }
  }
  for (const win of Zotero.getMainWindows()) updateToolbarButton(win);
}

export function registerScholarReader() {
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    (event: any) => {
      const { doc, append } = event;
      const wrap = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
      wrap.className = "scholar-suite-toolbar";
      wrap.setAttribute("style", "display:flex;align-items:center;gap:2px;");
      wrap.appendChild(createSourceSelect(doc));
      const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
      btn.className = "toolbar-button scholar-fulltext-button";
      btn.title = "全文翻译（保留图片）";
      btn.textContent = "译全文";
      btn.setAttribute("style", "width:auto;padding:0 6px;font-size:12px;");
      btn.addEventListener("click", () => {
        const it = Zotero.Items.get(event.reader.itemID);
        if (it) fullTextTranslate(it);
      });
      wrap.appendChild(btn);
      append(wrap);
    },
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "createViewContextMenu",
    (event: any) => {
      const { reader, append } = event;
      append({
        label: "全文翻译（保留图片）",
        onCommand: () => {
          const it = Zotero.Items.get(reader.itemID);
          if (it) fullTextTranslate(it);
        },
      });
    },
    config.addonID,
  );
}

/* ---------------- main window toolbar switcher ---------------- */

function updateToolbarButton(win: Window) {
  const btn = win.document.getElementById(TOOLBAR_BTN_ID) as any;
  if (!btn) return;
  const eff = getEffectiveProfileId();
  const p = eff ? getProfile(eff) : undefined;
  btn.setAttribute("tooltiptext", `翻译模型源：${p ? p.name + (p.model ? " · " + p.model : "") : "未使用模型源管理器"}（点击切换）`);
  btn.setAttribute("label", p ? p.name : "模型源");
}

export function addToolbarButton(win: Window) {
  const doc = win.document;
  if (doc.getElementById(TOOLBAR_BTN_ID)) return;
  const anchor =
    doc.getElementById("zotero-tb-sync") ||
    doc.getElementById("zotero-tb-note-add") ||
    doc.querySelector("#zotero-items-toolbar toolbarbutton:last-of-type");
  if (!anchor || !anchor.parentNode) return;
  const btn = doc.createElementNS(XUL_NS, "toolbarbutton") as any;
  btn.id = TOOLBAR_BTN_ID;
  btn.setAttribute("type", "menu");
  btn.setAttribute("class", "zotero-tb-button");
  btn.setAttribute("image", ICON);
  btn.setAttribute("style", "list-style-image:url(" + ICON + ");-moz-context-properties:fill;");
  const popup = doc.createElementNS(XUL_NS, "menupopup") as any;
  popup.addEventListener("popupshowing", () => {
    while (popup.firstChild) popup.firstChild.remove();
    const active = getEffectiveProfileId();
    const list = listProfiles();
    if (!list.length) {
      const mi = doc.createElementNS(XUL_NS, "menuitem") as any;
      mi.setAttribute("label", "（还没有模型源）");
      mi.setAttribute("disabled", "true");
      popup.appendChild(mi);
    }
    for (const p of list) {
      const mi = doc.createElementNS(XUL_NS, "menuitem") as any;
      mi.setAttribute("type", "radio");
      mi.setAttribute("label", `${p.name}${p.model ? " · " + p.model : ""}`);
      if (p.id === active) mi.setAttribute("checked", "true");
      mi.addEventListener("command", () => activateProfile(p.id));
      popup.appendChild(mi);
    }
    popup.appendChild(doc.createElementNS(XUL_NS, "menuseparator"));
    const manage = doc.createElementNS(XUL_NS, "menuitem") as any;
    manage.setAttribute("label", "管理模型源…");
    manage.addEventListener("command", () => openSourceManager());
    popup.appendChild(manage);
    const ft = doc.createElementNS(XUL_NS, "menuitem") as any;
    ft.setAttribute("label", "全文翻译（保留图片）");
    ft.addEventListener("command", () => fullTextTranslateContext());
    popup.appendChild(ft);
  });
  btn.appendChild(popup);
  anchor.parentNode.insertBefore(btn, anchor);
  updateToolbarButton(win);
}

export function removeToolbarButton(win: Window) {
  win.document.getElementById(TOOLBAR_BTN_ID)?.remove();
  win.document.getElementById("scholar-suite-fulltext-engine")?.remove();
}

/* ---------------- shortcuts ---------------- */

export function registerScholarShortcuts() {
  ztoolkit.Keyboard.register((ev: KeyboardEvent, data: any) => {
    if (data.type !== "keyup" || !data.keyboard) return;
    if (data.keyboard.equals("alt,shift,F")) {
      fullTextTranslateContext();
    } else if (data.keyboard.equals("alt,shift,M")) {
      openSourceManager();
    }
  });
}

/* ---------------- lifecycle ---------------- */

export function initScholar() {
  unlisten = onProfilesChanged(() => refreshAllSelects()) as any;
  unwatchSource = watchTranslateSource();
  registerScholarMenus();
  registerScholarReader();
  registerScholarShortcuts();
}

export function onScholarMainWindowLoad(win: Window) {
  try {
    addToolbarButton(win);
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

export function shutdownScholar() {
  unlisten?.();
  unlisten = null;
  unwatchSource?.();
  unwatchSource = null;
  for (const win of Zotero.getMainWindows()) removeToolbarButton(win);
  destroyEngine();
  if (managerWin && !managerWin.closed) managerWin.close();
}
