#!/bin/bash
# 下载 e2e 用的测试 PDF（体积较大，不放进仓库）到 <仓库>/testdata
#   DreamBooth  https://arxiv.org/abs/2208.12242   （约 23 MB，双栏，全文翻译 / 图内文字测试）
#   LDM         https://arxiv.org/abs/2112.10752   （约 41 MB，用于“超过 30 MB 上限”提示测试）
# 下载的是 arXiv 当前版本，若作者更新过版本，段落/图片计数可能与 PROGRESS 记录略有差异。
set -e
D=${ZSS_TESTDATA:-$(cd "$(dirname "$0")/.." && pwd)/testdata}
mkdir -p "$D"; cd "$D"
[ -f dreambooth-2208.12242.pdf ] || curl -fL -o dreambooth-2208.12242.pdf https://arxiv.org/pdf/2208.12242
[ -f ldm-2112.10752.pdf ] || curl -fL -o ldm-2112.10752.pdf https://arxiv.org/pdf/2112.10752
# 图内文字 e2e（06/07）用的截取版：第 1、2、5 页（需要 ghostscript）
[ -f dreambooth-figtext-p1-2-5.pdf ] || gs -q -sDEVICE=pdfwrite -sPageList=1,2,5 -o dreambooth-figtext-p1-2-5.pdf dreambooth-2208.12242.pdf
ls -la "$D"
