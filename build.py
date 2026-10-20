#!/usr/bin/env python3
"""
Zotero Scholar Suite 构建脚本

用法:
  python3 build.py                     # 构建 Lite 版（Better Notes + Translate），可公开分发
  python3 build.py --with-style        # 构建完整三合一版：额外下载官方 Ethereal Style 6.0.8，
                                       #   校验 sha256 后原样打包进去。仅供本地自用，请勿再分发
  python3 build.py --skip-npm          # 跳过 npm run build，直接用 src/*/build/addon 组装
  python3 build.py --with-style --style-xpi PATH
                                       # 用本地已下载的官方 xpi（同样校验 sha256），不联网
  python3 build.py --dist DIR          # 产物输出目录（默认 ./dist）

产物:
  build/xpi/                                   解包的合并插件（调试用）
  dist/zotero-scholar-suite-lite-<ver>.xpi     Lite 版
  dist/zotero-scholar-suite-full-<ver>.xpi     完整版（--with-style）
  dist/update.json                             Lite 版的 Zotero 更新清单（发布时复制到仓库根目录）

首次构建前需要在 src/pdf-translate 与 src/better-notes 里各执行一次 `npm install`。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
MASTER = os.path.join(HERE, "master")
STAGE = os.path.join(HERE, "build", "xpi")
CACHE = os.path.join(HERE, ".cache")

SUITE = json.load(open(os.path.join(MASTER, "suite.json"), encoding="utf-8"))
SUITE_ID = SUITE["id"]
VERSION = SUITE["version"]

# Ethereal Style 6.x 不开源，只以混淆后的官方 xpi 发布。公开仓库与 Lite 版中不含它的任何文件；
# --with-style 时从作者的 GitHub Releases 下载，并以官方 Release 资产页面公布的 sha256 校验。
# 来源: https://github.com/MuiseDestiny/zotero-style/releases/tag/6.0.8
STYLE = {
    "version": "6.0.8",
    "id": "zoterostyle@polygon.org",
    "url": "https://github.com/MuiseDestiny/zotero-style/releases/download/6.0.8/zotero-style.xpi",
    "sha256": "752937a4bf07f5efa00001aabdc585241071302415fb650864dfaeab390f163b",
    "size": 1494882,
}

TRANSLATE = ("pdf-translate", os.path.join(SRC, "pdf-translate", "build", "addon"))
BETTER_NOTES = ("better-notes", os.path.join(SRC, "better-notes", "build", "addon"))


def npm_build(key):
    d = os.path.join(SRC, key)
    if not os.path.isdir(os.path.join(d, "node_modules")):
        sys.exit(f"{d}/node_modules 不存在：请先在该目录执行 npm install")
    print(f"==> npm run build ({key})")
    r = subprocess.run(["npm", "run", "build"], cwd=d)
    if r.returncode != 0:
        sys.exit(f"build of {key} failed")


def copytree(src, dst):
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".DS_Store", "*.xpi"))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_style(local_xpi=None):
    """返回已校验 sha256 的官方 Ethereal Style xpi 路径。"""
    if local_xpi:
        path = local_xpi
    else:
        os.makedirs(CACHE, exist_ok=True)
        path = os.path.join(CACHE, f"zotero-style-{STYLE['version']}.xpi")
        if not (os.path.exists(path) and sha256_file(path) == STYLE["sha256"]):
            print(f"==> 下载官方 Ethereal Style {STYLE['version']}: {STYLE['url']}")
            tmp = path + ".part"
            req = urllib.request.Request(STYLE["url"], headers={"User-Agent": "zotero-scholar-suite-build"})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(tmp, path)
    digest = sha256_file(path)
    if digest != STYLE["sha256"]:
        sys.exit(
            f"Ethereal Style xpi 的 sha256 不符：\n  期望 {STYLE['sha256']}\n  实际 {digest}\n"
            "拒绝打包（文件可能损坏或不是官方 6.0.8 发布包）。"
        )
    print(f"==> sha256 校验通过: {digest}")
    return path


def extract_style(xpi, dst):
    with zipfile.ZipFile(xpi) as z:
        for info in z.infolist():
            name = info.filename
            if name.endswith("/") or os.path.basename(name) == ".DS_Store" or name.startswith("__MACOSX/"):
                continue
            target = os.path.normpath(os.path.join(dst, name))
            if not target.startswith(os.path.normpath(dst) + os.sep):
                sys.exit(f"unsafe path in style xpi: {name}")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    man = json.load(open(os.path.join(dst, "manifest.json"), encoding="utf-8"))
    mid = man["applications"]["zotero"]["id"]
    if mid != STYLE["id"] or man.get("version") != STYLE["version"]:
        sys.exit(f"unexpected style manifest: id={mid} version={man.get('version')}")


def main():
    ap = argparse.ArgumentParser(description="Build Zotero Scholar Suite")
    ap.add_argument("--with-style", action="store_true",
                    help="下载官方 Ethereal Style 6.0.8 并打包成完整三合一版（仅供本地自用）")
    ap.add_argument("--style-xpi", help="使用本地的官方 Ethereal Style 6.0.8 xpi（仍校验 sha256）")
    ap.add_argument("--skip-npm", action="store_true", help="跳过 npm run build")
    ap.add_argument("--dist", default=os.path.join(HERE, "dist"), help="产物输出目录")
    args = ap.parse_args()
    if args.style_xpi and not args.with_style:
        ap.error("--style-xpi 需要与 --with-style 一起使用")

    variant = "full" if args.with_style else "lite"
    style_xpi = fetch_style(args.style_xpi) if args.with_style else None

    if not args.skip_npm:
        npm_build("pdf-translate")
        npm_build("better-notes")

    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE)

    modules = [TRANSLATE, BETTER_NOTES]
    if style_xpi:
        style_dir = os.path.join(STAGE, "modules", "ethereal-style")
        extract_style(style_xpi, style_dir)
        modules.append(("ethereal-style", None))

    prefs_lines = [
        "// Zotero Scholar Suite — merged default preferences",
        "// (" + ", ".join(k for k, _ in modules) + ", scholar suite)",
    ]
    for key, src in modules:
        dst = os.path.join(STAGE, "modules", key)
        if src is not None:
            if not os.path.isdir(src):
                sys.exit(f"missing module build: {src}（先去掉 --skip-npm 构建一次）")
            copytree(src, dst)
        man = json.load(open(os.path.join(dst, "manifest.json"), encoding="utf-8"))
        mid = man["applications"]["zotero"]["id"]
        # Translate / Better Notes 构建时 addonID 已改为套件 ID（package.json config.addonID）
        if key != "ethereal-style" and mid != SUITE_ID:
            sys.exit(f"{key} was built with addonID {mid}, expected {SUITE_ID}")
        # Ethereal Style 原样打包、保留原 ID：6.0.8 内置自检会按自身 addonID 查找插件，
        # 元数据不符就禁用并卸载“它”。若改成套件 ID，自检会把整个套件卸载。
        # 偏好面板的 pluginID 由主 bootstrap 在运行时映射（不改 Style 的任何文件）。
        pp = os.path.join(dst, "prefs.js")
        if os.path.exists(pp):
            prefs_lines.append(f"\n// ---- {key} ----")
            for line in open(pp, encoding="utf-8"):
                line = line.rstrip("\n")
                if line.strip().startswith("pref("):
                    prefs_lines.append(line)
        # Zotero 只读取 <root>/locale，把各模块的 ftl 合并到根目录
        loc = os.path.join(dst, "locale")
        if os.path.isdir(loc):
            for lang in os.listdir(loc):
                ld = os.path.join(loc, lang)
                if not os.path.isdir(ld):
                    continue
                out = os.path.join(STAGE, "locale", lang)
                os.makedirs(out, exist_ok=True)
                for f in os.listdir(ld):
                    if f.endswith(".ftl"):
                        target = os.path.join(out, f)
                        if os.path.exists(target):
                            sys.exit(f"locale file collision: {lang}/{f}")
                        shutil.copy(os.path.join(ld, f), target)

    sp = os.path.join(MASTER, "prefs.js")
    if os.path.exists(sp):
        prefs_lines.append("\n// ---- scholar suite ----")
        prefs_lines += [l.rstrip("\n") for l in open(sp, encoding="utf-8") if l.strip().startswith("pref(")]
    open(os.path.join(STAGE, "prefs.js"), "w", encoding="utf-8").write("\n".join(prefs_lines) + "\n")

    # 主 bootstrap：写入本包实际包含的子模块
    bs = open(os.path.join(MASTER, "bootstrap.js"), encoding="utf-8").read()
    keys = [k for k, _ in modules]
    marker1 = "var SUITE_BUNDLED_MODULES = null; /* @@SUITE_BUNDLED_MODULES@@ */"
    marker2 = 'var SUITE_VARIANT = "full"; /* @@SUITE_VARIANT@@ */'
    if marker1 not in bs or marker2 not in bs:
        sys.exit("master/bootstrap.js: build markers not found")
    bs = bs.replace(marker1, f"var SUITE_BUNDLED_MODULES = {json.dumps(keys)};")
    bs = bs.replace(marker2, f"var SUITE_VARIANT = {json.dumps(variant)};")
    open(os.path.join(STAGE, "bootstrap.js"), "w", encoding="utf-8").write(bs)

    for f in ("LICENSE", "NOTICE.md"):
        shutil.copy(os.path.join(MASTER, f), STAGE)
    copytree(os.path.join(MASTER, "icons"), os.path.join(STAGE, "icons"))

    v = SUITE["variants"][variant]
    manifest = {
        "manifest_version": 2,
        "name": v["name"],
        "version": VERSION,
        "description": v["description"],
        "author": SUITE["author"],
        "homepage_url": SUITE["homepage"],
        "icons": {"48": "icons/favicon@0.5x.png", "96": "icons/favicon.png"},
        "applications": {
            "zotero": {
                "id": SUITE_ID,
                # 完整版不指向公开更新源，避免被自动“更新”成不含 Style 的 Lite 版
                "update_url": v["update_url"],
                "strict_min_version": SUITE["strict_min_version"],
                "strict_max_version": SUITE["strict_max_version"],
            }
        },
    }
    json.dump(manifest, open(os.path.join(STAGE, "manifest.json"), "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)

    os.makedirs(args.dist, exist_ok=True)
    xpi_name = f"zotero-scholar-suite-{variant}-{VERSION}.xpi"
    xpi = os.path.join(args.dist, xpi_name)
    if os.path.exists(xpi):
        os.remove(xpi)
    with zipfile.ZipFile(xpi, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(STAGE, "manifest.json"), "manifest.json")
        for base, dirs, files in os.walk(STAGE):
            dirs.sort()
            for f in sorted(files):
                full = os.path.join(base, f)
                rel = os.path.relpath(full, STAGE).replace(os.sep, "/")
                if rel == "manifest.json":
                    continue
                z.write(full, rel)
    digest = sha256_file(xpi)
    print(f"==> {xpi} ({os.path.getsize(xpi):,} bytes) [{variant}: {', '.join(keys)}]")
    print(f"    sha256 {digest}")

    if variant == "lite":
        update = {
            "addons": {
                SUITE_ID: {
                    "updates": [
                        {
                            "version": VERSION,
                            "update_link": f"{SUITE['homepage']}/releases/download/v{VERSION}/{xpi_name}",
                            "update_hash": f"sha256:{digest}",
                            "applications": {
                                "zotero": {
                                    "strict_min_version": SUITE["strict_min_version"],
                                    "strict_max_version": SUITE["strict_max_version"],
                                }
                            },
                        }
                    ]
                }
            }
        }
        json.dump(update, open(os.path.join(args.dist, "update.json"), "w", encoding="utf-8"), indent=2)
    else:
        print("    注意：完整版含 Ethereal Style（非开源、版权归原作者），仅供本地自用，请勿再分发。")


if __name__ == "__main__":
    main()
