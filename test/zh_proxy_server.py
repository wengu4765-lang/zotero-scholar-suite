#!/usr/bin/env python3
"""
演示用：OpenAI 兼容 /v1/chat/completions 代理，把待译英文交给 MyMemory 免费接口
(https://api.mymemory.translated.net/get, langpair=en|zh-CN) 拿到真实中文后按 OpenAI 格式返回。
仅用于生成带真实中文的截图，不是插件的一部分。

- 从提示词里取 🔤…🔤 之间的原文（同 mock_llm_server.py）
- 文本 > MAX_CHARS（默认 450）时按句子切分、逐段翻译再拼接
- 本地磁盘缓存：ZH_CACHE（默认 test/out/zh_proxy_cache.json），重跑不再消耗额度
- 匿名额度有限：超额 / 网络失败 → 回退为原文，并记录到日志与 /stats
- 不带 de= 邮箱参数
环境变量：ZH_PORT=8766  ZH_CACHE=...  ZH_MAX_CHARS=450
统计：GET /stats
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("ZH_PORT", "8766"))
CACHE_PATH = os.environ.get("ZH_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "zh_proxy_cache.json"))
MAX_CHARS = int(os.environ.get("ZH_MAX_CHARS", "450"))
API = "https://api.mymemory.translated.net/get"
# 离线：只用缓存 + 测试词表（zh_glossary.json，人工词表，仅覆盖测试论文图内的短标签），不访问 MyMemory
OFFLINE = os.environ.get("ZH_OFFLINE", "") == "1"
GLOSSARY_PATH = os.environ.get("ZH_GLOSSARY", os.path.join(os.path.dirname(os.path.abspath(__file__)), "zh_glossary.json"))
try:
    GLOSSARY = {k: v for k, v in json.load(open(GLOSSARY_PATH, encoding="utf-8")).items() if not k.startswith("_")}
except Exception:
    GLOSSARY = {}

LOCK = threading.Lock()
NET_LOCK = threading.Lock()  # 串行访问 MyMemory，避免被限流
STATS = {"requests": 0, "segments": 0, "cache_hits": 0, "glossary_hits": 0, "api_calls": 0, "api_chars": 0, "fallbacks": 0, "quota_finished": False, "offline": OFFLINE, "errors": []}
try:
    CACHE = json.load(open(CACHE_PATH, encoding="utf-8"))
except Exception:
    CACHE = {}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def save_cache():
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(CACHE, f, ensure_ascii=False)
    os.replace(tmp, CACHE_PATH)


def extract_source(text):
    m = re.search(r"[:：]\s*🔤\s*(.*?)\s*🔤", text, re.S)
    if m:
        return m.group(1)
    parts = text.split("🔤")
    if len(parts) >= 3:
        return max(parts[1:-1], key=len).strip()
    return text


def split_sentences(text, limit=MAX_CHARS):
    """按句子切分，合并到不超过 limit 的片段；超长单句再按逗号/空格硬切。"""
    sents = re.split(r"(?<=[.!?;:])\s+(?=[A-Z0-9(\[])", text)
    out, cur = [], ""
    for s in sents:
        while len(s) > limit:
            cut = max(s.rfind(", ", 0, limit), s.rfind(" ", 0, limit))
            cut = cut if cut > limit // 3 else limit
            piece, s = s[: cut + 1].strip(), s[cut + 1 :].strip()
            if cur:
                out.append(cur); cur = ""
            out.append(piece)
        if cur and len(cur) + 1 + len(s) > limit:
            out.append(cur); cur = s
        else:
            cur = (cur + " " + s).strip()
    if cur:
        out.append(cur)
    return out


def glossary(seg):
    k = re.sub(r"^[\s\-–—:;,./|]+|[\s\-–—:;,./|]+$", "", seg).lower()
    k = re.sub(r"\s+", " ", k)
    return GLOSSARY.get(k)


def mymemory(seg):
    """翻译一段（≤ MAX_CHARS）。返回 (译文, ok)。"""
    with LOCK:
        STATS["segments"] += 1
        if seg in CACHE:
            STATS["cache_hits"] += 1
            return CACHE[seg], True
        if (OFFLINE or STATS["quota_finished"]) and len(seg) <= 80:
            g = glossary(seg)
            if g:
                STATS["glossary_hits"] += 1
                return g, True
        if OFFLINE or STATS["quota_finished"]:
            STATS["fallbacks"] += 1
            return seg, False
    url = API + "?" + urllib.parse.urlencode({"q": seg, "langpair": "en|zh-CN"})
    with NET_LOCK:
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "zh-proxy-demo"}), timeout=30) as r:
                    data = json.loads(r.read().decode("utf-8"))
                with LOCK:
                    STATS["api_calls"] += 1
                    STATS["api_chars"] += len(seg)
                tr = (data.get("responseData") or {}).get("translatedText") or ""
                status = int(data.get("responseStatus") or 0)
                if data.get("quotaFinished") or status == 429 or "MYMEMORY WARNING" in tr.upper():
                    with LOCK:
                        STATS["quota_finished"] = True
                        STATS["fallbacks"] += 1
                        STATS["errors"].append("quota finished: " + tr[:160])
                    log("QUOTA FINISHED:", tr[:160])
                    return seg, False
                # 人名、机构名等 MyMemory 会原样返回（无中文），也视为成功
                if status != 200 or not tr:
                    raise RuntimeError(f"status={status} details={data.get('responseDetails')!r} tr={tr[:80]!r}")
                with LOCK:
                    CACHE[seg] = tr
                    save_cache()
                return tr, True
            except urllib.error.HTTPError as e:
                if e.code == 429:  # 匿名每日额度用完 / 限流：不再请求，直接回退原文
                    with LOCK:
                        STATS["quota_finished"] = True
                        STATS["fallbacks"] += 1
                        STATS["errors"].append("HTTP 429 quota/rate limit")
                    log("HTTP 429: quota finished, falling back to source text")
                    return seg, False
                log("mymemory http error", attempt, e.code)
                with LOCK:
                    STATS["errors"].append(f"HTTP {e.code}")
                time.sleep(1.5 * (attempt + 1))
            except Exception as e:  # noqa
                log("mymemory error", attempt, repr(e)[:200])
                with LOCK:
                    STATS["errors"].append(repr(e)[:200])
                time.sleep(1.5 * (attempt + 1))
    with LOCK:
        STATS["fallbacks"] += 1
    return seg, False


BATCH_RE = re.compile(r"^\s*\[(\d{1,3})\]\s*(.*)$")


def translate(text):
    text = text.strip()
    if not text:
        return text
    # 图内文字的批量请求：多行 "[n] 标签"，逐行翻译并保留编号
    lines = [l for l in text.split("\n") if l.strip()]
    if len(lines) >= 2 and all(BATCH_RE.match(l) for l in lines):
        return "\n".join(f"[{BATCH_RE.match(l).group(1)}] {translate(BATCH_RE.match(l).group(2))}" for l in lines)
    # 纯符号 / 数字 / 极短串（如 “(a)”, “1”）不译
    if not re.search(r"[A-Za-z]{2,}", text):
        return text
    segs = [text] if len(text) <= MAX_CHARS else split_sentences(text)
    outs = [mymemory(s)[0] for s in segs]
    return "".join(outs)


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
                return self._json(200, dict(STATS, cache_size=len(CACHE)))
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "mymemory-zh", "object": "model"}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        with LOCK:
            STATS["requests"] += 1
        msgs = req.get("messages") or []
        user = ""
        for m in msgs:
            if m.get("role") == "user":
                c = m.get("content")
                user = c if isinstance(c, str) else " ".join(x.get("text", "") for x in (c or []))
        src = extract_source(user)
        out = translate(src)
        log(f"req {len(src)} chars -> {out[:40]!r}")
        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            for i in range(0, max(len(out), 1), 40):
                chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": out[i:i + 40]}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
            fin = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(("data: " + json.dumps(fin) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
            self.close_connection = True
            return
        return self._json(200, {"id": "chatcmpl-zh", "object": "chat.completion", "model": req.get("model"),
                                "choices": [{"index": 0, "message": {"role": "assistant", "content": out}, "finish_reason": "stop"}]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    log(f"zh proxy (MyMemory en->zh-CN) on http://127.0.0.1:{PORT}, cache {CACHE_PATH} ({len(CACHE)} entries)")
    srv.serve_forever()
