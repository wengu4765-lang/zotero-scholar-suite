import { getAddon } from "../utils/global";
import { resetAll } from "../utils/status";

/**
 * Tests for the full-library note relation graph:
 * - `updateAllNoteLinkRelations` scans every note in the library and indexes
 *   the note links, skipping notes whose index is already up to date.
 * - `getAllNoteLinkRelations` returns the complete link table.
 * - The library graph window renders the notes and their (aggregated,
 *   directed) links, and reacts to option changes.
 */
describe("Full-library note relation graph", function () {
  const addon = getAddon();
  this.timeout(60000);

  this.beforeAll(async function () {
    await resetAll();
  });

  this.afterEach(async function () {
    const win = addon.data.libraryGraph.window;
    if (win && !win.closed) {
      win.close();
    }
    await resetAll();
  });

  async function createNote(innerHTML = "") {
    const note = new Zotero.Item("note");
    note.setNote(`<div data-schema-version="9">${innerHTML}</div>`);
    await note.saveTx();
    return note;
  }

  function linkHTML(target: Zotero.Item) {
    return `<p><a href="zotero://note/u/${target.key}/">link</a></p>`;
  }

  /** Poll until `condition` is truthy or `timeout` ms elapse. */
  async function waitUntil(condition: () => boolean, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (condition()) return true;
      await Zotero.Promise.delay(100);
    }
    return false;
  }

  /** Create A -> B, A -> C, B -> A. */
  async function createLinkedNotes() {
    const noteB = await createNote("<p>B</p>");
    const noteC = await createNote("<p>C</p>");
    const noteA = await createNote(
      `<p>A</p>${linkHTML(noteB)}${linkHTML(noteC)}`,
    );
    noteB.setNote(
      `<div data-schema-version="9"><p>B</p>${linkHTML(noteA)}</div>`,
    );
    await noteB.saveTx();
    return { noteA, noteB, noteC };
  }

  it("indexes the full library and returns all note link relations", async function () {
    const { noteA, noteB, noteC } = await createLinkedNotes();

    const first = await addon.api.relation.updateAllNoteLinkRelations();
    expect(first.scanned, "all new notes are scanned").to.be.at.least(3);

    const links = await addon.api.relation.getAllNoteLinkRelations();
    const has = (from: Zotero.Item, to: Zotero.Item) =>
      links.some(
        (link) =>
          link.fromLibID === from.libraryID &&
          link.fromKey === from.key &&
          link.toLibID === to.libraryID &&
          link.toKey === to.key,
      );
    expect(has(noteA, noteB), "A -> B is indexed").to.be.true;
    expect(has(noteA, noteC), "A -> C is indexed").to.be.true;
    expect(has(noteB, noteA), "B -> A is indexed").to.be.true;

    // A second scan skips notes whose index is already up to date.
    const second = await addon.api.relation.updateAllNoteLinkRelations();
    expect(second.scanned, "unchanged notes are skipped").to.equal(0);
  });

  it("opens the library graph window and renders nodes and links", async function () {
    await createLinkedNotes();
    await createNote("<p>Unlinked</p>");

    await addon.hooks.onShowLibraryGraph();
    const win = addon.data.libraryGraph.window;
    expect(win, "graph window is opened").to.exist;

    // Scope to the user library so group libraries cannot interfere.
    win!.postMessage(
      {
        type: "setOptions",
        libraryID: Zotero.Libraries.userLibraryID,
        showUnlinked: false,
      },
      "*",
    );

    const rendered = await waitUntil(
      () => win!.document.querySelectorAll(".node").length === 3,
    );
    expect(rendered, "the 3 linked notes are rendered as nodes").to.be.true;

    const lines = win!.document.querySelectorAll("svg line");
    expect(lines.length, "links are aggregated per note pair").to.equal(2);
    const bidirectional = Array.from(lines).filter((line) =>
      line.getAttribute("marker-start"),
    );
    expect(
      bidirectional.length,
      "A <-> B is rendered as one bidirectional link",
    ).to.equal(1);

    // Unlinked notes appear when the option is enabled.
    win!.postMessage(
      {
        type: "setOptions",
        libraryID: Zotero.Libraries.userLibraryID,
        showUnlinked: true,
      },
      "*",
    );
    const withUnlinked = await waitUntil(
      () => win!.document.querySelectorAll(".node").length === 4,
    );
    expect(withUnlinked, "the unlinked note appears as a node").to.be.true;
  });

  it("styles the <select> dropdown via the toolkit ContentSelectDropdown", async function () {
    await addon.hooks.onShowLibraryGraph();
    const win = addon.data.libraryGraph.window!;

    const ready = await waitUntil(
      () => win.document.querySelectorAll("#library-select option").length > 0,
    );
    expect(ready, "library select is populated").to.be.true;

    // Request the dropdown the same way a user click does: Gecko fires
    // mozshowdropdown on the <select>, the toolkit Select actor handles it
    // and injects menulist#ContentSelectDropdown into this chrome window's
    // document.
    const select = win.document.getElementById(
      "library-select",
    ) as HTMLSelectElement;
    // The native event bubbles (CanBubble::eYes); the Select actor's
    // listener sits at the window level, so ours must bubble too.
    select.dispatchEvent(
      new (win as any).Event("mozshowdropdown", { bubbles: true }),
    );

    const getPopup = () =>
      win.document.querySelector(
        "#ContentSelectDropdown > menupopup",
      ) as XULPopupElement | null;
    const injected = await waitUntil(() => !!getPopup());
    expect(injected, "ContentSelectDropdown menupopup is injected").to.be.true;

    // menu.css (imported via global.css -> widgets.css) defines
    // --menuitem-padding on menupopup. Without the toolkit skin loaded in
    // this window the property computes to the empty string and the
    // dropdown renders unstyled.
    const popup = getPopup()!;
    const padding = win
      .getComputedStyle(popup)
      .getPropertyValue("--menuitem-padding")
      .trim();
    expect(padding, "toolkit menu styles apply to the dropdown").to.not.equal(
      "",
    );

    popup.hidePopup();
  });
});
