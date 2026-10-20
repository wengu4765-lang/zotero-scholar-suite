import Dexie from "dexie";
import { MessageHelper } from "zotero-plugin-toolkit";

export { handlers };

const db = new Dexie("BN_Two_Way_Relation") as Dexie & {
  link: Dexie.Table<LinkModel>;
  annotation: Dexie.Table<AnnotationModel>;
  noteIndex: Dexie.Table<NoteIndexModel>;
};

db.version(2).stores({
  link: "++id, fromLibID, fromKey, toLibID, toKey, fromLine, toLine, toSection, url",
  annotation: "++id, fromLibID, fromKey, toLibID, toKey, url",
});

// noteIndex tracks the last-indexed version (dateModified) of each note,
// so that full-library scans can skip unchanged notes.
db.version(3).stores({
  link: "++id, fromLibID, fromKey, toLibID, toKey, fromLine, toLine, toSection, url",
  annotation: "++id, fromLibID, fromKey, toLibID, toKey, url",
  noteIndex: "++id, [libID+key]",
});

log("Using Dexie v" + Dexie.semVer, db);

const handlers = {
  addLink,
  bulkAddLink,
  rebuildLinkForNote,
  getOutboundLinks,
  getInboundLinks,
  getAllLinks,
  getNoteIndexVersions,
  deleteNoteIndex,
  linkAnnotationToTarget,
  getLinkTargetByAnnotation,
  getAnnotationByLinkTarget,
};

const messageServer = new MessageHelper({
  canBeDestroyed: true,
  dev: true,
  name: "parsingWorker",
  target: self,
  handlers,
});

messageServer.start();

async function addLink(model: LinkModel) {
  await db.link.add(model);
  log("addLink", model);
}

async function bulkAddLink(models: LinkModel[]) {
  await db.link.bulkAdd(models);
  log("bulkAddLink", models);
}

async function rebuildLinkForNote(
  fromLibID: number,
  fromKey: string,
  links: LinkModel[],
  version?: string,
) {
  log("rebuildLinkForNote", fromLibID, fromKey, links, version);

  return db.transaction("rw", db.link, db.noteIndex, async () => {
    const collection = db.link.where({ fromLibID, fromKey });
    const oldOutboundLinks = await collection.toArray();
    await collection.delete().then((deleteCount) => {
      log("Deleted " + deleteCount + " objects");
      return bulkAddLink(links);
    });
    if (typeof version !== "undefined") {
      await db.noteIndex.where({ libID: fromLibID, key: fromKey }).delete();
      await db.noteIndex.add({ libID: fromLibID, key: fromKey, version });
    }
    return {
      oldOutboundLinks,
    };
  });
}

async function getOutboundLinks(fromLibID: number, fromKey: string) {
  log("getOutboundLinks", fromLibID, fromKey);
  return db.link.where({ fromLibID, fromKey }).toArray();
}

async function getInboundLinks(toLibID: number, toKey: string) {
  log("getInboundLinks", toLibID, toKey);
  return db.link.where({ toLibID, toKey }).toArray();
}

async function getAllLinks() {
  log("getAllLinks");
  return db.link.toArray();
}

async function getNoteIndexVersions() {
  log("getNoteIndexVersions");
  return db.noteIndex.toArray();
}

async function deleteNoteIndex(libID: number, key: string) {
  log("deleteNoteIndex", libID, key);
  await db.transaction("rw", db.link, db.noteIndex, async () => {
    await db.link.where({ fromLibID: libID, fromKey: key }).delete();
    await db.noteIndex.where({ libID, key }).delete();
  });
}

async function linkAnnotationToTarget(model: AnnotationModel) {
  log("linkAnnotationToTarget", model);
  const collection = db.annotation.where({
    fromLibID: model.fromLibID,
    fromKey: model.fromKey,
  });
  await collection.delete().then(() => {
    return db.annotation.add(model);
  });
}

async function getLinkTargetByAnnotation(fromLibID: number, fromKey: string) {
  log("getLinkTargetByAnnotation", fromLibID, fromKey);
  return db.annotation.get({ fromLibID, fromKey });
}

async function getAnnotationByLinkTarget(toLibID: number, toKey: string) {
  log("getAnnotationByLinkTarget", toLibID, toKey);
  return db.annotation.get({ toLibID, toKey });
}

function log(...args: any[]) {
  if (__env__ === "development") console.log("[relationWorker]", ...args);
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

interface AnnotationModel {
  fromLibID: number;
  fromKey: string;
  toLibID: number;
  toKey: string;
  url: string;
}

interface NoteIndexModel {
  libID: number;
  key: string;
  version: string;
}
