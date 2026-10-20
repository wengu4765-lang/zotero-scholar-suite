// 导入 23MB 测试 PDF，用 mock 服务跑全文翻译（后台运行，结果写到 globalThis.__ft）
let parent = new Zotero.Item("journalArticle");
parent.setField("title", "DreamBooth: Fine Tuning Text-to-Image Diffusion Models for Subject-Driven Generation");
parent.setField("language", "en");
await parent.saveTx();
await Zotero.Attachments.importFromFile({ file: PathUtils.join((Services.env.get("ZSS_TESTDATA") || "testdata"), "dreambooth-2208.12242.pdf"), parentItemID: parent.id });
globalThis.__ft = null; globalThis.__ftParent = parent.id;
const t0 = Date.now();
Zotero.PDFTranslate.api.fullText.run(parent.id, { noOpen: true, noPrompt: true }).then((r) => (globalThis.__ft = { r, ms: Date.now() - t0 }));
return { parent: parent.id };
