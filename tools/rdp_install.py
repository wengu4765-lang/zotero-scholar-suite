#!/usr/bin/env python3
"""通过 Firefox Remote Debugging Protocol 给运行中的 Zotero 安装临时插件。
用法: rdp_install.py <port> <addon_dir_or_xpi> [...]"""
import json
import socket
import sys
import time


class RDP:
    def __init__(self, port):
        for _ in range(120):
            try:
                self.s = socket.create_connection(("127.0.0.1", port), timeout=60)
                break
            except OSError:
                time.sleep(1)
        else:
            raise SystemExit("cannot connect to debugger server")
        self.buf = b""
        self.recv()  # hello

    def recv(self):
        while True:
            if b":" in self.buf:
                n, rest = self.buf.split(b":", 1)
                n = int(n)
                if len(rest) >= n:
                    msg, self.buf = rest[:n], rest[n:]
                    return json.loads(msg)
            chunk = self.s.recv(65536)
            if not chunk:
                raise SystemExit("connection closed")
            self.buf += chunk

    def request(self, to, type_, **kw):
        kw.update({"to": to, "type": type_})
        data = json.dumps(kw).encode()
        self.s.sendall(str(len(data)).encode() + b":" + data)
        while True:
            r = self.recv()
            if r.get("from") == to:
                return r


def main():
    port = int(sys.argv[1])
    rdp = RDP(port)
    root = rdp.request("root", "getRoot")
    actor = root.get("addonsActor")
    if not actor:
        raise SystemExit("no addonsActor: %r" % root)
    for path in sys.argv[2:]:
        r = rdp.request(actor, "installTemporaryAddon", addonPath=path, openDevTools=False)
        print(json.dumps(r))
        if "error" in r:
            sys.exit(1)


if __name__ == "__main__":
    main()
