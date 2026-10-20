/**
 * Zotero Scholar Suite — model / API source manager ("CC Switch" style).
 *
 * Profiles (name, type, base URL, model, temperature …) are stored as JSON in
 * the pref `extensions.zotero.ZoteroPDFTranslate.scholar.profiles`.
 * API keys are NOT stored in that JSON: they go into Translate for Zotero's
 * existing secret store (`secretObj`) under the key `profile:<id>`, exactly
 * like the keys of the built-in services.
 *
 * Like CC Switch, nothing switches by itself: a profile becomes the current
 * source only when the user clicks 「启用」 (activateProfile). The "当前" mark
 * (`ProfileView.active`) reflects what is really in effect, i.e. the active
 * profile id AND translateSource === "profile". Creating, importing or
 * deleting profiles never silently re-routes translations.
 *
 * Activating a profile sets the translate service to `profile`, so selection
 * translation, the reader panel, annotation/title translation, Ethereal Style
 * (via Zotero.PDFTranslate.api.translate) and the full-text translation all
 * use it immediately.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { getPref, setPref, registerPrefObserver, unregisterPrefObserver } from "../../utils/prefs";
import { getServiceSecret, setServiceSecret } from "../../utils/secret";
import { normalizeLLMEndpoint } from "../../utils/llmEndpoint";

export type ProfileType = "openai" | "claude" | "gemini" | "deepl" | "ollama" | "custom";

export const PROFILE_TYPES: { value: ProfileType; label: string }[] = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "claude", label: "Claude (Anthropic)" },
  { value: "gemini", label: "Gemini (OpenAI 兼容端点)" },
  { value: "deepl", label: "DeepL API" },
  { value: "ollama", label: "本地 Ollama" },
  { value: "custom", label: "自定义（OpenAI 兼容）" },
];

export interface SourceProfile {
  id: string;
  name: string;
  type: ProfileType;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  stream: boolean;
  /** JSON object string, merged into the request body */
  customParams?: string;
  /** JSON object string, extra HTTP headers */
  extraHeaders?: string;
  /** optional prompt; must contain ${sourceText}. Empty = the shared GPT prompt */
  prompt?: string;
  preset?: string;
  notes?: string;
  /** the model accepts image input (needed to use it as the vision / OCR source) */
  supportsVision?: boolean;
  /** image input format: auto | openai | zhipu | claude | gemini (see vision.ts) */
  visionFormat?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ProfileView extends SourceProfile {
  hasKey: boolean;
  maskedKey: string;
  active: boolean;
  /** this profile is the one used for figure OCR (explicit choice or fallback to the current source) */
  vision: boolean;
  /** explicitly chosen as the vision source */
  visionExplicit: boolean;
}

export interface ProfilePreset {
  id: string;
  name: string;
  type: ProfileType;
  baseURL: string;
  model: string;
  temperature: number;
  needsKey: boolean;
  keyHint?: string;
  docs?: string;
  /** vision (image input) preset for figure OCR */
  vision?: boolean;
  visionFormat?: string;
  customParams?: string;
  notes?: string;
}

export const PRESETS: ProfilePreset[] = [
  { id: "openai", name: "OpenAI", type: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini", temperature: 0.3, needsKey: true, keyHint: "sk-...", docs: "https://platform.openai.com/api-keys" },
  { id: "deepseek", name: "DeepSeek", type: "openai", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", temperature: 0.3, needsKey: true, keyHint: "sk-...", docs: "https://platform.deepseek.com/api_keys" },
  { id: "moonshot", name: "Kimi / Moonshot", type: "openai", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", temperature: 0.3, needsKey: true, keyHint: "sk-...", docs: "https://platform.moonshot.cn/console/api-keys" },
  { id: "dashscope", name: "通义千问 DashScope", type: "openai", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", temperature: 0.3, needsKey: true, keyHint: "sk-...", docs: "https://bailian.console.aliyun.com/" },
  { id: "zhipu", name: "智谱 GLM", type: "openai", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", temperature: 0.3, needsKey: true, docs: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "siliconflow", name: "硅基流动 SiliconFlow", type: "openai", baseURL: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", temperature: 0.3, needsKey: true, keyHint: "sk-...", docs: "https://cloud.siliconflow.cn/account/ak" },
  { id: "openrouter", name: "OpenRouter", type: "openai", baseURL: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", temperature: 0.3, needsKey: true, keyHint: "sk-or-...", docs: "https://openrouter.ai/keys" },
  { id: "claude", name: "Claude (Anthropic)", type: "claude", baseURL: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", temperature: 0.3, needsKey: true, keyHint: "sk-ant-...", docs: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", name: "Google Gemini", type: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.5-flash-lite", temperature: 0.3, needsKey: true, docs: "https://aistudio.google.com/apikey" },
  { id: "ollama", name: "本地 Ollama", type: "ollama", baseURL: "http://localhost:11434/v1", model: "qwen2.5:7b", temperature: 0.3, needsKey: false, docs: "https://ollama.com/" },
  { id: "deepl", name: "DeepL API Free", type: "deepl", baseURL: "https://api-free.deepl.com", model: "", temperature: 0, needsKey: true, keyHint: "xxxx:fx", docs: "https://www.deepl.com/your-account/keys" },
  { id: "custom", name: "自定义 OpenAI 兼容", type: "custom", baseURL: "http://127.0.0.1:8000/v1", model: "your-model", temperature: 0.3, needsKey: false },
  /* ---- 识图模型源（图内文字 OCR）。模型名核实于 2026-10-20 的官方文档，见 README「识图模型推荐」 ---- */
  { id: "vision-openai", name: "识图 · OpenAI", type: "openai", baseURL: "https://api.openai.com/v1", model: "gpt-5.4-mini", temperature: 0, needsKey: true, keyHint: "sk-...", docs: "https://platform.openai.com/docs/guides/images-vision", vision: true, visionFormat: "openai" },
  { id: "vision-claude", name: "识图 · Claude", type: "claude", baseURL: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", temperature: 0, needsKey: true, keyHint: "sk-ant-...", docs: "https://docs.anthropic.com/en/docs/about-claude/models/overview", vision: true, visionFormat: "claude" },
  { id: "vision-gemini", name: "识图 · Gemini", type: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.5-flash-lite", temperature: 0, needsKey: true, docs: "https://ai.google.dev/gemini-api/docs/openai", vision: true, visionFormat: "openai" },
  { id: "vision-qwen", name: "识图 · 通义 Qwen-VL", type: "openai", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-flash", temperature: 0, needsKey: true, keyHint: "sk-...", docs: "https://help.aliyun.com/zh/model-studio/qwen-vl-compatible-with-openai", vision: true, visionFormat: "openai", customParams: '{"enable_thinking": false}' },
  { id: "vision-zhipu", name: "识图 · 智谱 GLM-4.6V-Flash（免费）", type: "openai", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6v-flash", temperature: 0, needsKey: true, docs: "https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash", vision: true, visionFormat: "zhipu", customParams: '{"thinking": {"type": "disabled"}}' },
];

const PREF_PROFILES = "scholar.profiles";
const PREF_ACTIVE = "scholar.activeProfile";
const PREF_VISION = "scholar.visionProfile" as const;
const SECRET_PREFIX = "profile:";
export const PROFILE_SERVICE_ID = "profile";

type Listener = () => void;
const listeners = new Set<Listener>();

export function onProfilesChanged(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }
}

/**
 * Keep the "当前" mark honest when the service is switched elsewhere
 * (preferences, reader panel): re-render listeners on translateSource changes.
 */
export function watchTranslateSource(): () => void {
  const sym = registerPrefObserver("translateSource", () => emit());
  return () => {
    try {
      unregisterPrefObserver(sym);
    } catch (e) {
      // ignore
    }
  };
}

function uid() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function readAll(): SourceProfile[] {
  try {
    const raw = (getPref(PREF_PROFILES) as string) || "[]";
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && p.id) : [];
  } catch (e) {
    return [];
  }
}

function writeAll(list: SourceProfile[]) {
  setPref(PREF_PROFILES, JSON.stringify(list));
}

export function maskKey(key: string) {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 3)}${"•".repeat(Math.min(12, key.length - 7))}${key.slice(-4)}`;
}

export function getProfileKey(id: string) {
  return getServiceSecret(SECRET_PREFIX + id);
}

function setProfileKey(id: string, key: string) {
  setServiceSecret(SECRET_PREFIX + id, key || "");
}

function deleteProfileKey(id: string) {
  try {
    const secrets = JSON.parse((getPref("secretObj") as string) || "{}");
    delete secrets[SECRET_PREFIX + id];
    setPref("secretObj", JSON.stringify(secrets));
  } catch (e) {
    // ignore
  }
}

function sanitize(p: Partial<SourceProfile>, base?: SourceProfile): SourceProfile {
  const type = (PROFILE_TYPES.find((t) => t.value === p.type)?.value || base?.type || "openai") as ProfileType;
  const temperature = Number(p.temperature ?? base?.temperature ?? 0.3);
  return {
    id: p.id || base?.id || uid(),
    name: String(p.name ?? base?.name ?? "未命名").trim() || "未命名",
    type,
    baseURL: String(p.baseURL ?? base?.baseURL ?? "").trim(),
    model: String(p.model ?? base?.model ?? "").trim(),
    temperature: isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 0.3,
    maxTokens: p.maxTokens ? Math.max(1, Math.floor(Number(p.maxTokens))) : base?.maxTokens,
    stream: p.stream ?? base?.stream ?? false,
    customParams: (p.customParams ?? base?.customParams ?? "").trim(),
    extraHeaders: (p.extraHeaders ?? base?.extraHeaders ?? "").trim(),
    prompt: (p.prompt ?? base?.prompt ?? "").trim(),
    preset: p.preset ?? base?.preset,
    notes: p.notes ?? base?.notes ?? "",
    supportsVision: !!(p.supportsVision ?? base?.supportsVision ?? false),
    visionFormat: ["auto", "openai", "zhipu", "claude", "gemini"].includes(String(p.visionFormat ?? base?.visionFormat ?? "auto"))
      ? String(p.visionFormat ?? base?.visionFormat ?? "auto")
      : "auto",
    createdAt: base?.createdAt || p.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

function validateJSONField(s: string | undefined, field: string) {
  if (!s) return;
  try {
    const v = JSON.parse(s);
    if (typeof v !== "object" || Array.isArray(v) || v === null) throw new Error();
  } catch (e) {
    throw new Error(`${field} 必须是 JSON 对象，例如 {"top_p": 0.9}`);
  }
}

export function listProfiles(): ProfileView[] {
  const active = getEffectiveProfileId();
  const explicitVision = getVisionProfileId();
  const vision = resolveVisionProfile().profile?.id || "";
  return readAll().map((p) => {
    const key = getProfileKey(p.id);
    return {
      ...p,
      hasKey: !!key,
      maskedKey: maskKey(key),
      active: p.id === active,
      vision: p.id === vision,
      visionExplicit: p.id === explicitVision,
    };
  });
}

/* ---------------- vision (figure OCR) source ---------------- */

/** Explicitly chosen vision source ("" = follow the current source). */
export function getVisionProfileId(): string {
  const id = (getPref(PREF_VISION) as string) || "";
  return id && getProfile(id) ? id : "";
}

export function setVisionProfile(id: string) {
  if (id && !getProfile(id)) throw new Error("配置不存在");
  if (id) {
    // choosing a source for OCR implies it takes images
    const p = getProfile(id)!;
    if (!p.supportsVision) saveProfile({ ...p, supportsVision: true });
  }
  setPref(PREF_VISION as any, id || "");
  emit();
}

/**
 * The profile used for figure OCR: the explicit vision source, otherwise the
 * current source if it is a source-manager profile marked as accepting images.
 */
export function resolveVisionProfile(): { profile?: SourceProfile; reason?: string; explicit: boolean } {
  const id = getVisionProfileId();
  if (id) return { profile: getProfile(id), explicit: true };
  const cur = getEffectiveProfileId();
  if (!cur) {
    return {
      explicit: false,
      reason: "未指定识图模型源，且当前翻译服务不是模型源管理器中的源",
    };
  }
  const p = getProfile(cur)!;
  if (p.type === "deepl") return { explicit: false, reason: `当前源「${p.name}」是 DeepL，不支持图片输入` };
  if (!p.supportsVision) {
    return { explicit: false, reason: `当前源「${p.name}」未勾选“支持图片输入”，请在模型源管理器中勾选或另行指定识图模型源` };
  }
  return { profile: p, explicit: false };
}

export function getProfile(id: string): SourceProfile | undefined {
  return readAll().find((p) => p.id === id);
}

export function getActiveProfileId(): string {
  return (getPref(PREF_ACTIVE) as string) || "";
}

/** True when translations are currently routed through the source manager. */
export function isProfileServiceInUse(): boolean {
  return getPref("translateSource") === PROFILE_SERVICE_ID;
}

/**
 * The profile that is really in effect right now: only set after the user
 * clicked 「启用」 and while translateSource is still "profile". Empty otherwise.
 */
export function getEffectiveProfileId(): string {
  const id = getActiveProfileId();
  return id && isProfileServiceInUse() && getProfile(id) ? id : "";
}

export function getActiveProfile(): SourceProfile | undefined {
  const id = getActiveProfileId();
  return id ? getProfile(id) : undefined;
}

/**
 * Create or update a profile.
 * @param key undefined = keep the stored key, "" = clear it, otherwise set it.
 */
export function saveProfile(p: Partial<SourceProfile>, key?: string): SourceProfile {
  validateJSONField(p.customParams, "自定义参数");
  validateJSONField(p.extraHeaders, "额外请求头");
  if (p.prompt && !p.prompt.includes("${sourceText}")) {
    throw new Error("自定义提示词必须包含 ${sourceText} 占位符");
  }
  const list = readAll();
  const idx = p.id ? list.findIndex((x) => x.id === p.id) : -1;
  const saved = sanitize(p, idx >= 0 ? list[idx] : undefined);
  if (!saved.baseURL && saved.type !== "deepl") throw new Error("Base URL 不能为空");
  if (idx >= 0) list[idx] = saved;
  else list.push(saved);
  writeAll(list);
  if (key !== undefined) setProfileKey(saved.id, key.trim());
  // no auto-activation: only 「启用」 switches the translation service
  emit();
  return saved;
}

export function createFromPreset(presetId: string, key?: string): SourceProfile {
  const pr = PRESETS.find((x) => x.id === presetId);
  if (!pr) throw new Error("未知预设: " + presetId);
  return saveProfile(
    {
      name: pr.name,
      type: pr.type,
      baseURL: pr.baseURL,
      model: pr.model,
      temperature: pr.temperature,
      stream: false,
      preset: pr.id,
      supportsVision: !!pr.vision,
      visionFormat: pr.visionFormat || "auto",
      customParams: pr.customParams || "",
      notes: pr.notes || "",
    },
    key,
  );
}

export function duplicateProfile(id: string): SourceProfile {
  const src = getProfile(id);
  if (!src) throw new Error("配置不存在");
  const copy = saveProfile({ ...src, id: undefined, name: src.name + " 副本", createdAt: undefined }, getProfileKey(id));
  // put the copy right after the original
  const list = readAll();
  const from = list.findIndex((x) => x.id === copy.id);
  const to = list.findIndex((x) => x.id === id) + 1;
  const [it] = list.splice(from, 1);
  list.splice(to, 0, it);
  writeAll(list);
  emit();
  return copy;
}

export function deleteProfile(id: string) {
  const list = readAll().filter((p) => p.id !== id);
  writeAll(list);
  deleteProfileKey(id);
  if ((getPref(PREF_VISION) as string) === id) setPref(PREF_VISION as any, "");
  if (getActiveProfileId() === id) {
    // the source in use was deleted: do not silently switch to another profile;
    // clear the mark and fall back to a free built-in service
    setPref(PREF_ACTIVE, "");
    if (isProfileServiceInUse()) {
      setPref("translateSource", Zotero.locale === "zh-CN" ? "cnki" : "googleapi");
    }
  }
  emit();
}

export function reorderProfiles(ids: string[]) {
  const list = readAll();
  const byId = new Map(list.map((p) => [p.id, p]));
  const out: SourceProfile[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) {
      out.push(p);
      byId.delete(id);
    }
  }
  out.push(...byId.values());
  writeAll(out);
  emit();
}

export function moveProfile(id: string, delta: number) {
  const ids = readAll().map((p) => p.id);
  const i = ids.indexOf(id);
  if (i < 0) return;
  const j = Math.max(0, Math.min(ids.length - 1, i + delta));
  ids.splice(i, 1);
  ids.splice(j, 0, id);
  reorderProfiles(ids);
}

/** Make `id` the current source and route all translations through it. */
export function activateProfile(id: string) {
  if (!getProfile(id)) throw new Error("配置不存在");
  setPref(PREF_ACTIVE, id);
  setPref("translateSource", PROFILE_SERVICE_ID);
  emit();
  try {
    addon.hooks.onReaderTabPanelRefresh();
  } catch (e) {
    // ignore
  }
}

export function exportProfiles(includeKeys: boolean): string {
  const list = readAll().map((p) => {
    const out: any = { ...p };
    if (includeKeys) out.apiKey = getProfileKey(p.id);
    return out;
  });
  return JSON.stringify(
    {
      format: "zotero-scholar-suite/profiles",
      version: 1,
      exportedAt: new Date().toISOString(),
      includesKeys: includeKeys,
      activeProfile: getEffectiveProfileId(),
      visionProfile: getVisionProfileId(),
      profiles: list,
    },
    null,
    2,
  );
}

export function importProfiles(text: string, mode: "merge" | "replace" = "merge"): number {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("不是有效的 JSON");
  }
  const arr: any[] = Array.isArray(data) ? data : data?.profiles;
  if (!Array.isArray(arr)) throw new Error("JSON 中没有 profiles 数组");
  let list = mode === "replace" ? [] : readAll();
  if (mode === "replace") {
    for (const p of readAll()) deleteProfileKey(p.id);
  }
  let n = 0;
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const existing = raw.id ? list.find((x) => x.id === raw.id) : undefined;
    const p = sanitize({ ...raw, id: existing ? raw.id : raw.id || undefined }, existing);
    if (existing) list = list.map((x) => (x.id === p.id ? p : x));
    else list.push(p);
    if (typeof raw.apiKey === "string" && raw.apiKey) setProfileKey(p.id, raw.apiKey);
    n++;
  }
  writeAll(list);
  // importing never switches the current source; if the active profile was
  // replaced away, clear the mark and leave the profile service
  const cur = getActiveProfileId();
  if (cur && !list.some((p) => p.id === cur)) {
    setPref(PREF_ACTIVE, "");
    if (isProfileServiceInUse()) {
      setPref("translateSource", Zotero.locale === "zh-CN" ? "cnki" : "googleapi");
    }
  }
  emit();
  return n;
}

export function profileTypeLabel(t: ProfileType) {
  return PROFILE_TYPES.find((x) => x.value === t)?.label || t;
}

export function describeEndpoint(p: SourceProfile): string {
  if (p.type === "deepl") return (p.baseURL || "https://api-free.deepl.com").replace(/\/+$/, "") + "/v2/translate";
  return normalizeLLMEndpoint(p.baseURL, p.type === "claude" ? "anthropic" : "openai");
}
