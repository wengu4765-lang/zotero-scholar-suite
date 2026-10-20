/**
 * Zotero Scholar Suite — "全文翻译（保留图片）" inside Zotero.
 * Replaces Ethereal Style's text-only full-text translation:
 *  - parses the PDF with Zotero's bundled pdf.js (hidden chrome engine page),
 *  - keeps figures / tables / display equations as PNG/JPEG crops,
 *  - translates through Translate for Zotero's services (incl. the source manager),
 *  - saves a bilingual HTML attachment under the item and opens it.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { autoDetectLanguage, TranslateTask } from "../../utils/task";
import { getVisionOcr } from "./profileService";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ENGINE_URL = `chrome://${config.addonRef}/content/fulltextEngine.html`;

let engineFrame: HTMLIFrameElement | null = null;

export interface FullTextJob {
  id: string;
  itemID: number;
  title: string;
  cancelled: boolean;
  fraction: number;
  message: string;
  startedAt: number;
}

export interface FullTextOutcome {
  ok: boolean;
  reason?: "no-pdf" | "no-file" | "too-large" | "busy" | "cancelled" | "error";
  message?: string;
  size?: number;
  limit?: number;
  attachmentID?: number;
  stats?: any;
  pageCount?: number;
  regions?: any[];
  failures?: any[];
  timings?: any;
  htmlBytes?: number;
  figureText?: any;
  figureFailures?: any[];
}

let currentJob: FullTextJob | null = null;

export function getCurrentFullTextJob() {
  return currentJob;
}

export function cancelFullText() {
  if (currentJob) {
    currentJob.cancelled = true;
    currentJob.message = "正在取消…";
  }
}

/**
 * Add a 「取消」 button to a toolkit ProgressWindow. The underlying
 * Zotero.ProgressWindow keeps its DOM window private, so we reach it through
 * the first line's element once the window has loaded.
 */
function attachCancelButton(pw: any, onCancel: () => void) {
  let btn: HTMLButtonElement | null = null;
  let removed = false;
  (async () => {
    for (let i = 0; i < 100 && !removed; i++) {
      const hbox = pw?.lines?.[0]?._hbox as Element | undefined;
      const doc = hbox?.ownerDocument;
      const box = doc?.getElementById("zotero-progress-text-box");
      if (doc && box) {
        const row = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
        row.id = "scholar-fulltext-cancel-row";
        row.setAttribute("style", "display:flex;justify-content:flex-end;margin-top:6px;");
        btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
        btn.id = "scholar-fulltext-cancel";
        btn.textContent = "取消";
        btn.title = "取消本次全文翻译（已发出的请求会在返回后丢弃）";
        btn.setAttribute("style", "padding:2px 14px;font-size:12px;cursor:pointer;");
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!btn) return;
          btn.disabled = true;
          btn.textContent = "正在取消…";
          onCancel();
        });
        row.appendChild(btn);
        box.appendChild(row);
        try {
          (doc.defaultView as any)?.sizeToContent?.();
        } catch (e) {
          // ignore
        }
        return;
      }
      await Zotero.Promise.delay(50);
    }
  })();
  return {
    remove() {
      removed = true;
      try {
        btn?.parentElement?.remove();
      } catch (e) {
        // ignore
      }
      btn = null;
    },
  };
}

export function getMaxFileSizeBytes(): number {
  const mb = Number(getPref("fullText.maxFileSizeMB"));
  const v = isFinite(mb) && mb > 0 ? mb : 30;
  return Math.round(v * 1024 * 1024);
}

function fmtSize(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export function destroyEngine() {
  try {
    engineFrame?.remove();
  } catch (e) {
    // ignore
  }
  engineFrame = null;
}

async function getEngine(): Promise<any> {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  if (!engineFrame || !engineFrame.isConnected || engineFrame.ownerDocument !== doc) {
    destroyEngine();
    engineFrame = doc.createElementNS(HTML_NS, "iframe") as HTMLIFrameElement;
    engineFrame.id = "scholar-suite-fulltext-engine";
    engineFrame.setAttribute(
      "style",
      "position:fixed;left:-2000px;top:-2000px;width:16px;height:16px;border:0;visibility:hidden;pointer-events:none;",
    );
    engineFrame.src = ENGINE_URL;
    doc.documentElement.appendChild(engineFrame);
  }
  for (let i = 0; i < 300; i++) {
    const w = engineFrame.contentWindow as any;
    if (w?.ScholarFulltextLoadError) {
      throw new Error("全文翻译引擎加载失败：" + w.ScholarFulltextLoadError);
    }
    if (w?.ScholarFulltext) {
      await w.ScholarFulltext.ready;
      return w.ScholarFulltext;
    }
    await Zotero.Promise.delay(100);
  }
  throw new Error("全文翻译引擎加载超时");
}

/** Find the PDF attachment for a regular item / attachment. */
export async function resolvePDFAttachment(item: Zotero.Item | false | null | undefined): Promise<Zotero.Item | null> {
  if (!item) return null;
  if (item.isAttachment()) return item.isPDFAttachment() ? item : null;
  if (item.isRegularItem()) {
    const best = await item.getBestAttachment();
    if (best && best.isPDFAttachment()) return best;
    for (const id of item.getAttachments()) {
      const a = Zotero.Items.get(id);
      if (a && a.isPDFAttachment()) return a;
    }
  }
  return null;
}

export function itemHasPDF(item: Zotero.Item): boolean {
  if (item.isAttachment()) return item.isPDFAttachment();
  if (!item.isRegularItem()) return false;
  return item.getAttachments().some((id) => Zotero.Items.get(id)?.isPDFAttachment());
}

function alert(title: string, text: string) {
  try {
    Services.prompt.alert(Zotero.getMainWindow() as any, title, text);
  } catch (e) {
    Zotero.debug(`[ScholarSuite] ${title}: ${text}`);
  }
}

async function translateText(
  text: string,
  service: string,
  itemID: number,
  langfrom: string,
  langto: string,
): Promise<string> {
  const task: TranslateTask = {
    id: `${Zotero.Utilities.randomString()}-${Date.now()}`,
    type: "custom",
    raw: text,
    result: "",
    audio: [],
    service,
    candidateServices: [],
    itemId: itemID,
    status: "waiting",
    extraTasks: [],
    silent: true,
    langfrom,
    langto,
    callerID: config.addonID,
  };
  await addon.data.translate.services.runTranslationTask(task, {
    noDisplay: true,
    noCheckZoteroItemLanguage: true,
    noCache: true,
  });
  if (task.status !== "success") {
    throw new Error(String(task.result || "翻译失败").slice(0, 300));
  }
  return task.result;
}

export interface FullTextOptions {
  /** do not open the attachment afterwards */
  noOpen?: boolean;
  /** do not show modal alerts (tests / batch) */
  noPrompt?: boolean;
  /** override the service id */
  service?: string;
  maxPages?: number;
  /** override figure-text settings (tests) */
  figureText?: Record<string, any>;
}

/** Figure-text (图内文字翻译) settings from the preferences. */
export function getFigureTextSettings() {
  const num = (k: string, d: number) => {
    const v = Number(getPref(k as any));
    return isFinite(v) && v >= 0 ? v : d;
  };
  return {
    enabled: getPref("fullText.figureText.enabled") !== false,
    ocr: getPref("fullText.figureText.ocr") === true,
    skipSmall: getPref("fullText.figureText.skipSmall") !== false,
    minSize: num("fullText.figureText.minSize", 80),
    skipPhoto: getPref("fullText.figureText.skipPhoto") === true,
    maxImages: Math.floor(num("fullText.figureText.maxImages", 30)),
    ocrTimeoutMs: Math.max(5, num("fullText.figureText.ocrTimeout", 60)) * 1000,
  };
}

export async function fullTextTranslate(
  input: Zotero.Item | number,
  options: FullTextOptions = {},
): Promise<FullTextOutcome> {
  const item = typeof input === "number" ? Zotero.Items.get(input) : input;
  const say = (title: string, text: string) => {
    if (!options.noPrompt) alert(title, text);
  };
  if (currentJob) {
    say("全文翻译（保留图片）", `已有一个全文翻译任务在进行：${currentJob.title}\n请等待完成或在「工具」菜单中取消。`);
    return { ok: false, reason: "busy" };
  }
  const att = await resolvePDFAttachment(item || null);
  if (!att) {
    say("全文翻译（保留图片）", "所选条目没有 PDF 附件。");
    return { ok: false, reason: "no-pdf" };
  }
  const path = await att.getFilePathAsync();
  if (!path) {
    say("全文翻译（保留图片）", "找不到 PDF 文件（可能尚未下载到本地）。");
    return { ok: false, reason: "no-file" };
  }
  const size = (await IOUtils.stat(path)).size || 0;
  const limit = getMaxFileSizeBytes();
  if (size > limit) {
    const msg =
      `该 PDF 大小为 ${fmtSize(size)}，超过了当前的全文翻译上限 ${fmtSize(limit)}。\n\n` +
      `如需翻译，请在「设置 → 翻译 → 全文翻译（保留图片）」中调高“PDF 大小上限”后重试。`;
    say("全文翻译（保留图片）：文件过大", msg);
    return { ok: false, reason: "too-large", size, limit, message: msg };
  }

  const parent = att.parentItem;
  const titleBase = ((parent?.getField("title") as string) || att.getField("title") || att.attachmentFilename || "PDF").toString();
  const job: FullTextJob = {
    id: Zotero.Utilities.randomString(),
    itemID: att.id,
    title: titleBase,
    cancelled: false,
    fraction: 0,
    message: "准备中",
    startedAt: Date.now(),
  };
  currentJob = job;

  const service = (options.service || (getPref("fullText.service") as string) || (getPref("translateSource") as string)) as string;
  const serviceName = addon.data.translate.services.getServiceNameByID(service);
  const { fromLanguage, toLanguage } = autoDetectLanguage(parent || att);

  const pw = new ztoolkit.ProgressWindow("全文翻译（保留图片）", { closeOnClick: false, closeTime: -1 })
    .createLine({ text: `${titleBase.slice(0, 40)} · 准备中`, progress: 0, type: "default" })
    .show();
  const cancelBtn = attachCancelButton(pw, () => {
    cancelFullText();
    pw.changeLine({ text: "正在取消…（等待进行中的请求返回）" });
  });

  let lastUpdate = 0;
  let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  const ftSettings = { ...getFigureTextSettings(), ...(options.figureText || {}) };
  const vision = ftSettings.enabled && ftSettings.ocr ? getVisionOcr(ftSettings.ocrTimeoutMs) : null;
  if (vision && !vision.ok) Zotero.debug(`[ScholarSuite] figure OCR unavailable: ${vision.reason}`);
  try {
    const engine = await getEngine();
    const result = await engine.run({
      path,
      meta: {
        title: titleBase,
        sourceFile: att.attachmentFilename || PathUtils.filename(path),
        serviceName,
        langFrom: fromLanguage,
        langTo: toLanguage,
      },
      options: {
        renderScale: Number(getPref("fullText.renderScale")) || 2,
        imageFormat: (getPref("fullText.imageFormat") as any) || "auto",
        equations: getPref("fullText.keepEquationImages") !== false,
        concurrency: Number(getPref("fullText.concurrency")) || 4,
        retries: Number(getPref("fullText.retries")) >= 0 ? Number(getPref("fullText.retries")) : 2,
        retryDelayMs: 1500,
        translateCaptions: true,
        maxChunkChars: 2500,
        maxPages: options.maxPages,
        figureText: ftSettings.enabled ? ftSettings : undefined,
      },
      callbacks: {
        translate: (text: string) => translateText(text, service, att.id, fromLanguage, toLanguage),
        isCancelled: () => job.cancelled,
        ocr: vision && vision.ok ? (req: any) => vision.run(req.dataURL, req.prompt) : undefined,
        ocrUnavailable: vision && !vision.ok ? vision.reason : undefined,
        ocrPixelCoords: vision && vision.ok ? vision.pixelCoords : false,
        onProgress: (p: any) => {
          if (job.cancelled) return;
          job.fraction = p.fraction;
          job.message = p.message;
          const show = () => {
            if (job.cancelled || currentJob !== job) return;
            lastUpdate = Date.now();
            pw.changeLine({ text: `${job.message}（${Math.round(job.fraction * 100)}%）`, progress: Math.round(job.fraction * 100) });
          };
          const t = Date.now();
          if (t - lastUpdate < 250 && p.phase !== "done") {
            // throttled: make sure the latest message still shows up (slow OCR
            // requests may not emit another event for a while)
            if (!pendingUpdate) {
              pendingUpdate = setTimeout(() => {
                pendingUpdate = null;
                show();
              }, 260);
            }
            return;
          }
          show();
        },
      },
    });

    if (job.cancelled) throw new Error("cancelled");
    for (const ff of result.figureFailures || []) {
      Zotero.debug(`[ScholarSuite] figure text: page ${ff.page} ${ff.kind}: ${ff.error}`);
    }
    // save as attachment
    const safe = (att.attachmentFilename || "paper.pdf").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
    const tmpDir = Zotero.getTempDirectory().path;
    const tmp = PathUtils.join(tmpDir, `${safe}.全文翻译.html`);
    await IOUtils.writeUTF8(tmp, result.html);
    const newAtt = await Zotero.Attachments.importFromFile({
      file: tmp,
      parentItemID: parent ? parent.id : undefined,
      libraryID: parent ? undefined : att.libraryID,
      title: `全文翻译（保留图片）· ${toLanguage}`,
      contentType: "text/html",
      charset: "utf-8",
    } as any);
    try {
      await IOUtils.remove(tmp);
    } catch (e) {
      // ignore
    }
    const s = result.stats;
    const f = result.figureText;
    cancelBtn.remove();
    pw.changeLine({
      text: `完成：${result.pageCount} 页 · 段落 ${s.paragraphs} · 图 ${s.figures} · 表 ${s.tables} · 公式 ${s.equations}${s.failed ? ` · 失败 ${s.failed}` : ""}${
        f?.enabled ? ` · 图内文字 ${f.overlays} 处${f.ocrFailed ? `（OCR 失败 ${f.ocrFailed} 张已跳过）` : ""}` : ""
      }`,
      progress: 100,
      type: "success",
    });
    pw.startCloseTimer(6000);
    if (!options.noOpen && getPref("fullText.autoOpen") !== false) {
      try {
        await (Zotero.getActiveZoteroPane() as any).viewAttachment(newAtt.id);
      } catch (e) {
        Zotero.logError(e as Error);
      }
    }
    return {
      ok: true,
      attachmentID: newAtt.id,
      stats: result.stats,
      pageCount: result.pageCount,
      regions: result.regions,
      failures: result.failures,
      timings: result.timings,
      htmlBytes: result.html.length,
      figureText: result.figureText,
      figureFailures: result.figureFailures,
      size,
      limit,
    };
  } catch (e: any) {
    const cancelled = job.cancelled || String(e?.message || e) === "cancelled";
    cancelBtn.remove();
    pw.changeLine({ text: cancelled ? "已取消" : `失败：${String(e?.message || e).slice(0, 120)}`, type: "fail", progress: 100 });
    pw.startCloseTimer(8000);
    if (!cancelled) {
      Zotero.logError(e);
      say("全文翻译（保留图片）失败", String(e?.stack || e?.message || e).slice(0, 1500));
    }
    return { ok: false, reason: cancelled ? "cancelled" : "error", message: String(e?.message || e) };
  } finally {
    currentJob = null;
  }
}

/** Item(s) for the current context: selected reader tab or selected library items. */
export function getContextItems(): Zotero.Item[] {
  const win = Zotero.getMainWindow() as any;
  const tabs = win?.Zotero_Tabs;
  if (tabs && tabs.selectedType && tabs.selectedType !== "library") {
    const reader = Zotero.Reader.getByTabID(tabs.selectedID);
    if (reader) {
      const it = Zotero.Items.get(reader.itemID as number);
      return it ? [it] : [];
    }
  }
  return (Zotero.getActiveZoteroPane()?.getSelectedItems() || []) as Zotero.Item[];
}

export async function fullTextTranslateContext() {
  const items = getContextItems().filter((i) => itemHasPDF(i));
  if (!items.length) {
    alert("全文翻译（保留图片）", "请先选择一个带 PDF 的条目，或在阅读器中打开 PDF。");
    return;
  }
  for (const it of items) {
    const r = await fullTextTranslate(it);
    if (r.reason === "cancelled") break;
  }
}
