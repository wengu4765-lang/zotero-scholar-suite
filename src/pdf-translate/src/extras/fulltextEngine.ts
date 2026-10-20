/**
 * Zotero Scholar Suite — full-text engine entry for the hidden engine page
 * (chrome://zoteropdftranslate/content/fulltextEngine.html).
 * Exposes window.ScholarFulltext; pdf.js is Zotero's own bundled copy.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { runFullText, EngineCallbacks, EngineMeta, EngineOptions } from "../modules/scholar/fulltext/engine";

declare const IOUtils: any;

let pdfjsLib: any = null;
let docParams: Record<string, any> = {};
let readyResolve: (v: any) => void;
const ready = new Promise((r) => (readyResolve = r));

function createCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", { willReadFrequently: true } as any)!;
  return {
    canvas,
    context,
    toDataURL: (type: string, q?: number) => canvas.toDataURL(type, q),
    dispose: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

(window as any).ScholarFulltext = {
  ready,
  setPdfjs(lib: any, params: Record<string, any>) {
    pdfjsLib = lib;
    if (params.workerSrc) lib.GlobalWorkerOptions.workerSrc = params.workerSrc;
    docParams = { ...params };
    delete docParams.workerSrc;
    readyResolve(lib.version);
  },
  get version() {
    return pdfjsLib?.version;
  },
  async run(args: {
    path?: string;
    data?: Uint8Array;
    meta: EngineMeta;
    options: Partial<EngineOptions>;
    callbacks: EngineCallbacks;
  }) {
    await ready;
    let data: Uint8Array;
    if (args.path) {
      // read inside this window's realm so pdf.js sees a native Uint8Array
      data = await IOUtils.read(args.path);
    } else {
      data = new Uint8Array(args.data!);
    }
    return runFullText(
      data,
      args.meta,
      { pdfjs: pdfjsLib, createCanvas, docParams },
      args.callbacks,
      args.options,
    );
  },
};
