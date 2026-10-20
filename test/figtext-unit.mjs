// 图内文字翻译：纯函数单元测试（figureText.ts / vision.ts，与插件同一份 TS 源码）
// 用法: node figtext-unit.mjs
import { build } from "esbuild";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src", "pdf-translate", "src", "modules", "scholar");
for (const [name, entry] of [["ft", "fulltext/figureText.ts"], ["vision", "vision.ts"]]) {
  await build({ entryPoints: [path.join(src, entry)], bundle: true, format: "esm", platform: "node", outfile: path.join(here, "dist", `${name}.mjs`), logLevel: "warning" });
}
const f = await import(path.join(here, "dist", "ft.mjs"));
const v = await import(path.join(here, "dist", "vision.mjs"));
let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log("✓", name);
};

t("needsTranslation", () => {
  assert.equal(f.needsTranslation("Real Images"), true);
  assert.equal(f.needsTranslation("Ours"), true);
  assert.equal(f.needsTranslation("CLIP-I ↑"), false);
  assert.equal(f.needsTranslation("0.774"), false);
  assert.equal(f.needsTranslation("(a)"), false);
  assert.equal(f.needsTranslation("输入图像"), false);
});
t("batch build/parse with fallback markers", () => {
  assert.equal(f.buildBatch(["Input images", "Ours"]), "[1] Input images\n[2] Ours");
  assert.deepEqual(f.parseBatch("[1] 输入图像\n[2] 我们的方法\n【3】 保真度", 3), ["输入图像", "我们的方法", "保真度"]);
  assert.deepEqual(f.parseBatch("[2] 只有第二行", 3), [undefined, "只有第二行", undefined]);
});
t("parseOcrReply: fenced JSON, normalised", () => {
  const r = f.parseOcrReply('```json\n{"items":[{"text":"Input images","bbox":[0.1,0.8,0.3,0.9]}]}\n```', 1000, 500);
  assert.deepEqual(r, [{ text: "Input images", bbox: [0.1, 0.8, 0.3, 0.9] }]);
});
t("parseOcrReply: Gemini box_2d (ymin,xmin,ymax,xmax 0..1000)", () => {
  const r = f.parseOcrReply('{"items":[{"text":"A","box_2d":[100,200,150,400]}]}', 1000, 500);
  assert.deepEqual(r[0].bbox, [0.2, 0.1, 0.4, 0.15]);
});
t("parseOcrReply: per-mille and pixel coordinates", () => {
  assert.deepEqual(f.parseOcrReply('[{"text":"Hi","bbox":[100,200,300,260]}]', 1600, 800)[0].bbox, [0.1, 0.2, 0.3, 0.26]);
  assert.deepEqual(f.parseOcrReply('[{"text":"Hi","bbox":[160,80,480,160]}]', 1600, 800, { pixelCoords: true })[0].bbox, [0.1, 0.1, 0.3, 0.2]);
});
t("parseOcrReply: think tags + prose around JSON; garbage throws", () => {
  const r = f.parseOcrReply('<think>…</think>Here you go: {"items":[{"text":"x y","bbox":[0,0,0.2,0.1]}]} hope it helps', 100, 100);
  assert.equal(r.length, 1);
  assert.throws(() => f.parseOcrReply("Sorry, I can't read this figure.", 100, 100));
  assert.deepEqual(f.parseOcrReply('{"items":[]}', 100, 100), []);
});
t("trimOcrNoise keeps arrows, drops stray slashes", () => {
  assert.equal(f.trimOcrNoise({ text: "New contexts /", bbox: [0.1, 0.1, 0.5, 0.2] }).text, "New contexts");
  assert.ok(f.trimOcrNoise({ text: "New contexts /", bbox: [0.1, 0.1, 0.5, 0.2] }).bbox[2] < 0.5);
  assert.equal(f.trimOcrNoise({ text: "Loss ↑", bbox: [0, 0, 1, 1] }).text, "Loss ↑");
});
t("ocrItemsToLabels drops duplicates of vector text and implausible boxes", () => {
  const vec = [{ source: "vector", text: "Ours", x: 0.1, y: 0.1, w: 0.1, h: 0.05, fs: 0.02 }];
  const ls = f.ocrItemsToLabels(
    [
      { text: "Ours", bbox: [0.1, 0.1, 0.2, 0.15] },
      { text: "Input images", bbox: [0.5, 0.5, 0.7, 0.55] },
      { text: "sleeping", bbox: [0.5, 0.0, 0.6, 0.6] },
    ],
    vec,
    0.5,
  );
  assert.deepEqual(ls.map((l) => l.text), ["Input images"]);
});
t("fitLabel never exceeds the original size, CJK fits the box", () => {
  const l = { source: "vector", text: "Method", translation: "方法", x: 0.1, y: 0.1, w: 0.1, h: 0.04, fs: 0.033 };
  const o = f.fitLabel(l, 0.25, 480);
  assert.ok(o.fsCqw <= 3.3 + 1e-9);
  assert.ok(f.emWidth("方法") * o.fsCqw <= o.w * 100 * 1.01, "text fits mask width");
  const long = f.fitLabel({ ...l, translation: "这是一个非常非常长的中文翻译结果" }, 0.25, 480);
  assert.ok(f.emWidth(long.text) * long.fsCqw <= long.w * 100 * 1.01);
  assert.equal(long.lines, 1);
});
t("vision requests: openai / zhipu / claude / gemini shapes", () => {
  const url = "data:image/jpeg;base64,QUJD";
  const o = v.buildVisionRequest({ type: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-5.4-mini" }, "k", url, "OCR");
  assert.equal(o.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(o.body.messages[0].content[1].image_url.url, url);
  const z = v.buildVisionRequest({ type: "openai", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6v-flash" }, "k", url, "OCR");
  assert.equal(z.format, "zhipu");
  assert.equal(z.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(z.body.messages[0].content[1].image_url.url, "QUJD");
  const c = v.buildVisionRequest({ type: "claude", baseURL: "https://api.anthropic.com/v1", model: "claude-haiku-5-5" }, "k", url, "OCR");
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.headers["x-api-key"], "k");
  assert.deepEqual(c.body.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  const g = v.buildVisionRequest({ type: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.5-flash-lite" }, "k", url, "OCR");
  assert.equal(g.format, "gemini");
  assert.equal(g.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  assert.deepEqual(g.body.contents[0].parts[1], { inline_data: { mime_type: "image/jpeg", data: "QUJD" } });
  const go = v.buildVisionRequest({ type: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.5-flash-lite" }, "k", url, "OCR");
  assert.equal(go.format, "openai");
  assert.equal(go.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  const q = v.buildVisionRequest({ type: "openai", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-flash", customParams: '{"enable_thinking": false}' }, "k", url, "OCR");
  assert.equal(q.body.enable_thinking, false);
  assert.equal(v.visionUsesPixelCoords({ model: "qwen2.5-vl-72b-instruct" }), true);
});
t("vision responses", () => {
  assert.equal(v.extractVisionText("openai", { choices: [{ message: { content: "x" } }] }), "x");
  assert.equal(v.extractVisionText("claude", { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(v.extractVisionText("gemini", { candidates: [{ content: { parts: [{ text: "g" }] } }] }), "g");
  assert.throws(() => v.extractVisionText("openai", { error: { message: "bad key" } }), /bad key/);
});
t("symbol-only / single non-alnum OCR items are dropped", () => {
  assert.equal(f.trimOcrNoise({ text: "/", bbox: [0.1, 0.1, 0.2, 0.2] }), null);
  assert.equal(f.trimOcrNoise({ text: "✓", bbox: [0.1, 0.1, 0.2, 0.2] }), null);
  assert.equal(f.trimOcrNoise({ text: "| ×", bbox: [0.1, 0.1, 0.2, 0.2] }), null);
  const ls = f.ocrItemsToLabels([{ text: "✓", bbox: [0.1, 0.1, 0.13, 0.15] }, { text: "→", bbox: [0.3, 0.1, 0.33, 0.15] }], [], 1);
  assert.equal(ls.length, 0);
});
t("refineWithPixels: trimmed box is cut before a ✓, mask never reaches other ink", () => {
  // 200x40 white image: "text" ink at x 10..120, a symbol (✓ stand-in) at x 150..165
  const W = 200, H = 40, data = new Uint8ClampedArray(W * H * 4).fill(255);
  const ink = (xa, xb) => { for (let y = 12; y < 28; y++) for (let x = xa; x < xb; x++) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; } };
  for (let x = 10; x < 120; x += 8) ink(x, x + 5);
  ink(150, 165);
  ink(185, 200); // a photo frame further right must not move the cut past the symbol
  // OCR read "New contexts /": box 10..166, the proportional trim leaves it at ~150 (on top of the symbol)
  const [lab] = f.ocrItemsToLabels([{ text: "New contexts /", bbox: [10 / W, 10 / H, 166 / W, 30 / H] }], [], H / W);
  assert.ok(lab.trimmed && lab.trimmed.trail);
  f.refineWithPixels([lab], { data, width: W, height: H });
  assert.ok((lab.x + lab.w) * W <= 130, `right edge ${(lab.x + lab.w) * W}`);
  assert.ok((lab.x + lab.w + lab.freeR) * W < 150);
  // a symbol touching the box is not "overhang": no free space on that side
  const l2 = { source: "ocr", text: "Loss", x: 10 / W, y: 10 / H, w: 138 / W, h: 20 / H, fs: 0.05 };
  f.refineWithPixels([l2], { data, width: W, height: H });
  assert.equal(l2.freeR, 0);
  lab.translation = "新场景（一段很长很长的译文用来触发加宽）";
  const o = f.fitLabel(lab, H / W, W);
  assert.ok((o.x + o.w) * W < 150, `mask right ${(o.x + o.w) * W}`);
});
console.log(`\n${n} groups passed`);
