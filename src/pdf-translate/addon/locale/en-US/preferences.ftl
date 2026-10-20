pref-general = General

pref-basic-enableAuto =
    .label = Automatically Translate Selection
pref-basic-enableComment =
    .label = Automatically Translate Annotation
pref-basic-enablePopup =
    .label = Enable Reader Selection Pop-up
pref-basic-enableHidePopupTextarea =
    .label = Hide Pop-up Text Area
pref-basic-annotationTranslationInComment =
    .label = Save Translation in Annotation Comment
pref-basic-annotationTranslationInBody =
    .label = Save Translation in Annotation Body
pref-basic-annotationTranslationInBodyBeforeText =
    .label = Before Annotation Text
pref-basic-annotationTranslationInBodyAfterText =
    .label = After Annotation Text
pref-basic-enableAnnotationFromSyncTranslation =
    .label = Automatically Translate Annotation from Sync
pref-basic-enableNote =
    .label = Show "Add Translation to Note" in Pop-up
pref-basic-enableNoteReplaceMode =
    .label = Replace Raw Text When Adding Translation to Note
pref-basic-enableAutoTagAnnotation =
    .label = Automatically Tag Annotation After Translation
pref-basic-annotationTagContent =
    .value = Tag
pref-audio-autoPlay =
    .label = Auto-play Pronunciation
pref-audio-showPlayBtn =
    .label = Show Play Buttons🔊 in Pop-up Panel

pref-service = Service

pref-service-sentenceServices =
    .value = Translation Services
pref-service-sentenceServicesSecret =
    .value = Secret
pref-service-attachPaperContext =
    .label = Feed GPT/Claude/Gemini Services with Title and Abstract
pref-service-useWordService =
    .label = Use Dictionary Service for Word Translation
pref-service-wordServices =
    .value = Dictionary Services
pref-service-wordServicesSecret =
    .value = Secret
pref-service-langfrom =
    .value = Translate From
pref-service-langto =
    .value = To
pref-service-hint =
    .value = Service📍requires custom configuration; 🗝️requires a secret key. See GitHub for details

pref-service-manageKeys =
    .label = Manage Secret Keys
pref-service-manageKeys-hint =
    .value = Display saved secret keys for bulk import and export:
pref-service-renameServices =
    .label = Rename Custom GPT🗝️ Services
pref-service-renameServices-hint =
    .value = Show Services to rename or view mappings:

pref-interface = User Interface

pref-interface-fontSize =
    .value = Font Size
pref-interface-lineHeight =
    .value = Line Height
pref-interface-showItemMenu =
    .label = Show Item Context Menu
pref-interface-showItemMenuTitleTranslation =
    .label = Item Context Menu: Show Title Translation
pref-interface-showItemMenuAbstractTranslation =
    .label = Item Context Menu: Show Abstract Translation
pref-interface-showSidebarEngine =
    .label = Item Pane Section: Show Service Selection Menu
pref-interface-hideUnconfiguredServices =
    .label = Item Pane Section: Hide Unconfigured Services from Menu
pref-interface-showSidebarLanguage =
    .label = Item Pane Section: Show Language Selection Menu
pref-interface-showSidebarSettings =
    .label = Item Pane Section: Show Auto-Trans Settings
pref-interface-showSidebarConcat =
    .label = Item Pane Section: Show Concatenated Translation Menu
pref-interface-enableConcatKey =
    .label = Item Pane Section: Hold down { PLATFORM() ->
        [macos] ⌘
       *[other] Ctrl
    } to enable Concat Mode
pref-interface-showSidebarRaw =
    .label = Item Pane Section: Show Raw
pref-interface-enableMathRendering =
    .label = Item Pane Section: Render LaTeX math in translation
pref-interface-showSidebarCopy =
    .label = Item Pane Section: Show Copy Buttons
pref-interface-rawResultOrder =
    .label = Item Pane Section: Reverse Order of Raw and Translated Text
pref-interface-showItemBoxTitleTranslation =
    .label = Item Pane Info: Show Title Translation
pref-interface-showItemBoxAbstractTranslation =
    .label = Item Pane Info: Show Abstract Translation
pref-interface-keepWindowTop =
    .label = Standalone: Keep Window on Top
pref-interface-keepPopupSize =
    .label = Pop-up: Remember Size

pref-advanced = Advanced

pref-advanced-enableAutoDetectLanguage =
    .label = Automatically Detect Item Language
pref-advanced-disabledLanguages =
    .value = Disable automatic translation for file languages (comma-separated)
pref-advanced-disabledLanguages-alert = Reopen files or restart Zotero to apply changes.
pref-advanced-extraEngines =
    .value = Additional services in standalone window (comma-separated)
pref-advanced-splitChar =
    .value = Delimiter (between text and translation)
pref-advanced-resultRegex =
    .value = Regex for removing extra text from translation results (leave empty to disable)
pref-advanced-reset =
    .value = Reset field of selected items in library:
pref-advanced-reset-titleTranslation =
    .label = Title Translation
pref-advanced-reset-abstractTranslation =
    .label = Abstract Translation

pref-about = About

pref-about-feedback =
    .value = GitHub
pref-about-docs =
    .value = Documentation (ZH)
pref-about-version =
    .value = { $name } Version { $version } Build { $time }

pref-advanced-stripEmptyLines =
    .label = Strip empty lines and thinking from translation results


pref-scholar-title = Scholar Suite: Full-text Translation (keep figures) & Model Sources
pref-scholar-desc = Full-text translation parses the PDF text and images; figures, tables and display equations are kept as images in place, producing a bilingual HTML attachment. It uses the translation service selected above (the active model source once one is enabled).
pref-scholar-openManager =
    .label = Open Model Source Manager…
pref-scholar-maxSize = Max PDF size (MB):
pref-scholar-concurrency = Concurrent requests:
pref-scholar-retries = Retries on failure:
pref-scholar-scale = Image resolution (render scale):
pref-scholar-format = Image format:
pref-scholar-format-auto =
    .label = Auto (photos JPEG, charts/equations PNG)
pref-scholar-format-png =
    .label = PNG for all (lossless, larger)
pref-scholar-format-jpeg =
    .label = JPEG for all (smaller)
pref-scholar-equations =
    .label = Keep display equations as images (not translated)
pref-scholar-autoOpen =
    .label = Open the translation when finished

pref-scholar-figtext-title = Translate text inside figures
pref-scholar-figtext-desc = Text inside figures and charts is translated and shown as a switchable overlay on top of the untouched image. Vector text is read from the PDF (free); raster images (photos, screenshots) need a vision model for OCR, billed per image. Choose the vision source in the Model Source Manager; without one, the current source is used if it is marked "accepts images".
pref-scholar-figtext-enabled =
    .label = Translate text inside figures (vector, free)
pref-scholar-figtext-ocr =
    .label = Raster OCR: let a vision model read text in photos / screenshots (costs money)
pref-scholar-figtext-skipSmall =
    .label = Skip small figures: width and height below
pref-scholar-figtext-minSize-unit = pt (1 pt ≈ 0.35 mm)
pref-scholar-figtext-skipPhoto =
    .label = Skip photo-like figures (OCR only, saves money)
pref-scholar-figtext-maxImages = Max figures to process:
pref-scholar-figtext-ocrTimeout = OCR timeout per image (s):
