import { wait } from "zotero-plugin-toolkit";
import { config } from "../../package.json";
import { getAddon } from "../utils/global";
import { resetAll } from "../utils/status";

describe("MarkdownMode", function () {
  const addon = getAddon();

  this.beforeAll(async function () {
    await resetAll();
    // Diagnostics for out-of-band failures: mocha attributes uncaught
    // errors/rejections to the running test; log their origin.
    const targets = [globalThis as any, Zotero.getMainWindow() as any].filter(
      (w, i, arr) => w?.addEventListener && arr.indexOf(w) === i,
    );
    for (const w of targets) {
      w.addEventListener("unhandledrejection", (ev: any) => {
        debug(
          `UNHANDLED REJECTION: reason=${String(ev?.reason)} type=${typeof ev?.reason} stack=${String(
            ev?.reason?.stack || "",
          )
            .split("\n")
            .slice(0, 6)
            .join(" || ")}`,
        );
      });
      w.addEventListener("error", (ev: any) => {
        debug(
          `UNCAUGHT ERROR: msg=${String(ev?.message)} at=${ev?.filename}:${ev?.lineno}`,
        );
      });
    }
  });

  this.afterEach(async function () {
    // The harness JSON-serializes failures (losing Error props); print the
    // real error here where it is still intact.
    const err = (this.currentTest as any)?.err;
    if (err) {
      debug(
        `TEST ERR [${this.currentTest?.title}]: name=${err.name} msg=${err.message} str=${String(
          err,
        )} stack=${String(err.stack || "")
          .split("\n")
          .slice(0, 8)
          .join(" || ")}`,
      );
    }
    await resetAll();
  });

  async function openNoteEditor(note: Zotero.Item) {
    await Zotero.getActiveZoteroPane().selectItem(note.id);
    await wait.waitUtilAsync(
      () => !!addon.api.editor.getEditorInstance(note.id),
    );
    const editor = addon.api.editor.getEditorInstance(note.id)!;
    await editor._initPromise;
    return editor;
  }

  it("follows the default-mode and toggle-button preferences", async function () {
    this.timeout(30000);
    const defaultPref = `${config.prefsPrefix}.editor.useMarkdownByDefault`;
    const togglePref = `${config.prefsPrefix}.editor.showMarkdownToggle`;
    const note = new Zotero.Item("note");
    note.setNote(`<div data-schema-version="9"><p>Settings test</p></div>`);
    await note.saveTx();
    const note2 = new Zotero.Item("note");
    note2.setNote(`<div data-schema-version="9"><p>Second note</p></div>`);
    await note2.saveTx();

    try {
      // Start from the shipped defaults regardless of what earlier runs left
      // in the profile
      Zotero.Prefs.clear(defaultPref, true);
      Zotero.Prefs.clear(togglePref, true);
      assert.isFalse(!!Zotero.Prefs.get(togglePref, true));
      assert.isFalse(!!Zotero.Prefs.get(defaultPref, true));

      // Defaults: rich text, and no toggle button (hidden by default). The
      // button insert is async after the editor init; wait for the toolbar
      // it would attach to before asserting its absence.
      const editor = await openNoteEditor(note);
      const doc = editor._iframeWindow.document;
      await wait.waitUtilAsync(() => !!doc.querySelector(".toolbar .start"));
      assert.isFalse(addon.api.editor.isMarkdownMode(editor));
      assert.notExists(doc.querySelector(".toolbar .bn-md-toggle"));

      // Showing the toggle button applies to open editors immediately
      Zotero.Prefs.set(togglePref, true, true);
      await wait.waitUtilAsync(
        () => !!doc.querySelector(".toolbar .bn-md-toggle"),
      );
      // ...and so does hiding it again
      Zotero.Prefs.set(togglePref, false, true);
      await wait.waitUtilAsync(
        () => !doc.querySelector(".toolbar .bn-md-toggle"),
      );

      // With markdown as the default mode, a newly opened note starts in it
      Zotero.Prefs.set(defaultPref, true, true);
      const editor2 = await openNoteEditor(note2);
      await wait.waitUtilAsync(() => addon.api.editor.isMarkdownMode(editor2));
      assert.isTrue(addon.api.editor.isMarkdownMode(editor2));

      // The manual toggle still wins over the default for this editor
      await addon.api.editor.toggleMarkdownMode(editor2);
      assert.isFalse(addon.api.editor.isMarkdownMode(editor2));
    } finally {
      Zotero.Prefs.clear(defaultPref, true);
      Zotero.Prefs.clear(togglePref, true);
    }
    await Zotero.Items.erase(note.id);
    await Zotero.Items.erase(note2.id);
  });

  it("api.editor.toggleMarkdownMode round trip", async function () {
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><h1>Title</h1>\n<p>Hello <strong>world</strong></p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);

    // Enter markdown mode
    await addon.api.editor.toggleMarkdownMode(editor);
    assert.isTrue(addon.api.editor.isMarkdownMode(editor));

    const doc = editor._iframeWindow.document;
    assert.exists(doc.querySelector(".bn-md-editor"));
    assert.isTrue(doc.body.classList.contains("bn-md-mode"));

    const source = addon.api.editor.getMarkdownSource(editor)!;
    assert.include(source, "# Title");
    assert.include(source, "**world**");

    // Edit the markdown source; the debounced save converts it back into the
    // note item behind the UI.
    addon.api.editor.setMarkdownSource(
      editor,
      source.trimEnd() + "\n\nNew *markdown* line\n",
    );

    await wait.waitUtilAsync(
      () => note.getNote().includes("<em>markdown</em>"),
      100,
      10000,
    );
    assert.include(note.getNote(), "<em>markdown</em>");
    // The original content is preserved through the md->note conversion
    assert.include(note.getNote(), "<h1>Title</h1>");
    assert.include(note.getNote(), "<strong>world</strong>");

    // Exit back to rich text
    await addon.api.editor.toggleMarkdownMode(editor);
    assert.isFalse(addon.api.editor.isMarkdownMode(editor));
    assert.notExists(doc.querySelector(".bn-md-editor"));
    assert.isFalse(doc.body.classList.contains("bn-md-mode"));

    await Zotero.Items.erase(note.id);
  });

  it("highlights markdown syntax with CodeMirror", async function () {
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><h1>Heading</h1>\n<p><strong>bold</strong> and <code>code</code></p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    // The CodeMirror view is used (not the plain-textarea fallback)
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .cm-content"),
    );
    assert.notExists(doc.querySelector(".bn-md-textarea"));

    // Syntax highlighting is applied via @lezer/highlight tok-* classes
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .tok-heading"),
    );
    assert.exists(doc.querySelector(".bn-md-editor .tok-heading"));
    assert.exists(doc.querySelector(".bn-md-editor .tok-strong"));
    assert.exists(doc.querySelector(".bn-md-editor .tok-monospace"));

    // The markdown editor follows the note font-size preference (exposed by
    // the note-editor as the --font-size variable on the iframe root)
    const scroller = doc.querySelector(
      ".bn-md-editor .cm-scroller",
    ) as HTMLElement;
    let expectedSize = Zotero.Prefs.get("note.fontSize") as number;
    if (expectedSize < 6) {
      expectedSize = 11;
    }
    assert.equal(
      editor._iframeWindow.getComputedStyle(scroller).fontSize,
      `${expectedSize}px`,
    );

    // ...and mirrors the rich-text page's left/right padding
    const cmContent = doc.querySelector(
      ".bn-md-editor .cm-content",
    ) as HTMLElement;
    const primaryEditor = doc.querySelector(".primary-editor") as HTMLElement;
    const cmStyle = editor._iframeWindow.getComputedStyle(cmContent);
    const primaryStyle = editor._iframeWindow.getComputedStyle(primaryEditor);
    assert.equal(cmStyle.paddingLeft, primaryStyle.paddingLeft);
    assert.equal(cmStyle.paddingRight, primaryStyle.paddingRight);

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });

  it("renders citations, annotations, and note links as atomic chips", async function () {
    this.timeout(30000);
    const linkedNote = new Zotero.Item("note");
    linkedNote.setNote(`<div data-schema-version="9"><p>Target</p></div>`);
    await linkedNote.saveTx();

    const citation = encodeURIComponent(
      JSON.stringify({
        citationItems: [
          { uris: ["http://zotero.org/users/12345/items/ABCD2345"] },
        ],
        properties: {},
      }),
    );
    const annotation = encodeURIComponent(
      JSON.stringify({
        attachmentURI: "http://zotero.org/users/12345/items/EFGH2345",
        annotationKey: "IJKL2345",
        position: { pageIndex: 0 },
      }),
    );
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9">` +
        `<p>Cite <span class="citation" data-citation="${citation}">(<span class="citation-item">Doe, 2020</span>)</span></p>\n` +
        `<p><span class="highlight" data-annotation="${annotation}">“Quoted highlight”</span></p>\n` +
        `<p>See <a href="zotero://note/u/${linkedNote.key}/">Linked note</a></p>` +
        `</div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .bn-md-node"),
    );

    // The markdown source still contains the raw HTML...
    const source = addon.api.editor.getMarkdownSource(editor)!;
    assert.include(source, "data-citation=");
    assert.include(source, "data-annotation=");
    assert.include(source, 'ztype="znotelink"');

    // ...but the view shows one chip per node instead of the raw HTML
    const citationChip = doc.querySelector(
      ".bn-md-editor .bn-md-node-citation",
    );
    const annotationChip = doc.querySelector(
      ".bn-md-editor .bn-md-node-annotation",
    );
    const linkChip = doc.querySelector(".bn-md-editor .bn-md-node-notelink");
    assert.exists(citationChip);
    assert.exists(annotationChip);
    assert.exists(linkChip);
    assert.include(citationChip!.textContent, "Doe, 2020");
    assert.include(annotationChip!.textContent, "Quoted highlight");
    assert.include(linkChip!.textContent, "Linked note");

    const rendered = (
      doc.querySelector(".bn-md-editor .cm-content") as HTMLElement
    ).textContent!;
    assert.notInclude(rendered, "data-citation=");
    assert.notInclude(rendered, "data-annotation=");
    assert.notInclude(rendered, "znotelink");

    // Images (serialized as ![<img ztype="zimage" ...>](path)) are chips too
    addon.api.editor.setMarkdownSource(
      editor,
      source +
        `\n![<img alt="" ztype="zimage" data-attachment-key="NOKEY234" src="attachments/NOKEY234.png">](attachments/NOKEY234.png)\n`,
    );
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .bn-md-node-image"),
    );
    const imageChip = doc.querySelector(".bn-md-editor .bn-md-node-image");
    assert.exists(imageChip);
    assert.include(imageChip!.textContent, "NOKEY234.png");

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
    await Zotero.Items.erase(linkedNote.id);
  });

  it("shows an action popup with edit actions on chip click", async function () {
    this.timeout(30000);
    const pairURI = "http://zotero.org/users/12345/items/AAAA2345";
    const itemData = {
      type: "book",
      title: "Pair Book",
      author: [{ family: "Doe", given: "Jane" }],
      issued: { "date-parts": [[2021]] },
    };
    const annotation = encodeURIComponent(
      JSON.stringify({
        attachmentURI: "http://zotero.org/users/12345/items/EFGH2345",
        annotationKey: "IJKL2345",
        position: { pageIndex: 0 },
        citationItem: { uris: [pairURI], itemData },
      }),
    );
    const pairCitation = encodeURIComponent(
      JSON.stringify({
        citationItems: [{ uris: [pairURI], itemData }],
        properties: {},
      }),
    );
    const soloCitation = encodeURIComponent(
      JSON.stringify({
        citationItems: [
          {
            uris: ["http://zotero.org/users/12345/items/BBBB2345"],
            locator: "12",
          },
        ],
        properties: {},
      }),
    );
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9">` +
        `<p><span class="highlight" data-annotation="${annotation}">“Quoted text”</span> <span class="citation" data-citation="${pairCitation}">(<span class="citation-item">Doe, 2021</span>)</span></p>\n` +
        `<p>Cite <span class="citation" data-citation="${soloCitation}">(<span class="citation-item">Solo, 2020</span>)</span></p>` +
        `</div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);
    const doc = editor._iframeWindow.document;
    await wait.waitUtilAsync(
      () => doc.querySelectorAll(".bn-md-editor .bn-md-node").length >= 3,
    );

    const clickChip = async (chip: Element) => {
      chip.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await wait.waitUtilAsync(
        () => !!doc.querySelector(".bn-md-action .popup button"),
        100,
        5000,
      );
      return doc.querySelector(".bn-md-action .popup") as HTMLElement;
    };
    const popupActions = (popup: HTMLElement) =>
      Array.from(popup.querySelectorAll("button")).map(
        (button) => (button as HTMLElement).dataset.action,
      );

    // Standalone citation with a page locator: go-to-page, show, edit — no
    // remove (no annotation pair before it)
    const chips = doc.querySelectorAll(".bn-md-editor .bn-md-node-citation");
    assert.equal(chips.length, 2);
    let popup = await clickChip(chips[1]);
    assert.deepEqual(popupActions(popup), [
      "openCitationPage",
      "showItem",
      "editCitation",
    ]);

    // Escape closes the popup
    doc.body.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await wait.waitUtilAsync(() => !doc.querySelector(".bn-md-action"));

    // The citation paired with the annotation offers remove instead
    popup = await clickChip(chips[0]);
    assert.deepEqual(popupActions(popup), [
      "showItem",
      "editCitation",
      "removeCitation",
    ]);

    // Hide Citation removes the chip and the gap to the annotation
    (
      popup.querySelector('[data-action="removeCitation"]') as HTMLElement
    ).click();
    await wait.waitUtilAsync(
      () =>
        !(
          addon.api.editor.getMarkdownSource(editor)!.split("\n")[0] || ""
        ).includes("data-citation"),
    );
    let source = addon.api.editor.getMarkdownSource(editor)!;
    assert.include(source, "data-annotation");
    // ...and the gap whitespace went with it
    assert.isFalse((source.split("\n")[0] || "").endsWith(" "));

    // The annotation now offers go-to-page, unlink, and add-citation
    let annotationChip = doc.querySelector(
      ".bn-md-editor .bn-md-node-annotation",
    )!;
    popup = await clickChip(annotationChip);
    assert.deepEqual(popupActions(popup), [
      "openAnnotation",
      "unlink",
      "addCitationAfter",
    ]);

    // Add Citation inserts the pair citation after the annotation again
    (
      popup.querySelector('[data-action="addCitationAfter"]') as HTMLElement
    ).click();
    await wait.waitUtilAsync(() =>
      (
        addon.api.editor.getMarkdownSource(editor)!.split("\n")[0] || ""
      ).includes("data-citation"),
    );
    source = addon.api.editor.getMarkdownSource(editor)!;
    // The inserted data-citation carries the annotation's citation item
    assert.include(source, "Pair%20Book");

    // ...so Add Citation is no longer offered
    annotationChip = doc.querySelector(".bn-md-editor .bn-md-node-annotation")!;
    popup = await clickChip(annotationChip);
    assert.deepEqual(popupActions(popup), ["openAnnotation", "unlink"]);

    // Unlink keeps the quoted text but drops the annotation span
    (popup.querySelector('[data-action="unlink"]') as HTMLElement).click();
    await wait.waitUtilAsync(
      () =>
        !addon.api.editor
          .getMarkdownSource(editor)!
          .includes("data-annotation"),
    );
    source = addon.api.editor.getMarkdownSource(editor)!;
    assert.include(source, "“Quoted text”");
    assert.notInclude(source, "data-annotation");

    // The unlink is saved into the note
    await wait.waitUtilAsync(
      () => !note.getNote().includes("data-annotation"),
      100,
      10000,
    );
    assert.include(note.getNote(), "Quoted text");

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });

  it("keeps the cursor location across mode toggles", async function () {
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><p>Paragraph alpha</p>\n<p>Paragraph beta</p>\n<p>Paragraph gamma</p>\n<p>Paragraph delta</p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;

    // Put the rich-text cursor inside the third block, before "gamma"
    const core = win.wrappedJSObject._currentEditorInstance._editorCore;
    const EditorAPI = win.wrappedJSObject.BetterNotesEditorAPI;
    const blockStart = addon.api.editor.getPositionAtLine(editor, 2, "start");
    EditorAPI.setSelection(blockStart + 1 + "Paragraph ".length)(
      core.view.state,
      core.view.dispatch,
    );

    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const source = addon.api.editor.getMarkdownSource(editor)!;
    const cursor = mdEditor.getCursor(container);
    assert.equal(source.slice(cursor, cursor + 5), "gamma");

    // The editor API reads the note line from the markdown cursor while the
    // mode is active (the settings menu's copy-link labels rely on this)
    assert.equal(addon.api.editor.getLineAtCursor(editor), 2);

    // Move the markdown cursor into the fourth block and toggle back
    mdEditor.setCursor(container, source.indexOf("delta"));
    assert.equal(addon.api.editor.getLineAtCursor(editor), 3);
    await addon.api.editor.toggleMarkdownMode(editor);

    await wait.waitUtilAsync(
      () => addon.api.editor.getLineAtCursor(editor) === 3,
      100,
      5000,
    );
    assert.equal(addon.api.editor.getLineAtCursor(editor), 3);

    await Zotero.Items.erase(note.id);
  });

  it("keeps a range selection across mode toggles", async function () {
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><p>Paragraph alpha</p>\n<p>Paragraph beta</p>\n<p>Paragraph gamma</p>\n<p>Paragraph delta</p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;

    // Select from before "beta" (block 1) to before "gamma" (block 2)
    const core = win.wrappedJSObject._currentEditorInstance._editorCore;
    const EditorAPI = win.wrappedJSObject.BetterNotesEditorAPI;
    const anchorPos =
      addon.api.editor.getPositionAtLine(editor, 1, "start") +
      1 +
      "Paragraph ".length;
    const headPos =
      addon.api.editor.getPositionAtLine(editor, 2, "start") +
      1 +
      "Paragraph ".length;
    EditorAPI.setSelection(anchorPos, headPos)(
      core.view.state,
      core.view.dispatch,
    );

    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const source = addon.api.editor.getMarkdownSource(editor)!;
    const mdSelection = mdEditor.getSelection(container);
    assert.equal(
      source.slice(mdSelection.anchor, mdSelection.anchor + 4),
      "beta",
    );
    assert.equal(source.slice(mdSelection.head, mdSelection.head + 5), "gamma");

    // Select the word "delta" in the markdown source and toggle back
    const deltaIdx = source.indexOf("delta");
    mdEditor.setSelection(container, deltaIdx, deltaIdx + 5);
    await addon.api.editor.toggleMarkdownMode(editor);

    await wait.waitUtilAsync(
      () => {
        const range = addon.api.editor.getRangeAtCursor(editor);
        return (
          range.to > range.from &&
          addon.api.editor.getTextBetween(editor, range.from, range.to) ===
            "delta"
        );
      },
      100,
      5000,
    );
    const range = addon.api.editor.getRangeAtCursor(editor);
    assert.equal(
      addon.api.editor.getTextBetween(editor, range.from, range.to),
      "delta",
    );

    await Zotero.Items.erase(note.id);
  });

  it("keeps the undo history across mode toggles", async function () {
    this.timeout(30000);
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><h1>Undo test</h1>\n<p>Original paragraph</p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;

    await addon.api.editor.toggleMarkdownMode(editor);
    const doc = editor._iframeWindow.document;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;

    // An undoable edit in markdown mode, saved into the note
    const source = addon.api.editor.getMarkdownSource(editor)!;
    addon.api.editor.setMarkdownSource(
      editor,
      source.trimEnd() + "\n\nUndoable markdown edit\n",
    );
    await wait.waitUtilAsync(
      () => note.getNote().includes("Undoable markdown edit"),
      100,
      10000,
    );

    // Toggle out (letting the hidden editor's normalized echo re-save
    // settle, which shifts the regenerated markdown) and back in
    await addon.api.editor.toggleMarkdownMode(editor);
    assert.isFalse(addon.api.editor.isMarkdownMode(editor));
    await Zotero.Promise.delay(1500);
    await addon.api.editor.toggleMarkdownMode(editor);
    assert.isTrue(addon.api.editor.isMarkdownMode(editor));
    assert.include(
      addon.api.editor.getMarkdownSource(editor)!,
      "Undoable markdown edit",
    );

    // Undo reverts the edit made in the previous markdown-mode session
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    assert.isTrue(mdEditor.undo(container));
    await wait.waitUtilAsync(
      () =>
        !addon.api.editor
          .getMarkdownSource(editor)!
          .includes("Undoable markdown edit"),
      100,
      10000,
    );
    // ...and the undo itself is saved back into the note
    await wait.waitUtilAsync(
      () => !note.getNote().includes("Undoable markdown edit"),
      100,
      10000,
    );
    assert.include(note.getNote(), "Original paragraph");

    // The redo branch survives too
    assert.isTrue(mdEditor.redo(container));
    await wait.waitUtilAsync(
      () =>
        addon.api.editor
          .getMarkdownSource(editor)!
          .includes("Undoable markdown edit"),
      100,
      10000,
    );

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });

  it("opens the magic-key command palette in markdown mode", async function () {
    this.timeout(30000);
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><p>Alpha line</p>\n<p>Beta line</p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);
    const doc = editor._iframeWindow.document;
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .cm-content"),
    );

    // Put the markdown cursor on the "Beta line" line
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    const source = addon.api.editor.getMarkdownSource(editor)!;
    mdEditor.setCursor(container, source.indexOf("Beta"));

    // Toggle the palette with the keyboard shortcut (Mod-/)
    const content = doc.querySelector(
      ".bn-md-editor .cm-content",
    ) as HTMLElement;
    const modKey = Zotero.isMac ? { metaKey: true } : { ctrlKey: true };
    const openPalette = async () => {
      content.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "/",
          ...modKey,
          bubbles: true,
        }),
      );
      await wait.waitUtilAsync(
        () => !!doc.querySelector(".bn-md-magic .popup-item"),
        100,
        5000,
      );
    };
    await openPalette();

    // Privileged and formatting commands are both listed; openAttachment is
    // not (standalone note without a parent item)
    const ids = Array.from(
      doc.querySelectorAll(".bn-md-magic .popup-item"),
    ).map((item) => (item as HTMLElement).dataset.command);
    assert.include(ids, "insertTemplate");
    assert.include(ids, "insertCitation");
    assert.include(ids, "heading1");
    assert.include(ids, "todoList");
    assert.notInclude(ids, "openAttachment");

    // Filtering by the shortcut key selects the matching command
    const input = doc.querySelector(
      ".bn-md-magic .popup-input",
    ) as HTMLInputElement;
    input.value = "h1";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    await wait.waitUtilAsync(
      () => {
        const selected = doc.querySelector(
          ".bn-md-magic .popup-item.selected",
        ) as HTMLElement | null;
        return selected?.dataset.command === "heading1";
      },
      100,
      5000,
    );

    // Enter runs the command: the cursor's line becomes a heading
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await wait.waitUtilAsync(() =>
      addon.api.editor.getMarkdownSource(editor)!.includes("# Beta line"),
    );
    assert.notExists(doc.querySelector(".bn-md-magic"));

    // Escape closes the palette without running anything
    await openPalette();
    const input2 = doc.querySelector(
      ".bn-md-magic .popup-input",
    ) as HTMLInputElement;
    input2.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await wait.waitUtilAsync(() => !doc.querySelector(".bn-md-magic"));
    assert.include(addon.api.editor.getMarkdownSource(editor)!, "# Beta line");

    // Custom commands registered via the addon API appear and run. Their
    // handler (like copy line/section link) reads the note cursor, which
    // must reflect the markdown cursor even with unsaved edits in flight —
    // the command flushes and waits for the hidden editor before syncing.
    const commandID = "test.md.magicKeyCommand";
    let executedWith: Zotero.EditorInstance | undefined;
    let lineAtCursor = -1;
    addon.api.editor.registerMagicKeyCommand({
      id: commandID,
      title: "Test MD Magic Command",
      handler: (ed: Zotero.EditorInstance) => {
        executedWith = ed;
        lineAtCursor = addon.api.editor.getLineAtCursor(ed);
      },
    });
    try {
      // Dirty the source, then put the markdown cursor on the "Beta" block
      const source2 = addon.api.editor.getMarkdownSource(editor)!;
      addon.api.editor.setMarkdownSource(
        editor,
        source2.trimEnd() + "\n\nTail edit\n",
      );
      mdEditor.setCursor(
        container,
        addon.api.editor.getMarkdownSource(editor)!.indexOf("Beta"),
      );

      await openPalette();
      const item = doc.querySelector(
        `.bn-md-magic .popup-item[data-command="custom:${commandID}"]`,
      ) as HTMLElement;
      assert.exists(item);
      item.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await wait.waitUtilAsync(() => !!executedWith);
      assert.equal(executedWith, editor);
      assert.equal(lineAtCursor, 1, "note cursor matches the markdown cursor");
      assert.notExists(doc.querySelector(".bn-md-magic"));
    } finally {
      addon.api.editor.unregisterMagicKeyCommand(commandID);
    }

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });

  it("jumps note lines and sections to the markdown view", async function () {
    this.timeout(30000);
    const defaultPref = `${config.prefsPrefix}.editor.useMarkdownByDefault`;
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><h1>Section A</h1>\n<p>Para one</p>\n<p>Para two</p>\n<h1>Section B</h1>\n<p>Para three</p></div>`,
    );
    await note.saveTx();
    const note2 = new Zotero.Item("note");
    note2.setNote(
      `<div data-schema-version="9"><h1>Head</h1>\n<p>First</p>\n<p>Jump target</p></div>`,
    );
    await note2.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);
    const doc = editor._iframeWindow.document;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    const source = addon.api.editor.getMarkdownSource(editor)!;

    // Jump to a line (block index), as the outline pane and note links do
    await addon.api.editor.scroll(editor, 2);
    assert.equal(mdEditor.getCursor(container), source.indexOf("Para two"));

    // Jump to a section
    await addon.api.editor.scrollToSection(editor, "Section B");
    assert.equal(mdEditor.getCursor(container), source.indexOf("# Section B"));

    await addon.api.editor.toggleMarkdownMode(editor);

    // A jump racing a pending markdown mode (a note opening with the
    // markdown default) waits for the mode and lands in the markdown view
    try {
      Zotero.Prefs.set(defaultPref, true, true);
      const editor2 = await openNoteEditor(note2);
      await addon.api.editor.scroll(editor2, 2);
      assert.isTrue(addon.api.editor.isMarkdownMode(editor2));
      const win2 = editor2._iframeWindow as any;
      const doc2 = editor2._iframeWindow.document;
      const mdEditor2 = win2.wrappedJSObject.BetterNotesMarkdownEditor;
      const container2 = doc2.querySelector(".bn-md-editor") as HTMLElement;
      const source2 = addon.api.editor.getMarkdownSource(editor2)!;
      assert.equal(
        mdEditor2.getCursor(container2),
        source2.indexOf("Jump target"),
      );
      await addon.api.editor.toggleMarkdownMode(editor2);
    } finally {
      Zotero.Prefs.set(defaultPref, false, true);
    }

    await Zotero.Items.erase(note.id);
    await Zotero.Items.erase(note2.id);
  });

  it("keeps the scroll position when the note is edited in markdown mode", async function () {
    const paragraphs = Array.from(
      { length: 120 },
      (_, i) => `<p>Scroll paragraph number ${i}</p>`,
    ).join("\n");
    const note = new Zotero.Item("note");
    note.setNote(`<div data-schema-version="9">${paragraphs}</div>`);
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;

    // Let the enter-time scroll-into-view effect settle before scrolling
    await Zotero.Promise.delay(300);
    mdEditor.setScroll(container, 500);
    await wait.waitUtilAsync(() => mdEditor.getScroll(container) > 400);

    // Simulate an edit (view-preserving change + the debounced save)
    const source = addon.api.editor.getMarkdownSource(editor)!;
    mdEditor.setValue(container, source.trimEnd() + "\n\nEdited tail\n", true);
    assert.isAbove(
      mdEditor.getScroll(container),
      400,
      "scroll right after setValue",
    );
    await wait.waitUtilAsync(
      () => note.getNote().includes("Edited tail"),
      100,
      10000,
    );
    // Let the save's aftermath (hidden rich-text update + its echo save)
    // settle before checking the view was left alone
    await Zotero.Promise.delay(2000);

    assert.isTrue(addon.api.editor.isMarkdownMode(editor));
    const activeContainer = doc.querySelector(".bn-md-editor") as HTMLElement;
    assert.exists(activeContainer);
    assert.isAbove(mdEditor.getScroll(activeContainer), 400);

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });

  it("restores the markdown view state after an editor reinitialization", async function () {
    // The editor re-render that drops the overlay happens at no fixed
    // delay; give the recovery room beyond the default mocha budget.
    this.timeout(30000);
    try {
      await runReinitTest();
    } catch (e: any) {
      debug(
        `reinit test error: type=${typeof e} str=${String(e)} msg=${e?.message} stack=${String(
          e?.stack || "",
        )
          .split("\n")
          .slice(0, 5)
          .join(" || ")}`,
      );
      // Give the reporter time to relay the debug line before the abort.
      await Zotero.Promise.delay(1500);
      throw e;
    }
  });

  async function runReinitTest() {
    const step = async <T>(name: string, p: Promise<T> | T): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        debug(`reinit step failed [${name}]: ${String(e)}`);
        // Give the reporter time to relay the debug line before the abort.
        await Zotero.Promise.delay(1500);
        throw e;
      }
    };
    const paragraphs = Array.from(
      { length: 120 },
      (_, i) => `<p>Reinit paragraph number ${i}</p>`,
    ).join("\n");
    const note = new Zotero.Item("note");
    note.setNote(`<div data-schema-version="9">${paragraphs}</div>`);
    await step("saveTx", note.saveTx());

    const editor = await step("openEditor", openNoteEditor(note));
    const win = editor._iframeWindow as any;
    await step("toggleOn", addon.api.editor.toggleMarkdownMode(editor));

    const doc = editor._iframeWindow.document;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    const source = addon.api.editor.getMarkdownSource(editor)!;
    const target = source.indexOf("number 100");
    mdEditor.setCursor(container, target);
    const safeScrolled = () => {
      try {
        return mdEditor.getScroll(container) > 0;
      } catch (e) {
        return false;
      }
    };
    try {
      await wait.waitUtilAsync(safeScrolled);
    } catch (e) {
      // A large height re-measure while the fresh view warms up can swallow
      // the scroll-into-view; retry once.
      mdEditor.setCursor(container, target);
      await step("preScrollRetry", wait.waitUtilAsync(safeScrolled));
    }

    await step("reinit", (editor as any).reinit());

    // The editor may be reinitialized in place or replaced entirely, so
    // re-resolve the instance and iframe references on every poll. Stale
    // references can be dead wrappers, and content-side throws surface as
    // opaque exceptions — keep every access inside the try.
    const resolveRestored = () => {
      try {
        const inst = addon.api.editor.getEditorInstance(note.id);
        if (!inst || !addon.api.editor.isMarkdownMode(inst)) {
          return undefined;
        }
        const el = inst._iframeWindow.document.querySelector(
          ".bn-md-editor",
        ) as HTMLElement | null;
        const api = (inst._iframeWindow as any).wrappedJSObject
          ?.BetterNotesMarkdownEditor;
        if (!el || !el.isConnected || !api) {
          return undefined;
        }
        return {
          inst,
          el,
          api,
          scroll: api.getScroll(el) as number,
          cursor: api.getCursor(el) as number,
        };
      } catch (e) {
        return undefined;
      }
    };

    // Markdown mode is re-entered automatically and the position restored.
    // The note may get re-serialized by the editor between capture and
    // restore, shifting the markdown by a few characters — accept a small
    // tolerance. Keep the wait below mocha's per-test timeout so a failure
    // reports through our step diagnostics rather than a bare timeout.
    try {
      await step(
        "restoreWait",
        wait.waitUtilAsync(
          () => {
            const restored = resolveRestored();
            return (
              !!restored &&
              restored.scroll > 0 &&
              Math.abs(restored.cursor - target) <= 50
            );
          },
          200,
          20000,
        ),
      );
    } catch (e) {
      const inst = addon.api.editor.getEditorInstance(note.id);
      const restored = resolveRestored();
      debug(
        `restore dump: sameInst=${inst === editor} inst=${!!inst} winSame=${
          !!inst && (inst as any)._iframeWindow === win
        } mode=${
          inst ? addon.api.editor.isMarkdownMode(inst) : "-"
        } resolved=${!!restored} cursor=${restored?.cursor} scroll=${
          restored?.scroll
        } target=${target} viewState=${JSON.stringify(
          (addon as any).data.markdownMode.viewState.get(note.id),
        )}`,
      );
      await Zotero.Promise.delay(1500);
      throw e;
    }

    const restored = resolveRestored()!;
    assert.closeTo(restored.cursor, target, 50);
    assert.isAbove(restored.scroll, 0);

    await step("toggleOff", addon.api.editor.toggleMarkdownMode(restored.inst));
    await step("erase", Zotero.Items.erase(note.id));
  }

  it("shows a hover preview popup for note link chips", async function () {
    const linkedNote = new Zotero.Item("note");
    linkedNote.setNote(
      `<div data-schema-version="9"><p>Preview target content</p></div>`,
    );
    await linkedNote.saveTx();

    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><p>See <a href="zotero://note/u/${linkedNote.key}/">Linked note</a></p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .bn-md-node-notelink"),
    );
    const chip = doc.querySelector(
      ".bn-md-editor .bn-md-node-notelink",
    ) as HTMLElement;
    chip.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));

    await wait.waitUtilAsync(
      () =>
        !!doc
          .querySelector(".bn-md-preview .popup")
          ?.textContent?.includes("Preview target content"),
      100,
      10000,
    );
    assert.include(
      doc.querySelector(".bn-md-preview .popup")!.textContent!,
      "Preview target content",
    );

    // The popup is anchored at the chip: directly above or below it and
    // roughly centered on it
    const popupEl = doc.querySelector(".bn-md-preview .popup") as HTMLElement;
    const chipRect = chip.getBoundingClientRect();
    const popupRect = popupEl.getBoundingClientRect();
    const verticalGap = Math.min(
      Math.abs(chipRect.top - popupRect.bottom),
      Math.abs(popupRect.top - chipRect.bottom),
    );
    assert.isBelow(verticalGap, 30, "popup sits next to the chip");
    assert.isBelow(
      Math.abs(
        popupRect.left +
          popupRect.width / 2 -
          (chipRect.left + chipRect.width / 2),
      ),
      200,
      "popup is horizontally near the chip",
    );

    // Leaving the chip closes the popup
    chip.dispatchEvent(
      new win.MouseEvent("mouseout", {
        bubbles: true,
        relatedTarget: doc.body,
      }),
    );
    await wait.waitUtilAsync(() => !doc.querySelector(".bn-md-preview"));

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
    await Zotero.Items.erase(linkedNote.id);
  });

  it("sizes the hover popup to its content without wrapping", async function () {
    // An annotation with only a page label produces a tiny popup; a
    // scrollbar-induced width squeeze used to wrap "Page 1" mid-word.
    const annotation = encodeURIComponent(
      JSON.stringify({
        attachmentURI: "http://zotero.org/users/12345/items/EFGH2345",
        annotationKey: "IJKL2345",
        position: { pageIndex: 0 },
        pageLabel: "1",
      }),
    );
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><p><span class="highlight" data-annotation="${annotation}"></span>area annotation</p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);

    const doc = editor._iframeWindow.document;
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .bn-md-node-annotation"),
    );
    const chip = doc.querySelector(
      ".bn-md-editor .bn-md-node-annotation",
    ) as HTMLElement;
    chip.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));

    await wait.waitUtilAsync(
      () =>
        !!doc
          .querySelector(".bn-md-preview .popup")
          ?.textContent?.includes("Page 1"),
      100,
      10000,
    );
    const pageLine = doc.querySelector(
      ".bn-md-preview .bn-md-preview-body p",
    ) as HTMLElement;
    const lineHeight =
      parseFloat(editor._iframeWindow.getComputedStyle(pageLine).lineHeight) ||
      20;
    assert.isBelow(
      pageLine.getBoundingClientRect().height,
      lineHeight * 1.5,
      "popup text renders on a single line",
    );

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });

  it("converts pasted note content and imports its images", async function () {
    this.timeout(20000);
    // Source note owning a real embedded image attachment
    const sourceNote = new Zotero.Item("note");
    sourceNote.setNote(`<div data-schema-version="9"><p>Source</p></div>`);
    await sourceNote.saveTx();

    const mainWin = Zotero.getMainWindow() as any;
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const binary = mainWin.atob(b64);
    // Build the bytes with the main window's own typed array: a foreign
    // compartment's Uint8Array can reach the Blob constructor as empty.
    const bytes = new mainWin.Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new mainWin.Blob([bytes], { type: "image/png" });
    const attachment = await Zotero.Attachments.importEmbeddedImage({
      blob,
      parentItemID: sourceNote.id,
      saveOptions: {},
    });
    // Reference the image from the source note, like a real note would —
    // unreferenced embedded images get cleaned up by Zotero.
    sourceNote.setNote(
      `<div data-schema-version="9"><p>Source <img data-attachment-key="${attachment.key}" width="1" height="1"/></p></div>`,
    );
    await sourceNote.saveTx();

    const annotation = encodeURIComponent(
      JSON.stringify({
        attachmentURI: "http://zotero.org/users/12345/items/EFGH2345",
        annotationKey: "IJKL2345",
        position: { pageIndex: 0 },
      }),
    );

    const note = new Zotero.Item("note");
    note.setNote(`<div data-schema-version="9"><p>Target</p></div>`);
    await note.saveTx();

    const editor = await openNoteEditor(note);
    await addon.api.editor.toggleMarkdownMode(editor);
    const doc = editor._iframeWindow.document;

    // The DOM paste handler defers to this converter; synthetic clipboard
    // events are unreadable by content code (protected DataTransfer), so
    // exercise the conversion directly.
    const pastedHTML =
      `<p>Pasted <img data-attachment-key="${attachment.key}" width="1" height="1"/> with ` +
      `<img src="data:image/png;base64,${b64}"/> and ` +
      `<span class="highlight" data-annotation="${annotation}">“quote”</span></p>`;
    const md = await addon.api.editor.convertPastedHTMLToMarkdown(
      editor,
      pastedHTML,
    );

    // The images belong to this note now: the attachment-keyed one was
    // copied, the data-URI one imported — no raw data URLs in the markdown
    assert.include(md, 'ztype="zimage"');
    assert.notInclude(md, attachment.key);
    assert.notInclude(md, "data:image");
    const keys = Array.from(
      md.matchAll(
        /data-attachment-key="([^"]+)"/g,
      ) as IterableIterator<RegExpMatchArray>,
      (m) => m[1],
    );
    assert.lengthOf(keys, 2, "both images reference attachments");
    for (const key of new Set(keys)) {
      const att = Zotero.Items.getByLibraryAndKey(note.libraryID, key);
      assert.ok(att, `attachment ${key} exists`);
      assert.equal((att as Zotero.Item).parentID, note.id);
    }
    const newKey = keys[0];

    // The annotation survives with its metadata
    assert.include(md, "data-annotation=");

    // Inserted into the source, both render as chips and survive the save
    const source = addon.api.editor.getMarkdownSource(editor)!;
    addon.api.editor.setMarkdownSource(editor, source.trimEnd() + "\n\n" + md);
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .bn-md-node-annotation"),
    );
    assert.exists(doc.querySelector(".bn-md-editor .bn-md-node-image"));
    await wait.waitUtilAsync(
      () => note.getNote().includes(newKey!),
      100,
      10000,
    );

    // The files flavor (screenshot / image file paste) synthesizes
    // image-only HTML; it converts and imports standalone too
    const bareMD = await addon.api.editor.convertPastedHTMLToMarkdown(
      editor,
      `<p><img src="data:image/png;base64,${b64}"/></p>`,
    );
    assert.include(bareMD, 'ztype="zimage"');
    assert.notInclude(bareMD, "data:image");

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
    await Zotero.Items.erase(sourceNote.id);
  });

  it("provides a markdown formatting toolbar", async function () {
    const note = new Zotero.Item("note");
    note.setNote(
      `<div data-schema-version="9"><p>Format target here</p></div>`,
    );
    await note.saveTx();

    const editor = await openNoteEditor(note);
    const win = editor._iframeWindow as any;
    await addon.api.editor.toggleMarkdownMode(editor);
    const doc = editor._iframeWindow.document;

    // The markdown toolbar replaces the rich-text formatting controls,
    // mirroring the native toolbar: format dropdown, text/highlight colors,
    // clear formatting, link, citation — with the native SVG icons
    const bar = doc.querySelector(".toolbar .bn-md-toolbar") as HTMLElement;
    assert.exists(bar);
    const barButtons = bar.querySelectorAll("button.bn-md-command");
    assert.lengthOf(barButtons, 7);
    for (const button of Array.from(barButtons)) {
      assert.exists(
        (button as HTMLElement).querySelector("svg"),
        "button uses a native SVG icon",
      );
    }
    // The format menu reuses the native text-dropdown styling scope
    assert.exists(bar.querySelector(".dropdown.text-dropdown"));
    assert.lengthOf(bar.querySelectorAll(".dropdown.color-dropdown"), 2);
    assert.equal(editor._iframeWindow.getComputedStyle(bar)!.display, "flex");
    const middle = doc.querySelector(".toolbar .middle") as HTMLElement;
    if (middle) {
      assert.equal(
        editor._iframeWindow.getComputedStyle(middle)!.display,
        "none",
      );
    }

    const container = doc.querySelector(".bn-md-editor") as HTMLElement;
    const mdEditor = win.wrappedJSObject.BetterNotesMarkdownEditor;
    const source = addon.api.editor.getMarkdownSource(editor)!;

    // Bold toggles around the selection
    const start = source.indexOf("target");
    mdEditor.setSelection(container, start, start + "target".length, false);
    mdEditor.applyCommand(container, "bold");
    assert.include(addon.api.editor.getMarkdownSource(editor), "**target**");
    mdEditor.applyCommand(container, "bold");
    assert.notInclude(addon.api.editor.getMarkdownSource(editor), "**");

    // Heading level set/unset on the current line
    mdEditor.applyCommand(container, "heading2");
    assert.include(
      addon.api.editor.getMarkdownSource(editor),
      "## Format target here",
    );
    mdEditor.applyCommand(container, "paragraph");
    assert.notInclude(addon.api.editor.getMarkdownSource(editor), "## ");

    // List prefix
    mdEditor.applyCommand(container, "bulletList");
    assert.include(
      addon.api.editor.getMarkdownSource(editor),
      "- Format target here",
    );
    mdEditor.applyCommand(container, "bulletList");

    // Underline via raw HTML (markdown has no underline syntax)
    mdEditor.setSelection(container, start, start + "target".length, false);
    mdEditor.applyCommand(container, "underline");
    assert.include(addon.api.editor.getMarkdownSource(editor), "<u>target</u>");
    mdEditor.applyCommand(container, "underline");
    assert.notInclude(addon.api.editor.getMarkdownSource(editor), "<u>");

    // Text color wraps a styled span; clearFormat strips it again
    mdEditor.applyCommand(container, "textColor:#ff2020");
    assert.include(
      addon.api.editor.getMarkdownSource(editor),
      '<span style="color: #ff2020">target</span>',
    );
    mdEditor.applyCommand(container, "clearFormat");
    assert.notInclude(addon.api.editor.getMarkdownSource(editor), "<span");

    // Find/replace panel toggles
    mdEditor.applyCommand(container, "search");
    assert.exists(doc.querySelector(".bn-md-editor .cm-panel.cm-search"));
    mdEditor.applyCommand(container, "search");
    assert.notExists(doc.querySelector(".bn-md-editor .cm-panel.cm-search"));

    // Citation insertion (the picker dialog is driven by the button; the
    // insertion path renders the citation as a chip)
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Cited work");
    await item.saveTx();
    const citation = {
      citationItems: [{ uris: [Zotero.URI.getItemURI(item)] }],
      properties: {},
    };
    mdEditor.setSelection(container, 0, 0, false);
    mdEditor.insertText(
      container,
      `<span class="citation" data-citation="${encodeURIComponent(
        JSON.stringify(citation),
      )}">(Cited work)</span>`,
    );
    await wait.waitUtilAsync(
      () => !!doc.querySelector(".bn-md-editor .bn-md-node-citation"),
    );
    assert.include(
      doc.querySelector(".bn-md-editor .bn-md-node-citation")!.textContent!,
      "Cited work",
    );

    // Exiting removes the markdown toolbar
    await addon.api.editor.toggleMarkdownMode(editor);
    assert.notExists(doc.querySelector(".toolbar .bn-md-toolbar"));
    await Zotero.Items.erase(note.id);
  });

  it("markdown mode reflects external note changes when not dirty", async function () {
    const note = new Zotero.Item("note");
    note.setNote(`<div data-schema-version="9"><p>First line</p></div>`);
    await note.saveTx();

    const editor = await openNoteEditor(note);

    await addon.api.editor.toggleMarkdownMode(editor);
    assert.include(addon.api.editor.getMarkdownSource(editor), "First line");

    // Modify the note from outside the markdown editor
    note.setNote(
      `<div data-schema-version="9"><p>First line</p>\n<p>External addition</p></div>`,
    );
    await note.saveTx();

    await wait.waitUtilAsync(
      () =>
        !!addon.api.editor
          .getMarkdownSource(editor)
          ?.includes("External addition"),
      100,
      10000,
    );
    assert.include(
      addon.api.editor.getMarkdownSource(editor),
      "External addition",
    );

    await addon.api.editor.toggleMarkdownMode(editor);
    await Zotero.Items.erase(note.id);
  });
});
