# Zotero Scholar Suite — 版权与许可声明 / NOTICE

Zotero Scholar Suite 是基于 Better Notes for Zotero 与 Translate for Zotero 的衍生作品，整体以
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** 发布，完整许可证见 `LICENSE`。
依照 AGPL 第 13 条，本作品的完整对应源码（含构建脚本与全部修改）公开于：
<https://github.com/wengu4765-lang/zotero-scholar-suite>

## 两种构建

| 构建 | 包含 | 分发 |
|---|---|---|
| **Lite 版**（默认，`python3 build.py`） | Better Notes + Translate + 套件新增功能 | GitHub Releases 公开发布 |
| **完整版**（`python3 build.py --with-style`） | 以上 + 官方 Ethereal Style 6.0.8 原样文件 | **仅供本地自用，不公开分发** |

公开仓库与 Lite 版**不包含 Ethereal Style 的任何文件**。完整版的构建脚本只是从作者的 GitHub Releases
（<https://github.com/MuiseDestiny/zotero-style/releases/tag/6.0.8>）下载官方 xpi、校验 sha256 后原样放入。

## 包含的组件

| 子模块目录 | 原作品 | 版本 | 原作者 | 许可证 | 本套件中的改动 |
|---|---|---|---|---|---|
| `modules/better-notes/` | Better Notes for Zotero (https://github.com/windingwind/zotero-better-notes) | 3.3.3 | windingwind 及贡献者 | AGPL-3.0-or-later | 仅把构建时的 addonID 改为套件 ID（`package.json` 的 `config.addonID`），其余源码未改 |
| `modules/pdf-translate/` | Translate for Zotero (https://github.com/windingwind/zotero-pdf-translate) | 2.4.8 | windingwind 及贡献者 | AGPL-3.0-or-later | addonID 改为套件 ID；新增「全文翻译（保留图片）」「模型源管理器」及相关菜单、偏好、翻译服务 `profile`；1.1.0 新增「图内文字翻译」（矢量文字叠加、位图经识图模型 OCR、识图模型源预设与设置、纯 CSS 的译文/原图切换），新增代码位于 `src/modules/scholar/`（`fulltext/figureText.ts`、`vision.ts` 等） |
| `modules/ethereal-style/`（**仅完整版**） | Ethereal Style (https://github.com/MuiseDestiny/zotero-style) | 6.0.8（官方发布 xpi） | Polygon / MuiseDestiny | 开源仓库（≤2.x）为 AGPL-3.0；6.x 仅以混淆后的 xpi 发布 | **未做任何修改**，官方 xpi 内容原样放入（保留其原 addonID `zoterostyle@polygon.org`）。原因：6.0.8 自带防重打包自检，会按自身 ID 查找插件并在元数据不符时禁用/卸载，修改 ID 会导致整个套件被卸载。其偏好面板的归属由套件主 `bootstrap.js` 在注册时把 pluginID 映射为套件 ID（运行时包装 `Zotero.PreferencePanes.register`，不改动 Style 的任何文件）。其版权、作者信息、在线授权/会员逻辑均原样保留 |

Ethereal Style 的全部版权归原作者 Polygon（MuiseDestiny）所有。其高级功能若需要作者的授权/会员，仍按原作者的规则执行，本套件不做任何绕过。
Lite 版可与单独安装的官方 Ethereal Style 共存：Lite 版不会把官方 Style 当作冲突，也不会改动它的任何注册。

第三方依赖（pdf.js、KaTeX、zotero-plugin-toolkit、CodeMirror 等）沿用各自的许可证，见各子模块内的说明。
全文翻译使用的是 Zotero 自带的 pdf.js（Mozilla, Apache-2.0），未额外打包。
图内文字翻译不内置任何 OCR 引擎或模型：位图 OCR 通过用户自己配置的识图模型 API（OpenAI / Claude / Gemini / 通义 Qwen-VL / 智谱 GLM 等）完成，图片只发送给用户选定的服务，费用与数据处理遵循该服务商的条款。
测试工具（仓库中的 `test/` 与 `tools/`，含基于 tesseract 的 mock 识图服务）只用于开发测试，不打包进 xpi。
