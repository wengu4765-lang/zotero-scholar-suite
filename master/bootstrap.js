/*
 * Zotero Scholar Suite — master bootstrap
 *
 * Copyright (C) 2026 Zotero Scholar Suite contributors
 * This file is part of Zotero Scholar Suite, licensed under AGPL-3.0-or-later.
 *
 * Bundled sub-modules (see NOTICE.md):
 *   - modules/better-notes    : Better Notes for Zotero 3.3.3 (c) windingwind, AGPL-3.0-or-later
 *   - modules/pdf-translate   : Translate for Zotero 2.4.8 (c) windingwind, AGPL-3.0-or-later
 *                               + Scholar Suite additions (full-text translation with figures,
 *                                 model source manager)
 *   - modules/ethereal-style  : Ethereal Style 6.0.8 (c) Polygon / MuiseDestiny — ONLY in the
 *                               local "full" build (`python3 build.py --with-style`), which
 *                               downloads the official xpi and ships it completely unmodified
 *                               (keeps its own addon ID; its preference pane is mapped to the
 *                               suite ID at runtime, see patchPreferencePanes / NOTICE.md).
 *                               The public "Lite" build does not contain any Style file; it
 *                               coexists with a separately installed official Ethereal Style.
 *
 * This bootstrap delegates every lifecycle event (install / startup / shutdown /
 * uninstall / onMainWindowLoad / onMainWindowUnload) to each sub-module's own
 * bootstrap.js, giving each its own scope object and its own rootURI.
 */

/* global Zotero, Services, Components, ChromeUtils, APP_SHUTDOWN, APP_STARTUP */

var SUITE_ID = "zotero-scholar-suite@hark.local";

// Order matters: Translate first (Style and Better Notes call into
// Zotero.PDFTranslate), then Better Notes, then Ethereal Style.
var ALL_SUITE_MODULES = [
  {
    key: "pdf-translate",
    dir: "modules/pdf-translate/",
    name: "Translate for Zotero",
    originalID: "zoteropdftranslate@euclpts.com",
    instance: "PDFTranslate",
  },
  {
    key: "better-notes",
    dir: "modules/better-notes/",
    name: "Better Notes for Zotero",
    originalID: "Knowledge4Zotero@windingwind.com",
    instance: "BetterNotes",
  },
  {
    key: "ethereal-style",
    dir: "modules/ethereal-style/",
    name: "Ethereal Style",
    originalID: "zoterostyle@polygon.org",
    instance: "ZoteroStyle",
  },
];

// Which sub-modules this package actually contains. build.py rewrites this
// line: ["pdf-translate","better-notes"] for the Lite build, all three for
// `--with-style`. null (unbuilt source) means "all of them".
var SUITE_BUNDLED_MODULES = null; /* @@SUITE_BUNDLED_MODULES@@ */
var SUITE_VARIANT = "full"; /* @@SUITE_VARIANT@@ */

var SUITE_MODULES = ALL_SUITE_MODULES.filter(function (m) {
  return !SUITE_BUNDLED_MODULES || SUITE_BUNDLED_MODULES.indexOf(m.key) !== -1;
});

// IDs (current and older releases) of the standalone plugins whose code the
// suite bundles. Only modules that are really bundled count: in the Lite build
// a separately installed official Ethereal Style is a companion, not a
// conflict, and its plugin-API registrations must be left alone.
var ALL_LEGACY_IDS = {
  "zoteropdftranslate@polygon.org": "pdf-translate",
  "zoteropdftranslate@euclpts.com": "pdf-translate",
  "Knowledge4Zotero@windingwind.com": "better-notes",
  "zoterostyle@polygon.org": "ethereal-style",
};
var LEGACY_IDS = {};
Object.keys(ALL_LEGACY_IDS).forEach(function (id) {
  var key = ALL_LEGACY_IDS[id];
  if (SUITE_MODULES.some(function (m) { return m.key === key; })) {
    LEGACY_IDS[id] = key;
  }
});

var suiteState = {
  rootURI: null,
  scopes: {}, // key -> sandbox scope object of the sub bootstrap
  started: {}, // key -> bool
  skipped: {}, // key -> reason
  errors: {}, // key -> string
  conflicts: [],
  prefPanePatch: null,
  debugTimer: null,
};

function suiteLog(msg, isError) {
  try {
    var line = "[ScholarSuite] " + msg;
    if (typeof Zotero !== "undefined" && Zotero.debug) {
      Zotero.debug(line);
    }
    if (isError) {
      Components.utils.reportError(line);
    } else {
      Services.console.logStringMessage(line);
    }
  } catch (e) {
    // ignore
  }
}

function makeSubData(data, mod) {
  var rootURI = suiteState.rootURI + mod.dir;
  return {
    id: SUITE_ID,
    version: data.version,
    rootURI: rootURI,
    resourceURI: Services.io.newURI(rootURI),
    installPath: data.installPath,
    // Let sub-modules know they live inside the suite.
    suite: { id: SUITE_ID, key: mod.key, rootURI: suiteState.rootURI },
  };
}

// Sub-module bootstraps load their main script with `${rootURI}/chrome/...`.
// With rootURI = "jar:file:///…xpi!/modules/<key>/" that yields "…/<key>//chrome/…",
// which the jar: protocol does NOT resolve (an unpacked directory tolerates it,
// a packed .xpi fails with "Error opening input stream"). Give every sub
// bootstrap a Services view whose scriptloader collapses duplicate slashes.
function normalizeSubURL(url) {
  return typeof url === "string" ? url.replace(/([^:\/])\/{2,}/g, "$1/") : url;
}

function makeSubServices() {
  var loader = Services.scriptloader;
  // Plain wrapper objects (not proxies over the XPCOM objects themselves: their
  // non-configurable properties would violate Proxy invariants).
  var loaderView = {
    loadSubScript: function (url) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = normalizeSubURL(url);
      return loader.loadSubScript.apply(loader, args);
    },
    loadSubScriptWithOptions: function (url, opts) {
      return loader.loadSubScriptWithOptions(normalizeSubURL(url), opts);
    },
    compileScript: function () {
      return loader.compileScript.apply(loader, arguments);
    },
  };
  return new Proxy(
    {},
    {
      get: function (target, prop) {
        if (prop === "scriptloader") return loaderView;
        return Services[prop];
      },
      has: function (target, prop) {
        return prop in Services;
      },
    },
  );
}

function loadSubBootstrap(mod) {
  if (suiteState.scopes[mod.key]) {
    return suiteState.scopes[mod.key];
  }
  // A plain object is used as a non-syntactic scope: top-level `var`s and
  // functions of the sub bootstrap land on it, while free names such as
  // Zotero / Services / APP_SHUTDOWN resolve through this sandbox global.
  var scope = { __suiteModule: mod.key, Services: makeSubServices() };
  Services.scriptloader.loadSubScript(
    suiteState.rootURI + mod.dir + "bootstrap.js",
    scope,
  );
  suiteState.scopes[mod.key] = scope;
  return scope;
}

async function callSub(mod, fnName, args) {
  var scope = suiteState.scopes[mod.key];
  if (!scope || typeof scope[fnName] !== "function") {
    return;
  }
  try {
    await scope[fnName].apply(scope, args);
  } catch (e) {
    var msg = mod.key + "." + fnName + " failed: " + e + "\n" + (e && e.stack);
    suiteState.errors[mod.key] = (suiteState.errors[mod.key] || "") + msg + "\n";
    suiteLog(msg, true);
  }
}

/**
 * Sub-modules register their preference panes with their own pluginID in some
 * builds (Ethereal Style ships obfuscated). Zotero requires the pluginID to be
 * an installed extension, so map any known sub-module ID to the suite ID.
 */
function patchPreferencePanes() {
  if (suiteState.prefPanePatch || !Zotero.PreferencePanes) return;
  var original = Zotero.PreferencePanes.register;
  Zotero.PreferencePanes.register = function (options) {
    if (options && options.pluginID && LEGACY_IDS[options.pluginID]) {
      options = Object.assign({}, options, { pluginID: SUITE_ID });
    }
    return original.apply(this, [options].concat([].slice.call(arguments, 1)));
  };
  suiteState.prefPanePatch = original;
}

function unpatchPreferencePanes() {
  if (suiteState.prefPanePatch && Zotero.PreferencePanes) {
    Zotero.PreferencePanes.register = suiteState.prefPanePatch;
  }
  suiteState.prefPanePatch = null;
}

function unregisterLegacyPluginIDs() {
  var holders = ["ItemTreeManager", "ItemPaneManager", "MenuManager", "Reader", "PreferencePanes"];
  for (var legacyID of Object.keys(LEGACY_IDS)) {
    // Only the bundled Ethereal Style registers under its original ID (and
    // LEGACY_IDS lists it only when it is bundled).
    if (legacyID !== "zoterostyle@polygon.org") continue;
    for (var h of holders) {
      var obj = Zotero[h];
      if (!obj) continue;
      for (var fn of ["_unregisterByPluginID", "_unregisterEventListenerByPluginID", "unregisterByPluginID"]) {
        try {
          if (typeof obj[fn] === "function") obj[fn](legacyID);
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

async function detectConflicts() {
  var conflicts = [];
  try {
    var { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    var ids = Object.keys(LEGACY_IDS);
    var addons = await AddonManager.getAddonsByIDs(ids);
    for (var i = 0; i < addons.length; i++) {
      var a = addons[i];
      if (a && a.isActive) {
        conflicts.push({ id: a.id, name: a.name, key: LEGACY_IDS[a.id] });
      }
    }
  } catch (e) {
    suiteLog("conflict detection failed: " + e, true);
  }
  return conflicts;
}

function showConflictWarning(conflicts) {
  if (!conflicts.length) return;
  var names = conflicts.map((c) => "  • " + c.name + " (" + c.id + ")").join("\n");
  var text =
    "Zotero Scholar Suite 已内置以下插件的全部功能，但检测到原插件仍处于启用状态：\n\n" +
    names +
    "\n\n为避免菜单/快捷键/偏好设置重复和冲突，套件已暂时跳过对应的内置子模块。\n" +
    "请在「工具 → 插件」中禁用或卸载上述原插件，然后重启 Zotero，即可使用套件的完整功能" +
    "（含保留图片的全文翻译与模型源管理器）。";
  try {
    var win = Zotero.getMainWindow();
    if (win) {
      Services.prompt.alert(win, "Zotero Scholar Suite：检测到插件冲突", text);
    }
  } catch (e) {
    suiteLog(text, true);
  }
}

/* ---------------- Debug bridge (only when ZSS_DEBUG_DIR is set) ---------------- */

function getEnv(name) {
  try {
    return Services.env.get(name);
  } catch (e) {
    try {
      return Components.classes["@mozilla.org/process/environment;1"]
        .getService(Components.interfaces.nsIEnvironment)
        .get(name);
    } catch (e2) {
      return "";
    }
  }
}

function startDebugBridge() {
  var dir = getEnv("ZSS_DEBUG_DIR");
  if (!dir) return;
  suiteLog("debug bridge enabled, watching " + dir);
  var busy = false;
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      var children = await IOUtils.getChildren(dir);
      children.sort();
      for (var path of children) {
        if (!path.endsWith(".js")) continue;
        var outPath = path.replace(/\.js$/, ".out.json");
        var code = await IOUtils.readUTF8(path);
        await IOUtils.remove(path);
        var result;
        try {
          var fn = new AsyncFunction("Zotero", "Services", "suite", code);
          var value = await fn(Zotero, Services, suiteDebugAPI);
          result = { ok: true, value: value };
        } catch (e) {
          result = { ok: false, error: String(e), stack: e && e.stack };
        }
        var text;
        try {
          text = JSON.stringify(result, null, 2);
        } catch (e) {
          text = JSON.stringify({ ok: false, error: "unserializable: " + e });
        }
        await IOUtils.writeUTF8(outPath + ".tmp", text);
        await IOUtils.move(outPath + ".tmp", outPath);
      }
    } catch (e) {
      // directory may not exist yet
    }
    busy = false;
  }
  suiteState.debugTimer = setInterval(tick, 400);
  // Signal readiness
  IOUtils.writeUTF8(dir + "/READY", String(Date.now())).catch(() => {});
}

var suiteDebugAPI = {
  get state() {
    return {
      variant: SUITE_VARIANT,
      bundled: SUITE_MODULES.map((m) => m.key),
      started: suiteState.started,
      skipped: suiteState.skipped,
      errors: suiteState.errors,
      conflicts: suiteState.conflicts,
      rootURI: suiteState.rootURI,
    };
  },
};

/* ---------------- Lifecycle ---------------- */

function install(data, reason) {
  // Sub-module install() hooks are no-ops upstream; they are invoked at
  // startup time (we need rootURI first), see startup().
}

async function startup(data, reason) {
  await Zotero.initializationPromise;
  suiteState.rootURI = data.rootURI || data.resourceURI.spec;
  if (!suiteState.rootURI.endsWith("/")) suiteState.rootURI += "/";

  Zotero.ScholarSuite = {
    id: SUITE_ID,
    version: data.version,
    rootURI: suiteState.rootURI,
    variant: SUITE_VARIANT,
    modules: SUITE_MODULES.map((m) => m.key),
    get state() {
      return suiteDebugAPI.state;
    },
  };

  patchPreferencePanes();

  suiteState.conflicts = await detectConflicts();
  var conflictKeys = suiteState.conflicts.map((c) => c.key);

  for (var mod of SUITE_MODULES) {
    if (conflictKeys.indexOf(mod.key) !== -1) {
      suiteState.skipped[mod.key] = "original plugin is active";
      suiteLog("skip " + mod.key + ": original plugin is active");
      continue;
    }
    if (Zotero[mod.instance]) {
      suiteState.skipped[mod.key] = "Zotero." + mod.instance + " already exists";
      suiteLog("skip " + mod.key + ": Zotero." + mod.instance + " already exists");
      continue;
    }
    try {
      loadSubBootstrap(mod);
    } catch (e) {
      suiteState.errors[mod.key] = "load bootstrap failed: " + e;
      suiteLog("load " + mod.key + " bootstrap failed: " + e + "\n" + e.stack, true);
      continue;
    }
    var subData = makeSubData(data, mod);
    await callSub(mod, "install", [subData, reason]);
    var t0 = Date.now();
    await callSub(mod, "startup", [subData, reason]);
    suiteState.started[mod.key] = !suiteState.errors[mod.key];
    suiteLog("started " + mod.key + " in " + (Date.now() - t0) + " ms");
  }

  if (suiteState.conflicts.length) {
    // Do not block startup with a modal dialog.
    Zotero.uiReadyPromise.then(() => {
      setTimeout(() => showConflictWarning(suiteState.conflicts), 3000);
    });
  }

  startDebugBridge();
}

async function onMainWindowLoad(params, reason) {
  for (var mod of SUITE_MODULES) {
    if (!suiteState.started[mod.key]) continue;
    await callSub(mod, "onMainWindowLoad", [params, reason]);
  }
}

async function onMainWindowUnload(params, reason) {
  for (var mod of SUITE_MODULES) {
    if (!suiteState.started[mod.key]) continue;
    await callSub(mod, "onMainWindowUnload", [params, reason]);
  }
}

async function shutdown(data, reason) {
  if (suiteState.debugTimer) {
    clearInterval(suiteState.debugTimer);
    suiteState.debugTimer = null;
  }
  if (reason === APP_SHUTDOWN) {
    return;
  }
  // Reverse order
  var mods = SUITE_MODULES.slice().reverse();
  for (var mod of mods) {
    if (!suiteState.scopes[mod.key]) continue;
    await callSub(mod, "shutdown", [makeSubData(data, mod), reason]);
    suiteState.started[mod.key] = false;
  }
  // Ethereal Style registers Zotero plugin-API options under its original ID,
  // which Zotero cannot map to this addon on shutdown; clean them up here.
  unregisterLegacyPluginIDs();
  unpatchPreferencePanes();
  delete Zotero.ScholarSuite;
}

async function uninstall(data, reason) {
  if (!suiteState.rootURI) {
    suiteState.rootURI = data.rootURI || (data.resourceURI && data.resourceURI.spec);
  }
  var mods = SUITE_MODULES.slice().reverse();
  for (var mod of mods) {
    // Ethereal Style's uninstall() only calls Zotero.ZoteroStyle.hooks.onShutdown(),
    // which shutdown() already did. During an upgrade it would run *after* the
    // new version started and tear the new instance down, so skip it.
    if (mod.key === "ethereal-style") continue;
    if (!suiteState.scopes[mod.key]) {
      try {
        loadSubBootstrap(mod);
      } catch (e) {
        continue;
      }
    }
    await callSub(mod, "uninstall", [makeSubData(data, mod), reason]);
  }
}
