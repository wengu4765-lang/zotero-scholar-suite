// 进度窗口里的文字（图内文字进度）与取消按钮是否存在
const w = [...Services.wm.getEnumerator("alert:alert")].find((x) => x.document.getElementById("scholar-fulltext-cancel"));
if (!w) return { found: false, job: Zotero.PDFTranslate.api.fullText.current()?.message };
const txt = [...w.document.querySelectorAll("label, description, .zotero-progress-item-label, div")].map((e) => e.textContent).filter((t) => t && t.includes("%")).slice(0, 3);
return { found: true, text: txt, job: Zotero.PDFTranslate.api.fullText.current()?.message, frac: Zotero.PDFTranslate.api.fullText.current()?.fraction };
