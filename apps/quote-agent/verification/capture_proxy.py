"""Logging reverse proxy 127.0.0.1:8000 -> 127.0.0.1:8001. Logs header NAMES and value lengths only."""
import json, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import httpx
UP = "http://127.0.0.1:8001"
LOG = open(sys.argv[1], "a", buffering=1)
client = httpx.Client(timeout=30.0)
class H(BaseHTTPRequestHandler):
    def _go(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        LOG.write(json.dumps({"t": time.time(), "method": self.command, "path": self.path,
                              "headers": {k.lower(): len(v) for k, v in self.headers.items()},
                              "content_type": self.headers.get("content-type"), "body_len": len(body),
                              "body_prefix": body[:60].decode("utf-8", "replace") if self.path.startswith("/webhooks") else None}) + "\n")
        hop = {"host", "content-length", "connection", "transfer-encoding"}
        r = client.request(self.command, UP + self.path, content=body,
                           headers={k: v for k, v in self.headers.items() if k.lower() not in hop})
        self.send_response(r.status_code)
        for k, v in r.headers.items():
            if k.lower() not in hop | {"content-encoding"}:
                self.send_header(k, v)
        self.send_header("content-length", str(len(r.content)))
        self.end_headers()
        self.wfile.write(r.content)
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _go
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", 8000), H).serve_forever()
