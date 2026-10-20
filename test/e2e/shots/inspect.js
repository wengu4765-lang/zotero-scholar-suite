// 检查快照阅读器中叠层的实际渲染：容器尺寸、字号、是否溢出
const r = Zotero.Reader._readers[Zotero.Reader._readers.length - 1];
const d = r._iframeWindow.document.querySelector("iframe").contentWindow.document;
const out = [];
for (const fx of d.querySelectorAll(".ftx")) {
  const fb = fx.getBoundingClientRect();
  const sp = [...fx.querySelectorAll(".ftx-t")];
  out.push({
    ftx: [fb.width, fb.height].map(Math.round),
    n: sp.length,
    spans: sp.map((s) => {
      const b = s.getBoundingClientRect();
      const cs = s.ownerGlobal.getComputedStyle(s);
      return { t: s.textContent, fs: cs.fontSize, box: [b.left - fb.left, b.top - fb.top, b.width, b.height].map(Math.round), overflowX: s.scrollWidth > s.clientWidth + 1 };
    }),
  });
}
const layerHidden = [...d.querySelectorAll(".ftx-layer")].map((l) => l.ownerGlobal.getComputedStyle(l).display);
return { out, layerDisplay: layerHidden };
