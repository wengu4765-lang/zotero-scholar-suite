// 点击 HTML 工具栏的「图内文字：显示原图 / 显示译文」（纯 CSS 单选，不依赖 JS）
const which = globalThis.__toggle || "f-orig";
const r = Zotero.Reader._readers[Zotero.Reader._readers.length - 1];
const d = r._iframeWindow.document.querySelector("iframe").contentWindow.document;
d.querySelector(`label[for=${which}]`).click();
await Zotero.Promise.delay(300);
return { checked: d.getElementById(which).checked, layer: d.defaultView.getComputedStyle(d.querySelector(".ftx-layer")).display, scripts: d.querySelectorAll("script").length };
