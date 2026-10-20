// 图内文字：建翻译源（zh 代理 8766，离线词表 + 缓存）与识图源（识图·OpenAI 预设改指本地 mock 识图 8767），
// 打开位图 OCR，导入 DreamBooth 截取版（第 1、2、5 页），后台跑全文翻译（结果写入 globalThis.__fx）
const api = Zotero.PDFTranslate.api.profiles;
const P = "extensions.zotero.ZoteroPDFTranslate.";
for (const p of api.list()) api.remove(p.id);
const tr = api.save({ name: "中文代理（测试）", type: "custom", baseURL: "http://127.0.0.1:8766/v1", model: "mymemory-zh", temperature: 0 }, "");
api.activate(tr.id);
const v0 = api.resolveVision(); // 未指定识图源 + 当前源未勾选“支持图片输入” → 应给出原因
const vis = api.createFromPreset("vision-openai", "sk-test-vision-123456");
const presetModel = api.get(vis.id).model;
api.save({ id: vis.id, baseURL: "http://127.0.0.1:8767/v1", model: "mock-vision" });
api.setVision(vis.id);
const v1 = api.resolveVision();
Zotero.Prefs.set(P + "fullText.figureText.enabled", true, true);
Zotero.Prefs.set(P + "fullText.figureText.ocr", true, true);
const file = globalThis.__fxFile || PathUtils.join((Services.env.get("ZSS_TESTDATA") || "testdata"), "dreambooth-figtext-p1-2-5.pdf");
let parent = new Zotero.Item("journalArticle");
parent.setField("title", "DreamBooth（图内文字测试：第 1、2、5 页）");
parent.setField("language", "en");
await parent.saveTx();
await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id });
globalThis.__fx = null;
globalThis.__fxParent = parent.id;
const t0 = Date.now();
Zotero.PDFTranslate.api.fullText.run(parent.id, { noOpen: true, noPrompt: true }).then((r) => (globalThis.__fx = { r, ms: Date.now() - t0 }));
return { parent: parent.id, presetModel, visionBefore: v0, visionAfter: v1, settings: Zotero.PDFTranslate.api.fullText.figureTextSettings() };
