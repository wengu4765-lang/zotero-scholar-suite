/**
 * Zotero node chips: citation/annotation/note-link/image HTML runs render
 * as atomic chips (the underlying source text is unchanged).
 */
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { ZNodeKind } from "./types";

const Z_NODE_LABELS: Record<ZNodeKind, string> = {
  citation: "Citation",
  annotation: "Annotation",
  notelink: "Note link",
  image: "Image",
};

const Z_NODE_OPEN_RE =
  /<(span|a)\s[^>]*(?:data-citation=|data-annotation=|ztype="znotelink"|class="[^"]*internal-link[^"]*")[^>]*>/g;

/**
 * Images travel as `![<img ... ztype="zimage" ...>](path)`, with the note
 * metadata serialized into the alt text.
 */
const Z_IMAGE_RE = /!\[[^\]\n]*ztype="zimage"[^\]\n]*\]\([^)\n]*\)/g;

/** Chip element -> its source info, for the hover and action popups. */
export const chipData = new WeakMap<
  HTMLElement,
  { kind: ZNodeKind; raw: string }
>();

/** One atomic chip; kind and raw source ride along for the popups. */
export class ZNodeWidget extends WidgetType {
  constructor(
    readonly kind: ZNodeKind,
    readonly raw: string,
    readonly label: string,
  ) {
    super();
  }

  eq(other: ZNodeWidget) {
    return other.kind === this.kind && other.raw === this.raw;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = `bn-md-node bn-md-node-${this.kind}`;
    span.textContent = this.label;
    span.title = Z_NODE_LABELS[this.kind];
    chipData.set(span, { kind: this.kind, raw: this.raw });
    return span;
  }
}

/** End offset (exclusive) of the tag run opened at `openEnd`, or -1. */
function findTagClose(text: string, tag: string, openEnd: number): number {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(text))) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (!depth) {
      return m.index + m[0].length;
    }
  }
  return -1;
}

/** Human-readable chip label extracted from the node's raw source. */
function zNodeLabel(raw: string, kind: ZNodeKind): string {
  let s = raw;
  if (kind === "image") {
    // Label an image by its file name.
    const src = /\]\(([^)\n]*)\)$/.exec(raw)?.[1] || "";
    s = decodeURIComponent(src.split("/").pop() || "");
  }
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) {
    s = Z_NODE_LABELS[kind];
  }
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

/** Whether the position sits in markdown code, where chips stay raw. */
function isInCode(state: EditorState, pos: number): boolean {
  for (
    let node: any = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (/Code/.test(node.name)) {
      return true;
    }
  }
  return false;
}

/** Scan the doc and replace every Zotero node run with a chip widget. */
function buildZNodeDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const matches: { from: number; to: number; kind: ZNodeKind }[] = [];

  Z_NODE_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = Z_NODE_OPEN_RE.exec(text))) {
    const open = m[0];
    const from = m.index;
    const to = findTagClose(text, m[1], from + open.length);
    if (to < 0) {
      continue;
    }
    const kind: ZNodeKind = open.includes("data-citation=")
      ? "citation"
      : open.includes("data-annotation=")
        ? "annotation"
        : "notelink";
    matches.push({ from, to, kind });
    Z_NODE_OPEN_RE.lastIndex = to;
  }

  Z_IMAGE_RE.lastIndex = 0;
  while ((m = Z_IMAGE_RE.exec(text))) {
    matches.push({ from: m.index, to: m.index + m[0].length, kind: "image" });
  }

  matches.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  let lastEnd = -1;
  for (const match of matches) {
    if (match.from < lastEnd || isInCode(state, match.from)) {
      continue;
    }
    lastEnd = match.to;
    const raw = text.slice(match.from, match.to);
    builder.add(
      match.from,
      match.to,
      Decoration.replace({
        widget: new ZNodeWidget(match.kind, raw, zNodeLabel(raw, match.kind)),
      }),
    );
  }
  return builder.finish();
}

/** The chip decoration field, rebuilt on every document change. */
export const zNodeField = StateField.define<DecorationSet>({
  create: buildZNodeDecorations,
  update(value, tr) {
    return tr.docChanged ? buildZNodeDecorations(tr.state) : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Atomic: cursor motion skips over a chip and deletion removes it whole.
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
});
