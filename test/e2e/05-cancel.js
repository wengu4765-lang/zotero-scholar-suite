// 再跑一次，5 秒后点击进度窗口里的「取消」按钮，确认任务结束、未生成附件
const pid = globalThis.__ftParent;
const before = Zotero.Items.get(pid).getAttachments().length;
let r = null;
Zotero.PDFTranslate.api.fullText.run(pid, { noOpen: true, noPrompt: true }).then((x) => (r = x));
await Zotero.Promise.delay(5000);
const pw = [...Services.wm.getEnumerator("alert:alert")].find((w) => w.document.getElementById("scholar-fulltext-cancel"));
if (!pw) return { pass: false, err: "进度窗口里没有找到取消按钮" };
pw.document.getElementById("scholar-fulltext-cancel").click();
for (let i = 0; i < 150 && !r; i++) await Zotero.Promise.delay(200);
const after = Zotero.Items.get(pid).getAttachments().length;
return { reason: r && r.reason, attBefore: before, attAfter: after, jobCleared: !Zotero.PDFTranslate.api.fullText.current(), pass: !!r && r.reason === "cancelled" && before === after };
