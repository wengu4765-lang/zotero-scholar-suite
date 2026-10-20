// 回归：整篇 DreamBooth（23MB，25 页）+ mock 翻译（8765）+ mock 识图（8767，OCR 开）。后台运行，结果写入 globalThis.__fx
// 之后用 07-figtext-result.js 或 12-figtext-full-check.js 读取结果
const api = Zotero.PDFTranslate.api.profiles;
const P = "extensions.zotero.ZoteroPDFTranslate.";
for (const p of api.list()) api.remove(p.id);
const tr = api.save({ name: "本地 Mock（测试）", type: "custom", baseURL: "http://127.0.0.1:8765/v1", model: "mock-model", temperature: 0 }, "");
api.activate(tr.id);
const vis = api.createFromPreset("vision-openai", "sk-test-vision-123456");
api.save({ id: vis.id, baseURL: "http://127.0.0.1:8767/v1", model: "mock-vision" });
api.setVision(vis.id);
Zotero.Prefs.set(P + "fullText.figureText.enabled", true, true);
Zotero.Prefs.set(P + "fullText.figureText.ocr", true, true);
const file = PathUtils.join((Services.env.get("ZSS_TESTDATA") || "testdata"), "dreambooth-2208.12242.pdf");
let parent = new Zotero.Item("journalArticle");
parent.setField("title", "DreamBooth（整篇回归：图内文字 + OCR）");
parent.setField("language", "en");
await parent.saveTx();
await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id });
globalThis.__fx = null;
globalThis.__fxParent = parent.id;
const t0 = Date.now();
Zotero.PDFTranslate.api.fullText.run(parent.id, { noOpen: true, noPrompt: true }).then((r) => (globalThis.__fx = { r, ms: Date.now() - t0 }));
return { parent: parent.id, vision: api.resolveVision(), settings: Zotero.PDFTranslate.api.fullText.figureTextSettings() };
