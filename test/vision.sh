#!/bin/bash
# 启动/重启 mock 识图（OCR）服务: vision.sh [port]   （测试用，基于 tesseract）
PORT=${1:-8767}
PIDF=/tmp/vision-$PORT.pid
[ -f $PIDF ] && kill $(cat $PIDF) 2>/dev/null; sleep 0.5
VISION_PORT=$PORT nohup python3 "$(dirname "$0")/mock_vision_server.py" > /tmp/vision-$PORT.log 2>&1 &
echo $! > $PIDF; sleep 0.7; echo "mock vision on $PORT pid $(cat $PIDF)"
