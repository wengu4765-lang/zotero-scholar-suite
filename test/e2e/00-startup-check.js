// 启动自检：套件变体、子模块启动状态、偏好面板、Style 是否在运行、控制台错误
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const addons = (await AddonManager.getAllAddons()).filter((a) => a.type === "extension" && !a.isSystem)
  .map((a) => ({ id: a.id, name: a.name, version: a.version, active: a.isActive }));
const panes = (Zotero.PreferencePanes.pluginPanes || []).map((p) => ({ id: p.id, pluginID: p.pluginID, label: p.label }));
const msgs = Services.console.getMessageArray() || [];
const errs = msgs.map((m) => { try { m.QueryInterface(Ci.nsIScriptError); return m.flags & 1 ? null : m.errorMessage + " @ " + m.sourceName; } catch (e) { return null; } })
  .filter(Boolean)
  .filter((t) => /ScholarSuite|zotero-scholar-suite|PDFTranslate|BetterNotes|zoterostyle|ZoteroStyle|modules\/(pdf-translate|better-notes|ethereal-style)/i.test(t));
return {
  zotero: Zotero.version,
  suite: Zotero.ScholarSuite && Zotero.ScholarSuite.state,
  variant: Zotero.ScholarSuite && Zotero.ScholarSuite.variant,
  instances: { PDFTranslate: !!Zotero.PDFTranslate, BetterNotes: !!Zotero.BetterNotes, ZoteroStyle: !!Zotero.ZoteroStyle,
    fullText: !!(Zotero.PDFTranslate && Zotero.PDFTranslate.api && Zotero.PDFTranslate.api.fullText),
    profiles: !!(Zotero.PDFTranslate && Zotero.PDFTranslate.api && Zotero.PDFTranslate.api.profiles) },
  addons, panes, errors: errs.slice(-30),
};
