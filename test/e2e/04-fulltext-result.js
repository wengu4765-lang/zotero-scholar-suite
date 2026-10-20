const f = globalThis.__ft;
if (!f) { const j = Zotero.PDFTranslate.api.fullText.current(); return { running: true, msg: j && j.message, frac: j && j.fraction }; }
const att = f.r.attachmentID && Zotero.Items.get(f.r.attachmentID);
return { done: true, ok: f.r.ok, reason: f.r.reason, ms: f.ms, pages: f.r.pageCount, stats: f.r.stats, failures: (f.r.failures || []).length, htmlKB: Math.round((f.r.htmlBytes || 0) / 1024),
  attachment: att && { title: att.getField("title"), parentID: att.parentItemID, path: att.getFilePath(), type: att.attachmentContentType } };
