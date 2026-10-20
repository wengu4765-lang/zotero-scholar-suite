// 把全文翻译 HTML（Zotero 快照阅读器）里第 globalThis.__ftxIdx 个 <figure> 滚到屏幕中间，返回其位置
const idx = globalThis.__ftxIdx || 0;
const r = Zotero.Reader._readers[Zotero.Reader._readers.length - 1];
const d = r._iframeWindow.document.querySelector("iframe").contentWindow.document;
const el = d.querySelectorAll("figure")[idx];
el.scrollIntoView({ block: "center" });
await Zotero.Promise.delay(600);
const b = el.getBoundingClientRect();
return { n: d.querySelectorAll("figure").length, rect: [b.left, b.top, b.width, b.height].map(Math.round), kind: el.dataset.kind, ftx: el.dataset.ftx || 0 };
