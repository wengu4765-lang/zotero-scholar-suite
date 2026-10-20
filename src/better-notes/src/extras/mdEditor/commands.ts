/**
 * Markdown formatting commands (used by the markdown-mode toolbar, the
 * magic-key palette, and keyboard shortcuts).
 */
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import {
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
} from "@codemirror/search";
import { views } from "./registries";
import { tryOrRetryNextTick } from "../shared/utils";

/**
 * Inline wrappers: markdown marks where the syntax exists, raw HTML tags
 * (which the note dialect round-trips) where it doesn't.
 */
const INLINE_WRAPPERS: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strikethrough: ["~~", "~~"],
  code: ["`", "`"],
  underline: ["<u>", "</u>"],
  subscript: ["<sub>", "</sub>"],
  superscript: ["<sup>", "</sup>"],
};

/** Inline HTML stripped by removeColor / clearFormat respectively. */
const COLOR_SPAN_RE = /<\/?span[^>]*>/g;
const CLEAR_FORMAT_RE = /<\/?(?:span|u|sub|sup)[^>]*>|\*\*|~~|[*_`]/g;

/** Run a named formatting command (optionally `name:argument`). */
export function applyCommand(container: HTMLElement, command: string) {
  tryOrRetryNextTick(() => {
    const view = views.get(container);
    if (!view) {
      return;
    }
    const [name, arg] = [
      command.split(":", 1)[0],
      command.includes(":")
        ? command.slice(command.indexOf(":") + 1)
        : undefined,
    ];
    if (name in INLINE_WRAPPERS) {
      const [open, close] = INLINE_WRAPPERS[name];
      toggleInlineWrap(view, open, close);
    } else if (name === "textColor" && arg) {
      applyColorSpan(view, "color", arg);
    } else if (name === "highlightColor" && arg) {
      applyColorSpan(view, "background-color", arg);
    } else if (name === "removeColor") {
      stripInline(view, COLOR_SPAN_RE);
    } else if (name === "clearFormat") {
      stripInline(view, CLEAR_FORMAT_RE);
    } else if (name.startsWith("heading")) {
      setHeading(view, Number(name.slice("heading".length)) || 0);
    } else if (name === "paragraph") {
      setHeading(view, 0);
    } else if (name === "bulletList") {
      toggleLinePrefix(view, "- ", /^([-*+])\s+/);
    } else if (name === "orderedList") {
      toggleOrderedList(view);
    } else if (name === "blockquote") {
      toggleLinePrefix(view, "> ", /^>\s?/);
    } else if (name === "taskList") {
      toggleTaskListLines(view);
    } else if (name === "codeBlock") {
      wrapCodeBlock(view);
    } else if (name === "mathBlock") {
      insertMathBlock(view);
    } else if (name === "link") {
      insertLink(view);
    } else if (name === "search") {
      if (searchPanelOpen(view.state)) {
        closeSearchPanel(view);
      } else {
        openSearchPanel(view);
      }
      // The panel manages its own focus.
      return;
    }
    view.focus();
  });
}

/** Toggle a wrapper pair around the selection (or the word at the cursor). */
function toggleInlineWrap(view: EditorView, open: string, close: string) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  // Selection includes the wrappers: unwrap
  if (
    selected.length >= open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close)
  ) {
    view.dispatch({
      changes: {
        from,
        to,
        insert: selected.slice(open.length, selected.length - close.length),
      },
      selection: EditorSelection.range(from, to - open.length - close.length),
    });
    return;
  }
  // Wrappers surround the selection: unwrap
  if (
    from >= open.length &&
    state.sliceDoc(from - open.length, from) === open &&
    state.sliceDoc(to, to + close.length) === close
  ) {
    view.dispatch({
      changes: [
        { from: from - open.length, to: from, insert: "" },
        { from: to, to: to + close.length, insert: "" },
      ],
      selection: EditorSelection.range(from - open.length, to - open.length),
    });
    return;
  }
  // Wrap the selection, or the word at the cursor
  let start = from;
  let end = to;
  if (start === end) {
    const word = state.wordAt(start);
    if (word) {
      start = word.from;
      end = word.to;
    }
  }
  view.dispatch({
    changes: [
      { from: start, insert: open },
      { from: end, insert: close },
    ],
    selection:
      start === end
        ? EditorSelection.cursor(start + open.length)
        : EditorSelection.range(start + open.length, end + open.length),
  });
}

/** Expand an empty selection to the word at the cursor. */
function selectionOrWord(view: EditorView) {
  const { from, to } = view.state.selection.main;
  if (from !== to) {
    return { from, to };
  }
  const word = view.state.wordAt(from);
  return word ? { from: word.from, to: word.to } : { from, to };
}

/** Color the selection with an inline span (replacing previous colors). */
function applyColorSpan(view: EditorView, property: string, value: string) {
  const { from, to } = selectionOrWord(view);
  if (from === to) {
    return;
  }
  const text = view.state.sliceDoc(from, to).replace(COLOR_SPAN_RE, "");
  const wrapped = `<span style="${property}: ${value}">${text}</span>`;
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: EditorSelection.range(from, from + wrapped.length),
  });
}

/** Remove inline formatting matched by `pattern` from the selection. */
function stripInline(view: EditorView, pattern: RegExp) {
  const { from, to } = selectionOrWord(view);
  if (from === to) {
    return;
  }
  const text = view.state.sliceDoc(from, to);
  const cleaned = text.replace(pattern, "");
  if (cleaned === text) {
    return;
  }
  view.dispatch({
    changes: { from, to, insert: cleaned },
    selection: EditorSelection.range(from, from + cleaned.length),
  });
}

/** Set (or toggle off) the heading level of the selected lines. */
function setHeading(view: EditorView, level: number) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const headingRe = /^#{1,6}\s+/;

  let allAtLevel = level > 0;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) {
      continue;
    }
    const current = headingRe.exec(line.text)?.[0].trim().length || 0;
    if (current !== level) {
      allAtLevel = false;
      break;
    }
  }
  const prefix = level && !allAtLevel ? "#".repeat(level) + " " : "";

  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) {
      continue;
    }
    const existing = headingRe.exec(line.text)?.[0] || "";
    changes.push({
      from: line.from,
      to: line.from + existing.length,
      insert: prefix,
    });
  }
  if (changes.length) {
    view.dispatch({ changes });
  }
}

/** Toggle a line prefix (list marker, quote mark) on the selected lines. */
function toggleLinePrefix(view: EditorView, prefix: string, detect: RegExp) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;

  let allPrefixed = true;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() && !detect.test(line.text)) {
      allPrefixed = false;
      break;
    }
  }

  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) {
      continue;
    }
    const existing = detect.exec(line.text)?.[0];
    if (allPrefixed) {
      if (existing) {
        changes.push({ from: line.from, to: line.from + existing.length });
      }
    } else if (!existing) {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  if (changes.length) {
    view.dispatch({ changes });
  }
}

/** Toggle a sequentially numbered list on the selected lines. */
function toggleOrderedList(view: EditorView) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const detect = /^\d+[.)]\s+/;

  let allPrefixed = true;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() && !detect.test(line.text)) {
      allPrefixed = false;
      break;
    }
  }

  const changes = [];
  let index = 1;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) {
      continue;
    }
    const existing = detect.exec(line.text)?.[0];
    if (allPrefixed) {
      if (existing) {
        changes.push({ from: line.from, to: line.from + existing.length });
      }
    } else {
      changes.push({
        from: line.from,
        to: line.from + (existing?.length || 0),
        insert: `${index}. `,
      });
    }
    index += 1;
  }
  if (changes.length) {
    view.dispatch({ changes });
  }
}

/**
 * Toggle GFM task markers on the selected lines; plain bullets keep their
 * bullet and gain the checkbox.
 */
function toggleTaskListLines(view: EditorView) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const taskRe = /^([-*+])\s+\[[ xX]\]\s?/;
  const bulletRe = /^([-*+])\s+/;

  let allTasks = true;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() && !taskRe.test(line.text)) {
      allTasks = false;
      break;
    }
  }

  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) {
      continue;
    }
    const task = taskRe.exec(line.text)?.[0];
    if (allTasks) {
      if (task) {
        changes.push({ from: line.from, to: line.from + task.length });
      }
    } else if (!task) {
      const bullet = bulletRe.exec(line.text)?.[0];
      changes.push({
        from: line.from,
        to: line.from + (bullet?.length || 0),
        insert: `${bullet?.trimEnd() || "-"} [ ] `,
      });
    }
  }
  if (changes.length) {
    view.dispatch({ changes });
  }
}

/** Wrap the selected lines in a fenced code block (or unwrap them). */
function wrapCodeBlock(view: EditorView) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const firstLine = state.doc.lineAt(from);
  const lastLine = state.doc.lineAt(to);

  // Unwrap when the block is already fenced.
  const lineBefore =
    firstLine.number > 1 ? state.doc.line(firstLine.number - 1) : null;
  const lineAfter =
    lastLine.number < state.doc.lines
      ? state.doc.line(lastLine.number + 1)
      : null;
  if (
    lineBefore &&
    lineAfter &&
    /^```/.test(lineBefore.text) &&
    /^```\s*$/.test(lineAfter.text)
  ) {
    view.dispatch({
      changes: [
        { from: lineBefore.from, to: firstLine.from },
        { from: lastLine.to, to: lineAfter.to },
      ],
    });
    return;
  }

  view.dispatch({
    changes: [
      { from: firstLine.from, insert: "```\n" },
      { from: lastLine.to, insert: "\n```" },
    ],
    selection: EditorSelection.cursor(firstLine.from + 4),
    scrollIntoView: true,
  });
}

/** Insert a `$$` math block on its own lines, cursor inside. */
function insertMathBlock(view: EditorView) {
  const state = view.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const from = line.text.trim() ? line.to : line.from;
  const prefix = line.text.trim() ? "\n\n" : "";
  view.dispatch({
    changes: { from, to: from, insert: `${prefix}$$\n\n$$\n` },
    selection: EditorSelection.cursor(from + prefix.length + 3),
    scrollIntoView: true,
  });
}

/** Insert text at the selection (e.g. a citation span from the picker). */
export function insertText(container: HTMLElement, text: string) {
  tryOrRetryNextTick(() => {
    const view = views.get(container);
    if (!view || typeof text !== "string" || !text) {
      return;
    }
    view.dispatch({
      ...view.state.replaceSelection(text),
      scrollIntoView: true,
    });
    view.focus();
  });
}

/** Wrap the selection as a markdown link, placing the cursor in the URL. */
function insertLink(view: EditorView) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const text = state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `[${text}]()` },
    selection: EditorSelection.cursor(text ? from + text.length + 3 : from + 1),
  });
}

/** Insert a markdown table skeleton, prompting for its size (rows,cols). */
export function insertTableSkeleton(container: HTMLElement) {
  const input = prompt(
    "Enter the number of rows and columns, separated by a comma (e.g., 3,3)",
  );
  if (!input) {
    return;
  }
  const splitter = input.includes("x") ? "x" : input.includes(",") ? "," : " ";
  const [rows, cols] = input.split(splitter).map((n) => parseInt(n, 10));
  if (isNaN(rows) || isNaN(cols) || rows < 1 || cols < 1) {
    return;
  }
  const row = `|${"   |".repeat(cols)}`;
  const lines = [
    row,
    `|${" --- |".repeat(cols)}`,
    ...Array.from({ length: Math.max(0, rows - 1) }, () => row),
  ];
  tryOrRetryNextTick(() => {
    const view = views.get(container);
    if (!view) {
      return;
    }
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    // Insert as its own block: after the current line when it has content.
    const from = line.text.trim() ? line.to : line.from;
    const prefix = line.text.trim() ? "\n\n" : "";
    view.dispatch({
      changes: { from, to: from, insert: `${prefix}${lines.join("\n")}\n` },
      selection: EditorSelection.cursor(from + prefix.length + 2),
      scrollIntoView: true,
    });
    view.focus();
  });
}
