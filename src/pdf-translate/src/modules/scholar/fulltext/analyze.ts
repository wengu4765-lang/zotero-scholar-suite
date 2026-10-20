/**
 * Zotero Scholar Suite — full-text translation (with figures)
 * Page analysis: classify blocks, find figure / table / equation regions,
 * and produce elements in reading order.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  Box,
  area,
  center,
  clusterBoxes,
  contains,
  coverage,
  hOverlap,
  height,
  intersect,
  union,
  width,
  expand,
  clamp,
} from "./geometry";
import { Block, captionTypeOf } from "./layout";
import { GraphicBox } from "./graphics";

export type RegionKind = "figure" | "table" | "equation";

export interface Region {
  id: number;
  page: number;
  kind: RegionKind;
  box: Box;
  caption?: Block;
  image?: string; // data URL after rendering
  pixelWidth?: number;
  pixelHeight?: number;
  source: string; // how it was detected (debug)
  /** text inside the figure (vector text / OCR), see figureText.ts */
  figureLabels?: import("./figureText").FigureLabel[];
  figureOverlays?: import("./figureText").FigureOverlay[];
}

export type Element =
  | { type: "heading" | "para" | "caption" | "byline"; page: number; box: Box; block: Block; text: string }
  | { type: "region"; page: number; box: Box; region: Region };

export interface PageAnalysis {
  page: number;
  pageBox: Box;
  blocks: Block[];
  regions: Region[];
  elements: Element[];
}

export interface DocStats {
  bodyFontSize: number;
}

let regionSeq = 1;

/** document-level vote: are tables usually above or below their captions? */
export const docTableSide = { votes: { above: 0, below: 0 }, value: "below" as "above" | "below" };
export function resetDocState() {
  docTableSide.votes.above = 0;
  docTableSide.votes.below = 0;
  docTableSide.value = "below";
}

export function computeBodyFontSize(allBlocks: Block[]): number {
  const counts = new Map<number, number>();
  for (const b of allBlocks) {
    for (const l of b.lines) {
      const k = Math.round(l.fontSize * 2) / 2;
      counts.set(k, (counts.get(k) || 0) + l.chars);
    }
  }
  let best = 10;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

function normalizeNoise(s: string) {
  return s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Mark running headers/footers/page numbers as noise (document level). */
export function markNoise(pages: { pageBox: Box; blocks: Block[] }[]) {
  const freq = new Map<string, number>();
  const zoneBlocks: { b: Block; key: string }[] = [];
  for (const p of pages) {
    const h = height(p.pageBox);
    for (const b of p.blocks) {
      const inTop = b.box.y1 < p.pageBox.y0 + 0.075 * h;
      const inBottom = b.box.y0 > p.pageBox.y1 - 0.075 * h;
      if (!(inTop || inBottom)) continue;
      if (b.text.length > 160) continue;
      if (/^[\s\divxlcIVXLC\-–—|·•/]+$/.test(b.text) || /^(page|第)\s*\d+/i.test(b.text)) {
        b.kind = "noise";
        continue;
      }
      const key = normalizeNoise(b.text);
      freq.set(key, (freq.get(key) || 0) + 1);
      zoneBlocks.push({ b, key });
    }
  }
  const minRepeat = Math.max(2, Math.min(3, Math.floor(pages.length / 3)));
  for (const { b, key } of zoneBlocks) {
    if ((freq.get(key) || 0) >= minRepeat) b.kind = "noise";
  }
}

function isProse(b: Block, body: number) {
  return (
    b.kind === "para" &&
    b.fontSize >= body * 0.9 &&
    b.mathRatio < 0.3 &&
    (b.text.length > 120 || (b.lines.length >= 2 && b.text.length > 60))
  );
}

export function classifyBlocks(blocks: Block[], body: number) {
  for (const b of blocks) {
    if (b.kind === "noise") continue;
    const t = b.text;
    const words = t.split(/\s+/).filter(Boolean).length;
    const cap = captionTypeOf(t);
    if (cap) {
      b.kind = "caption";
      b.captionType = cap;
      continue;
    }
    const isNumberedHeading =
      /^((\d+(\.\d+){0,3})\.?|[IVX]{1,5}\.|[A-H]\.|Appendix\s+[A-Z])\s+\S/.test(t) &&
      words <= 14 &&
      !/[.;:,]$/.test(t) &&
      b.lines.length <= 2;
    const knownHeading =
      /^(abstract|introduction|related work|background|method(s|ology)?|experiments?|results|discussion|conclusions?|references|acknowledg(e)?ments?|appendix|limitations|摘要|引言|参考文献)\b/i.test(
        t,
      ) && words <= 6;
    if (
      (b.fontSize > body * 1.18 && t.length < 220 && b.lines.length <= 3) ||
      ((isNumberedHeading || knownHeading) && (b.boldRatio > 0.5 || b.fontSize > body * 1.05 || knownHeading)) ||
      (b.boldRatio > 0.8 && b.lines.length === 1 && words <= 12 && !/[.,;]$/.test(t) && t.length > 2)
    ) {
      b.kind = "heading";
      continue;
    }
    // display equations
    const eqNumber = /\(\s*[A-Z]?\d+(\.\d+)?[a-z]?\s*\)\s*$/.test(t);
    const letters = (t.match(/[A-Za-z]{3,}/g) || []).length;
    const bigEnough = b.text.replace(/\s/g, "").length >= 4 && width(b.box) > 30;
    if (
      (bigEnough && b.mathRatio > 0.35 && b.lines.length <= 8 && letters < 14) ||
      (eqNumber && b.mathRatio > 0.12 && t.length < 160 && letters < 10)
    ) {
      b.kind = "equation";
      continue;
    }
    b.kind = "para";
  }
}

function contentBox(blocks: Block[], pageBox: Box): Box {
  const live = blocks.filter((b) => b.kind !== "noise");
  if (!live.length) return pageBox;
  let box = live[0].box;
  for (const b of live) box = union(box, b.box);
  return box;
}

function columnBoxFor(b: Box, content: Box): Box {
  const cw = width(content);
  const mid = (content.x0 + content.x1) / 2;
  if (width(b) > 0.6 * cw || (b.x0 < mid - 0.05 * cw && b.x1 > mid + 0.05 * cw)) {
    return { x0: content.x0, x1: content.x1, y0: content.y0, y1: content.y1 };
  }
  if (center(b).x < mid) return { x0: content.x0, x1: mid, y0: content.y0, y1: content.y1 };
  return { x0: mid, x1: content.x1, y0: content.y0, y1: content.y1 };
}

/**
 * Find figure / table / equation regions on a page.
 */
export function findRegions(
  page: number,
  pageBox: Box,
  blocks: Block[],
  graphics: GraphicBox[],
  body: number,
  options: { equations: boolean; equationBoxes?: Box[] },
): Region[] {
  const content = union(contentBox(blocks, pageBox), graphics.length ? graphics.map((g) => g.box).reduce(union) : contentBox(blocks, pageBox));
  const regions: Region[] = [];
  const mk = (kind: RegionKind, box: Box, source: string, caption?: Block): Region => ({
    id: regionSeq++,
    page,
    kind,
    box,
    caption,
    source,
  });

  // 1. raster images
  const imgBoxes = graphics.filter((g) => g.type === "image").map((g) => g.box);
  for (const c of clusterBoxes(imgBoxes, 6)) {
    if (area(c) >= 900 && width(c) >= 20 && height(c) >= 20) regions.push(mk("figure", c, "image"));
  }

  // 2. dense vector drawings (plots, diagrams)
  const vecBoxes = graphics.filter((g) => g.type === "vector").map((g) => g.box);
  const vecClusters = clusterBoxes(vecBoxes, 3);
  for (const c of vecClusters) {
    if (width(c) < 40 || height(c) < 30) continue;
    const members = vecBoxes.filter((v) => coverage(v, c) > 0.9).length;
    if (members < 6) continue;
    // ignore frames around prose (e.g. boxed paragraphs / algorithm frames)
    const proseCover = blocks
      .filter((b) => isProse(b, body) && coverage(b.box, c) > 0.8)
      .reduce((s, b) => s + area(b.box), 0);
    if (proseCover > 0.45 * area(c)) continue;
    regions.push(mk("figure", c, "vector"));
  }

  // 3. caption-driven regions (covers vector figures and tables)
  const prose = blocks.filter((b) => isProse(b, body));
  // Where is the table relative to its caption? Decide per caption when it is
  // unambiguous (content on one side only), otherwise use the document vote.
  const tableSide = new Map<Block, "above" | "below">();
  for (const cap of blocks.filter((b) => b.kind === "caption" && b.captionType === "table")) {
    const col = columnBoxFor(cap.box, content);
    const near = (dir: "above" | "below") => {
      let best = Infinity;
      let kind: "content" | "prose" | null = null;
      const consider = (bx: Box, k: "content" | "prose") => {
        if (hOverlap(bx, col) < 0.3 * width(bx)) return;
        const d = dir === "above" ? cap.box.y0 - bx.y1 : bx.y0 - cap.box.y1;
        if (d < -2 || d > 60) return;
        if (d < best) {
          best = d;
          kind = k;
        }
      };
      for (const b of blocks) {
        if (b === cap || b.kind === "noise") continue;
        consider(b.box, isProse(b, body) || b.kind === "heading" || b.kind === "caption" ? "prose" : "content");
      }
      for (const g of graphics) consider(g.box, "content");
      return { d: best, kind: kind as "content" | "prose" | null };
    };
    const a = near("above");
    const b = near("below");
    if (a.kind === "content" && b.kind !== "content") tableSide.set(cap, "above");
    else if (b.kind === "content" && a.kind !== "content") tableSide.set(cap, "below");
  }
  for (const v of tableSide.values()) docTableSide.votes[v]++;
  docTableSide.value = docTableSide.votes.above > docTableSide.votes.below ? "above" : "below";
  for (const cap of blocks.filter((b) => b.kind === "caption")) {
    const col = columnBoxFor(cap.box, content);
    // a table's header row ("Method  DINO ↑ …") is set smaller than body text and
    // is often classified as a heading; it must not cut the table region
    const isTableHeaderRow = (h: Block) => cap.captionType === "table" && h.kind === "heading" && h.fontSize < body * 0.97;
    const tryAbove = (): Box | null => {
      let top = content.y0;
      for (const p of prose) {
        if (p === cap) continue;
        if (p.box.y1 <= cap.box.y0 + 2 && hOverlap(p.box, col) > 0.5 * width(p.box)) {
          top = Math.max(top, p.box.y1 + 2);
        }
      }
      for (const other of blocks) {
        if (other !== cap && other.kind === "caption" && other.box.y1 <= cap.box.y0 && hOverlap(other.box, col) > 0.3 * width(other.box)) {
          top = Math.max(top, other.box.y1 + 2);
        }
      }
      for (const h of blocks) {
        if (h.kind === "heading" && !isTableHeaderRow(h) && h.box.y1 <= cap.box.y0 && hOverlap(h.box, col) > 0.5 * width(h.box)) {
          top = Math.max(top, h.box.y1 + 2);
        }
      }
      const r = { x0: col.x0, x1: col.x1, y0: top, y1: cap.box.y0 - 1 };
      return height(r) >= 12 ? r : null;
    };
    const tryBelow = (): Box | null => {
      let bottom = content.y1;
      for (const p of prose) {
        if (p.box.y0 >= cap.box.y1 - 2 && hOverlap(p.box, col) > 0.5 * width(p.box)) {
          bottom = Math.min(bottom, p.box.y0 - 2);
        }
      }
      for (const other of blocks) {
        if (
          other !== cap &&
          (other.kind === "caption" || (other.kind === "heading" && !isTableHeaderRow(other))) &&
          other.box.y0 >= cap.box.y1 &&
          hOverlap(other.box, col) > 0.3 * width(other.box)
        ) {
          bottom = Math.min(bottom, other.box.y0 - 2);
        }
      }
      const r = { x0: col.x0, x1: col.x1, y0: cap.box.y1 + 1, y1: bottom };
      return height(r) >= 12 ? r : null;
    };
    const tighten = (r: Box | null): Box | null => {
      if (!r) return null;
      let tight: Box | null = null;
      let nGraphic = 0;
      for (const g of graphics) {
        const i = intersect(g.box, r);
        if (i && area(i) > 0.5 * area(g.box)) {
          tight = tight ? union(tight, i) : i;
          nGraphic++;
        }
      }
      let nText = 0;
      for (const b of blocks) {
        if (b === cap || b.kind === "noise" || b.kind === "caption") continue;
        if (contains(r, center(b.box)) && !isProse(b, body)) {
          tight = tight ? union(tight, b.box) : b.box;
          nText++;
        }
      }
      if (!tight) return null;
      if (nGraphic === 0 && nText < 3) return null;
      return tight;
    };
    let r: Box | null = null;
    if (cap.captionType === "table") {
      const below = tighten(tryBelow());
      const above = tighten(tryAbove());
      const side = tableSide.get(cap) || docTableSide.value;
      if (below && above) r = side === "above" ? above : below;
      else r = below || above;
    } else {
      r = tighten(tryAbove()) || tighten(tryBelow());
    }
    if (r) {
      regions.push(mk(cap.captionType === "table" ? "table" : "figure", r, "caption", cap));
    }
  }

  // 4. merge overlapping regions (keep caption)
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const i1 = intersect(expand(a.box, 2), expand(b.box, 2));
        if (!i1) continue;
        if (a.caption && b.caption && a.caption !== b.caption) {
          // two captioned regions touching: only merge if heavily overlapping
          if (area(i1) < 0.5 * Math.min(area(a.box), area(b.box))) continue;
        }
        a.box = union(a.box, b.box);
        a.caption = a.caption || b.caption;
        if (b.kind === "table") a.kind = "table";
        else if (a.kind === "equation" && b.kind === "figure") a.kind = "figure";
        a.source += "+" + b.source;
        regions.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }

  // 5. attach nearby captions to uncaptioned regions
  for (const r of regions) {
    if (r.caption) continue;
    let best: Block | null = null;
    let bestD = 40;
    for (const cap of blocks) {
      if (cap.kind !== "caption") continue;
      if (regions.some((o) => o.caption === cap)) continue;
      if (hOverlap(cap.box, r.box) < 0.3 * Math.min(width(cap.box), width(r.box))) continue;
      const d = cap.box.y0 >= r.box.y1 ? cap.box.y0 - r.box.y1 : r.box.y0 - cap.box.y1;
      if (d >= -2 && d < bestD) {
        bestD = d;
        best = cap;
      }
    }
    if (best) r.caption = best;
  }

  // 6. absorb label text inside regions; drop prose-dominated "figures"
  for (const r of regions) {
    for (const b of blocks) {
      if (b.kind === "noise" || b.kind === "caption" || b.kind === "consumed") continue;
      const cov = coverage(b.box, r.box);
      if (cov > 0.6 || (cov > 0.25 && !isProse(b, body) && b.text.length < 120)) {
        r.box = union(r.box, b.box);
      }
    }
  }
  // everything between a figure and its caption belongs to the figure
  for (const r of regions) {
    const cap = r.caption;
    if (!cap) continue;
    const below = cap.box.y0 >= r.box.y1 - 2;
    const above = cap.box.y1 <= r.box.y0 + 2;
    for (const b of blocks) {
      if (b === cap || b.kind === "noise" || b.kind === "caption" || isProse(b, body)) continue;
      if (hOverlap(b.box, r.box) < 0.5 * width(b.box)) continue;
      if (below && b.box.y0 >= r.box.y0 && b.box.y1 <= cap.box.y0 + 1) r.box = union(r.box, b.box);
      if (above && b.box.y1 <= r.box.y1 && b.box.y0 >= cap.box.y1 - 1) r.box = union(r.box, b.box);
    }
  }
  // never let a region run into its own caption (the crop would show half a caption line)
  for (const r of regions) {
    const cap = r.caption;
    if (!cap) continue;
    const fs = cap.fontSize || 8;
    const m = 0.15 * fs;
    // visual top of the caption: the font's ascent can be under-reported, use the baseline
    const capTop = Math.min(cap.box.y0, cap.lines?.[0] ? cap.lines[0].baseline - 0.9 * fs : cap.box.y0);
    if (cap.box.y0 >= r.box.y0 + 0.5 * height(r.box) && r.box.y1 > capTop - m) {
      r.box = { ...r.box, y1: Math.max(r.box.y0 + 4, capTop - m) };
    } else if (cap.box.y1 <= r.box.y1 - 0.5 * height(r.box) && r.box.y0 < cap.box.y1 + m) {
      r.box = { ...r.box, y0: Math.min(r.box.y1 - 4, cap.box.y1 + m) };
    }
  }
  for (const r of regions) {
    for (const b of blocks) {
      if (b.kind === "noise" || b.kind === "caption") continue;
      if (contains(r.box, center(b.box), 1) && coverage(b.box, r.box) > 0.5) b.kind = "consumed";
    }
  }

  // 7. display equations -> image regions
  if (options.equations) {
    for (const eb of options.equationBoxes || []) {
      if (regions.some((r) => r.kind !== "equation" && coverage(eb, r.box) > 0.5)) continue;
      regions.push(mk("equation", eb, "equation-lines"));
    }
    for (const b of blocks) {
      if (b.kind !== "equation") continue;
      regions.push(mk("equation", b.box, "equation"));
      b.kind = "consumed";
    }
  }

  for (const r of regions) r.box = clamp(expand(r.box, r.kind === "equation" ? 2 : 3), pageBox);
  return regions;
}

/** Order page elements: full-width bands, left column then right column. */
export function orderElements(page: number, pageBox: Box, blocks: Block[], regions: Region[]): Element[] {
  const els: Element[] = [];
  const captionsInRegions = new Set(regions.map((r) => r.caption).filter(Boolean));
  for (const b of blocks) {
    if (b.kind === "noise" || b.kind === "consumed" || b.kind === "equation") continue;
    if (b.kind === "caption" && captionsInRegions.has(b)) continue;
    const type = b.kind === "heading" ? "heading" : b.kind === "caption" ? "caption" : "para";
    els.push({ type, page, box: b.box, block: b, text: b.text });
  }
  for (const r of regions) els.push({ type: "region", page, box: r.box, region: r });
  if (!els.length) return els;

  let content = els[0].box;
  for (const e of els) content = union(content, e.box);
  const cw = width(content);
  const mid = (content.x0 + content.x1) / 2;
  const colOf = (b: Box) => {
    if (width(b) > 0.55 * cw || (b.x0 < mid - 0.04 * cw && b.x1 > mid + 0.04 * cw)) return "full";
    return center(b).x < mid ? "left" : "right";
  };
  const twoColumn =
    els.filter((e) => colOf(e.box) === "left").length >= 2 &&
    els.filter((e) => colOf(e.box) === "right").length >= 2;
  if (!twoColumn) {
    return els.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  }
  const full = els.filter((e) => colOf(e.box) === "full").sort((a, b) => a.box.y0 - b.box.y0);
  const others = els.filter((e) => colOf(e.box) !== "full");
  const out: Element[] = [];
  let prevY = -Infinity;
  const bandOf = (y: number) => {
    let i = 0;
    while (i < full.length && full[i].box.y0 <= y) i++;
    return i;
  };
  const bands: Element[][] = Array.from({ length: full.length + 1 }, () => []);
  for (const e of others) bands[bandOf(e.box.y0)].push(e);
  for (let i = 0; i <= full.length; i++) {
    const band = bands[i];
    const left = band.filter((e) => colOf(e.box) === "left").sort((a, b) => a.box.y0 - b.box.y0);
    const right = band.filter((e) => colOf(e.box) === "right").sort((a, b) => a.box.y0 - b.box.y0);
    out.push(...left, ...right);
    if (i < full.length) out.push(full[i]);
  }
  void prevY;
  return out;
}

function endsSentence(s: string) {
  return /[.!?。！？:：;；]["'”’)\]]?$/.test(s.trim());
}

/** Merge paragraphs split across columns / pages / figures. */
export function mergeContinuations(elements: Element[], body: number): Element[] {
  const out: Element[] = [];
  let lastPara: (Element & { type: "para" }) | null = null;
  for (const e of elements) {
    if (e.type === "para") {
      const startsLower = /^[a-z(\[,;]/.test(e.text);
      if (
        lastPara &&
        !endsSentence(lastPara.text) &&
        (startsLower || /-$/.test(lastPara.text)) &&
        Math.abs(e.block.fontSize - lastPara.block.fontSize) < 0.15 * body
      ) {
        if (/[A-Za-z]-$/.test(lastPara.text) && /^[a-z]/.test(e.text)) {
          lastPara.text = lastPara.text.slice(0, -1) + e.text;
        } else {
          lastPara.text = lastPara.text + " " + e.text;
        }
        continue;
      }
      lastPara = e as any;
      out.push(e);
    } else if (e.type === "heading") {
      lastPara = null;
      out.push(e);
    } else {
      // regions and captions do not break a running paragraph
      out.push(e);
    }
  }
  return out;
}

/**
 * Front matter on page 1: author names / affiliations / e-mails between the paper
 * title and the Abstract (or first section heading). They are often set in a larger
 * or bold font and would otherwise be classified as headings and sent to translation.
 * Marked as "byline": shown once, centred, not translated.
 * Only applied when such an Abstract / first-section heading exists on page 1.
 */
export function markFrontMatter(elements: Element[]): Element[] {
  const firstPage = elements.filter((e) => e.page === 1);
  const titleIdx = firstPage.findIndex((e) => e.type === "heading");
  if (titleIdx < 0) return elements;
  const isSectionStart = (e: Element) =>
    e.type !== "region" &&
    (e.type === "heading" || e.type === "para") &&
    (/^(abstract|摘要)\b/i.test(e.text) ||
      /^(1\.?|I\.)\s+(introduction|background|overview)\b/i.test(e.text) ||
      /^introduction$/i.test(e.text.trim()));
  const endIdx = firstPage.findIndex((e, i) => i > titleIdx && isSectionStart(e));
  if (endIdx < 0) return elements;
  for (let i = titleIdx + 1; i < endIdx; i++) {
    const e = firstPage[i];
    if (e.type !== "heading" && e.type !== "para") continue;
    const t = e.text.trim();
    // prose sentences (e.g. a teaser paragraph) are not bylines
    if (t.length > 300 || /[a-z]{3,}[.!?]$/.test(t) || t.split(/\s+/).length > 40) continue;
    (e as any).type = "byline";
  }
  return elements;
}
