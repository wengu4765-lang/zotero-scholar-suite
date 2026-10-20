import { MessageHelper } from "zotero-plugin-toolkit";
import { config } from "../../package.json";
import { getNoteLinkParams } from "./link";
import type { handlers } from "../extras/relationWorker";

function closeRelationServer() {
  if (addon.data.relation.server) {
    addon.data.relation.server.destroy();
    addon.data.relation.server = undefined;
  }
}

async function getRelationServer(): Promise<MessageHelper<typeof handlers>> {
  if (!addon.data.relation.server) {
    const worker = new Worker(
      `chrome://${config.addonRef}/content/scripts/relationWorker.js`,
      { name: "relationWorker" },
    );
    const server = new MessageHelper<typeof handlers>({
      canBeDestroyed: false,
      dev: __env__ === "development",
      name: "relationWorkerMain",
      target: worker,
      handlers: {},
    });
    server.start();
    await server.exec("_ping");
    addon.data.relation.server = server;
  }

  return addon.data.relation.server!;
}

export { getRelationServer, closeRelationServer };

export {
  updateNoteLinkRelation,
  updateAllNoteLinkRelations,
  getNoteLinkInboundRelation,
  getNoteLinkOutboundRelation,
  getAllNoteLinkRelations,
  removeNoteLinkIndex,
  linkAnnotationToTarget,
  getLinkTargetByAnnotation,
  getAnnotationByLinkTarget,
};

async function updateNoteLinkRelation(noteID: number) {
  ztoolkit.log("updateNoteLinkRelation", noteID);
  const note = Zotero.Items.get(noteID);
  if (!note?.isNote()) {
    return;
  }
  const affectedNoteIDs = await rebuildNoteLinkRelation(note);
  Zotero.Notifier.trigger(
    // @ts-ignore
    "updateBNRelation",
    "item",
    Array.from(affectedNoteIDs),
    {},
    true,
  );
}

async function rebuildNoteLinkRelation(note: Zotero.Item) {
  const affectedNoteIDs = new Set([note.id]);
  const fromLibID = note.libraryID;
  const fromKey = note.key;
  const lines = await addon.api.note.getLinesInNote(note);
  const linkToData: LinkModel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const linkMatches = lines[i].match(/href="zotero:\/\/note\/[^"]+"/g);
    if (!linkMatches) {
      continue;
    }
    for (const match of linkMatches) {
      const link = decodeHTMLEntities(match.slice(6, -1));
      const { noteItem, libraryID, noteKey, lineIndex, sectionName } =
        getNoteLinkParams(link);
      if (noteItem && noteItem.isNote() && noteItem.id !== note.id) {
        affectedNoteIDs.add(noteItem.id);
        linkToData.push({
          fromLibID,
          fromKey,
          toLibID: libraryID,
          toKey: noteKey!,
          fromLine: i,
          toLine: lineIndex ?? null,
          toSection: sectionName ?? null,
          url: link,
        });
      }
    }
  }
  const result = await (
    await getRelationServer()
  ).proxy.rebuildLinkForNote(fromLibID, fromKey, linkToData, note.dateModified);

  for (const link of result.oldOutboundLinks as LinkModel[]) {
    const item = Zotero.Items.getByLibraryAndKey(link.toLibID, link.toKey);
    if (!item) {
      continue;
    }
    affectedNoteIDs.add(item.id);
  }
  return affectedNoteIDs;
}

/**
 * Scan notes and rebuild their link relations, so that the full-library
 * relation data is complete. Notes whose dateModified matches the last
 * indexed version are skipped unless `force` is set.
 */
async function updateAllNoteLinkRelations(
  options: {
    force?: boolean;
    onProgress?: (done: number, total: number) => void;
  } = {},
) {
  const server = await getRelationServer();
  const indexMap = new Map<string, string>();
  if (!options.force) {
    for (const entry of await server.proxy.getNoteIndexVersions()) {
      indexMap.set(`${entry.libID}/${entry.key}`, entry.version);
    }
  }

  const notes: Zotero.Item[] = [];
  for (const library of Zotero.Libraries.getAll()) {
    const search = new Zotero.Search({ libraryID: library.libraryID });
    search.addCondition("itemType", "is", "note");
    const noteIDs = await search.search();
    notes.push(...(await Zotero.Items.getAsync(noteIDs)));
  }

  const toScan = notes.filter(
    (note) =>
      indexMap.get(`${note.libraryID}/${note.key}`) !== note.dateModified,
  );

  const affectedNoteIDs = new Set<number>();
  let done = 0;
  options.onProgress?.(done, toScan.length);
  for (const note of toScan) {
    try {
      await note.loadDataType("note");
      for (const id of await rebuildNoteLinkRelation(note)) {
        affectedNoteIDs.add(id);
      }
    } catch (e) {
      ztoolkit.log("updateAllNoteLinkRelations failed for note", note.id, e);
    }
    done++;
    options.onProgress?.(done, toScan.length);
  }
  if (affectedNoteIDs.size) {
    Zotero.Notifier.trigger(
      // @ts-ignore
      "updateBNRelation",
      "item",
      Array.from(affectedNoteIDs),
      {},
      true,
    );
  }
  return { scanned: toScan.length, total: notes.length };
}

async function getNoteLinkOutboundRelation(
  noteID: number,
): Promise<LinkModel[]> {
  const note = Zotero.Items.get(noteID);
  const fromLibID = note.libraryID;
  const fromKey = note.key;
  return await (
    await getRelationServer()
  ).proxy.getOutboundLinks(fromLibID, fromKey);
}

async function getNoteLinkInboundRelation(
  noteID: number,
): Promise<LinkModel[]> {
  const note = Zotero.Items.get(noteID);
  const toLibID = note.libraryID;
  const toKey = note.key;
  return await (
    await getRelationServer()
  ).proxy.getInboundLinks(toLibID, toKey);
}

async function getAllNoteLinkRelations(): Promise<LinkModel[]> {
  return await (await getRelationServer()).proxy.getAllLinks();
}

async function removeNoteLinkIndex(libID: number, key: string) {
  await (await getRelationServer()).proxy.deleteNoteIndex(libID, key);
}

function decodeHTMLEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

interface LinkModel {
  fromLibID: number;
  fromKey: string;
  toLibID: number;
  toKey: string;
  fromLine: number;
  toLine: number | null;
  toSection: string | null;
  url: string;
}

async function linkAnnotationToTarget(model: AnnotationModel) {
  return await (await getRelationServer()).proxy.linkAnnotationToTarget(model);
}

async function getLinkTargetByAnnotation(
  fromLibID: number,
  fromKey: string,
): Promise<AnnotationModel | undefined> {
  return await (
    await getRelationServer()
  ).proxy.getLinkTargetByAnnotation(fromLibID, fromKey);
}

async function getAnnotationByLinkTarget(
  toLibID: number,
  toKey: string,
): Promise<AnnotationModel | undefined> {
  return await (
    await getRelationServer()
  ).proxy.getAnnotationByLinkTarget(toLibID, toKey);
}

interface AnnotationModel {
  fromLibID: number;
  fromKey: string;
  toLibID: number;
  toKey: string;
  url: string;
}
