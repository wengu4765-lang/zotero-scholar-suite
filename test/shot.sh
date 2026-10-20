#!/bin/bash
# 用 headless Chromium 给 HTML 截图: shot.sh in.html out.png [width] [height]
W=${3:-1280}; H=${4:-4000}
chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=$W,$H --screenshot="$2" "file://$(realpath "$1")" >/dev/null 2>&1
