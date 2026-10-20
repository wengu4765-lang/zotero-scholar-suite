pref-general = 通用

pref-basic-enableAuto =
    .label = 自动翻译选择内容
pref-basic-enableComment =
    .label = 自动翻译注释
pref-basic-enablePopup =
    .label = 启用阅读器选择弹窗
pref-basic-enableHidePopupTextarea =
    .label = 隐藏弹窗文本区域
pref-basic-annotationTranslationInComment =
    .label = 保存翻译至注释评论
pref-basic-annotationTranslationInBody =
    .label = 保存翻译至注释正文
pref-basic-annotationTranslationInBodyBeforeText =
    .label = 翻译置于注释正文前
pref-basic-annotationTranslationInBodyAfterText =
    .label = 翻译置于注释正文后
pref-basic-enableAnnotationFromSyncTranslation =
    .label = 自动翻译来自同步的注释
pref-basic-enableNote =
    .label = 在弹窗中显示“添加翻译至笔记”
pref-basic-enableNoteReplaceMode =
    .label = 添加翻译至笔记时替换原始文本
pref-basic-enableAutoTagAnnotation =
    .label = 翻译后自动为注释添加标签
pref-basic-annotationTagContent =
    .value = 标签
pref-audio-autoPlay =
    .label = 自动播放发音
pref-audio-showPlayBtn =
    .label = 弹窗中显示播放按钮🔊

pref-service = 服务

pref-service-sentenceServices =
    .value = 翻译服务
pref-service-sentenceServicesSecret =
    .value = 密钥
pref-service-attachPaperContext =
    .label = 向GPT/Claude/Gemini服务提供论文标题和摘要
pref-service-useWordService =
    .label = 使用字典服务翻译词语
pref-service-wordServices =
    .value = 字典服务
pref-service-wordServicesSecret =
    .value = 密钥
pref-service-langfrom =
    .value = 从
pref-service-langto =
    .value = 翻译到
pref-service-hint =
    .value = 服务📍需要自定义配置；🗝️需要密钥。详情请参阅GitHub

pref-service-manageKeys =
    .label = 密钥管理
pref-service-manageKeys-hint =
    .value = 展示已保存的密钥以便批量导入和导出：
pref-service-renameServices =
    .label = 重命名自定义GPT🗝️服务
pref-service-renameServices-hint =
    .value = 显示服务以重命名或查看映射：

pref-interface = 用户界面

pref-interface-fontSize =
    .value = 字体大小
pref-interface-lineHeight =
    .value = 行高
pref-interface-showItemMenu =
    .label = 显示条目上下文菜单
pref-interface-showItemMenuTitleTranslation =
    .label = 条目上下文菜单：显示标题翻译
pref-interface-showItemMenuAbstractTranslation =
    .label = 条目上下文菜单：显示摘要翻译
pref-interface-showSidebarEngine =
    .label = 条目面板区块：显示翻译服务选择菜单
pref-interface-hideUnconfiguredServices =
    .label = 条目面板区块：在菜单中隐藏未配置的服务
pref-interface-showSidebarLanguage =
    .label = 条目面板区块：显示语言选择菜单
pref-interface-showSidebarSettings =
    .label = 条目面板区块：显示自动翻译设置
pref-interface-showSidebarConcat =
    .label = 条目面板区块：显示拼接翻译菜单
pref-interface-enableConcatKey =
    .label = 条目面板区块：按住 { PLATFORM() ->
        [macos] ⌘
       *[other] Ctrl
    } 键激活拼接模式
pref-interface-showSidebarRaw =
    .label = 条目面板区块：显示原文
pref-interface-enableMathRendering =
    .label = 条目面板区块：在翻译中渲染 LaTeX 公式
pref-interface-showSidebarCopy =
    .label = 条目面板区块：显示复制按钮
pref-interface-rawResultOrder =
    .label = 条目面板区块：反转原文与翻译文本顺序
pref-interface-showItemBoxTitleTranslation =
    .label = 信息栏：显示标题翻译
pref-interface-showItemBoxAbstractTranslation =
    .label = 信息栏：显示摘要翻译
pref-interface-keepWindowTop =
    .label = 独立窗口：保持最前
pref-interface-keepPopupSize =
    .label = 弹窗：记住大小

pref-advanced = 高级

pref-advanced-enableAutoDetectLanguage =
    .label = 自动检测条目语言
pref-advanced-disabledLanguages =
    .value = 对文件语言禁用自动翻译（用逗号分隔）
pref-advanced-disabledLanguages-alert = 重新打开文件或重启Zotero以应用更改。
pref-advanced-extraEngines =
    .value = 独立窗口额外翻译服务（用逗号分隔）
pref-advanced-splitChar =
    .value = 分隔符（原文与翻译之间）
pref-advanced-resultRegex =
    .value = 用于移除翻译结果中多余文本的正则表达式（留空以禁用）
pref-advanced-reset =
    .value = 重置库中选中条目的字段：
pref-advanced-reset-titleTranslation =
    .label = 标题翻译
pref-advanced-reset-abstractTranslation =
    .label = 摘要翻译

pref-about = 关于

pref-about-feedback =
    .value = GitHub
pref-about-docs =
    .value = 文档 (中文)
pref-about-version =
    .value = { $name } 版本 { $version } Build { $time }

pref-advanced-stripEmptyLines =
    .label = 从翻译结果中删除空行和思考内容



pref-scholar-title = Scholar Suite：全文翻译（保留图片）与模型源
pref-scholar-desc = 全文翻译会解析 PDF 的文字与图片，图表、公式以截图保留在原位置，生成中英对照 HTML 附件。翻译服务使用上方选择的翻译服务（启用模型源后即为当前模型源）。
pref-scholar-openManager =
    .label = 打开模型源管理…
pref-scholar-maxSize = PDF 大小上限（MB）：
pref-scholar-concurrency = 并发请求数：
pref-scholar-retries = 失败重试次数：
pref-scholar-scale = 图片清晰度（渲染倍数）：
pref-scholar-format = 图片格式：
pref-scholar-format-auto =
    .label = 自动（照片 JPEG，图表/公式 PNG）
pref-scholar-format-png =
    .label = 全部 PNG（无损，文件更大）
pref-scholar-format-jpeg =
    .label = 全部 JPEG（文件更小）
pref-scholar-equations =
    .label = 行间公式以图片保留（不翻译）
pref-scholar-autoOpen =
    .label = 完成后自动打开译文

pref-scholar-figtext-title = 图内文字翻译
pref-scholar-figtext-desc = 把图片 / 图表里的文字翻成中文，以可切换的译文叠层显示在原图上（原图不重绘）。矢量图的文字直接从 PDF 读取，免费；位图（照片、截图）需调用识图模型做 OCR，按图计费。识图模型源在「模型源管理」中指定，未指定时使用当前源（需勾选“支持图片输入”）。
pref-scholar-figtext-enabled =
    .label = 翻译图内文字（矢量图，免费）
pref-scholar-figtext-ocr =
    .label = 位图 OCR：调用识图模型识别照片 / 截图里的文字（会产生费用）
pref-scholar-figtext-skipSmall =
    .label = 跳过过小的图：宽和高都小于
pref-scholar-figtext-minSize-unit = pt（1 pt ≈ 0.35 mm）
pref-scholar-figtext-skipPhoto =
    .label = 跳过像照片的图（只影响 OCR，节省费用）
pref-scholar-figtext-maxImages = 最多处理图片数：
pref-scholar-figtext-ocrTimeout = 单张 OCR 超时（秒）：
