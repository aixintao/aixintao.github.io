"""同时提供站点静态文件和水排序求解接口。

在仓库根目录运行：

    python solver/server.py
"""

from __future__ import annotations

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys

from water_sort import solve

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 64 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/solve":
            self._json(404, {"status": "invalid", "message": "没有这个接口。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"status": "invalid", "message": "请求头不正确。"})
            return
        if length < 0 or length > MAX_BODY:
            self._json(400, {"status": "invalid", "message": "请求太大。"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"status": "invalid", "message": "请求不是合法的 JSON。"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"status": "invalid", "message": "请求格式不正确。"})
            return
        result = solve(payload.get("tubes"), payload.get("capacity"))
        self._json(200, result)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    port = 8765
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"http://127.0.0.1:{port}/works/water-sort.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
