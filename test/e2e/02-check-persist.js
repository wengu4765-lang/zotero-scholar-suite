// 重启后：源列表、Key、当前源、翻译服务是否保持；并实际走一次翻译确认路由到 mock
const api = Zotero.PDFTranslate.api.profiles;
const P = "extensions.zotero.ZoteroPDFTranslate.";
const list = api.list().map((p) => ({ name: p.name, active: p.active, hasKey: p.hasKey }));
const r = await Zotero.PDFTranslate.api.translate("Persistence check.", { langfrom: "en-US", langto: "zh-CN", pluginID: "e2e@test" });
return { list, src: Zotero.Prefs.get(P + "translateSource", true), result: r.result, service: r.service,
  pass: list.length === 4 && list.filter((p) => p.active).length === 1 && list.find((p) => p.active).name === "本地 Mock（测试）" && list[0].hasKey && list[1].hasKey && r.result.startsWith("[译]") };
