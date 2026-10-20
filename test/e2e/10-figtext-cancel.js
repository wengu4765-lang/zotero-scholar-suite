// OCR 进行中（mock-slow 不返回）点击进度窗口「取消」：应在数秒内结束，不生成附件
const pid = globalThis.__fxParent;
const before = Zotero.Items.get(pid).getAttachments().length;
const w = [...Services.wm.getEnumerator("alert:alert")].find((x) => x.document.getElementById("scholar-fulltext-cancel"));
if (!w) return { pass: false, err: "没有取消按钮", job: Zotero.PDFTranslate.api.fullText.current()?.message };
const msgBefore = Zotero.PDFTranslate.api.fullText.current()?.message;
const t0 = Date.now();
w.document.getElementById("scholar-fulltext-cancel").click();
for (let i = 0; i < 100 && !globalThis.__fx; i++) await Zotero.Promise.delay(100);
const f = globalThis.__fx;
return { msgBefore, cancelMs: Date.now() - t0, reason: f && f.r.reason, attBefore: before, attAfter: Zotero.Items.get(pid).getAttachments().length, jobCleared: !Zotero.PDFTranslate.api.fullText.current(), pass: !!f && f.r.reason === "cancelled" && Date.now() - t0 < 5000 };
