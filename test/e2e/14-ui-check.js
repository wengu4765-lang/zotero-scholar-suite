// 界面自检：打开模型源管理器（统计卡片 / 当前标记）与设置窗口（列出插件偏好面板及其是否能加载）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const w = Zotero.PDFTranslate.api.profiles.openManager();
for (let i = 0; i < 40 && !(w.document && w.document.readyState === "complete" && w.document.querySelector(".card")); i++) await sleep(250);
const d = w.document;
out.sourceManager = { title: d.title, cards: d.querySelectorAll(".card").length, active: [...d.querySelectorAll(".card.active")].map((e) => e.textContent.trim().slice(0, 40)) };
w.close();
const prefsWin = Zotero.Utilities.Internal.openPreferences();
for (let i = 0; i < 60 && !(prefsWin.document && prefsWin.document.readyState === "complete" && prefsWin.Zotero_Preferences && prefsWin.Zotero_Preferences.panes); i++) await sleep(250);
await sleep(1500);
const pd = prefsWin.document;
const navItems = [...pd.querySelectorAll("#prefs-navigation richlistitem, #prefs-navigation .pane-item, #prefs-navigation [value]")]
  .map((e) => ({ value: e.getAttribute("value") || e.id, label: (e.textContent || "").trim() })).filter((x) => x.value && /plugin-pane/.test(x.value));
out.prefPanes = [];
for (const it of navItems) {
  try {
    await prefsWin.Zotero_Preferences.navigateToPane(it.value);
    await sleep(1500);
    const visible = [...pd.querySelectorAll("#prefs-content > *")].filter((e) => !e.hidden && e.getBoundingClientRect().height > 0);
    const text = visible.map((e) => e.textContent.replace(/\s+/g, " ").trim()).join(" ");
    const navLabel = (pd.querySelector(`#prefs-navigation [value="${it.value}"]`) || {}).textContent;
    out.prefPanes.push({ ...it, label: (navLabel || "").trim(), loaded: text.length > 50, textLen: text.length, controls: visible.reduce((n, e) => n + e.querySelectorAll("input,checkbox,menulist,button,select,textarea,radio").length, 0), textStart: text.slice(0, 120) });
  } catch (e) {
    out.prefPanes.push({ ...it, error: String(e) });
  }
}
prefsWin.close();
return out;
