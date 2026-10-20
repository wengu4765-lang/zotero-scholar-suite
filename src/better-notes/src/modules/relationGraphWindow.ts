import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { slice } from "../utils/str";
import { waitUtilAsync } from "../utils/wait";
import {
  getAllNoteLinkRelations,
  updateAllNoteLinkRelations,
} from "../utils/relation";

export async function showLibraryGraph() {
  const state = addon.data.libraryGraph;
  if (
    state.window &&
    !Components.utils.isDeadWrapper(state.window) &&
    !state.window.closed
  ) {
    state.window.focus();
    await renderGraph();
    return;
  }
  const win = Services.ww.openWindow(
    // @ts-ignore
    null,
    `chrome://${config.addonRef}/content/libraryGraph.html`,
    `${config.addonRef}-libraryGraph`,
    "chrome,centerscreen,resizable,status,width=1000,height=700,dialog=no",
    {},
  ) as Window;
  state.window = win;
  await waitUtilAsync(() => win.document.readyState === "complete");
  win.document.title = getString("libraryGraph-title");

  win.addEventListener("message", async (ev: MessageEvent) => {
    const data = ev.data || {};
    switch (data.type) {
      case "openNote":
        addon.hooks.onOpenNote(data.id, data.isShift ? "window" : "tab", {
          forceTakeover: true,
        });
        break;
      case "setOptions":
        state.libraryID = data.libraryID;
        state.showUnlinked = !!data.showUnlinked;
        await renderGraph();
        break;
      case "rescan":
        await scanAndRender(true);
        break;
    }
  });

  const notifierKey = Zotero.Notifier.registerObserver(
    {
      notify: (event, type) => {
        if (
          type === "item" &&
          // @ts-ignore custom notifier event from the relation worker
          (event === "updateBNRelation" ||
            event === "delete" ||
            event === "trash")
        ) {
          scheduleRefresh();
        }
      },
    },
    ["item"],
  );
  win.addEventListener("unload", () => {
    Zotero.Notifier.unregisterObserver(notifierKey);
    if (state.window === win) {
      state.window = undefined;
    }
  });

  await scanAndRender(false);
}

function scheduleRefresh() {
  const win = addon.data.libraryGraph.window;
  if (!win || win.closed) {
    return;
  }
  if (addon.data.libraryGraph.refreshTimer) {
    win.clearTimeout(addon.data.libraryGraph.refreshTimer);
  }
  addon.data.libraryGraph.refreshTimer = win.setTimeout(() => {
    addon.data.libraryGraph.refreshTimer = undefined;
    renderGraph();
  }, 500);
}

async function scanAndRender(force: boolean) {
  const state = addon.data.libraryGraph;
  const win = state.window;
  if (!win || win.closed) {
    return;
  }
  // Scan the full library once per session, so that notes edited outside
  // Better Notes (or before the index existed) are included in the graph.
  if (force || !state.scanned) {
    try {
      await updateAllNoteLinkRelations({
        force,
        onProgress: (done, total) => {
          win.postMessage(
            {
              type: "progress",
              done,
              total,
              label: getString("libraryGraph-indexing", {
                args: { done, total },
              }),
            },
            "*",
          );
        },
      });
      state.scanned = true;
    } catch (e) {
      ztoolkit.log("libraryGraph scan failed", e);
    }
    win.postMessage({ type: "progress", done: 1, total: 1 }, "*");
  }
  await renderGraph();
}

async function renderGraph() {
  const state = addon.data.libraryGraph;
  const win = state.window;
  if (!win || win.closed) {
    return;
  }
  const data = await getGraphData(state.libraryID, state.showUnlinked);
  if (win.closed) {
    return;
  }
  win.postMessage(
    {
      type: "render",
      graph: data.graph,
      libraries: data.libraries,
      selectedLibraryID: state.libraryID,
      showUnlinked: state.showUnlinked,
      stats: getString("libraryGraph-stats", {
        args: {
          notes: data.graph.nodes.length,
          links: data.graph.links.length,
        },
      }),
      strings: {
        allLibraries: getString("libraryGraph-allLibraries"),
        showUnlinked: getString("libraryGraph-showUnlinked"),
        searchPlaceholder: getString("libraryGraph-searchPlaceholder"),
        rescan: getString("libraryGraph-rescan"),
        rescanTooltip: getString("libraryGraph-rescan-tooltip"),
        empty: getString("libraryGraph-empty"),
      },
    },
    "*",
  );
}

interface GraphNode {
  id: number;
  title: string;
  shortTitle: string;
  libID: number;
  libName: string;
  degree: number;
}

interface GraphLink {
  source: number;
  target: number;
  value: number;
  type: "out" | "both";
}

async function getGraphData(scope: number | "all", showUnlinked: boolean) {
  const allLinks = await getAllNoteLinkRelations();

  const itemCache = new Map<string, Zotero.Item | undefined>();
  const resolve = async (libID: number, key: string) => {
    const cacheKey = `${libID}/${key}`;
    if (!itemCache.has(cacheKey)) {
      let item =
        ((await Zotero.Items.getByLibraryAndKeyAsync(libID, key)) as
          | Zotero.Item
          | false) || undefined;
      if (item && (!item.isNote() || item.deleted)) {
        item = undefined;
      }
      itemCache.set(cacheKey, item);
    }
    return itemCache.get(cacheKey);
  };

  const pairs = new Map<string, GraphLink>();
  const degrees = new Map<number, number>();
  const nodeItems = new Map<number, Zotero.Item>();

  for (const link of allLinks) {
    const from = await resolve(link.fromLibID, link.fromKey);
    const to = await resolve(link.toLibID, link.toKey);
    if (!from || !to || from.id === to.id) {
      continue;
    }
    if (
      scope !== "all" &&
      (from.libraryID !== scope || to.libraryID !== scope)
    ) {
      continue;
    }
    nodeItems.set(from.id, from);
    nodeItems.set(to.id, to);
    const pairKey =
      from.id < to.id ? `${from.id}-${to.id}` : `${to.id}-${from.id}`;
    let pair = pairs.get(pairKey);
    if (!pair) {
      pair = { source: from.id, target: to.id, value: 0, type: "out" };
      pairs.set(pairKey, pair);
    }
    if (pair.source !== from.id) {
      pair.type = "both";
    }
    pair.value++;
    degrees.set(from.id, (degrees.get(from.id) || 0) + 1);
    degrees.set(to.id, (degrees.get(to.id) || 0) + 1);
  }

  if (showUnlinked) {
    for (const library of Zotero.Libraries.getAll()) {
      if (scope !== "all" && library.libraryID !== scope) {
        continue;
      }
      const search = new Zotero.Search({ libraryID: library.libraryID });
      search.addCondition("itemType", "is", "note");
      const noteIDs = await search.search();
      for (const item of await Zotero.Items.getAsync(noteIDs)) {
        if (!nodeItems.has(item.id)) {
          nodeItems.set(item.id, item);
        }
      }
    }
  }

  const items = Array.from(nodeItems.values());
  // Note titles live in the itemData data type; load them in bulk.
  await Zotero.Items.loadDataTypes(items, ["itemData"]);

  const nodes: GraphNode[] = items.map((item) => {
    const title = item.getNoteTitle();
    const library = Zotero.Libraries.get(item.libraryID);
    return {
      id: item.id,
      title,
      shortTitle: slice(title, 15),
      libID: item.libraryID,
      libName: (library && library.name) || "",
      degree: degrees.get(item.id) || 0,
    };
  });

  return {
    graph: { nodes, links: Array.from(pairs.values()) },
    libraries: Zotero.Libraries.getAll().map((library) => ({
      id: library.libraryID,
      name: library.name,
    })),
  };
}
