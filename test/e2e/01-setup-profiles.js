// 新建 4 个源（3 个预设 + 1 个指向本地 mock），验证未启用前没有“当前”标记、翻译服务未被切换；然后启用 mock 源
const api = Zotero.PDFTranslate.api.profiles;
const P = "extensions.zotero.ZoteroPDFTranslate.";
for (const p of api.list()) api.remove(p.id);
const srcBefore = Zotero.Prefs.get(P + "translateSource", true);
api.createFromPreset("deepseek", "sk-test-deepseek-1234567890");
api.createFromPreset("moonshot", "sk-test-kimi-abcdefghijk");
api.createFromPreset("ollama");
const mock = api.save({ name: "本地 Mock（测试）", type: "custom", baseURL: "http://127.0.0.1:8765/v1", model: "mock-model", temperature: 0.2 }, "");
const before = { marks: api.list().filter((p) => p.active).length, activeId: api.getActiveId(), src: Zotero.Prefs.get(P + "translateSource", true) };
api.activate(mock.id);
const after = { marks: api.list().filter((p) => p.active).map((p) => p.name), src: Zotero.Prefs.get(P + "translateSource", true) };
const test = await api.test(mock.id);
return { srcBefore, before, after, test, pass: before.marks === 0 && before.src === srcBefore && after.marks.length === 1 && after.src === "profile" && test.ok };
