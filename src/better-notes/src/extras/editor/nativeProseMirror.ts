// The note-editor bundles its own prosemirror-view; our editor script bundles a
// separate copy, so decorations built here are "foreign": the editor's
// DecorationGroup.from() does `set instanceof DecorationSet` and, on failure,
// reads `set.members` (absent on a set), leaving `undefined` in the group that
// later crashes DecorationGroup.eq — which breaks search. Fix: build decorations
// from the editor's OWN classes, recovered below from live objects.
import type { Decoration, DecorationSet } from "prosemirror-view";

export { getNativeDecorationClasses };

declare const _currentEditorInstance: { _editorCore: EditorCore };

let Decoration_: typeof Decoration | undefined;
let DecorationSet_: typeof DecorationSet | undefined;

function getNativeDecorationClasses() {
  const core = _currentEditorInstance?._editorCore;
  const search = (core as any)?.pluginState?.search;
  // The search plugin's `decorations` field is a native DecorationSet.empty.
  DecorationSet_ ||= search?.decorations?.constructor;
  // No native Decoration exists at rest, so briefly drive the search plugin's
  // updateDecorations to mint one (a Decoration.inline), then restore it.
  if (!Decoration_ && DecorationSet_ && search && core?.view) {
    const doc = core.view.state.doc;
    const saved = {
      results: search.results,
      selectedResultIndex: search.selectedResultIndex,
      decorations: search.decorations,
      view: search.view,
    };
    try {
      search.view ||= core.view;
      search.results = [{ from: 0, to: doc.content.size }];
      search.selectedResultIndex = 0;
      search.updateDecorations(doc);
      Decoration_ = search.decorations?.find?.()?.[0]?.constructor;
    } catch {
      // ignore — retry on the next call
    } finally {
      Object.assign(search, saved);
    }
  }
  return Decoration_ && DecorationSet_
    ? { Decoration: Decoration_, DecorationSet: DecorationSet_ }
    : null;
}
