#!/usr/bin/env python3
"""在运行中的 Zotero 里执行 JS（经套件调试桥）。用法: zeval.py 'return Zotero.version' 或 zeval.py -f file.js [--timeout N]"""
import sys, os, time, json, uuid
DBG = "/tmp/zdbg"
args = sys.argv[1:]
timeout = 60
if "--timeout" in args:
    i = args.index("--timeout"); timeout = float(args[i+1]); del args[i:i+2]
if args and args[0] == "-f":
    code = open(args[1]).read()
else:
    code = args[0] if args else sys.stdin.read()
name = f"{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}"
tmp = os.path.join(DBG, name + ".tmp")
open(tmp, "w").write(code)
os.rename(tmp, os.path.join(DBG, name + ".js"))
out = os.path.join(DBG, name + ".out.json")
t0 = time.time()
while time.time() - t0 < timeout:
    if os.path.exists(out):
        r = json.load(open(out)); os.remove(out)
        print(json.dumps(r, indent=2, ensure_ascii=False))
        sys.exit(0 if r.get("ok") else 2)
    time.sleep(0.3)
print("TIMEOUT"); sys.exit(3)
