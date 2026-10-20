/**
 * Zotero Scholar Suite — full-text translation: text inside figures / tables.
 *
 * Environment agnostic (runs in Zotero's hidden engine page and in Node).
 *  - vector figures: text runs that pdf.js reports inside a figure box are
 *    collected with their coordinates (no vision model needed);
 *  - raster figures: an optional vision model returns OCR JSON
 *    ({text, bbox normalised 0..1});
 *  - both are translated in batches through the active translation service
 *    and rendered as an absolutely positioned HTML layer on top of the
 *    untouched figure image (see html.ts). Nothing is repainted.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Box, area, intersect } from "./geometry";
import type { Line } from "./layout";
import type { GraphicBox } from "./graphics";

export interface FigureTextOptions {
  /** master switch: vector text (free) */
  enabled: boolean;
  /** raster OCR through a vision model (costs money) */
  ocr: boolean;
  /** skip figures smaller than minSize (pt, both sides) */
  skipSmall: boolean;
  minSize: number;
  /** skip OCR on photo-like figures */
  skipPhoto: boolean;
  /** at most this many figures/tables are processed */
  maxImages: number;
  /** per-image OCR timeout */
  ocrTimeoutMs: number;
  ocrConcurrency: number;
  /** longest side of the image sent to the vision model */
  ocrMaxSide: number;
  /** labels per translation request */
  batchSize: number;
}

export const DEFAULT_FIGURE_TEXT_OPTIONS: FigureTextOptions = {
  enabled: true,
  ocr: false,
  skipSmall: true,
  minSize: 80,
  skipPhoto: false,
  maxImages: 30,
  ocrTimeoutMs: 60000,
  ocrConcurrency: 2,
  ocrMaxSide: 1600,
  batchSize: 40,
};

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** One piece of text inside a figure, in region-relative fractions. */
export interface FigureLabel {
  source: "vector" | "ocr";
  text: string;
  /** box relative to the region image: 0..1 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** original font size as a fraction of the region width */
  fs: number;
  bg?: RGB;
  fg?: RGB;
  translation?: string;
  /** OCR noise was trimmed at the start / end (box may still cover a symbol) */
  trimmed?: { lead: boolean; trail: boolean; ox0: number; ox1: number };
  /** free (ink-less) space left / right of the box, region fractions; the mask never grows past it */
  freeL?: number;
  freeR?: number;
}

/** What the overlay renderer needs (computed by fitLabel). */
export interface FigureOverlay {
  source: "vector" | "ocr";
  src: string;
  text: string;
  /** mask box, fractions of region (may be slightly larger than the label) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** font size as % of the region width (CSS cqw) */
  fsCqw: number;
  /** font size in px for the image's natural width (fallback) */
  fsPx: number;
  lines: number;
  bg: string;
  fg: string;
}

export interface PixelData {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface OcrItem {
  text: string;
  /** normalised 0..1 [x0, y0, x1, y1] */
  bbox: [number, number, number, number];
}

/* ------------------------------------------------------------------ */
/* text filters                                                        */
/* ------------------------------------------------------------------ */

/** Does a label carry words worth translating (not numbers, symbols, short codes)? */
export function needsTranslation(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  // already CJK
  if (/[\u3400-\u9fff]/.test(t)) return false;
  // at least two consecutive latin letters
  if (!/[A-Za-z\u00C0-\u024F]{2,}/.test(t)) return false;
  // short all-caps abbreviations / metric names / variables: CLIP, FID, DINO, Ours?, x_t
  if (/^[A-Z0-9][A-Z0-9\-_.+/↑↓()%\s]{0,7}$/.test(t) && !/\s[a-z]/.test(t)) return false;
  // URLs, e-mails, file names
  if (/^(https?:\/\/|www\.)|@[\w-]+\.|\.(png|jpg|pdf)$/i.test(t)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* vector labels                                                       */
/* ------------------------------------------------------------------ */

/**
 * Text lines (from pdf.js textContent) that lie inside a figure box.
 * Returns labels in region fractions; lines that are mostly outside are
 * ignored (captions, body text next to the figure).
 */
export function collectVectorLabels(lines: Line[], region: Box): FigureLabel[] {
  const rw = region.x1 - region.x0;
  const rh = region.y1 - region.y0;
  if (rw <= 0 || rh <= 0) return [];
  const out: FigureLabel[] = [];
  for (const l of lines) {
    const inter = intersect(l.box, region);
    if (!inter) continue;
    const a = area(l.box);
    if (a <= 0 || area(inter) < 0.6 * a) continue;
    for (const seg of splitAtGaps(l)) {
      const text = seg.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      out.push({
        source: "vector",
        text,
        x: (seg.box.x0 - region.x0) / rw,
        y: (seg.box.y0 - region.y0) / rh,
        w: (seg.box.x1 - seg.box.x0) / rw,
        h: (seg.box.y1 - seg.box.y0) / rh,
        fs: l.fontSize / rw,
      });
    }
  }
  return out;
}

/**
 * Table cells / chart labels on one baseline end up in one text line; split
 * them where the horizontal gap is much wider than a word space.
 */
export function splitAtGaps(l: Line): { text: string; box: Box }[] {
  const gs = (l.glyphs || []).slice().sort((a, b) => a.box.x0 - b.box.x0);
  if (gs.length <= 1) return [{ text: l.text, box: l.box }];
  const segs: { text: string; box: Box }[] = [];
  let cur: { text: string; box: Box } | null = null;
  let prevX1 = -Infinity;
  for (const g of gs) {
    const gap = g.box.x0 - prevX1;
    if (!cur || gap > 0.9 * Math.max(l.fontSize, g.fontSize)) {
      cur = { text: g.str, box: { ...g.box } };
      segs.push(cur);
    } else {
      cur.text += (gap > 0.12 * g.fontSize && !/\s$/.test(cur.text) && !/^\s/.test(g.str) ? " " : "") + g.str;
      cur.box = {
        x0: Math.min(cur.box.x0, g.box.x0),
        y0: Math.min(cur.box.y0, g.box.y0),
        x1: Math.max(cur.box.x1, g.box.x1),
        y1: Math.max(cur.box.y1, g.box.y1),
      };
    }
    prevX1 = Math.max(prevX1, g.box.x1);
  }
  return segs;
}

/** Fraction of the region covered by raster images. */
export function rasterCoverage(graphics: GraphicBox[], region: Box): number {
  const ra = area(region);
  if (ra <= 0) return 0;
  let cov = 0;
  for (const g of graphics) {
    if (g.type !== "image") continue;
    const i = intersect(g.box, region);
    if (i) cov += area(i);
  }
  return Math.min(1, cov / ra);
}

/* ------------------------------------------------------------------ */
/* pixels: colours, photo heuristic                                    */
/* ------------------------------------------------------------------ */

function px(d: PixelData, x: number, y: number): RGB {
  const xi = Math.max(0, Math.min(d.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(d.height - 1, Math.round(y)));
  const i = (yi * d.width + xi) * 4;
  return { r: d.data[i], g: d.data[i + 1], b: d.data[i + 2] };
}

function dist(a: RGB, b: RGB) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

export function luminance(c: RGB) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Background = dominant colour of a thin ring just outside the label box;
 * foreground = the pixel inside the box that differs most from it.
 * Box is in pixel coordinates of `d`.
 */
export function sampleColors(d: PixelData, box: Box): { bg: RGB; fg: RGB } {
  const pad = Math.max(2, Math.round((box.y1 - box.y0) * 0.15));
  const ring: RGB[] = [];
  const x0 = box.x0 - pad;
  const x1 = box.x1 + pad;
  const y0 = box.y0 - pad;
  const y1 = box.y1 + pad;
  const stepX = Math.max(1, (x1 - x0) / 24);
  const stepY = Math.max(1, (y1 - y0) / 8);
  for (let x = x0; x <= x1; x += stepX) {
    ring.push(px(d, x, y0), px(d, x, y1));
  }
  for (let y = y0; y <= y1; y += stepY) {
    ring.push(px(d, x0, y), px(d, x1, y));
  }
  // also the four corners of the box itself (labels on coloured patches)
  ring.push(px(d, box.x0, box.y0), px(d, box.x1, box.y0), px(d, box.x0, box.y1), px(d, box.x1, box.y1));
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (const c of ring) {
    const k = `${c.r >> 4},${c.g >> 4},${c.b >> 4}`;
    const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += c.r;
    e.g += c.g;
    e.b += c.b;
    buckets.set(k, e);
  }
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const e of buckets.values()) if (e.n > best.n) best = e;
  const bg = best.n ? { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) } : { r: 255, g: 255, b: 255 };
  let fg = bg;
  let fd = -1;
  const sx = Math.max(1, (box.x1 - box.x0) / 40);
  const sy = Math.max(1, (box.y1 - box.y0) / 10);
  for (let y = box.y0; y <= box.y1; y += sy) {
    for (let x = box.x0; x <= box.x1; x += sx) {
      const c = px(d, x, y);
      const dd = dist(c, bg);
      if (dd > fd) {
        fd = dd;
        fg = c;
      }
    }
  }
  // not enough contrast (anti-aliased thin text sampled poorly) -> black / white
  if (fd < 160) fg = luminance(bg) > 140 ? { r: 17, g: 17, b: 17 } : { r: 250, g: 250, b: 250 };
  return { bg, fg };
}

/**
 * Photo heuristic: many distinct colours and few flat (white) pixels.
 * Charts, diagrams and screenshots have large flat areas and few colours.
 */
export function isPhotoLike(d: PixelData): boolean {
  const n = d.width * d.height;
  if (n < 100) return false;
  const step = Math.max(1, Math.floor(Math.sqrt(n / 20000)));
  const colors = new Set<number>();
  let samples = 0;
  let flat = 0;
  for (let y = 0; y < d.height; y += step) {
    for (let x = 0; x < d.width; x += step) {
      const i = (y * d.width + x) * 4;
      const r = d.data[i];
      const g = d.data[i + 1];
      const b = d.data[i + 2];
      samples++;
      if ((r > 245 && g > 245 && b > 245) || (r < 10 && g < 10 && b < 10)) flat++;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
  }
  const flatRatio = flat / samples;
  const colorRatio = colors.size / samples;
  return flatRatio < 0.35 && colors.size > 1500 && colorRatio > 0.08;
}

/* ------------------------------------------------------------------ */
/* keep masks off non-text symbols / graphics                          */
/* ------------------------------------------------------------------ */

/** Ink flags per column x in [xa, xb) for rows [ya, yb) (pixel coords). */
function inkColumns(d: PixelData, bg: RGB, xa: number, xb: number, ya: number, yb: number): boolean[] {
  const out: boolean[] = [];
  const y0 = Math.max(0, Math.round(ya));
  const y1 = Math.min(d.height - 1, Math.round(yb));
  for (let x = Math.round(xa); x < Math.round(xb); x++) {
    if (x < 0 || x >= d.width) {
      out.push(false);
      continue;
    }
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      if (dist(px(d, x, y), bg) > 120 && ++n >= 2) break;
    }
    out.push(n >= 2);
  }
  return out;
}

/**
 * Pixel pass over the labels of one figure (pixels = render of the region):
 *  - background / foreground colours for the mask;
 *  - OCR boxes whose stray leading/trailing "/" was trimmed are cut at the
 *    blank gap that separates the words from the symbol (✓, ✗, a frame edge);
 *  - how far the mask may grow left/right before it would hide other ink.
 */
export function refineWithPixels(labels: FigureLabel[], d: PixelData) {
  const W = d.width;
  const H = d.height;
  for (const l of labels) {
    const box = { x0: l.x * W, y0: l.y * H, x1: (l.x + l.w) * W, y1: (l.y + l.h) * H };
    const c = sampleColors(d, box);
    l.bg = c.bg;
    l.fg = c.fg;
    const hPx = Math.max(2, box.y1 - box.y0);
    const ya = box.y0 + hPx * 0.1;
    const yb = box.y1 - hPx * 0.1;
    if (l.trimmed) {
      // the untrimmed OCR box ends at the outer edge of the stray symbol: the last
      // (first) blank gap inside it separates the words from the symbol
      const xa = l.trimmed.lead ? Math.max(0, l.trimmed.ox0 * W - 2) : box.x0;
      const xb = l.trimmed.trail ? Math.min(W, l.trimmed.ox1 * W + 2) : box.x1;
      const ink = inkColumns(d, c.bg, xa, xb, ya, yb);
      const minGap = Math.max(3, hPx * 0.4);
      const gaps: [number, number][] = [];
      let g0 = -1;
      for (let i = 0; i <= ink.length; i++) {
        const blank = i < ink.length && !ink[i];
        if (blank && g0 < 0) g0 = i;
        if (!blank && g0 >= 0) {
          if (i - g0 >= minGap && g0 > 0 && i < ink.length) gaps.push([g0, i]);
          g0 = -1;
        }
      }
      const span = xb - xa;
      let nx0 = box.x0;
      let nx1 = box.x1;
      if (l.trimmed.trail) {
        const g = gaps.filter((q) => q[0] > span * 0.3).pop();
        if (g) nx1 = xa + g[0] + 1;
      }
      if (l.trimmed.lead) {
        const g = gaps.find((q) => q[1] < span * 0.7);
        if (g) nx0 = xa + g[1] - 1;
      }
      if (nx1 - nx0 > hPx) {
        l.x = nx0 / W;
        l.w = (nx1 - nx0) / W;
        box.x0 = nx0;
        box.x1 = nx1;
      }
    }
    // free space on each side (stop at the first column with ink)
    const reach = Math.max(hPx * 4, (box.x1 - box.x0) * 1.5);
    // ink touching the box (glyph overhang, anti-aliasing of the label itself) belongs to the label
    const overhang = Math.max(2, Math.round(hPx * 0.25));
    const firstForeign = (cols: boolean[]) => {
      let i = 0;
      if (cols.slice(0, overhang).some(Boolean)) {
        while (i < cols.length && (cols[i] || i < overhang)) i++;
        // a long run touching the box is something else (a symbol, a frame), not overhang
        if (i > overhang * 2) return 0;
      }
      const j = cols.indexOf(true, i);
      return j < 0 ? -1 : j;
    };
    const rStart = box.x1;
    const right = inkColumns(d, c.bg, rStart, Math.min(W, rStart + reach), ya, yb);
    const ri = firstForeign(right);
    l.freeR = (ri < 0 ? Math.min(W - rStart, reach) : Math.max(0, ri - 1)) / W;
    const lEnd = box.x0;
    const lx = Math.max(0, lEnd - reach);
    const left = inkColumns(d, c.bg, lx, lEnd, ya, yb).reverse();
    const li = firstForeign(left);
    l.freeL = (li < 0 ? Math.min(lEnd, reach) : Math.max(0, li - 1)) / W;
  }
}

export function rgbCss(c?: RGB, fallback = "#ffffff") {
  if (!c) return fallback;
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/* ------------------------------------------------------------------ */
/* OCR result parsing                                                  */
/* ------------------------------------------------------------------ */

function extractJSON(text: string): any {
  let s = String(text || "").trim();
  // reasoning models: drop <think>…</think>
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    // first {...} or [...] block
    const i = s.search(/[[{]/);
    if (i < 0) throw new Error("识图模型没有返回 JSON");
    const open = s[i];
    const close = open === "{" ? "}" : "]";
    const j = s.lastIndexOf(close);
    if (j <= i) throw new Error("识图模型返回的 JSON 不完整");
    return JSON.parse(s.slice(i, j + 1));
  }
}

/**
 * Parse the vision model reply into normalised OCR items.
 * Accepts {"items":[{text,bbox}]}, a bare array, `box`/`box_2d` (Gemini
 * [ymin,xmin,ymax,xmax] 0..1000) and absolute pixel / per-mille coordinates.
 */
export function parseOcrReply(
  reply: string,
  imgW: number,
  imgH: number,
  hint: { pixelCoords?: boolean } = {},
): OcrItem[] {
  const j = extractJSON(reply);
  const arr: any[] = Array.isArray(j)
    ? j
    : Array.isArray(j?.items)
      ? j.items
      : Array.isArray(j?.texts)
        ? j.texts
        : Array.isArray(j?.results)
          ? j.results
          : Array.isArray(j?.boxes)
            ? j.boxes
            : [];
  type Raw = { text: string; b: number[]; yx: boolean };
  const raws: Raw[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const text = String(it.text ?? it.label ?? it.content ?? "").trim();
    let b: any = it.bbox ?? it.box ?? it.bbox_2d ?? it.box_2d ?? it.rect;
    let yx = false;
    if (it.box_2d && !it.bbox) yx = true; // Gemini convention
    if (b && !Array.isArray(b) && typeof b === "object") {
      if ("x0" in b) b = [b.x0, b.y0, b.x1, b.y1];
      else if ("x" in b && "w" in b) b = [b.x, b.y, b.x + b.w, b.y + b.h];
      else if ("left" in b) b = [b.left, b.top, b.right ?? b.left + b.width, b.bottom ?? b.top + b.height];
    }
    if (!text || !Array.isArray(b) || b.length < 4) continue;
    const nums = b.slice(0, 4).map(Number);
    if (nums.some((v: number) => !isFinite(v))) continue;
    raws.push({ text, b: nums, yx });
  }
  if (!raws.length) return [];
  const max = Math.max(...raws.flatMap((r) => r.b));
  let mode: "unit" | "permille" | "pixel" = "unit";
  if (max > 1.5) {
    if (hint.pixelCoords) mode = "pixel";
    else if (max > 1000.5) mode = "pixel";
    else mode = "permille";
  }
  const out: OcrItem[] = [];
  for (const r of raws) {
    let [a, b, c, d] = r.b;
    if (r.yx) [a, b, c, d] = [b, a, d, c];
    let x0: number, y0: number, x1: number, y1: number;
    if (mode === "unit") [x0, y0, x1, y1] = [a, b, c, d];
    else if (mode === "permille") [x0, y0, x1, y1] = [a / 1000, b / 1000, c / 1000, d / 1000];
    else [x0, y0, x1, y1] = [a / imgW, b / imgH, c / imgW, d / imgH];
    // [x, y, w, h] style: x1 < x0 or y1 < y0 means width/height
    if (x1 < x0 || y1 < y0) {
      x1 = x0 + Math.abs(x1);
      y1 = y0 + Math.abs(y1);
    }
    x0 = Math.max(0, Math.min(1, x0));
    y0 = Math.max(0, Math.min(1, y0));
    x1 = Math.max(0, Math.min(1, x1));
    y1 = Math.max(0, Math.min(1, y1));
    if (x1 - x0 < 0.003 || y1 - y0 < 0.003) continue;
    if ((x1 - x0) * (y1 - y0) > 0.5) continue; // "whole image" answers
    out.push({ text: r.text, bbox: [x0, y0, x1, y1] });
  }
  return out;
}

export const OCR_PROMPT = [
  "You are an OCR engine for figures in scientific papers.",
  "Find every piece of readable text in the image: labels, legends, axis titles, annotations,",
  "and words inside photos or screenshots. One item per visual text line.",
  'Return ONLY a JSON object, no markdown, no explanation: {"items":[{"text":"...","bbox":[x0,y0,x1,y1]}]}',
  "bbox is the tight box around the text, normalised to 0..1 by the image width and height",
  "(x0,y0 = top-left corner, x1,y1 = bottom-right corner). Keep the original wording; do not translate.",
  'If there is no text, return {"items":[]}.',
].join("\n");

/**
 * OCR engines often read a neighbouring symbol (✓, ✗, a frame edge) as a
 * stray "/", "|" or "-" at the start/end of a line. Drop it and shrink the
 * box by the share of the text it took, so the mask does not hide the symbol.
 */
export function trimOcrNoise(it: OcrItem): (OcrItem & { lead?: boolean; trail?: boolean }) | null {
  const t = it.text.trim();
  // nothing but symbols / punctuation (a ✓ read as "/", a lone "×", "|"): not text
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  const m = /^([/|\\_~=*·•-]{1,2}\s+)?(.*?)(\s+[/|\\_~=*·•-]{1,2})?$/u.exec(t);
  if (!m || (!m[1] && !m[3])) return { ...it, text: t };
  const core = m[2].trim();
  if (!core) return null;
  const total = emWidth(t);
  const lead = m[1] ? emWidth(m[1]) : 0;
  const trail = m[3] ? emWidth(m[3]) : 0;
  const [x0, y0, x1, y1] = it.bbox;
  const w = x1 - x0;
  return {
    text: core,
    bbox: [x0 + (w * lead) / total, y0, x1 - (w * trail) / total, y1],
    lead: !!m[1],
    trail: !!m[3],
  };
}

/** Convert OCR items into labels; drop the ones that duplicate vector text. */
export function ocrItemsToLabels(items: OcrItem[], vector: FigureLabel[], regionAspect: number): FigureLabel[] {
  const out: FigureLabel[] = [];
  for (const raw of items) {
    const it = trimOcrNoise(raw);
    if (!it) continue;
    const [x0, y0, x1, y1] = it.bbox;
    const b: Box = { x0, y0, x1, y1 };
    const dup = vector.some((v) => {
      const vb: Box = { x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h };
      const i = intersect(b, vb);
      if (!i) return false;
      return area(i) > 0.3 * Math.min(area(b), area(vb));
    });
    if (dup) continue;
    // sizes in region-width units (box heights are relative to the region height)
    const aspect = Math.max(0.05, regionAspect);
    const wU = x1 - x0;
    let hU = (y1 - y0) * aspect;
    const fsW = wU / Math.max(0.5, emWidth(it.text)); // font size implied by the text width
    // a loose box much taller than one line of this text: the location is unreliable
    if (hU > fsW * 1.25 * 3.2 && it.text.length > 2) continue;
    // OCR boxes hug the glyphs (≈0.7 em without descenders, ≈1 em with): trust the
    // width-implied size, bounded by the box height
    // (the em-width estimate of Latin text is reliable; tall boxes are not)
    const fs = Math.max(hU * 0.5, Math.min(hU * 1.25, fsW * 1.1));
    let yy = y0;
    if (hU > fs * 1.6) {
      // tighten around the vertical centre
      const nh = fs * 1.3;
      yy = y0 + (hU - nh) / 2 / aspect;
      hU = nh;
    }
    // a single character that is not a letter or digit is never worth an overlay
    if ([...it.text].length === 1 && !/[\p{L}\p{N}]/u.test(it.text)) continue;
    out.push({
      source: "ocr",
      text: it.text,
      x: x0,
      y: yy,
      w: wU,
      h: hU / aspect,
      fs,
      ...(it.lead || it.trail ? { trimmed: { lead: !!it.lead, trail: !!it.trail, ox0: raw.bbox[0], ox1: raw.bbox[2] } } : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* batch translation                                                   */
/* ------------------------------------------------------------------ */

export function buildBatch(texts: string[]): string {
  return texts.map((t, i) => `[${i + 1}] ${t.replace(/\s*\n\s*/g, " ")}`).join("\n");
}

/** Parse "[n] translation" lines; returns undefined entries for missing ones. */
export function parseBatch(reply: string, n: number): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(n).fill(undefined);
  const s = String(reply || "").replace(/\r/g, "");
  const re = /[[【［]\s*(\d{1,3})\s*[\]】］]\s*[:：.、]?\s*([\s\S]*?)(?=\n?\s*[[【［]\s*\d{1,3}\s*[\]】］]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const k = parseInt(m[1], 10) - 1;
    const v = m[2].replace(/\s*\n\s*/g, " ").trim();
    if (k >= 0 && k < n && v && out[k] === undefined) out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* layout: fit the translation into the label box                      */
/* ------------------------------------------------------------------ */

/** Width of a string in em (rough, font independent). */
export function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if (c >= 0x2e80 && c <= 0x9fff) w += 1;
    else if (c >= 0xff00 && c <= 0xffef) w += 1;
    else if (c >= 0x3000 && c <= 0x303f) w += 1;
    else if (ch === " ") w += 0.3;
    else if (/[A-Z0-9]/.test(ch)) w += 0.62;
    else if (/[mwMW]/.test(ch)) w += 0.8;
    else if (/[il.,:;'|!]/.test(ch)) w += 0.28;
    else w += 0.52;
  }
  return w;
}

/**
 * Pick a font size (and number of lines) so that `text` fits in the label
 * box without overflowing. Sizes are in region-width fractions; the result
 * never exceeds the original size. The mask may widen a little (up to
 * maxGrow, within the region) when the text would otherwise be unreadably
 * small.
 */
/**
 * Labels of one figure that had the same original size get the same
 * translated size (a table looks odd when short cells are set larger than
 * long ones). Never larger than what fits each label.
 */
export function harmonizeSizes(labels: FigureLabel[], overlays: (FigureOverlay | null)[]) {
  const groups = new Map<string, number[]>();
  labels.forEach((l, i) => {
    const o = overlays[i];
    if (!o) return;
    const k = `${l.source}:${Math.round(l.fs * 2000)}`;
    const g = groups.get(k) || [];
    g.push(i);
    groups.set(k, g);
  });
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const fits = idx.map((i) => overlays[i]!.fsCqw).sort((a, b) => a - b);
    const median = fits[Math.floor(fits.length / 2)];
    const target = Math.max(fits[0], median * 0.8);
    for (const i of idx) {
      const o = overlays[i]!;
      if (o.fsCqw > target) {
        const k = target / o.fsCqw;
        o.fsCqw = target;
        o.fsPx *= k;
      }
    }
  }
}

export function fitLabel(label: FigureLabel, regionAspect: number, naturalWidthPx: number): FigureOverlay | null {
  const text = (label.translation || "").trim();
  if (!text) return null;
  // work in units of region width: w as is, h converted (h is relative to region height)
  const wU = label.w;
  const hU = label.h * regionAspect; // regionAspect = height / width
  const fs0 = Math.max(label.fs, 0.004);
  const em = Math.max(0.5, emWidth(text));
  const padX = Math.max(fs0 * 0.15, 0.002);
  const padY = fs0 * 0.12;
  let boxW = wU + 2 * padX;
  const boxH = Math.max(hU, fs0 * 0.95) + 2 * padY;
  // only labels that really span several lines may wrap (never break a one-line label)
  const maxN = Math.max(1, Math.min(3, Math.round(hU / (fs0 * 1.2))));
  const best = (bw: number) => {
    let bestFs = 0;
    let bestN = 1;
    for (let n = 1; n <= maxN; n++) {
      const LINE = n > 1 ? 1.12 : 1.0;
      const byH = boxH / (n * LINE);
      const byW = (bw * 0.96 * n) / (em * (n > 1 ? 1.12 : 1));
      const f = Math.min(byH, byW, fs0 * 1.0);
      if (f > bestFs * 1.04) {
        bestFs = f;
        bestN = n;
      }
    }
    return { fs: bestFs, n: bestN };
  };
  let r = best(boxW);
  let x = label.x - padX;
  if (r.fs < fs0 * 0.7) {
    // widen symmetrically (max 2.2× and at most to the region border) so that
    // short labels ("Ours" → "我们的方法") stay readable
    const want = Math.min(boxW * 2.2, (em * fs0 * 0.8) / r.n + 2 * padX);
    if (want > boxW) {
      const cx = label.x + label.w / 2;
      let nx = cx - want / 2;
      let nw = want;
      if (nx < 0) {
        nw += nx;
        nx = 0;
      }
      if (nx + nw > 1) nw = 1 - nx;
      if (nw > boxW) {
        boxW = nw;
        x = nx;
        r = best(boxW);
      }
    }
  }
  // never let the mask (padding / widening) reach other ink: a ✓, an arrow, a frame
  if (label.freeL !== undefined || label.freeR !== undefined) {
    const lo = label.x - (label.freeL ?? Infinity);
    const hi = label.x + label.w + (label.freeR ?? Infinity);
    let nx = Math.max(x, lo);
    let nr = Math.min(x + boxW, hi);
    if (nr - nx < wU) {
      nx = label.x;
      nr = label.x + label.w;
    }
    if (nx !== x || nr !== x + boxW) {
      x = nx;
      boxW = nr - nx;
      r = best(boxW);
    }
  }
  // centre the mask vertically on the label
  const y = label.y - (boxH - hU) / 2 / regionAspect;
  const fs = Math.max(r.fs, 0.0025);
  return {
    source: label.source,
    src: label.text,
    text,
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.min(1 - Math.max(0, x), boxW),
    h: Math.min(1 - Math.max(0, y), boxH / regionAspect),
    fsCqw: fs * 100,
    fsPx: fs * naturalWidthPx,
    lines: r.n,
    bg: rgbCss(label.bg, "#ffffff"),
    fg: rgbCss(label.fg, "#111111"),
  };
}
