#!/bin/bash
# 用打包好的 xpi 启动 Zotero 10，跑 06（建源+导入截取版+全文翻译）并等 07 出结果
set -e
cd "$(dirname "$0")/../../.."
ADDON_DIR=${ADDON_DIR:-$PWD/dist/zotero-scholar-suite-lite-1.1.0.xpi} timeout 110 tools/zrun.sh fresh | tail -1
python3 tools/zeval.py 'const w=Zotero.getMainWindow(); w.moveTo(0,0); w.resizeTo(1600,1000); return 1' >/dev/null
python3 tools/zeval.py -f test/e2e/06-figtext-setup.js > /tmp/r06.json
for i in $(seq 1 30); do sleep 3; python3 tools/zeval.py -f test/e2e/07-figtext-result.js > /tmp/r07.json; grep -q '"done": true' /tmp/r07.json && break; done
python3 -c "
import json;d=json.load(open('/tmp/r07.json'))['value'];print(d.get('stats'),d.get('figureText'),d.get('figureFailures'))"
