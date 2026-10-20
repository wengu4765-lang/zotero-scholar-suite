#!/bin/bash
# 启动/重启演示用中文翻译代理（MyMemory）: zh_proxy.sh [port]
PORT=${1:-8766}
PIDF=/tmp/zhproxy-$PORT.pid
[ -f $PIDF ] && kill $(cat $PIDF) 2>/dev/null; sleep 0.5
ZH_PORT=$PORT nohup python3 "$(dirname "$0")/zh_proxy_server.py" > /tmp/zhproxy-$PORT.log 2>&1 &
echo $! > $PIDF; sleep 0.7; echo "zh proxy on $PORT pid $(cat $PIDF)"
