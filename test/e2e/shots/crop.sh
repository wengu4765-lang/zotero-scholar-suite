#!/bin/bash
# crop.sh <figure序号> <输出.png> [底部额外像素] [toolbar=从窗口顶部截起]
# 前提：Zotero 主窗口最大化 1600x1000（窗口 0,0），快照阅读器内容区相对屏幕偏移 y=117
cd "$(dirname "$0")/../../.."
H=$(dirname "$0")
python3 tools/zeval.py "globalThis.__ftxIdx=$1; return 1" >/dev/null
R=$(python3 tools/zeval.py -f $H/scroll.js | python3 -c "import json,sys;v=json.load(sys.stdin)['value'];r=v['rect'];print(r[0],r[1],r[2],r[3])")
read X Y W HH <<< "$R"
EB=${3:-0}
DISPLAY=:99 import -window root /tmp/full.png
if [ -n "$4" ]; then
  convert /tmp/full.png -crop 1600x$((Y+117+HH+EB+12))+0+0 +repage "$2"
else
  convert /tmp/full.png -crop $((W+24))x$((HH+EB+24))+$((X-12))+$((Y+117-12)) +repage "$2"
fi
echo "$2 $R"
