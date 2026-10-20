#!/usr/bin/env python3
"""
本地 mock 的 OpenAI 兼容 / Anthropic 兼容翻译服务，用于测试。
- POST /v1/chat/completions  (OpenAI 格式，支持 stream=true SSE)
- POST /v1/messages          (Anthropic 格式)
- POST /v2/translate         (DeepL 格式)
- GET  /v1/models
返回 "[译]" + 原文（若提示词里用 🔤 包住原文，则只取 🔤 之间的内容）。
环境变量:
  MOCK_PORT=8765  MOCK_DELAY=0.05（秒） MOCK_FAIL_RATE=0.0（随机返回 500 的比例，用于测重试）
  MOCK_REQUIRE_KEY=sk-test（若设置则校验 Authorization / x-api-key）
统计: GET /stats
"""
import json
import os
import random
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MOCK_PORT", "8765"))
DELAY = float(os.environ.get("MOCK_DELAY", "0.05"))
FAIL_RATE = float(os.environ.get("MOCK_FAIL_RATE", "0"))
REQUIRE_KEY = os.environ.get("MOCK_REQUIRE_KEY", "")
STATS = {"requests": 0, "failed_injected": 0, "by_path": {}, "models": {}, "auth": {}}
LOCK = threading.Lock()


def extract_source(text):
    # Translate for Zotero 的默认提示词形如 "...enclosed in 🔤. ... follows:  🔤 原文 🔤  Please ... remove 🔤."
    m = re.search(r"[:：]\s*🔤\s*(.*?)\s*🔤", text, re.S)
    if m:
        return m.group(1)
    parts = text.split("🔤")
    if len(parts) >= 3:
        return max(parts[1:-1], key=len).strip()
    return text


BATCH_RE = re.compile(r"^\s*\[(\d{1,3})\]\s*(.*)$")


def mock_tr(src):
    """"[译]" + 原文；图内文字的批量请求（多行 "[n] 文本"）逐行加前缀并保留编号。"""
    lines = [l for l in src.split("\n") if l.strip()]
    if len(lines) >= 2 and all(BATCH_RE.match(l) for l in lines):
        return "\n".join(f"[{BATCH_RE.match(l).group(1)}] [译]{BATCH_RE.match(l).group(2)}" for l in lines)
    return "[译]" + src


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
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "mock-model", "object": "model"}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        auth = self.headers.get("Authorization") or self.headers.get("x-api-key") or ""
        with LOCK:
            STATS["requests"] += 1
            STATS["by_path"][self.path] = STATS["by_path"].get(self.path, 0) + 1
            mdl = req.get("model", "")
            STATS["models"][mdl] = STATS["models"].get(mdl, 0) + 1
            key = auth.replace("Bearer ", "")[:12]
            STATS["auth"][key] = STATS["auth"].get(key, 0) + 1
        if REQUIRE_KEY and REQUIRE_KEY not in auth:
            return self._json(401, {"error": {"message": "invalid api key"}})
        if DELAY:
            time.sleep(DELAY)
        if FAIL_RATE and random.random() < FAIL_RATE:
            with LOCK:
                STATS["failed_injected"] += 1
            return self._json(500, {"error": {"message": "injected failure"}})

        if self.path.startswith("/v2/translate"):
            texts = req.get("text") or []
            return self._json(200, {"translations": [{"text": "[译]" + t, "detected_source_language": "EN"} for t in texts]})

        if self.path.endswith("/messages"):
            msgs = req.get("messages") or []
            user = msgs[-1]["content"] if msgs else ""
            if isinstance(user, list):
                user = " ".join(x.get("text", "") for x in user)
            out = mock_tr(extract_source(user))
            return self._json(200, {"id": "msg_mock", "type": "message", "role": "assistant", "model": req.get("model"),
                                    "content": [{"type": "text", "text": out}], "stop_reason": "end_turn"})

        # OpenAI chat completions
        msgs = req.get("messages") or req.get("input") or []
        user = ""
        for m in msgs:
            if m.get("role") == "user":
                c = m.get("content")
                user = c if isinstance(c, str) else " ".join(x.get("text", "") for x in (c or []))
        out = mock_tr(extract_source(user))
        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            pieces = [out[i:i + 40] for i in range(0, len(out), 40)] or [""]
            for p in pieces:
                chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": p}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
            fin = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(("data: " + json.dumps(fin) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
            self.close_connection = True
            return
        return self._json(200, {"id": "chatcmpl-mock", "object": "chat.completion", "model": req.get("model"),
                                "choices": [{"index": 0, "message": {"role": "assistant", "content": out}, "finish_reason": "stop"}]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"mock LLM server on http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
