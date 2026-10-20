// 超过 30MB 提示：导入 LDM（40.8MB）并发起全文翻译（不加 noPrompt，应弹出“文件过大”提示）；结果写入 globalThis.__tl
let parent = new Zotero.Item("journalArticle");
parent.setField("title", "High-Resolution Image Synthesis with Latent Diffusion Models（40.8MB 超限测试）");
await parent.saveTx();
await Zotero.Attachments.importFromFile({ file: PathUtils.join((Services.env.get("ZSS_TESTDATA") || "testdata"), "ldm-2112.10752.pdf"), parentItemID: parent.id });
globalThis.__tl = null;
Zotero.PDFTranslate.api.fullText.run(parent.id, { noOpen: true }).then((r) => (globalThis.__tl = r));
return { parent: parent.id, limitMB: Zotero.Prefs.get("extensions.zotero.ZoteroPDFTranslate.fullText.maxFileSizeMB", true) };
