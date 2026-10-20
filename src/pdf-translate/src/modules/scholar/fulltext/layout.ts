/**
 * Zotero Scholar Suite — full-text translation (with figures)
 * Text layout analysis: pdf.js text items -> lines -> paragraph blocks.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Box, mul, union, hOverlap, width, height } from "./geometry";

export interface FontInfo {
  name: string;
  bold: boolean;
  italic: boolean;
  math: boolean;
}

export interface Glyph {
  str: string;
  box: Box;
  baseline: number;
  fontSize: number;
  font: FontInfo;
}

export interface Line {
  box: Box;
  baseline: number;
  fontSize: number;
  glyphs: Glyph[];
  text: string;
  mathChars: number;
  boldChars: number;
  chars: number;
  /** words of >=3 latin letters set in non-math fonts */
  proseWords: number;
}

export type BlockKind =
  | "para"
  | "heading"
  | "caption"
  | "equation"
  | "noise"
  | "consumed";

export interface Block {
  id: number;
  page: number;
  box: Box;
  lines: Line[];
  fontSize: number;
  text: string;
  kind: BlockKind;
  captionType?: "figure" | "table";
  mathRatio: number;
  boldRatio: number;
  column?: "left" | "right" | "full";
}

const MATH_FONT_RE =
  /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|RSFS|LMMath|Math|Symbol|STIX.*(Math|Two)|Cambria.?Math|TeXGyre.*Math|txsy|txex|pxsy|esint|wasy|stmary/i;
const MATH_CHAR_RE =
  /[∑∫∮∏√∂∇≤≥≈≠≡±∓×÷∈∉∋⊂⊃⊆⊇∪∩∀∃∄→←↔⇒⇐⇔↦∞∝∼≃≅⊕⊗⊙⟨⟩‖∥⌊⌋⌈⌉αβγδεϵζηθϑικλμνξπϖρϱσςτυφϕχψωΓΔΘΛΞΠΣΥΦΨΩ∗⋅·′″]/;
const BOLD_FONT_RE = /Bold|Black|Heavy|Semibold|Demi|CMBX|-Bd|,Bold|\.B$/i;
const ITALIC_FONT_RE = /Italic|Oblique|CMTI|-It\b/i;

export function classifyFont(name: string, flags?: { bold?: boolean; italic?: boolean }): FontInfo {
  const n = name || "";
  return {
    name: n,
    bold: !!flags?.bold || BOLD_FONT_RE.test(n),
    italic: !!flags?.italic || ITALIC_FONT_RE.test(n),
    math: MATH_FONT_RE.test(n),
  };
}

export function isMathChar(ch: string) {
  return MATH_CHAR_RE.test(ch);
}

/**
 * Convert pdf.js text content items to glyph runs in viewport space.
 * Rotated runs (arXiv side stamps etc.) are dropped.
 */
export function itemsToGlyphs(
  items: any[],
  styles: Record<string, any>,
  viewportTransform: number[],
  fonts: Record<string, FontInfo>,
): Glyph[] {
  const out: Glyph[] = [];
  for (const it of items) {
    if (!it || typeof it.str !== "string") continue;
    const str = it.str;
    if (!str.trim()) continue;
    const tx = mul(viewportTransform, it.transform);
    const sx = Math.hypot(tx[0], tx[1]);
    const sy = Math.hypot(tx[2], tx[3]);
    if (sx === 0 || sy === 0) continue;
    // rotated text: viewport y grows downward, so a normal run has tx[1]≈0, tx[2]≈0
    if (Math.abs(tx[1]) > 0.2 * sx || Math.abs(tx[2]) > 0.2 * sy) continue;
    const fontSize = sy;
    const style = styles?.[it.fontName] || {};
    const ascent = typeof style.ascent === "number" && style.ascent > 0 ? style.ascent : 0.8;
    const descent =
      typeof style.descent === "number" && style.descent < 0 ? -style.descent : 0.2;
    const x0 = tx[4];
    const baseline = tx[5];
    const w = Math.max(it.width || 0, 0.3 * fontSize * str.length * 0.5);
    const box: Box = {
      x0,
      y0: baseline - ascent * fontSize,
      x1: x0 + (it.width || w),
      y1: baseline + descent * fontSize,
    };
    out.push({
      str,
      box,
      baseline,
      fontSize,
      font: fonts[it.fontName] || classifyFont(style.fontFamily || ""),
    });
  }
  return out;
}

function joinGlyphText(glyphs: Glyph[]) {
  let s = "";
  let prev: Glyph | null = null;
  for (const g of glyphs) {
    if (prev) {
      const gapX = g.box.x0 - prev.box.x1;
      const needSpace =
        gapX > 0.12 * Math.min(prev.fontSize, g.fontSize) &&
        !/\s$/.test(s) &&
        !/^\s/.test(g.str);
      if (needSpace) s += " ";
    }
    s += g.str;
    prev = g;
  }
  return s.replace(/\s+/g, " ").trim();
}

function finishLine(glyphs: Glyph[]): Line {
  glyphs.sort((a, b) => a.box.x0 - b.box.x0);
  let box = glyphs[0].box;
  for (const g of glyphs) box = union(box, g.box);
  // dominant font size: by character count
  const sizeCount = new Map<number, number>();
  let mathChars = 0;
  let boldChars = 0;
  let chars = 0;
  let proseWords = 0;
  for (const g of glyphs) {
    if (!g.font.math) proseWords += (g.str.match(/[A-Za-z]{3,}/g) || []).length;
    const n = g.str.replace(/\s/g, "").length;
    const k = Math.round(g.fontSize * 2) / 2;
    sizeCount.set(k, (sizeCount.get(k) || 0) + n);
    chars += n;
    if (g.font.math) mathChars += n;
    else for (const ch of g.str) if (isMathChar(ch)) mathChars++;
    if (g.font.bold) boldChars += n;
  }
  let fontSize = glyphs[0].fontSize;
  let best = -1;
  for (const [k, v] of sizeCount) {
    if (v > best) {
      best = v;
      fontSize = k;
    }
  }
  const main = glyphs.filter((g) => Math.abs(g.fontSize - fontSize) < 0.2 * fontSize);
  const baseline = main.length
    ? main.reduce((s, g) => s + g.baseline, 0) / main.length
    : glyphs[0].baseline;
  return {
    box,
    baseline,
    fontSize,
    glyphs,
    text: joinGlyphText(glyphs),
    mathChars,
    boldChars,
    chars,
    proseWords,
  };
}

/** Group glyph runs into text lines. */
export function glyphsToLines(glyphs: Glyph[]): Line[] {
  const sorted = glyphs.slice().sort((a, b) => a.baseline - b.baseline || a.box.x0 - b.box.x0);
  type Open = { glyphs: Glyph[]; baseline: number; fs: number; x1: number; x0: number };
  const open: Open[] = [];
  const done: Open[] = [];
  for (const g of sorted) {
    let target: Open | null = null;
    let bestScore = Infinity;
    for (const l of open) {
      const fs = Math.max(l.fs, g.fontSize);
      const dy = Math.abs(g.baseline - l.baseline);
      const isScript = g.fontSize < 0.85 * l.fs || l.fs < 0.85 * g.fontSize;
      const dyOk = dy < 0.3 * Math.min(l.fs, g.fontSize) || (isScript && dy < 0.55 * fs);
      if (!dyOk) continue;
      // horizontal adjacency: must not jump a column gutter
      const gapR = g.box.x0 - l.x1;
      const gapL = l.x0 - g.box.x1;
      const gapX = Math.max(gapR, gapL);
      if (gapX > Math.max(1.5 * fs, 8)) continue;
      const score = dy + Math.max(0, gapX) * 0.1;
      if (score < bestScore) {
        bestScore = score;
        target = l;
      }
    }
    if (target) {
      target.glyphs.push(g);
      target.x1 = Math.max(target.x1, g.box.x1);
      target.x0 = Math.min(target.x0, g.box.x0);
      if (g.fontSize > target.fs * 1.15) {
        // a main-size run joined a line started by a sub/superscript:
        // the line's reference baseline becomes the main one
        target.baseline = g.baseline;
        target.fs = g.fontSize;
      } else if (g.fontSize >= target.fs * 0.85) {
        target.fs = Math.max(target.fs, g.fontSize);
      }
    } else {
      open.push({ glyphs: [g], baseline: g.baseline, fs: g.fontSize, x0: g.box.x0, x1: g.box.x1 });
    }
    // close lines that are far above
    for (let i = open.length - 1; i >= 0; i--) {
      if (g.baseline - open[i].baseline > 2 * open[i].fs) {
        done.push(open[i]);
        open.splice(i, 1);
      }
    }
  }
  done.push(...open);
  // merge fragments of the same visual line (accents, sub/superscripts that
  // started their own line)
  const groupsG = done.map((o) => o.glyphs);
  let changed = true;
  while (changed) {
    changed = false;
    const boxes = groupsG.map((gs) => gs.map((g) => g.box).reduce(union));
    const fss = groupsG.map((gs) => Math.max(...gs.map((g) => g.fontSize)));
    outer: for (let i = 0; i < groupsG.length; i++) {
      for (let j = i + 1; j < groupsG.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const vo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const minH = Math.min(a.y1 - a.y0, b.y1 - b.y0);
        if (vo < 0.6 * minH) continue;
        const fs = Math.max(fss[i], fss[j]);
        const dx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        if (dx > Math.max(1.2 * fs, 6)) continue;
        groupsG[i] = groupsG[i].concat(groupsG[j]);
        groupsG.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return groupsG.map((gs) => finishLine(gs)).filter((l) => l.text.length > 0);
}

function endsSentence(s: string) {
  return /[.!?。！？:：;；)\]]["'”’]?$/.test(s.trim());
}

/** Group lines into paragraph-like blocks. */
export function linesToBlocks(lines: Line[], page: number, idStart: number): Block[] {
  const sorted = lines.slice().sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  type Open = { lines: Line[]; box: Box; fs: number };
  const open: Open[] = [];
  const blocks: Open[] = [];
  for (const l of sorted) {
    let target: Open | null = null;
    let best = -Infinity;
    for (const b of open) {
      const last = b.lines[b.lines.length - 1];
      const fs = b.fs;
      if (Math.abs(l.fontSize - fs) > 0.18 * fs) continue;
      const vgap = l.box.y0 - last.box.y1;
      if (vgap > 0.75 * fs || vgap < -0.6 * fs) continue;
      const ov = hOverlap(l.box, b.box);
      const minW = Math.min(width(l.box), width(b.box));
      const leftAligned = Math.abs(l.box.x0 - b.box.x0) < 2.5 * fs;
      if (ov < 0.3 * minW && !leftAligned) continue;
      // new paragraph heuristics
      const indented = l.box.x0 - b.box.x0 > 1.0 * fs && l.box.x0 - b.box.x0 < 4 * fs;
      const lastShort = width(last.box) < 0.8 * width(b.box) && b.lines.length >= 1;
      if (endsSentence(last.text) && (indented || (lastShort && b.lines.length > 1))) continue;
      const score = ov - Math.abs(vgap);
      if (score > best) {
        best = score;
        target = b;
      }
    }
    if (target) {
      target.lines.push(l);
      target.box = union(target.box, l.box);
    } else {
      const nb = { lines: [l], box: { ...l.box }, fs: l.fontSize };
      open.push(nb);
      blocks.push(nb);
    }
    for (let i = open.length - 1; i >= 0; i--) {
      const last = open[i].lines[open[i].lines.length - 1];
      if (l.box.y0 - last.box.y1 > 3 * open[i].fs) open.splice(i, 1);
    }
  }
  let id = idStart;
  return blocks.map((b) => {
    let chars = 0;
    let mathChars = 0;
    let boldChars = 0;
    for (const l of b.lines) {
      chars += l.chars;
      mathChars += l.mathChars;
      boldChars += l.boldChars;
    }
    return {
      id: id++,
      page,
      box: b.box,
      lines: b.lines,
      fontSize: b.fs,
      text: joinLines(b.lines.map((l) => l.text)),
      kind: "para" as BlockKind,
      mathRatio: chars ? mathChars / chars : 0,
      boldRatio: chars ? boldChars / chars : 0,
    };
  });
}

/** Join wrapped lines, removing end-of-line hyphenation. */
export function joinLines(lines: string[]) {
  let s = "";
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (!s) {
      s = t;
      continue;
    }
    if (/[A-Za-z]-$/.test(s) && /^[a-z]/.test(t)) {
      s = s.slice(0, -1) + t;
    } else if (/[\u3000-\u9fff\uff00-\uffef]$/.test(s) && /^[\u3000-\u9fff\uff00-\uffef]/.test(t)) {
      s += t;
    } else {
      s += " " + t;
    }
  }
  return s;
}

export const CAPTION_RE =
  /^\s*(Figure|Fig\.?|FIGURE|FIG\.?|Table|TABLE|Tab\.|Algorithm|Listing|Scheme|Chart|Plate|图|表)\s*([A-Z]?\d+[a-z]?|[IVX]+|[A-Z]\.\d+|S\d+)?\s*[.:：|\-–—]?/;

export function captionTypeOf(text: string): "figure" | "table" | null {
  const m = CAPTION_RE.exec(text);
  if (!m || !m[2]) return null;
  // "Figure 3 shows ..." inside body text is not a caption: captions are
  // followed by ':' / '.' or are at least short labels
  const after = text.slice(m[0].length - (m[0].match(/[.:：|\-–—]\s*$/) ? 1 : 0));
  const hasDelimiter = /[.:：|\-–—]\s*$/.test(m[0]) || /^\s*[.:：|]/.test(after);
  if (!hasDelimiter && text.length > 60) return null;
  const word = m[1].toLowerCase();
  if (word.startsWith("tab") || word === "表") return "table";
  return "figure";
}

/**
 * Pull display-equation lines out of the text flow. Returns clusters of lines
 * (each cluster becomes one equation image) and the remaining text lines.
 */
export function extractEquations(lines: Line[], body: number): { equations: Box[]; rest: Line[] } {
  const isEqNumber = (l: Line) => /^\(\s*[A-Z]?\d+(\.\d+)?[a-z]?\s*\)$/.test(l.text);
  const mathy = new Set<Line>();
  for (const l of lines) {
    const ratio = l.chars ? l.mathChars / l.chars : 0;
    // "... z_t := a x + b as follows:" is an inline continuation, not a display
    if (l.proseWords >= 1 && /[A-Za-z]{2,}[:,]$/.test(l.text)) continue;
    if (ratio >= 0.3 && l.proseWords <= 5 && l.chars >= 1) mathy.add(l);
    else if (ratio >= 0.18 && l.proseWords <= 2 && l.chars >= 3) mathy.add(l);
  }
  // attach sub/superscript fragments, operators and equation numbers
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of lines) {
      if (mathy.has(l)) continue;
      const small = l.chars <= 6 && l.proseWords === 0;
      const eqn = isEqNumber(l);
      if (!small && !eqn) continue;
      for (const m of mathy) {
        const vo = Math.min(l.box.y1, m.box.y1) - Math.max(l.box.y0, m.box.y0);
        const dy = vo > 0 ? 0 : Math.min(Math.abs(l.box.y0 - m.box.y1), Math.abs(m.box.y0 - l.box.y1));
        const dx = Math.max(0, Math.max(l.box.x0, m.box.x0) - Math.min(l.box.x1, m.box.x1));
        if ((small && dy < 0.6 * body && dx < 2 * body) || (eqn && vo > 0.3 * Math.min(height(l.box), height(m.box)) && dx < 260)) {
          mathy.add(l);
          changed = true;
          break;
        }
      }
    }
  }
  const eqLines = lines.filter((l) => mathy.has(l));
  // cluster: same baseline band (eq numbers far right) or vertically close + overlapping
  const groups: { box: Box; lines: Line[] }[] = [];
  for (const l of eqLines.sort((a, b) => a.box.y0 - b.box.y0)) {
    let g = groups.find((gr) => {
      const vo = Math.min(l.box.y1, gr.box.y1) - Math.max(l.box.y0, gr.box.y0);
      const dy = vo > 0 ? 0 : l.box.y0 - gr.box.y1;
      const dx = Math.max(0, Math.max(l.box.x0, gr.box.x0) - Math.min(l.box.x1, gr.box.x1));
      if (vo > 0 && dx < (isEqNumber(l) ? 260 : 3 * body)) return true;
      return dy >= -1 && dy < 0.7 * body && (dx < 1.5 * body);
    });
    if (g) {
      g.box = union(g.box, l.box);
      g.lines.push(l);
    } else {
      groups.push({ box: { ...l.box }, lines: [l] });
    }
  }
  // merge groups touching each other
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i].box;
        const b = groups[j].box;
        const vo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
        if (vo > -0.3 * body && dx < 1.5 * body) {
          groups[i].box = union(a, b);
          groups[i].lines.push(...groups[j].lines);
          groups.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  // a lone eq-number or tiny fragment is not an equation
  const keep = groups.filter((g) => g.lines.some((l) => l.chars >= 3 && !isEqNumber(l)));
  const keepLines = new Set(keep.flatMap((g) => g.lines));
  return { equations: keep.map((g) => g.box), rest: lines.filter((l) => !keepLines.has(l)) };
}
