#!/usr/bin/env python3
"""
测试用 mock 识图（OCR）服务 —— 仅用于测试，不是插件的一部分，也不是真实的识图模型。

收到图片后用本机 tesseract 做 OCR（装不上 tesseract 时返回固定 JSON），按插件要求的格式
{"items":[{"text":..., "bbox":[x0,y0,x1,y1]}]}（bbox 归一化到 0..1）返回给插件。

同时校验各家的图片输入格式（字段不对就返回 400，用来验证插件构造的请求）：
  POST /v1/chat/completions                       OpenAI 兼容：content[] 里 {"type":"image_url","image_url":{"url":"data:image/...;base64,..."}}
                                                   智谱 GLM（model 以 glm 开头）：image_url.url 为纯 base64（不带 data: 前缀）
                                                   通义 Qwen-VL（compatible-mode）与 Gemini 的 OpenAI 兼容端点同 OpenAI 格式
  POST /v1/messages                               Claude：x-api-key + anthropic-version 头，
                                                   content[] 里 {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":...}}
  POST /v1beta/models/<model>:generateContent     Gemini 原生：x-goog-api-key 头，parts[] 里 {"inline_data":{"mime_type":...,"data":...}}

故障注入（按 model 名）：含 "fail" → 500；含 "slow" → 睡 VISION_SLOW 秒（默认 120）再返回；含 "bad" → 返回非 JSON 文本。
环境变量：VISION_PORT=8767  VISION_PSM=11  VISION_SLOW=120  VISION_SAVE=目录（保存收到的图片，便于人工核对）
统计：GET /stats
"""
import base64
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("VISION_PORT", "8767"))
PSM = os.environ.get("VISION_PSM", "11")
SLOW = float(os.environ.get("VISION_SLOW", "120"))
SAVE = os.environ.get("VISION_SAVE", "")
HAS_TESS = shutil.which("tesseract") is not None
LOCK = threading.Lock()
STATS = {"requests": 0, "by_format": {}, "ocr_items": 0, "images": [], "errors": [], "injected": {"fail": 0, "slow": 0, "bad": 0},
         "engine": "tesseract" if HAS_TESS else "fixed"}

FIXED = {"items": [{"text": "Input images", "bbox": [0.05, 0.85, 0.25, 0.93]}, {"text": "Ours", "bbox": [0.7, 0.9, 0.8, 0.97]}]}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def image_size(data):
    """(w, h) of PNG / JPEG bytes without PIL."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            m = data[i + 1]
            if m in (0xC0, 0xC1, 0xC2):
                return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
            ln = int.from_bytes(data[i + 2:i + 4], "big")
            i += 2 + ln
    return 0, 0


def tesseract_ocr(img):
    w, h = image_size(img)
    with tempfile.NamedTemporaryFile(suffix=".img", delete=False) as f:
        f.write(img)
        path = f.name
    try:
        # upscale small text a bit for tesseract via --dpi hint; psm 11 = sparse text (figure labels)
        r = subprocess.run(["tesseract", path, "stdout", "--psm", PSM, "-l", "eng", "tsv"], capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(path)
    lines = {}
    for row in r.stdout.splitlines()[1:]:
        c = row.split("\t")
        if len(c) < 12 or not c[11].strip():
            continue
        try:
            conf = float(c[10])
        except ValueError:
            continue
        if conf < 55:
            continue
        word = c[11].strip()
        key = (c[2], c[3], c[4])  # block, par, line
        x, y, ww, hh = map(int, c[6:10])
        e = lines.setdefault(key, {"words": [], "x0": 1e9, "y0": 1e9, "x1": 0, "y1": 0})
        e["words"].append((x, word))
        e["x0"] = min(e["x0"], x)
        e["y0"] = min(e["y0"], y)
        e["x1"] = max(e["x1"], x + ww)
        e["y1"] = max(e["y1"], y + hh)
    items = []
    for e in lines.values():
        text = " ".join(wd for _, wd in sorted(e["words"]))
        # tesseract hallucinates on photo textures: keep lines with a real word
        if not re.search(r"[A-Za-z]{3,}", text):
            continue
        if not w or not h:
            continue
        items.append({"text": text, "bbox": [round(e["x0"] / w, 4), round(e["y0"] / h, 4), round(e["x1"] / w, 4), round(e["y1"] / h, 4)]})
    return {"items": items}, (w, h)


class Bad(Exception):
    pass


def decode_data_url(url, allow_raw=False):
    m = re.match(r"^data:(image/[\w.+-]+);base64,(.*)$", url, re.S)
    if m:
        return m.group(1), base64.b64decode(m.group(2))
    if allow_raw and re.match(r"^[A-Za-z0-9+/=\s]+$", url[:200]):
        return "raw", base64.b64decode(url)
    raise Bad("image_url.url 必须是 data:image/...;base64,... 数据 URL" + ("（或纯 base64）" if allow_raw else ""))


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/stats"):
            with LOCK:
                return self._json(200, STATS)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            return self._json(400, {"error": {"message": "body is not JSON"}})
        with LOCK:
            STATS["requests"] += 1
        try:
            fmt, model, img, prompt = self.parse(req)
        except Bad as e:
            with LOCK:
                STATS["errors"].append(f"{self.path}: {e}")
            log("400", self.path, e)
            return self._json(400, {"error": {"message": str(e)}})
        with LOCK:
            STATS["by_format"][fmt] = STATS["by_format"].get(fmt, 0) + 1
        if "fail" in model:
            with LOCK:
                STATS["injected"]["fail"] += 1
            return self._json(500, {"error": {"message": "injected vision failure"}})
        if "slow" in model:
            with LOCK:
                STATS["injected"]["slow"] += 1
            time.sleep(SLOW)
        if "bad" in model:
            with LOCK:
                STATS["injected"]["bad"] += 1
            return self.reply(fmt, model, "Sorry, I can't read this figure.")
        if "OCR" not in prompt and "ocr" not in prompt.lower():
            return self._json(400, {"error": {"message": "prompt does not look like an OCR request"}})
        if HAS_TESS:
            result, (w, h) = tesseract_ocr(img)
        else:
            result, (w, h) = FIXED, image_size(img)
        if SAVE:
            os.makedirs(SAVE, exist_ok=True)
            with open(os.path.join(SAVE, f"ocr-{STATS['requests']:03d}.jpg"), "wb") as f:
                f.write(img)
        with LOCK:
            STATS["ocr_items"] += len(result["items"])
            STATS["images"].append({"format": fmt, "model": model, "bytes": len(img), "w": w, "h": h, "items": [i["text"] for i in result["items"]]})
        log(f"{fmt} {model} {w}x{h} -> {len(result['items'])} items: {[i['text'] for i in result['items']][:8]}")
        # models often wrap JSON in a markdown fence: do the same to exercise the parser
        return self.reply(fmt, model, "```json\n" + json.dumps(result, ensure_ascii=False) + "\n```")

    def parse(self, req):
        path = self.path
        if path.endswith("/chat/completions"):
            if not (self.headers.get("Authorization") or "").startswith("Bearer "):
                raise Bad("缺少 Authorization: Bearer 头")
            model = req.get("model") or ""
            msgs = req.get("messages") or []
            if not msgs or not isinstance(msgs[-1].get("content"), list):
                raise Bad("messages[-1].content 必须是数组（多模态）")
            zhipu = model.lower().startswith("glm")
            img = None
            prompt = ""
            for part in msgs[-1]["content"]:
                if part.get("type") == "text":
                    prompt += part.get("text", "")
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url") or ""
                    kind, img = decode_data_url(url, allow_raw=zhipu)
                    if zhipu and kind != "raw":
                        raise Bad("智谱 GLM 的 image_url.url 应为纯 base64（官方示例不带 data: 前缀）")
            if img is None:
                raise Bad("没有 image_url 图片")
            return ("zhipu" if zhipu else "openai"), model, img, prompt
        if path.endswith("/messages"):
            if not self.headers.get("x-api-key") or not self.headers.get("anthropic-version"):
                raise Bad("Claude 需要 x-api-key 与 anthropic-version 头")
            if not req.get("max_tokens"):
                raise Bad("Claude 需要 max_tokens")
            msgs = req.get("messages") or []
            img, prompt = None, ""
            for part in (msgs[-1].get("content") if msgs else []) or []:
                if part.get("type") == "text":
                    prompt += part.get("text", "")
                elif part.get("type") == "image":
                    src = part.get("source") or {}
                    if src.get("type") != "base64" or not str(src.get("media_type", "")).startswith("image/"):
                        raise Bad("Claude image.source 需 {type: base64, media_type, data}")
                    img = base64.b64decode(src.get("data") or "")
            if img is None:
                raise Bad("没有 image 内容块")
            return "claude", req.get("model") or "", img, prompt
        m = re.search(r"/models/([^/:]+):generateContent", path)
        if m:
            if not self.headers.get("x-goog-api-key"):
                raise Bad("Gemini 需要 x-goog-api-key 头")
            img, prompt = None, ""
            for c in req.get("contents") or []:
                for part in c.get("parts") or []:
                    if "text" in part:
                        prompt += part["text"]
                    d = part.get("inline_data") or part.get("inlineData")
                    if d:
                        if not str(d.get("mime_type") or d.get("mimeType") or "").startswith("image/"):
                            raise Bad("inline_data.mime_type 必须是 image/*")
                        img = base64.b64decode(d.get("data") or "")
            if img is None:
                raise Bad("没有 inline_data 图片")
            return "gemini", m.group(1), img, prompt
        raise Bad("unknown endpoint " + path)

    def reply(self, fmt, model, text):
        if fmt == "claude":
            return self._json(200, {"id": "msg_mock", "type": "message", "role": "assistant", "model": model,
                                    "content": [{"type": "text", "text": text}], "stop_reason": "end_turn"})
        if fmt == "gemini":
            return self._json(200, {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]})
        return self._json(200, {"id": "chatcmpl-vision", "object": "chat.completion", "model": model,
                                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    log(f"mock vision (OCR) server on http://127.0.0.1:{PORT}, engine={STATS['engine']}")
    srv.serve_forever()
