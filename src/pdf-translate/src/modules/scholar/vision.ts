/**
 * Zotero Scholar Suite — vision (image input) requests for figure OCR.
 * Pure functions (no Zotero globals) so the same code is exercised by the
 * Node test harness. Supported image input formats:
 *  - openai : OpenAI Chat Completions, content part {type:"image_url", image_url:{url:"data:<mime>;base64,..."}}
 *             (also 通义 Qwen-VL compatible-mode, Gemini OpenAI-compatible endpoint, Ollama, OpenRouter …)
 *  - zhipu  : 智谱 GLM-4V / GLM-4.6V, same shape but image_url.url is the bare base64 string
 *  - claude : Anthropic Messages, {type:"image", source:{type:"base64", media_type, data}}
 *  - gemini : Gemini native generateContent, parts[{inline_data:{mime_type, data}}]
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { normalizeLLMEndpoint } from "../../utils/llmEndpoint";

export type VisionFormat = "openai" | "zhipu" | "claude" | "gemini";

export const VISION_FORMATS: { value: "auto" | VisionFormat; label: string }[] = [
  { value: "auto", label: "自动（按类型 / 地址判断）" },
  { value: "openai", label: "OpenAI 兼容 image_url（data URL）" },
  { value: "zhipu", label: "智谱 GLM（image_url 纯 base64）" },
  { value: "claude", label: "Claude Messages（base64 source）" },
  { value: "gemini", label: "Gemini 原生 generateContent（inline_data）" },
];

export interface VisionProfileLike {
  type: string;
  baseURL: string;
  model: string;
  maxTokens?: number;
  visionFormat?: string;
  customParams?: string;
  extraHeaders?: string;
}

function parseObj(s?: string): Record<string, any> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}

export function resolveVisionFormat(p: VisionProfileLike): VisionFormat {
  const f = (p.visionFormat || "auto") as any;
  if (f && f !== "auto") return f;
  const url = (p.baseURL || "").toLowerCase();
  if (p.type === "claude" || /anthropic\.com/.test(url)) return "claude";
  if (/bigmodel\.cn|z\.ai\/api/.test(url) || /^glm-/i.test(p.model || "")) return "zhipu";
  if (p.type === "gemini" && /generativelanguage\.googleapis\.com/.test(url) && !/\/openai\/?$/.test(url)) return "gemini";
  return "openai";
}

/** Some models answer with absolute pixel coordinates regardless of the prompt. */
export function visionUsesPixelCoords(p: VisionProfileLike): boolean {
  return /qwen2(\.5)?-vl/i.test(p.model || "");
}

export function splitDataURL(dataURL: string): { mime: string; data: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataURL || "");
  if (!m) throw new Error("图片不是 base64 数据 URL");
  return { mime: m[1], data: m[2] };
}

export interface VisionRequest {
  format: VisionFormat;
  url: string;
  headers: Record<string, string>;
  body: any;
}

export function buildVisionRequest(p: VisionProfileLike, key: string, dataURL: string, prompt: string): VisionRequest {
  const format = resolveVisionFormat(p);
  const extra = parseObj(p.customParams);
  const extraHeaders = parseObj(p.extraHeaders);
  const maxTokens = p.maxTokens && p.maxTokens > 0 ? p.maxTokens : 4096;
  const { mime, data } = splitDataURL(dataURL);
  if (format === "claude") {
    return {
      format,
      url: normalizeLLMEndpoint(p.baseURL || "https://api.anthropic.com/v1", "anthropic"),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...extraHeaders,
      },
      body: {
        model: p.model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mime, data } },
              { type: "text", text: prompt },
            ],
          },
        ],
        ...extra,
      },
    };
  }
  if (format === "gemini") {
    const base = (p.baseURL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    return {
      format,
      url: `${base}/models/${encodeURIComponent(p.model)}:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key, ...extraHeaders },
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
        ...extra,
      },
    };
  }
  // openai / zhipu
  return {
    format,
    url: normalizeLLMEndpoint(p.baseURL, "openai"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key || (p.type === "ollama" ? "ollama" : "")}`,
      ...extraHeaders,
    },
    body: {
      model: p.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: format === "zhipu" ? data : dataURL } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      ...extra,
    },
  };
}

/** Pull the model's text out of a provider response. */
export function extractVisionText(format: VisionFormat, json: any): string {
  if (!json || typeof json !== "object") throw new Error("识图服务返回的不是 JSON");
  if (json.error) throw new Error(String(json.error?.message || JSON.stringify(json.error)).slice(0, 300));
  if (format === "claude") {
    const parts = Array.isArray(json.content) ? json.content : [];
    return parts
      .filter((x: any) => x?.type === "text")
      .map((x: any) => x.text)
      .join("");
  }
  if (format === "gemini") {
    const parts = json.candidates?.[0]?.content?.parts || [];
    return parts
      .filter((x: any) => typeof x?.text === "string" && !x.thought)
      .map((x: any) => x.text)
      .join("");
  }
  const c = json.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: any) => x?.text || "").join("");
  throw new Error("识图服务返回内容为空");
}
