#!/bin/bash
# 启动/重启测试用 Zotero（Xvfb + 临时 profile），用 Remote Debugging Protocol 安装解包插件
# 用法: zrun.sh [fresh|keep] [额外插件路径...]
#   ADDON_DIR=... 指定主插件（务必指向打包好的 xpi，默认 dist/zotero-scholar-suite-lite-<ver>.xpi）；NO_SUITE=1 不装套件
#   ZBIN=... Zotero 可执行文件（默认 /tmp/Zotero_linux-arm64/zotero；或设 ZOTERO_TARBALL 指向官方 Linux 压缩包自动解压）
#   ZSS_TESTDATA=... 测试 PDF 目录（默认 <仓库>/testdata，见 test/fetch-testdata.sh）
set -u
ZBIN=${ZBIN:-/tmp/Zotero_linux-arm64/zotero}
PROF=/tmp/zprof
DATA=/tmp/zdata
DBG=/tmp/zdbg
PORT=${PORT:-6100}
TOOLS=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$TOOLS")
VER=$(python3 -c "import json;print(json.load(open('$REPO/master/suite.json'))['version'])")
ADDON_DIR=${ADDON_DIR:-$REPO/dist/zotero-scholar-suite-lite-$VER.xpi}
export ZSS_TESTDATA=${ZSS_TESTDATA:-$REPO/testdata}
if [ ! -x "$ZBIN" ]; then
  [ -n "${ZOTERO_TARBALL:-}" ] || { echo "Zotero not found at $ZBIN (set ZBIN or ZOTERO_TARBALL)"; exit 1; }
  (cd /tmp && tar xf "$ZOTERO_TARBALL")
fi
pkill -x zotero-bin; sleep 2
MODE=${1:-keep}; shift || true
if [ "$MODE" = "fresh" ]; then rm -rf $PROF $DATA; fi
mkdir -p $PROF $DATA $DBG
rm -f $DBG/*
cat > $PROF/user.js <<EOP
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
user_pref("extensions.zotero.dataDir", "$DATA");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("intl.locale.requested", "zh-CN");
user_pref("network.proxy.type", 0);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.chrome.enabled", true);
user_pref("extensions.zotero.Knowledge4Zotero.latestTourVersion", 1);
user_pref("browser.dom.window.dump.enabled", true);
EOP
pgrep -x Xvfb >/dev/null || (Xvfb :99 -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &)
sleep 1
cd /tmp
DISPLAY=:99 ZSS_DEBUG_DIR=$DBG nohup env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
  $ZBIN -profile $PROF -ZoteroDebugText -no-remote -start-debugger-server $PORT > /tmp/zotero.log 2>&1 &
sleep 8
# 等 Zotero UI 就绪后再装（插件 startup 会等 uiReadyPromise）
for p in "$@"; do python3 $TOOLS/rdp_install.py $PORT "$p" || echo "install failed: $p"; done
if [ -z "${NO_SUITE:-}" ]; then python3 $TOOLS/rdp_install.py $PORT "$ADDON_DIR" || { echo "suite install failed"; exit 1; }; fi
for i in $(seq 1 90); do [ -f $DBG/READY ] && { echo "READY after ${i}s"; exit 0; }; sleep 1; done
echo "NOT READY (see /tmp/zotero.log)"; exit 1
