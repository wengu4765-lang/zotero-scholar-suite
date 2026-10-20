import { PatchHelper } from "zotero-plugin-toolkit";
import { initEditorImagePreviewer } from "./image";
import { injectEditorCSS, injectEditorScripts } from "./inject";
import { initEditorPlugins } from "./plugins";
import { initEditorMenu } from "./menu";
import { initEditorPopup } from "./popup";
import { initEditorToolbar } from "./toolbar";
import { initEditorSections } from "./section";
import { initEditorMagicKeyCommands } from "./magicKey";
import {
  initEditorMarkdownMode,
  registerMarkdownEditorBackend,
  registerMarkdownModePrefObserver,
  unregisterMarkdownEditorBackend,
  unregisterMarkdownModePrefObserver,
} from "./markdownMode";
import { config } from "../../../package.json";

let prefsObserver = Symbol();

export function registerEditorInstanceHook() {
  new PatchHelper().setData({
    target: Zotero.Notes,
    funcSign: "registerEditorInstance",
    patcher: (origin) =>
      function (this: typeof Zotero.Notes, instance: Zotero.EditorInstance) {
        origin.apply(this, [instance]);
        // Fire-and-forget: a rejection here would otherwise surface as an
        // unhandled promise rejection (opaque `undefined` for content-side
        // errors during editor reinitialization).
        onEditorInstanceCreated(instance).catch((e) =>
          ztoolkit.log("[BN editor init] error", e),
        );
      },
    enabled: true,
    pluginID: config.addonID,
  });
  Zotero.Notes._editorInstances.forEach((instance) => {
    onEditorInstanceCreated(instance).catch((e) =>
      ztoolkit.log("[BN editor init] error", e),
    );
  });

  // For unknown reasons, the css becomes undefined after font size change
  prefsObserver = Zotero.Prefs.registerObserver("note.fontSize", () => {
    Zotero.Notes._editorInstances.forEach((editor) => {
      injectEditorCSS(editor._iframeWindow);
    });
  });
  registerMarkdownModePrefObserver();
  registerMarkdownEditorBackend();
}

export function unregisterEditorInstanceHook() {
  Zotero.Prefs.unregisterObserver(prefsObserver);
  unregisterMarkdownModePrefObserver();
  unregisterMarkdownEditorBackend();
}

async function onEditorInstanceCreated(editor: Zotero.EditorInstance) {
  // `registerEditorInstance` (which triggers this hook) fires at the very start
  // of `EditorInstance.init()` — before init() assigns the fresh `_initPromise`
  // and, on a `reinit()`, before the new EditorCore is built. Yield once so the
  // fresh promise is in place, then await it, so we always attach our plugins to
  // the current core instead of a stale one. Re-application is safe because
  // `initPlugins` is idempotent (see extras/editor/plugins.ts).
  await Promise.resolve();
  await editor._initPromise;
  if (!addon.data.alive) {
    return;
  }

  // item.getNote may not be initialized yet
  if (Zotero.ItemTypes.getID("note") !== editor._item.itemTypeID) {
    return;
  }
  // The editor instance may be destroyed before the promise resolves
  try {
    await injectEditorScripts(editor._iframeWindow);
    injectEditorCSS(editor._iframeWindow);
    initEditorImagePreviewer(editor);
    await initEditorToolbar(editor);
    initEditorPopup(editor);
    initEditorMenu(editor);
    initEditorPlugins(editor);
    await initEditorMagicKeyCommands(editor);
    await initEditorSections(editor);
    await initEditorMarkdownMode(editor);
  } catch (e) {
    const isDead =
      !Zotero.Notes._editorInstances.includes(editor) ||
      Components.utils.isDeadWrapper(editor._iframeWindow);
    if (!isDead) {
      throw e;
    }
  }
}
