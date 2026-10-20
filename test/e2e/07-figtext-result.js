// 读取图内文字翻译结果：统计 + 叠层抽样
const f = globalThis.__fx;
if (!f) { const j = Zotero.PDFTranslate.api.fullText.current(); return { running: true, msg: j && j.message, frac: j && j.fraction }; }
const r = f.r;
const att = r.attachmentID && Zotero.Items.get(r.attachmentID);
let sample = [], toolbar = false, layers = 0;
if (att) {
  const html = await Zotero.File.getContentsAsync(att.getFilePath());
  toolbar = /<label for="f-tr">显示译文<\/label><label for="f-orig">显示原图<\/label>/.test(html);
  layers = (html.match(/class="ftx-layer"/g) || []).length;
  const re = /data-src="(\w+)" title="([^"]*)"[^>]*>([^<]*)</g; let m;
  while ((m = re.exec(html)) && sample.length < 40) sample.push(`${m[1]}: ${m[2]} → ${m[3]}`);
}
return { done: true, ok: r.ok, reason: r.reason, ms: f.ms, pages: r.pageCount, stats: r.stats, figureText: r.figureText, figureFailures: r.figureFailures, failures: (r.failures || []).length, attachmentID: r.attachmentID, toolbar, layers, sample };
