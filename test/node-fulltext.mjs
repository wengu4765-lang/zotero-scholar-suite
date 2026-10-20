// Node 侧验证：用 pdfjs-dist + @napi-rs/canvas 跑与插件完全相同的全文翻译引擎代码
// （src/modules/scholar/fulltext/engine.ts），翻译走本地 mock 的 OpenAI 兼容服务。
// 用法: node node-fulltext.mjs <pdf> <out.html> [--mock http://127.0.0.1:8765] [--pages N] [--max-mb 30]
//   图内文字: [--figtext] [--ocr http://127.0.0.1:8767/v1] [--vision-type openai|claude|gemini] [--vision-model m]
//            [--vision-format auto|openai|zhipu|claude|gemini] [--ocr-timeout ms] [--skip-photo] [--max-images N]
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, Path2D, DOMMatrix, ImageData } from "@napi-rs/canvas";
// pdf.js 在 Node 下需要与 canvas 实现一致的 Path2D/DOMMatrix
globalThis.Path2D = Path2D;
globalThis.DOMMatrix = DOMMatrix;
globalThis.ImageData = ImageData;

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pdfPath = args[0];
const outPath = args[1] || "out.html";
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const mock = opt("--mock", "http://127.0.0.1:8765");
const maxPages = parseInt(opt("--pages", "0")) || undefined;
const maxMB = parseFloat(opt("--max-mb", "30"));
const debugDir = opt("--debug", "");
const figtext = args.includes("--figtext");
const ocrBase = opt("--ocr", "");
const visionProfile = {
  type: opt("--vision-type", "openai"),
  baseURL: ocrBase,
  model: opt("--vision-model", "mock-vision"),
  visionFormat: opt("--vision-format", "auto"),
};
let debugPages = null;

// 1) 与插件相同的文件大小上限检查
const size = fs.statSync(pdfPath).size;
const limit = maxMB * 1024 * 1024;
if (size > limit) {
  console.log(JSON.stringify({ ok: false, reason: "too-large", size, limit }));
  process.exit(4);
}

// 2) 打包引擎源码（与插件中使用的是同一份 TS）
const engineOut = path.join(here, "dist", "engine.mjs");
await build({
  entryPoints: [path.join(here, "..", "src", "pdf-translate", "src", "modules", "scholar", "fulltext", "engine.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: engineOut,
  logLevel: "warning",
});
const engine = await import(engineOut + "?t=" + Date.now());
const visionOut = path.join(here, "dist", "vision.mjs");
await build({
  entryPoints: [path.join(here, "..", "src", "pdf-translate", "src", "modules", "scholar", "vision.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: visionOut,
  logLevel: "warning",
});
const vision = await import(visionOut + "?t=" + Date.now());
let ocrCalls = 0;
const ocr = async ({ dataURL, prompt }) => {
  ocrCalls++;
  const req = vision.buildVisionRequest(visionProfile, "sk-test", dataURL, prompt);
  const r = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  const j = await r.json().catch(() => null);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return vision.extractVisionText(req.format, j);
};
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));

const env = {
  pdfjs,
  docParams: {
    cMapUrl: path.join(pdfjsRoot, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts") + "/",
    wasmUrl: path.join(pdfjsRoot, "wasm") + "/",
    useSystemFonts: false,
    isEvalSupported: false,
  },
  createCanvas(w, h) {
    const canvas = createCanvas(w, h);
    return {
      canvas,
      context: canvas.getContext("2d"),
      toDataURL: (type, q) => canvas.toDataURL(type, q),
    };
  },
  log: (m) => console.error("[engine]", m),
};

const prompt = (t) =>
  `As an academic expert, translate from English to Chinese the text enclosed in 🔤. 🔤 ${t} 🔤 Return only the translation.`;
let calls = 0;
const translate = async (text) => {
  calls++;
  const r = await fetch(mock + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: prompt(text) }], stream: false }),
  });
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j.choices[0].message.content;
};

const t0 = Date.now();
let lastPct = -1;
const res = await engine.runFullText(
  new Uint8Array(fs.readFileSync(pdfPath)),
  {
    title: path.basename(pdfPath),
    sourceFile: path.basename(pdfPath),
    serviceName: "mock-openai (node 验证)",
    langFrom: "en-US",
    langTo: "zh-CN",
  },
  env,
  {
    translate,
    ocr: figtext && ocrBase ? ocr : undefined,
    ocrPixelCoords: vision.visionUsesPixelCoords(visionProfile),
    onAnalyzed: debugDir
      ? (pages) => {
          debugPages = pages;
        }
      : undefined,
    onProgress: (p) => {
      const pct = Math.floor(p.fraction * 20);
      if (pct !== lastPct) {
        lastPct = pct;
        console.error(`[progress] ${(p.fraction * 100).toFixed(0)}% ${p.phase} ${p.message}`);
      }
    },
  },
  {
    maxPages,
    concurrency: 6,
    retries: 2,
    retryDelayMs: 200,
    figureText: figtext
      ? {
          enabled: true,
          ocr: !!ocrBase,
          skipPhoto: args.includes("--skip-photo"),
          maxImages: parseInt(opt("--max-images", "30")),
          ocrTimeoutMs: parseInt(opt("--ocr-timeout", "60000")),
        }
      : undefined,
  },
);
fs.writeFileSync(outPath, res.html);
const summary = {
  ok: true,
  size,
  pages: res.pageCount,
  stats: res.stats,
  calls,
  htmlBytes: res.html.length,
  imgTags: (res.html.match(/<img /g) || []).length,
  seconds: (Date.now() - t0) / 1000,
  timings: res.timings,
  failures: res.failures.slice(0, 5),
  figureText: res.figureText,
  figureFailures: res.figureFailures,
  ocrCalls,
  regions: res.regions.map((r) => ({ page: r.page, kind: r.kind, src: r.source, box: [r.box.x0, r.box.y0, r.box.x1, r.box.y1].map((v) => Math.round(v)), caption: r.caption?.slice(0, 50), kb: Math.round(r.bytes / 1024) })),
};
fs.writeFileSync(outPath.replace(/\.html$/, "") + ".summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, regions: summary.regions.length }, null, 2));

// 调试：把版面分析结果画在页面渲染图上（蓝=段落 绿=标题 橙=图注 红=图表区域 紫=公式）
if (debugDir && debugPages) {
  fs.mkdirSync(debugDir, { recursive: true });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), ...env.docParams }).promise;
  for (const pd of debugPages) {
    const page = await doc.getPage(pd.page);
    const s = 1.5;
    const vp = page.getViewport({ scale: s });
    const c = env.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    c.context.fillStyle = "#fff";
    c.context.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: c.context, viewport: vp }).promise;
    const ctx = c.context;
    const rect = (b, color, lw = 1.5) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.strokeRect(b.x0 * s, b.y0 * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
    };
    for (const g of pd.graphics) if (g.type === "image") rect(g.box, "rgba(0,200,200,0.6)", 1);
    for (const b of pd.blocks) {
      const col = { para: "blue", heading: "green", caption: "orange", noise: "gray", consumed: "#bbb", equation: "purple" }[b.kind] || "black";
      rect(b.box, col, 1);
    }
    for (const r of pd.regions) rect(r.box, r.kind === "equation" ? "purple" : "red", 3);
    fs.writeFileSync(path.join(debugDir, `page-${String(pd.page).padStart(2, "0")}.png`), c.canvas.toBuffer("image/png"));
  }
}
