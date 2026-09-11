#!/usr/bin/env python3
"""本機靜態伺服器 —— 只服務這個資料夾，不對外開放。

    python serve.py           # 預設 http://localhost:9321
    python serve.py 9500      # 指定連接埠
"""

from __future__ import annotations

import functools
import http.server
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Server(http.server.ThreadingHTTPServer):
    # 多執行緒是必要的：瀏覽器會同時開好幾條 keep-alive 連線，
    # 單執行緒的 TCPServer 會被前一條連線卡住而永遠不回應。
    daemon_threads = True
    allow_reuse_address = True


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".pdf": "application/pdf",
        ".webp": "image/webp",
    }

    def end_headers(self):
        # 開發時不要讓瀏覽器快取，改了程式直接重新整理就會生效
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9321
    handler = functools.partial(Handler, directory=str(ROOT))

    for attempt in range(port, port + 20):
        try:
            with Server(("127.0.0.1", attempt), handler) as httpd:
                url = f"http://localhost:{attempt}"
                print(f"PDF 頁面編輯器已啟動： {url}")
                print("按 Ctrl+C 結束。\n")
                threading.Timer(0.6, webbrowser.open, [url]).start()
                httpd.serve_forever()
            return
        except OSError:
            print(f"連接埠 {attempt} 被占用，改試 {attempt + 1}…")
        except KeyboardInterrupt:
            print("\n已停止。")
            return


if __name__ == "__main__":
    main()
