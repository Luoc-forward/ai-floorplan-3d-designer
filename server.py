# -*- coding: utf-8 -*-
"""
AI 户型 3D 设计器 —— 零依赖后端
职责：
  1. 托管 web/ 静态前端；
  2. 代理豆包视觉识别 API（API Key 只保存在服务端，不暴露给浏览器）；
  3. 本地开发服务器，Python 标准库即可运行：python server.py
"""
import base64, json, os, sys, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3"
DEFAULT_MODEL = "doubao-seed-evolving"
CONFIG_PATH = os.path.join(ROOT, ".ark-config.json")

PROMPT = """识别这张中国住宅户型平面图（黑色填充为墙体）。只输出 JSON 对象，不要 markdown、不要解释。
坐标归一化到 0-1000：图片左上角为(0,0)，右下角为(1000,1000)，x/y 两轴各自独立归一化。
每道墙用单根中心线表示，在交点处断开闭合。
严格按此结构输出：
{"walls":[{"id":"w1","from":[x,y],"to":[x,y],"thicknessMm":200,"loadBearing":true}],
"doors":[{"id":"d1","wallId":"w1","at":[x,y],"widthMm":900,"kind":"swing","hingeSide":"left","opensInward":true}],
"windows":[{"id":"win1","wallId":"w1","from":[x,y],"to":[x,y],"kind":"normal","sillMm":900}],
"rooms":[{"id":"r1","name":"","type":"living_room","polygon":[[x,y]]}],
"dimensions":[{"text":"9000","from":[x,y],"to":[x,y]}],
"entranceDoorId":"d1","northDirectionDeg":0,"notes":""}
规则：
1. walls 覆盖全部外墙与内墙，外墙 thicknessMm=200 且 loadBearing=true，内墙 100；
2. 门只数真实门洞：平开门(有门弧) kind=swing，推拉门(平行双线) kind=sliding，折叠门 folding；hingeSide 为合页所在侧(left/right)，opensInward 表示是否向房间内开；
3. 窗只数窗洞：普通 normal、飘窗 bay、落地窗 floor；sillMm 默认 900；
4. 房间 type 取值 living_room/dining_room/bedroom/kitchen/bathroom/balcony/study/other，name 用图中文字；
5. dimensions 照抄图中尺寸数字，from/to 为该尺寸界线两端；
6. 不确定的元素不要编造，写入 notes。"""


def load_config():
    """生效配置：首页保存的 .ark-config.json 优先，其次环境变量，最后默认值。"""
    file_cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                file_cfg = json.load(f)
        except Exception:
            file_cfg = {}
    api_key = (file_cfg.get("apiKey") or os.environ.get("ARK_API_KEY") or "").strip()
    source = "file" if file_cfg.get("apiKey") else ("env" if os.environ.get("ARK_API_KEY") else "")
    if not api_key:  # 兼容旧版 .ark-key
        p = os.path.join(ROOT, ".ark-key")
        if os.path.exists(p):
            api_key = open(p, encoding="utf-8").read().strip()
            source = "legacy"
    base_url = (file_cfg.get("baseUrl") or os.environ.get("ARK_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
    model = (file_cfg.get("model") or os.environ.get("ARK_MODEL") or DEFAULT_MODEL).strip()
    return {"apiKey": api_key, "baseUrl": base_url, "model": model, "keySource": source}


def effective_config(over=None):
    cfg = load_config()
    over = over or {}
    if over.get("baseUrl"):
        cfg["baseUrl"] = over["baseUrl"].strip().rstrip("/")
    if over.get("model"):
        cfg["model"] = over["model"].strip()
    if over.get("apiKey"):
        cfg["apiKey"] = over["apiKey"].strip()
    return cfg


def save_config(data):
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    if "baseUrl" in data:
        cfg["baseUrl"] = (data.get("baseUrl") or "").strip().rstrip("/")
    if "model" in data:
        cfg["model"] = (data.get("model") or "").strip()
    if data.get("apiKey"):
        cfg["apiKey"] = data["apiKey"].strip()
    if data.get("clearKey"):
        cfg.pop("apiKey", None)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass
    return cfg


def chat_endpoint(cfg):
    b = cfg["baseUrl"].rstrip("/")
    return b if b.endswith("/chat/completions") else b + "/chat/completions"


def mask_key(key):
    return (("*" * max(0, len(key) - 4)) + key[-4:]) if key else ""


def raw_configured():
    """仅返回用户显式配置（文件/环境变量）的值；未配置返回空串，用于前端展示。"""
    file_cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                file_cfg = json.load(f)
        except Exception:
            file_cfg = {}
    base_url = (file_cfg.get("baseUrl") or os.environ.get("ARK_BASE_URL") or "").strip().rstrip("/")
    model = (file_cfg.get("model") or os.environ.get("ARK_MODEL") or "").strip()
    return base_url, model


def public_config():
    c = load_config()
    base_url, model = raw_configured()
    return {"hasKey": bool(c["apiKey"]), "model": model, "baseUrl": base_url,
            "keyMask": mask_key(c["apiKey"]), "keySource": c["keySource"]}


def test_ark(cfg):
    if not cfg["apiKey"]:
        raise RuntimeError("未配置 API Key，请先填写")
    body = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 16, "stream": False,
    }
    req = urllib.request.Request(
        chat_endpoint(cfg), data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {cfg['apiKey']}", "Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=30) as resp:
        json.loads(resp.read().decode("utf-8"))
    return round(time.time() - t0, 1)


def call_ark(data_url: str, thinking: bool, cfg=None):
    cfg = cfg or load_config()
    key = cfg["apiKey"]
    if not key:
        raise RuntimeError("未配置 API Key：请在首页「模型设置」中配置，或设置环境变量 ARK_API_KEY")
    body = {
        "model": cfg["model"],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}],
        "max_tokens": 6000,
        "temperature": 0.1,
        "stream": True,
        "thinking": {"type": "enabled" if thinking else "disabled"},
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        chat_endpoint(cfg), data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    t0 = time.time()
    parts, reasoning = [], 0
    with urllib.request.urlopen(req, timeout=600) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            p = line[5:].strip()
            if p == "[DONE]":
                break
            try:
                ch = json.loads(p)
            except json.JSONDecodeError:
                continue
            delta = ch.get("choices", [{}])[0].get("delta", {})
            if delta.get("reasoning_content"):
                reasoning += len(delta["reasoning_content"])
            if delta.get("content"):
                parts.append(delta["content"])
    text = "".join(parts).strip()
    if text.startswith("```"):
        text = text[text.find("{"):text.rfind("}") + 1]
    return json.loads(text), round(time.time() - t0, 1), reasoning


MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".webp": "image/webp",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "FloorPlan3D/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            return self._send(200, json.dumps(public_config(), ensure_ascii=False))
        rel = path.lstrip("/") or "index.html"
        fp = os.path.normpath(os.path.join(WEB, rel))
        if not fp.startswith(WEB) or not os.path.isfile(fp):
            return self._send(404, "Not Found", "text/plain; charset=utf-8")
        ext = os.path.splitext(fp)[1].lower()
        self._send(200, open(fp, "rb").read(), MIME.get(ext, "application/octet-stream"))

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if path == "/api/config/save":
            try:
                save_config(payload)
                return self._send(200, json.dumps(public_config(), ensure_ascii=False))
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False))
        if path == "/api/config/test":
            try:
                cfg = effective_config(payload)
                elapsed = test_ark(cfg)
                return self._send(200, json.dumps({"ok": True, "elapsed": elapsed, "model": cfg["model"]}, ensure_ascii=False))
            except urllib.error.HTTPError as e:
                msg = e.read().decode("utf-8", "ignore")[:300]
                return self._send(502, json.dumps({"error": f"上游 API 错误 {e.code}: {msg}"}, ensure_ascii=False))
            except Exception as e:
                return self._send(502, json.dumps({"error": str(e)}, ensure_ascii=False))
        if path != "/api/recognize":
            return self._send(404, json.dumps({"error": "not found"}))
        try:
            raw, elapsed, reasoning = call_ark(payload["image"], bool(payload.get("thinking")))
            return self._send(200, json.dumps({"raw": raw, "elapsed": elapsed,
                                               "reasoningChars": reasoning}, ensure_ascii=False))
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "ignore")[:500]
            return self._send(502, json.dumps({"error": f"上游 API 错误 {e.code}: {msg}"}, ensure_ascii=False))
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    _cfg = load_config()
    print(f"AI 户型 3D 设计器已启动: http://localhost:{port}")
    print(f"模型: {_cfg['model']} | 接口: {_cfg['baseUrl']}")
    print(f"API Key: {'已配置' if _cfg['apiKey'] else '未配置（可在首页「模型设置」中配置）'}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
