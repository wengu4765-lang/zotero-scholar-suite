/**
 * Zotero Scholar Suite — full-text translation (with figures)
 * Orchestrator. The same code runs inside Zotero (with Zotero's bundled
 * pdf.js) and in Node (with pdfjs-dist + @napi-rs/canvas) for verification.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Box } from "./geometry";
import { classifyFont, FontInfo, glyphsToLines, itemsToGlyphs, linesToBlocks, Block, Line, extractEquations } from "./layout";
import { collectGraphics, GraphicBox } from "./graphics";
import {
  classifyBlocks,
  computeBodyFontSize,
  Element,
  findRegions,
  markFrontMatter,
  markNoise,
  mergeContinuations,
  orderElements,
  Region,
  resetDocState,
} from "./analyze";
import { buildHtml, HtmlDoc, TranslatedElement } from "./html";
import {
  buildBatch,
  collectVectorLabels,
  DEFAULT_FIGURE_TEXT_OPTIONS,
  FigureLabel,
  FigureTextOptions,
  fitLabel,
  harmonizeSizes,
  isPhotoLike,
  needsTranslation,
  ocrItemsToLabels,
  OCR_PROMPT,
  parseBatch,
  parseOcrReply,
  refineWithPixels,
  PixelData,
  rasterCoverage,
  sampleColors,
} from "./figureText";

export interface EngineOptions {
  renderScale: number;
  imageFormat: "auto" | "png" | "jpeg";
  jpegQuality: number;
  equations: boolean;
  concurrency: number;
  retries: number;
  retryDelayMs: number;
  translateCaptions: boolean;
  maxChunkChars: number;
  maxPages?: number;
  /** text inside figures / tables (vector text + optional OCR) */
  figureText?: Partial<FigureTextOptions>;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  renderScale: 2,
  imageFormat: "auto",
  jpegQuality: 0.92,
  equations: true,
  concurrency: 4,
  retries: 2,
  retryDelayMs: 1500,
  translateCaptions: true,
  maxChunkChars: 2500,
};

export interface CanvasLike {
  canvas: any;
  context: any;
  toDataURL(type: string, quality?: number): string | Promise<string>;
  dispose?(): void;
}

export interface EngineEnv {
  pdfjs: any;
  createCanvas(w: number, h: number): CanvasLike;
  docParams?: Record<string, any>;
  log?(msg: string): void;
}

export interface Progress {
  phase: "parse" | "render" | "figtext" | "translate" | "html" | "done";
  done: number;
  total: number;
  /** overall fraction 0..1 */
  fraction: number;
  message: string;
}

export interface EngineCallbacks {
  translate(text: string): Promise<string>;
  onProgress?(p: Progress): void;
  isCancelled?(): boolean;
  /** debug hook: receives per-page analysis (blocks, regions, graphics) */
  onAnalyzed?(pages: any[]): void;
  /**
   * Vision model call for raster figures: receives the image (data URL) and
   * the OCR prompt, returns the model's raw text reply. Absent = no OCR.
   */
  ocr?(req: { dataURL: string; width: number; height: number; prompt: string; page: number }): Promise<string>;
  /** when OCR is enabled but no usable vision source exists: the reason (shown in the result) */
  ocrUnavailable?: string;
  /** coordinate convention hint for the vision model (Qwen2.5-VL answers in pixels) */
  ocrPixelCoords?: boolean;
}

export interface FigureTextStats {
  enabled: boolean;
  ocrEnabled: boolean;
  /** figures/tables whose text was processed */
  regions: number;
  vectorLabels: number;
  ocrRegions: number;
  ocrLabels: number;
  translated: number;
  overlays: number;
  ocrFailed: number;
  translateFailed: number;
  skipped: { small: number; photo: number; limit: number; noText: number };
  ocrUnavailable?: string;
}

export interface EngineMeta {
  title: string;
  sourceFile: string;
  serviceName: string;
  langFrom: string;
  langTo: string;
}

export interface EngineResult {
  html: string;
  pageCount: number;
  stats: HtmlDoc["stats"];
  regions: { page: number; kind: string; box: Box; caption?: string; source: string; bytes: number }[];
  failures: { text: string; error: string }[];
  timings: Record<string, number>;
  figureText: FigureTextStats;
  /** OCR / label translation problems; never fatal */
  figureFailures: { page: number; kind: string; error: string }[];
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

interface PageData {
  page: number;
  pageBox: Box;
  lines: Line[];
  equationBoxes: Box[];
  blocks: Block[];
  graphics: GraphicBox[];
  regions: Region[];
  elements: Element[];
}

function now() {
  return Date.now();
}

/** Find the bounding box of non-white pixels; returns null if nothing to trim. */
export function trimWhite(
  data: ArrayLike<number>,
  w: number,
  h: number,
  pad: number,
): { x: number; y: number; w: number; h: number } | null {
  const isInk = (i: number) => data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (isInk(row + x * 4)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** split long text at sentence boundaries */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？]+$/g) || [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Race a promise against a timeout; polls `checkCancel` so 「取消」 works while waiting. */
export function withTimeout<T>(p: Promise<T>, ms: number, checkCancel: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`识图超时（${Math.round(ms / 1000)} 秒）`))), Math.max(1000, ms));
    const poll = setInterval(() => {
      try {
        checkCancel();
      } catch (e) {
        finish(() => reject(e));
      }
    }, 200);
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

function figureTextNote(f: FigureTextStats): string {
  const parts = [`${f.regions} 张图/表叠加译文 ${f.overlays} 处`];
  if (f.vectorLabels) parts.push(`矢量文字 ${f.vectorLabels}`);
  if (f.ocrEnabled) parts.push(f.ocrUnavailable ? `位图 OCR 未执行（${f.ocrUnavailable}）` : `OCR ${f.ocrRegions} 张、${f.ocrLabels} 处`);
  if (f.ocrFailed) parts.push(`OCR 失败 ${f.ocrFailed} 张（已跳过）`);
  if (f.translateFailed) parts.push(`未译 ${f.translateFailed} 处`);
  const sk = f.skipped;
  const skipped = [sk.small && `过小 ${sk.small}`, sk.photo && `照片 ${sk.photo}`, sk.limit && `超出上限 ${sk.limit}`].filter(Boolean);
  if (skipped.length) parts.push(`跳过：${skipped.join("、")}`);
  return parts.join(" · ");
}

export async function runFullText(
  data: Uint8Array,
  meta: EngineMeta,
  env: EngineEnv,
  cb: EngineCallbacks,
  opts: Partial<EngineOptions> = {},
): Promise<EngineResult> {
  const o: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, ...opts };
  const pdfjs = env.pdfjs;
  const timings: Record<string, number> = {};
  const log = env.log || (() => {});
  const checkCancel = () => {
    if (cb.isCancelled?.()) throw new CancelledError();
  };
  const ft: FigureTextOptions = { ...DEFAULT_FIGURE_TEXT_OPTIONS, ...(o.figureText || {}) };
  const ftOn = !!o.figureText && ft.enabled;
  const ocrOn = ftOn && ft.ocr && typeof cb.ocr === "function";
  const W = ftOn
    ? { parse: 0.18, render: 0.14, figtext: ocrOn ? 0.15 : 0.06, translate: 0, html: 0.05 }
    : { parse: 0.2, render: 0.15, figtext: 0, translate: 0.6, html: 0.05 };
  W.translate = 1 - W.parse - W.render - W.figtext - W.html;
  const report = (phase: Progress["phase"], done: number, total: number, message: string) => {
    let base = 0;
    let w = 0;
    if (phase === "parse") w = W.parse;
    else if (phase === "render") (base = W.parse), (w = W.render);
    else if (phase === "figtext") (base = W.parse + W.render), (w = W.figtext);
    else if (phase === "translate") (base = W.parse + W.render + W.figtext), (w = W.translate);
    else if (phase === "html") (base = W.parse + W.render + W.figtext + W.translate), (w = W.html);
    else base = 1;
    cb.onProgress?.({ phase, done, total, message, fraction: Math.min(1, base + (total ? (w * done) / total : 0)) });
  };

  let t = now();
  const loadingTask = pdfjs.getDocument({ data, ...(env.docParams || {}) });
  const doc = await loadingTask.promise;
  const pageCount = Math.min(doc.numPages, o.maxPages || doc.numPages);
  const pages: PageData[] = [];
  let blockId = 1;

  try {
    // ---------- parse ----------
    for (let p = 1; p <= pageCount; p++) {
      checkCancel();
      report("parse", p - 1, pageCount, `解析第 ${p}/${pageCount} 页`);
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const pageBox: Box = { x0: 0, y0: 0, x1: vp.width, y1: vp.height };
      const opList = await page.getOperatorList();
      const tc = await page.getTextContent();
      const fonts: Record<string, FontInfo> = {};
      for (const fontName of Object.keys(tc.styles || {})) {
        let name = tc.styles[fontName]?.fontFamily || "";
        let flags: any = {};
        try {
          if (page.commonObjs.has(fontName)) {
            const f = page.commonObjs.get(fontName);
            name = f?.name || name;
            flags = { bold: !!f?.bold || !!f?.black, italic: !!f?.italic };
          }
        } catch (e) {
          // ignore
        }
        fonts[fontName] = classifyFont(name, flags);
      }
      const glyphs = itemsToGlyphs(tc.items, tc.styles, vp.transform, fonts);
      const lines = glyphsToLines(glyphs);
      const graphics = collectGraphics(opList, pdfjs.OPS, vp.transform, pageBox);
      pages.push({ page: p, pageBox, lines, equationBoxes: [], blocks: [], graphics, regions: [], elements: [] });
      page.cleanup?.();
    }
    timings.parse = now() - t;

    // ---------- analyze ----------
    t = now();
    const body = computeBodyFontSize(pages.map((p) => ({ lines: p.lines }) as any));
    for (const p of pages) {
      let lines = p.lines;
      if (o.equations) {
        const eq = extractEquations(lines, body);
        p.equationBoxes = eq.equations;
        lines = eq.rest;
      }
      p.blocks = linesToBlocks(lines, p.page, blockId);
      blockId += p.blocks.length + 1;
    }
    markNoise(pages);
    resetDocState();
    for (const p of pages) classifyBlocks(p.blocks, body);
    for (const p of pages) {
      p.regions = findRegions(p.page, p.pageBox, p.blocks, p.graphics, body, {
        equations: o.equations,
        equationBoxes: p.equationBoxes,
      });
      p.elements = orderElements(p.page, p.pageBox, p.blocks, p.regions);
    }
    let elements = markFrontMatter(
      mergeContinuations(
        pages.flatMap((p) => p.elements),
        body,
      ),
    );
    timings.analyze = now() - t;
    cb.onAnalyzed?.(pages);
    report("parse", pageCount, pageCount, "解析完成");

    // ---------- render figures ----------
    t = now();
    const pagesWithRegions = pages.filter((p) => p.regions.length);
    let rendered = 0;
    const regionInfo: EngineResult["regions"] = [];
    const ftStats: FigureTextStats = {
      enabled: ftOn,
      ocrEnabled: ftOn && ft.ocr,
      regions: 0,
      vectorLabels: 0,
      ocrRegions: 0,
      ocrLabels: 0,
      translated: 0,
      overlays: 0,
      ocrFailed: 0,
      translateFailed: 0,
      skipped: { small: 0, photo: 0, limit: 0, noText: 0 },
      ocrUnavailable: ftOn && ft.ocr && !cb.ocr ? cb.ocrUnavailable || "没有可用的识图模型源" : undefined,
    };
    const figureFailures: EngineResult["figureFailures"] = [];
    interface OcrJob {
      region: Region;
      page: number;
      dataURL: string;
      width: number;
      height: number;
      pixels: PixelData;
    }
    const ocrJobs: OcrJob[] = [];
    const ftRegions: Region[] = [];
    const collectFigureText = async (r: Region, pd: PageData, page: any, crop: CanvasLike, tw: number, th: number) => {
      const rw = r.box.x1 - r.box.x0;
      const rh = r.box.y1 - r.box.y0;
      // "too small": icons / logos — both sides below the threshold (tables are short but wide)
      if (ft.skipSmall && rw < ft.minSize && rh < ft.minSize) {
        ftStats.skipped.small++;
        return;
      }
      const vector = collectVectorLabels(pd.lines, r.box).filter((l) => needsTranslation(l.text));
      const wantsOcr = ocrOn && rasterCoverage(pd.graphics, r.box) >= 0.25;
      if (!vector.length && !wantsOcr) {
        ftStats.skipped.noText++;
        return;
      }
      if (ftRegions.length >= Math.max(0, ft.maxImages)) {
        ftStats.skipped.limit++;
        return;
      }
      let pixels: PixelData | null = null;
      try {
        const img = crop.context.getImageData(0, 0, tw, th);
        pixels = { data: img.data, width: tw, height: th };
      } catch (e) {
        pixels = null;
      }
      if (pixels) refineWithPixels(vector, pixels);
      r.figureLabels = vector;
      ftStats.vectorLabels += vector.length;
      ftRegions.push(r);
      if (wantsOcr) {
        if (ft.skipPhoto && pixels && isPhotoLike(pixels)) {
          ftStats.skipped.photo++;
          return;
        }
        // image for the vision model: longest side ≈ ocrMaxSide (cost scales with pixels).
        // Small text needs resolution, so re-render just this region at a higher scale
        // when the page render is too coarse; otherwise downscale the crop.
        const want = Math.min(4, ft.ocrMaxSide / Math.max(rw, rh));
        let ow: number;
        let oh: number;
        let oc: CanvasLike;
        if (want > o.renderScale * 1.15) {
          ow = Math.max(1, Math.round(rw * want));
          oh = Math.max(1, Math.round(rh * want));
          oc = env.createCanvas(ow, oh);
          oc.context.fillStyle = "#ffffff";
          oc.context.fillRect(0, 0, ow, oh);
          await page.render({
            canvasContext: oc.context,
            canvas: oc.canvas,
            viewport: page.getViewport({ scale: want }),
            transform: [1, 0, 0, 1, -r.box.x0 * want, -r.box.y0 * want],
            background: "#ffffff",
          }).promise;
        } else {
          const k = Math.min(1, ft.ocrMaxSide / Math.max(tw, th));
          ow = Math.max(1, Math.round(tw * k));
          oh = Math.max(1, Math.round(th * k));
          oc = env.createCanvas(ow, oh);
          oc.context.fillStyle = "#ffffff";
          oc.context.fillRect(0, 0, ow, oh);
          oc.context.drawImage(crop.canvas, 0, 0, tw, th, 0, 0, ow, oh);
        }
        let opx: PixelData | null = null;
        try {
          const im = oc.context.getImageData(0, 0, ow, oh);
          opx = { data: im.data, width: ow, height: oh };
        } catch (e) {
          opx = null;
        }
        const dataURL = oc.toDataURL("image/jpeg", 0.9);
        ocrJobs.push({ region: r, page: pd.page, dataURL: dataURL as string, width: ow, height: oh, pixels: opx || { data: [], width: 0, height: 0 } });
        oc.dispose?.();
      }
    };
    for (const pd of pagesWithRegions) {
      checkCancel();
      report("render", rendered, pagesWithRegions.length, `截取第 ${pd.page} 页的图表`);
      const page = await doc.getPage(pd.page);
      const scale = o.renderScale;
      const vp = page.getViewport({ scale });
      const cw = Math.ceil(vp.width);
      const ch = Math.ceil(vp.height);
      const full = env.createCanvas(cw, ch);
      full.context.fillStyle = "#ffffff";
      full.context.fillRect(0, 0, cw, ch);
      await page.render({ canvasContext: full.context, canvas: full.canvas, viewport: vp, background: "#ffffff" }).promise;
      for (const r of pd.regions) {
        const sx = Math.max(0, Math.floor(r.box.x0 * scale));
        const sy = Math.max(0, Math.floor(r.box.y0 * scale));
        const sw = Math.min(cw - sx, Math.ceil((r.box.x1 - r.box.x0) * scale));
        const sh = Math.min(ch - sy, Math.ceil((r.box.y1 - r.box.y0) * scale));
        if (sw < 2 || sh < 2) continue;
        // trim uniform white margins (backgrounds drawn behind figures)
        let [tx, ty, tw, th] = [sx, sy, sw, sh];
        try {
          const img = full.context.getImageData(sx, sy, sw, sh);
          const t2 = trimWhite(img.data, sw, sh, Math.round(3 * scale));
          if (t2) {
            tx = sx + t2.x;
            ty = sy + t2.y;
            tw = t2.w;
            th = t2.h;
            r.box = {
              x0: tx / scale,
              y0: ty / scale,
              x1: (tx + tw) / scale,
              y1: (ty + th) / scale,
            };
          }
        } catch (e) {
          // getImageData may be unavailable; keep the untrimmed crop
        }
        const crop = env.createCanvas(tw, th);
        crop.context.fillStyle = "#ffffff";
        crop.context.fillRect(0, 0, tw, th);
        crop.context.drawImage(full.canvas, tx, ty, tw, th, 0, 0, tw, th);
        // ----- text inside the figure (before the crop is encoded) -----
        if (ftOn && (r.kind === "figure" || r.kind === "table")) {
          try {
            await collectFigureText(r, pd, page, crop, tw, th);
          } catch (e: any) {
            figureFailures.push({ page: pd.page, kind: "collect", error: String(e?.message || e) });
          }
        }
        const useJpeg =
          r.kind !== "equation" &&
          (o.imageFormat === "jpeg" || (o.imageFormat === "auto" && /image/.test(r.source) && tw * th > 160000));
        r.image = await crop.toDataURL(useJpeg ? "image/jpeg" : "image/png", o.jpegQuality);
        r.pixelWidth = tw;
        r.pixelHeight = th;
        crop.dispose?.();
        regionInfo.push({
          page: r.page,
          kind: r.kind,
          box: r.box,
          caption: r.caption?.text.slice(0, 120),
          source: r.source,
          bytes: r.image.length,
        });
      }
      full.dispose?.();
      page.cleanup?.();
      rendered++;
    }
    timings.render = now() - t;
    report("render", pagesWithRegions.length, pagesWithRegions.length, "图表截取完成");

    // resolve data URLs produced asynchronously (Node canvas returns strings, Zotero may return promises)
    for (const j of ocrJobs) j.dataURL = await (j.dataURL as any);

    const failures: EngineResult["failures"] = [];
    const memo = new Map<string, Promise<string>>();
    const translateOne = async (text: string): Promise<string> => {
      const chunks = chunkText(text, o.maxChunkChars);
      const outs: string[] = [];
      for (const c of chunks) {
        let lastErr: any = null;
        let ok = false;
        for (let attempt = 0; attempt <= o.retries; attempt++) {
          checkCancel();
          try {
            const r = await cb.translate(c);
            if (typeof r !== "string" || !r.trim()) throw new Error("空结果");
            outs.push(r.trim());
            ok = true;
            break;
          } catch (e: any) {
            if (e instanceof CancelledError) throw e;
            lastErr = e;
            if (attempt < o.retries) {
              await new Promise((res) => setTimeout(res, o.retryDelayMs * Math.pow(2, attempt)));
            }
          }
        }
        if (!ok) throw lastErr || new Error("翻译失败");
      }
      return outs.join(" ");
    };
    const memoTranslate = (text: string) => {
      let p = memo.get(text);
      if (!p) {
        p = translateOne(text);
        memo.set(text, p);
        // a failed translation may be retried by a later caller
        p.catch(() => memo.delete(text));
      }
      return p;
    };

    // ---------- text inside figures ----------
    if (ftOn && ftRegions.length) {
      t = now();
      const ocrTotal = ocrJobs.length;
      let ocrDone = 0;
      let trDone = 0;
      let trTotal = 0;
      const msg = () =>
        `图内文字：${ocrTotal ? `识别 ${ocrDone}/${ocrTotal} · ` : ""}翻译 ${trDone}/${trTotal || "…"}`;
      const tick = () => report("figtext", ocrDone + trDone, Math.max(1, ocrTotal + Math.max(trTotal, ftRegions.length)), msg());
      tick();
      // 1) OCR (raster figures)
      if (ocrJobs.length && cb.ocr) {
        let oi = 0;
        const ocrWorker = async () => {
          while (oi < ocrJobs.length) {
            const job = ocrJobs[oi++];
            checkCancel();
            try {
              const reply = await withTimeout(
                cb.ocr!({ dataURL: job.dataURL, width: job.width, height: job.height, prompt: OCR_PROMPT, page: job.page }),
                ft.ocrTimeoutMs,
                checkCancel,
              );
              const items = parseOcrReply(reply, job.width, job.height, { pixelCoords: cb.ocrPixelCoords });
              const rw = job.region.box.x1 - job.region.box.x0;
              const rh = job.region.box.y1 - job.region.box.y0;
              const labels = ocrItemsToLabels(items, job.region.figureLabels || [], rh / rw).filter((l) =>
                needsTranslation(l.text),
              );
              if (job.pixels.width) refineWithPixels(labels, job.pixels);
              job.region.figureLabels = (job.region.figureLabels || []).concat(labels);
              ftStats.ocrRegions++;
              ftStats.ocrLabels += labels.length;
            } catch (e: any) {
              if (e instanceof CancelledError) throw e;
              ftStats.ocrFailed++;
              const err = String(e?.message || e).slice(0, 300);
              figureFailures.push({ page: job.page, kind: "ocr", error: err });
              log(`figure OCR failed on page ${job.page}: ${err}`);
            }
            job.dataURL = "";
            ocrDone++;
            tick();
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(ft.ocrConcurrency, 4)) }, () => ocrWorker()));
      }
      // 2) translate labels in batches (one request per figure / batch)
      interface Batch {
        region: Region;
        labels: FigureLabel[];
      }
      const batches: Batch[] = [];
      for (const r of ftRegions) {
        const ls = r.figureLabels || [];
        for (let i = 0; i < ls.length; i += Math.max(1, ft.batchSize)) {
          batches.push({ region: r, labels: ls.slice(i, i + Math.max(1, ft.batchSize)) });
        }
      }
      trTotal = batches.length;
      tick();
      let bi = 0;
      const trWorker = async () => {
        while (bi < batches.length) {
          const b = batches[bi++];
          checkCancel();
          const texts = b.labels.map((l) => l.text);
          let parsed: (string | undefined)[] = new Array(texts.length).fill(undefined);
          if (texts.length === 1) {
            try {
              parsed[0] = await memoTranslate(texts[0]);
            } catch (e: any) {
              if (e instanceof CancelledError) throw e;
            }
          } else {
            try {
              const reply = await memoTranslate(buildBatch(texts));
              parsed = parseBatch(reply, texts.length);
            } catch (e: any) {
              if (e instanceof CancelledError) throw e;
            }
            // missing lines: translate one by one
            for (let k = 0; k < texts.length; k++) {
              if (parsed[k] !== undefined) continue;
              try {
                parsed[k] = await memoTranslate(texts[k]);
              } catch (e: any) {
                if (e instanceof CancelledError) throw e;
              }
            }
          }
          for (let k = 0; k < texts.length; k++) {
            const tr = parsed[k];
            // services that fall back to the source text: nothing to overlay
            if (tr && tr.trim() && tr.trim() !== texts[k].trim()) {
              b.labels[k].translation = tr.replace(/^[[【［]\s*\d+\s*[\]】］]\s*/, "").trim();
              ftStats.translated++;
            } else if (!tr) {
              ftStats.translateFailed++;
              figureFailures.push({ page: b.region.page, kind: "translate", error: `未能翻译：${texts[k].slice(0, 60)}` });
            }
          }
          trDone++;
          tick();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, 8)) }, () => trWorker()));
      // 3) layout
      for (const r of ftRegions) {
        const rw = r.box.x1 - r.box.x0;
        const rh = r.box.y1 - r.box.y0;
        const natural = Math.min(r.pixelWidth || rw * o.renderScale, 864);
        const labels = r.figureLabels || [];
        const fitted = labels.map((l) => fitLabel(l, rh / rw, natural));
        harmonizeSizes(labels, fitted);
        r.figureOverlays = fitted.filter((x): x is NonNullable<typeof x> => !!x);
        ftStats.overlays += r.figureOverlays.length;
        if (r.figureOverlays.length) ftStats.regions++;
      }
      timings.figtext = now() - t;
      report("figtext", 1, 1, `图内文字完成：${ftStats.overlays} 处`);
    }

    // ---------- translate ----------
    t = now();
    const items: TranslatedElement[] = elements.map((el) => ({ el }));
    interface Job {
      text: string;
      apply: (s: string, failed: boolean) => void;
    }
    const jobs: Job[] = [];
    for (const it of items) {
      const el = it.el;
      if (el.type === "region") {
        if (o.translateCaptions && el.region.caption && el.region.image) {
          jobs.push({
            text: el.region.caption.text,
            apply: (s, f) => {
              it.captionTranslation = s;
              it.failed = it.failed || f;
            },
          });
        }
        continue;
      }
      if (el.type === "byline") {
        // author names / affiliations: keep as-is, do not translate
        it.translation = el.text;
        continue;
      }
      if (!/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30ff\u3400-\u9fff]/.test(el.text)) {
        it.translation = el.text;
        continue;
      }
      jobs.push({
        text: el.text,
        apply: (s, f) => {
          it.translation = s;
          it.failed = f;
        },
      });
    }

    let done = 0;
    let failedCount = 0;
    let idx = 0;
    const total = jobs.length;
    report("translate", 0, total, `翻译 0/${total}`);
    const worker = async () => {
      while (idx < jobs.length) {
        const job = jobs[idx++];
        try {
          job.apply(await memoTranslate(job.text), false);
        } catch (e: any) {
          if (e instanceof CancelledError) throw e;
          failedCount++;
          failures.push({ text: job.text.slice(0, 200), error: String(e?.message || e) });
          job.apply(`【翻译失败：${String(e?.message || e).slice(0, 200)}】`, true);
        }
        done++;
        report("translate", done, total, `翻译 ${done}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, 16)) }, () => worker()));
    timings.translate = now() - t;

    // ---------- html ----------
    t = now();
    report("html", 0, 1, "生成 HTML");
    let figures = 0;
    let tables = 0;
    let equations = 0;
    let paragraphs = 0;
    for (const it of items) {
      if (it.el.type === "region") {
        if (!it.el.region.image) continue;
        if (it.el.region.kind === "figure") figures++;
        else if (it.el.region.kind === "table") tables++;
        else equations++;
      } else if (it.el.type !== "byline") paragraphs++;
    }
    const stats = { paragraphs, figures, tables, equations, failed: failedCount };
    const html = buildHtml(
      {
        ...meta,
        generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        pageCount,
        stats,
        figureTextNote: ftOn ? figureTextNote(ftStats) : undefined,
        figureFailures: figureFailures.map((f) => `第 ${f.page} 页 · ${f.kind === "ocr" ? "OCR" : f.kind === "translate" ? "翻译" : "提取"}：${f.error}`),
      },
      items,
    );
    timings.html = now() - t;
    report("done", 1, 1, "完成");
    log(`fulltext done: ${JSON.stringify(stats)} timings=${JSON.stringify(timings)}`);
    log(`figure text: ${JSON.stringify(ftStats)}`);
    return { html, pageCount, stats, regions: regionInfo, failures, timings, figureText: ftStats, figureFailures };
  } finally {
    try {
      await doc.destroy();
    } catch (e) {
      // ignore
    }
  }
}
