/**
 * Zotero Scholar Suite — full-text translation (with figures)
 * Bilingual HTML output. Works without JavaScript (Zotero's snapshot reader):
 * the view modes are pure-CSS radio toggles.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Element } from "./analyze";
import type { FigureOverlay } from "./figureText";

export interface HtmlDoc {
  title: string;
  sourceFile: string;
  serviceName: string;
  langFrom: string;
  langTo: string;
  generatedAt: string;
  pageCount: number;
  stats: { paragraphs: number; figures: number; tables: number; equations: number; failed: number };
  /** text-inside-figures summary line (optional) */
  figureTextNote?: string;
  /** OCR / label problems, listed in a collapsed block */
  figureFailures?: string[];
}

export interface TranslatedElement {
  el: Element;
  translation?: string;
  captionTranslation?: string;
  failed?: boolean;
}

export function escapeHtml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHtml(s: string) {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

const CSS = `
:root{--fg:#1f2328;--muted:#6b7280;--src:#4b5563;--bg:#fff;--line:#e5e7eb;--accent:#2563eb;--tr-bg:#f8fafc}
@media (prefers-color-scheme: dark){:root{--fg:#e5e7eb;--muted:#9ca3af;--src:#9ca3af;--bg:#111827;--line:#374151;--accent:#60a5fa;--tr-bg:#1f2937}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
body{font:16px/1.75 -apple-system,"Segoe UI","Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
.mode-radio{position:absolute;opacity:0;pointer-events:none}
.toolbar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--line);font-size:13px}
.toolbar .title{font-weight:600;margin-right:auto;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toolbar label{cursor:pointer;padding:3px 10px;border:1px solid var(--line);border-radius:999px;user-select:none}
#m-bi:checked~.toolbar label[for=m-bi],#m-side:checked~.toolbar label[for=m-side],#m-tr:checked~.toolbar label[for=m-tr],#m-src:checked~.toolbar label[for=m-src],#t-src:checked~.toolbar label[for=t-src],#f-tr:checked~.toolbar label[for=f-tr],#f-orig:checked~.toolbar label[for=f-orig]{background:var(--accent);color:#fff;border-color:var(--accent)}
main{max-width:920px;margin:0 auto;padding:24px 28px 80px}
.meta{color:var(--muted);font-size:13px;border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:24px}
.pair{margin:0 0 1.1em}
.pair .src{color:var(--src);font-size:.92em;margin:0 0 .25em;font-family:Georgia,"Times New Roman",serif;line-height:1.6}
.pair .tr{margin:0;background:var(--tr-bg);border-left:3px solid var(--accent);padding:.15em .7em}
.pair .tr.failed{border-left-color:#dc2626}
.byline{text-align:center;color:var(--src);font-family:Georgia,"Times New Roman",serif;font-size:.95em;line-height:1.5;margin:.15em 0}
h1.doc-title{font-size:1.5em;line-height:1.35;margin:.2em 0 .6em}
.heading .src,.heading .tr{font-weight:700}
.heading .tr{font-size:1.2em;background:none;border:none;padding:0}
.heading .src{font-size:1em}
figure{margin:1.2em 0 1.6em;text-align:center}
figure img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px;background:#fff}
figure.equation{margin:.8em 0}
figure.equation img{border:none;max-height:none}
figcaption{text-align:left;font-size:.92em;margin-top:.5em}
.page-mark{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:28px 0 18px}
.page-mark::before,.page-mark::after{content:"";flex:1;border-top:1px dashed var(--line)}
/* view modes (no JavaScript needed) */
#m-tr:checked~main .pair .src{display:none}
#m-tr:checked~#t-src:checked~main .pair .src{display:block;opacity:.75}
#m-src:checked~main .pair .tr{display:none}
#m-side:checked~main{max-width:1400px}
#m-side:checked~main .pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}
#m-side:checked~main .pair .src{font-size:.95em;margin:0}
#m-side:checked~main figcaption.pair{display:grid}
.tsrc{display:none}
#m-tr:checked~.toolbar .tsrc{display:inline-block}
/* text inside figures: translated labels laid over the untouched image (no JavaScript) */
.toolbar .ftx-ctl{display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding-left:8px;border-left:1px solid var(--line);color:var(--muted)}
.ftx{position:relative;display:inline-block;max-width:100%;vertical-align:top;line-height:0;border:1px solid var(--line);border-radius:4px;background:#fff;overflow:hidden}
.ftx>img{display:block;max-width:100%;height:auto;border:none;border-radius:0}
.ftx-layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;container-type:inline-size;line-height:normal}
.ftx-t{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden;box-sizing:border-box;padding:0 .05em;line-height:1;white-space:nowrap;font-family:"Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei","WenQuanYi Micro Hei",sans-serif;font-weight:500;border-radius:1px;pointer-events:auto;cursor:help}
.ftx-t.ml{white-space:normal;line-height:1.12;overflow-wrap:anywhere}
.ftx-t:hover{opacity:0}
#f-orig:checked~main .ftx-layer,#m-src:checked~main .ftx-layer{display:none}
@media print{.toolbar{display:none}}
`;

function pct(v: number) {
  return `${(Math.max(0, v) * 100).toFixed(2)}%`;
}

function overlayHtml(r: { figureOverlays?: FigureOverlay[] }): string {
  const ov = r.figureOverlays || [];
  if (!ov.length) return "";
  const spans = ov
    .map(
      (o) =>
        `<span class="ftx-t${o.lines > 1 ? " ml" : ""}" data-src="${o.source}" title="${escapeHtml(o.src)}" style="left:${pct(o.x)};top:${pct(
          o.y,
        )};width:${pct(o.w)};height:${pct(o.h)};font-size:${o.fsPx.toFixed(1)}px;font-size:${o.fsCqw.toFixed(3)}cqw;background:${o.bg};color:${o.fg}">${escapeHtml(
          o.text,
        )}</span>`,
    )
    .join("");
  return `<div class="ftx-layer" aria-hidden="true">${spans}</div>`;
}

export function buildHtml(doc: HtmlDoc, items: TranslatedElement[]): string {
  const parts: string[] = [];
  let lastPage = 0;
  let firstHeadingDone = false;
  let hasOverlays = false;
  for (const it of items) {
    const el = it.el;
    if (el.page !== lastPage) {
      parts.push(`<div class="page-mark" id="page-${el.page}">第 ${el.page} 页 · Page ${el.page}</div>`);
      lastPage = el.page;
    }
    if (el.type === "region") {
      const r = el.region;
      if (!r.image) continue;
      const cls = r.kind === "equation" ? "equation" : r.kind;
      const w = r.pixelWidth && r.pixelHeight ? ` data-w="${r.pixelWidth}" data-h="${r.pixelHeight}"` : "";
      const style = r.kind === "equation" ? ` style="width:${Math.round(r.box.x1 - r.box.x0) * 1.333}px;max-width:100%"` : "";
      let cap = "";
      if (r.caption) {
        cap = `<figcaption class="pair"><div class="src">${textToHtml(r.caption.text)}</div><div class="tr${
          it.failed ? " failed" : ""
        }">${textToHtml(it.captionTranslation || "")}</div></figcaption>`;
      }
      const img = `<img alt="${escapeHtml(r.caption?.text.slice(0, 80) || r.kind)}"${w}${style} src="${r.image}">`;
      const layer = overlayHtml(r);
      if (layer) hasOverlays = true;
      parts.push(
        `<figure class="${cls}" data-page="${r.page}" data-kind="${r.kind}" data-box="${[r.box.x0, r.box.y0, r.box.x1, r.box.y1]
          .map((v) => v.toFixed(1))
          .join(",")}"${layer ? ` data-ftx="${r.figureOverlays!.length}"` : ""}>${
          layer ? `<div class="ftx">${img}${layer}</div>` : img
        }${cap}</figure>`,
      );
      continue;
    }
    if (el.type === "byline") {
      parts.push(`<div class="byline">${textToHtml(el.text)}</div>`);
      continue;
    }
    const tr = it.translation ?? "";
    const failedCls = it.failed ? " failed" : "";
    if (el.type === "heading") {
      const tag = !firstHeadingDone && el.page === 1 && el.block.fontSize > 0 ? "h1" : "h2";
      firstHeadingDone = true;
      parts.push(
        `<${tag} class="pair heading${tag === "h1" ? " doc-title" : ""}"><div class="src">${textToHtml(el.text)}</div><div class="tr${failedCls}">${textToHtml(tr)}</div></${tag}>`,
      );
    } else {
      parts.push(
        `<div class="pair ${el.type}"><p class="src">${textToHtml(el.text)}</p><p class="tr${failedCls}">${textToHtml(tr)}</p></div>`,
      );
    }
  }

  const s = doc.stats;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(doc.langTo || "zh-CN")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Zotero Scholar Suite · full-text translation (with figures)">
<title>${escapeHtml(doc.title)} · 全文翻译</title>
<style>${CSS}</style>
</head>
<body>
<input class="mode-radio" type="radio" name="mode" id="m-bi" checked>
<input class="mode-radio" type="radio" name="mode" id="m-side">
<input class="mode-radio" type="radio" name="mode" id="m-tr">
<input class="mode-radio" type="radio" name="mode" id="m-src">
<input class="mode-radio" type="checkbox" id="t-src">
${hasOverlays ? `<input class="mode-radio" type="radio" name="ftx" id="f-tr" checked>\n<input class="mode-radio" type="radio" name="ftx" id="f-orig">` : ""}
<div class="toolbar">
  <span class="title">${escapeHtml(doc.title)}</span>
  <label for="m-bi">中英对照</label>
  <label for="m-side">左右并排</label>
  <label for="m-tr">仅译文</label>
  <label for="m-src">仅原文</label>
  <label for="t-src" class="tsrc">显示/隐藏原文</label>
  ${hasOverlays ? `<span class="ftx-ctl" title="图片/图表内文字的译文叠层（鼠标悬停可临时查看原文）">图内文字：<label for="f-tr">显示译文</label><label for="f-orig">显示原图</label></span>` : ""}
</div>
<main>
<div class="meta">
  源文件：${escapeHtml(doc.sourceFile)}（${doc.pageCount} 页）<br>
  翻译服务：${escapeHtml(doc.serviceName)} · ${escapeHtml(doc.langFrom)} → ${escapeHtml(doc.langTo)} · 生成于 ${escapeHtml(doc.generatedAt)}<br>
  段落 ${s.paragraphs} · 图 ${s.figures} · 表 ${s.tables} · 公式 ${s.equations}${s.failed ? ` · <b style="color:#dc2626">翻译失败 ${s.failed} 段（保留原文）</b>` : ""}${
    doc.figureTextNote ? `<br>图内文字：${escapeHtml(doc.figureTextNote)}` : ""
  }${
    doc.figureFailures && doc.figureFailures.length
      ? `<details><summary>图内文字处理记录（${doc.figureFailures.length} 条，均已跳过，不影响正文）</summary><ul>${doc.figureFailures
          .slice(0, 50)
          .map((x) => `<li>${escapeHtml(x)}</li>`)
          .join("")}</ul></details>`
      : ""
  }
</div>
${parts.join("\n")}
</main>
</body>
</html>`;
}
