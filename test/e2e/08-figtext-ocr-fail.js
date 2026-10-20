// 识图失败 / 超时：把识图源模型改成 mock-fail（HTTP 500）或 mock-slow（不返回），OCR 超时设为 globalThis.__fxTimeout 秒；
// 期望：整篇照常完成，OCR 失败的图被跳过并记录，矢量图内文字照常叠加
const api = Zotero.PDFTranslate.api.profiles;
const P = "extensions.zotero.ZoteroPDFTranslate.";
const model = globalThis.__fxModel || "mock-fail";
api.save({ id: api.getVisionId(), model });
Zotero.Prefs.set(P + "fullText.figureText.ocrTimeout", String(globalThis.__fxTimeout || 60), true);
globalThis.__fx = null;
const t0 = Date.now();
Zotero.PDFTranslate.api.fullText.run(globalThis.__fxParent, { noOpen: true, noPrompt: true }).then((r) => (globalThis.__fx = { r, ms: Date.now() - t0 }));
return { model, timeout: Zotero.Prefs.get(P + "fullText.figureText.ocrTimeout", true) };
