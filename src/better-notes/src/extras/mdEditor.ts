/**
 * Entry of the markdown source editor bundle (implementation in ./mdEditor/):
 * self-contained CodeMirror 6, sharing no classes with the note editor.
 */
import {
  create,
  destroy,
  focus,
  getCursor,
  getScroll,
  getSelection,
  getStateJSON,
  getValue,
  redo,
  setCursor,
  setScroll,
  setSelection,
  setValue,
  undo,
} from "./mdEditor/editor";
import { applyCommand, insertText } from "./mdEditor/commands";

export const BetterNotesMarkdownEditor = {
  create,
  getValue,
  setValue,
  getStateJSON,
  undo,
  redo,
  focus,
  getCursor,
  setCursor,
  getSelection,
  setSelection,
  getScroll,
  setScroll,
  applyCommand,
  insertText,
  destroy,
};

// @ts-ignore - exposed for the privileged side (modules/editor/markdownMode.ts)
window.BetterNotesMarkdownEditor = BetterNotesMarkdownEditor;
