/**
 * Zotero Scholar Suite — translation service that routes to the active
 * source-manager profile.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { TranslateService } from "../services/base";
import { gptTranslate } from "../services/gpt";
import { normalizeLLMEndpoint } from "../../utils/llmEndpoint";
import { TranslateTask } from "../../utils/task";
import {
  getActiveProfile,
  getProfile,
  getProfileKey,
  PROFILE_SERVICE_ID,
  SourceProfile,
} from "./profiles";
import { getPref } from "../../utils/prefs";
import { buildVisionRequest, extractVisionText, visionUsesPixelCoords } from "./vision";
import { resolveVisionProfile } from "./profiles";

function parseObj(s?: string): Record<string, any> | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch (e) {
    return undefined;
  }
}

const DEEPL_LANG: Record<string, string> = {
  "zh-CN": "ZH-HANS",
  "zh-HK": "ZH-HANT",
  "zh-TW": "ZH-HANT",
  "en-US": "EN-US",
  "en-GB": "EN-GB",
  "pt-BR": "PT-BR",
  "pt-PT": "PT-PT",
};

function deeplLang(code: string, target: boolean) {
  if (!code) return "";
  if (target && DEEPL_LANG[code]) return DEEPL_LANG[code];
  return code.split("-")[0].toUpperCase();
}

async function deeplTranslate(p: SourceProfile, key: string, data: Required<TranslateTask>) {
  const url = (p.baseURL || "https://api-free.deepl.com").replace(/\/+$/, "") + "/v2/translate";
  const body: Record<string, any> = {
    text: [data.raw],
    target_lang: deeplLang(data.langto, true),
    ...(parseObj(p.customParams) || {}),
  };
  const from = deeplLang(data.langfrom, false);
  if (from && from !== "AUTO") body.source_lang = from;
  const xhr = await Zotero.HTTP.request("POST", url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `DeepL-Auth-Key ${key}`,
      ...(parseObj(p.extraHeaders) || {}),
    },
    body: JSON.stringify(body),
    responseType: "json",
    successCodes: false,
  } as any);
  if (xhr?.status !== 200) throw `Request error: ${xhr?.status} ${JSON.stringify(xhr?.response || "").slice(0, 200)}`;
  data.result = xhr.response?.translations?.[0]?.text || "";
}

/** Run a translation task with the given profile (used by the service and by "测试连接"). */
export async function translateWithProfile(p: SourceProfile, key: string, data: Required<TranslateTask>) {
  if (p.type === "deepl") {
    return deeplTranslate(p, key, data);
  }
  const apiFormat = p.type === "claude" ? "anthropic" : "openai";
  const apiURL = normalizeLLMEndpoint(p.baseURL, apiFormat);
  // keyless local servers (Ollama) still get a harmless dummy bearer token
  data.secret = key || (p.type === "ollama" ? "ollama" : "");
  await gptTranslate(
    apiURL,
    p.model,
    p.temperature,
    "chatGPT",
    data,
    p.stream,
    apiFormat,
    "default",
    {
      prompt: p.prompt || (getPref("chatGPT.prompt") as string),
      customParams: parseObj(p.customParams) || {},
      extraHeaders: parseObj(p.extraHeaders),
      maxTokens: p.maxTokens,
    },
  );
}

export const ProfileService: TranslateService = {
  id: PROFILE_SERVICE_ID,
  type: "sentence",
  helpUrl: "",
  async translate(data) {
    const p = getActiveProfile();
    if (!p) {
      throw "尚未启用任何模型源：请打开「工具 → Scholar Suite：模型源管理」新增并启用一个源。";
    }
    await translateWithProfile(p, getProfileKey(p.id), data);
  },
};

export interface TestResult {
  ok: boolean;
  ms: number;
  result?: string;
  error?: string;
  endpoint?: string;
}

/** "测试连接": translate a short sentence and measure the latency. */
export async function testProfile(idOrProfile: string | SourceProfile, keyOverride?: string): Promise<TestResult> {
  const p = typeof idOrProfile === "string" ? getProfile(idOrProfile) : idOrProfile;
  if (!p) return { ok: false, ms: 0, error: "配置不存在" };
  const key = keyOverride !== undefined && keyOverride !== "" ? keyOverride : p.id ? getProfileKey(p.id) : "";
  const task: any = {
    id: `test-${Date.now()}`,
    type: "custom",
    raw: "Hello, world. This is a connection test.",
    result: "",
    audio: [],
    service: PROFILE_SERVICE_ID,
    candidateServices: [],
    itemId: -1,
    langfrom: "en-US",
    langto: (getPref("targetLanguage") as string) || "zh-CN",
    status: "processing",
    extraTasks: [],
    silent: true,
    callerID: "zotero-scholar-suite",
    secret: key,
    processed: false,
    langfromInferred: false,
  };
  const t0 = Date.now();
  try {
    await translateWithProfile({ ...p, stream: false }, key, task);
    const ms = Date.now() - t0;
    if (!task.result) return { ok: false, ms, error: "服务返回了空结果" };
    return { ok: true, ms, result: String(task.result).slice(0, 300) };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 500) };
  }
}

/* ---------------- vision / figure OCR ---------------- */


/** Send one image to a vision-capable profile and return the model's raw text reply. */
export async function ocrWithProfile(
  p: SourceProfile,
  key: string,
  dataURL: string,
  prompt: string,
  timeoutMs = 60000,
): Promise<string> {
  const req = buildVisionRequest(p, key, dataURL, prompt);
  let xhr: any;
  try {
    xhr = await Zotero.HTTP.request("POST", req.url, {
      headers: req.headers,
      body: JSON.stringify(req.body),
      responseType: "text",
      successCodes: false,
      timeout: timeoutMs,
    } as any);
  } catch (e: any) {
    throw new Error(`识图请求失败：${String(e?.message || e).slice(0, 200)}`);
  }
  let json: any = null;
  try {
    json = JSON.parse(xhr?.response || xhr?.responseText || "null");
  } catch (e) {
    json = null;
  }
  if (xhr?.status !== 200) {
    const msg = json?.error?.message || json?.message || String(xhr?.response || "").slice(0, 200);
    throw new Error(`识图服务 HTTP ${xhr?.status}：${String(msg).slice(0, 240)}`);
  }
  return extractVisionText(req.format, json);
}

/** The OCR callback for the full-text engine, or the reason it is unavailable. */
export function getVisionOcr(timeoutMs: number):
  | { ok: true; name: string; pixelCoords: boolean; run: (dataURL: string, prompt: string) => Promise<string> }
  | { ok: false; reason: string } {
  const r = resolveVisionProfile();
  if (!r.profile) return { ok: false, reason: r.reason || "没有可用的识图模型源" };
  const p = r.profile;
  const key = getProfileKey(p.id);
  return {
    ok: true,
    name: `${p.name}${r.explicit ? "" : "（当前源）"}`,
    pixelCoords: visionUsesPixelCoords(p),
    run: (dataURL: string, prompt: string) => ocrWithProfile(p, key, dataURL, prompt, timeoutMs),
  };
}

/** "测试识图": OCR a small generated image (data URL made by the manager window). */
export async function testVisionProfile(
  idOrProfile: string | SourceProfile,
  dataURL: string,
  prompt: string,
  keyOverride?: string,
): Promise<TestResult> {
  const p = typeof idOrProfile === "string" ? getProfile(idOrProfile) : idOrProfile;
  if (!p) return { ok: false, ms: 0, error: "配置不存在" };
  const key = keyOverride ? keyOverride : p.id ? getProfileKey(p.id) : "";
  const t0 = Date.now();
  try {
    const out = await ocrWithProfile({ ...p }, key, dataURL, prompt, 60000);
    return { ok: true, ms: Date.now() - t0, result: out.slice(0, 600), endpoint: buildVisionRequest(p, key, dataURL, prompt).url };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 500) };
  }
}
