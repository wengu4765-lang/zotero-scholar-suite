// 回归检查：统计 + 叠层 HTML 自检（每个 ftx-layer 内叠加数、坐标在 0..100%、无空译文、纯 CSS 切换存在）+ 抽查 Fig.2 的 OCR 叠层
const f = globalThis.__fx;
if (!f) { const j = Zotero.PDFTranslate.api.fullText.current(); return { running: true, msg: j && j.message, frac: j && j.fraction }; }
const r = f.r;
const att = r.attachmentID && Zotero.Items.get(r.attachmentID);
const out = { done: true, ok: r.ok, reason: r.reason, ms: f.ms, pages: r.pageCount, stats: r.stats, failures: (r.failures || []).length,
  figureText: r.figureText, figureFailures: r.figureFailures, attachmentID: r.attachmentID };
if (att) {
  const html = await Zotero.File.getContentsAsync(att.getFilePath());
  out.htmlKB = Math.round(html.length / 1024);
  out.layers = (html.match(/class="ftx-layer"/g) || []).length;
  const ov = [...html.matchAll(/<span class="ftx[^"]*"[^>]*data-src="(\w+)"[^>]*style="([^"]*)"[^>]*>([^<]*)</g)];
  out.overlaySpans = ov.length;
  const bad = [];
  for (const m of ov) {
    const st = m[2];
    const nums = [...st.matchAll(/(left|top|width|height):\s*(-?[\d.]+)%/g)].map((x) => [x[1], +x[2]]);
    if (!m[3].trim()) bad.push({ why: "empty", st });
    for (const [k, v] of nums) if (v < -0.01 || v > 100.01) bad.push({ why: `${k}=${v}`, text: m[3] });
  }
  out.badOverlays = bad.slice(0, 10);
  out.badCount = bad.length;
  out.cssToggle = /<label for="f-tr">显示译文<\/label><label for="f-orig">显示原图<\/label>/.test(html) && !/<script/i.test(html);
  out.bySource = { vector: ov.filter((m) => m[1] === "vector").length, ocr: ov.filter((m) => m[1] === "ocr").length };
  out.symbolOnly = ov.filter((m) => !/[\p{L}\p{N}]/u.test(m[3])).length;
  out.sameAsSource = [...html.matchAll(/data-src="\w+" title="([^"]*)"[^>]*>([^<]*)</g)].filter((m) => m[1].trim() === m[2].trim()).length;
  out.newContexts = [...html.matchAll(/title="(New contexts[^"]*)"[^>]*style="([^"]*)"/g)].map((m) => m[1] + " | " + m[2]).slice(0, 4);
}
return out;
