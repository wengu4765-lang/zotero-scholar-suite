#!/bin/bash
# 启动/重启 mock LLM 服务: mock.sh [port]
PORT=${1:-8765}
PIDF=/tmp/mock-$PORT.pid
[ -f $PIDF ] && kill $(cat $PIDF) 2>/dev/null; sleep 0.5
MOCK_PORT=$PORT nohup python3 "$(dirname "$0")/mock_llm_server.py" > /tmp/mock-$PORT.log 2>&1 &
echo $! > $PIDF; sleep 0.7; echo "mock on $PORT pid $(cat $PIDF)"
