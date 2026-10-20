/* Zotero Scholar Suite — 模型源管理器 UI. SPDX-License-Identifier: AGPL-3.0-or-later */
/* global Components, ChromeUtils */
"use strict";

(function () {
  function getZotero() {
    try {
      if (window.opener && window.opener.Zotero) return window.opener.Zotero;
    } catch (e) {
      /* ignore */
    }
    return Components.classes["@zotero.org/Zotero;1"].getService(Components.interfaces.nsISupports)
      .wrappedJSObject;
  }
  const Zotero = getZotero();
  const api = Zotero.PDFTranslate.api.profiles;
  const $ = (id) => document.getElementById(id);

  let selectedId = null;
  let dirty = false;

  function status(msg, isErr) {
    const el = $("status");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
  }

  // ---------- presets menu ----------
  function buildPresetMenu() {
    const menu = $("preset-menu");
    menu.innerHTML = "";
    const g = document.createElement("div");
    g.className = "group";
    g.textContent = "从预设模板新增";
    menu.appendChild(g);
    let visionGroup = false;
    for (const p of api.presets()) {
      if (p.vision && !visionGroup) {
        visionGroup = true;
        const g2 = document.createElement("div");
        g2.className = "group";
        g2.textContent = "识图模型源（图内文字 OCR，按图收费）";
        menu.appendChild(g2);
      }
      const it = document.createElement("div");
      it.className = "item";
      it.dataset.preset = p.id;
      const nm = document.createElement("span");
      nm.textContent = p.name;
      const sm = document.createElement("small");
      sm.textContent = p.model || p.type;
      it.append(nm, sm);
      it.addEventListener("click", () => {
        menu.hidden = true;
        guardDirty(() => {
          try {
            const created = api.createFromPreset(p.id);
            selectedId = created.id;
            render();
            status(`已新增「${created.name}」，请填写 API Key 后保存并测试`);
            setTimeout(() => $(p.needsKey ? "f-key" : "f-model").focus(), 50);
          } catch (e) {
            status(String(e.message || e), true);
          }
        });
      });
      menu.appendChild(it);
    }
  }

  // ---------- list ----------
  function renderList() {
    const list = api.list();
    const ul = $("profile-list");
    ul.innerHTML = "";
    $("empty").hidden = list.length > 0;
    const active = list.find((p) => p.active);
    $("current-name").textContent = active ? active.name : "（未启用）";
    const vis = api.resolveVision();
    $("vision-name").textContent = vis.id ? vis.name + (vis.explicit ? "" : "（跟随当前源）") : "（未指定，跟随当前源）";
    $("vision-name").title = vis.reason || "";
    for (const p of list) {
      const li = document.createElement("li");
      li.className = "card" + (p.id === selectedId ? " selected" : "") + (p.active ? " active" : "");
      li.draggable = true;
      li.dataset.id = p.id;
      const needsKey = p.type !== "ollama" && p.type !== "custom";
      // NB: build with DOM APIs — innerHTML in a system-principal document is
      // sanitized and silently drops <button> elements.
      const mk = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      };
      const grip = mk("span", "grip", "⋮⋮");
      grip.title = "拖动排序";
      const info = mk("div", "info");
      const name = mk("div", "name", p.name);
      name.append(" ", mk("span", "tag", api.typeLabel(p.type)));
      if (p.active) name.append(" ", mk("span", "tag on", "当前"));
      if (needsKey && !p.hasKey) name.append(" ", mk("span", "tag nokey", "无 Key"));
      if (p.vision) {
        const t = mk("span", "tag vis" + (p.visionExplicit ? "" : " follow"), p.visionExplicit ? "识图" : "识图·跟随");
        t.title = p.visionExplicit ? "已指定为识图模型源" : "未单独指定识图源，OCR 使用当前源";
        name.append(" ", t);
      } else if (p.supportsVision) {
        name.append(" ", mk("span", "tag", "可识图"));
      }
      const meta = mk("div", "meta", `${p.model || "—"} · ${p.baseURL}${p.hasKey ? " · " + p.maskedKey : ""}`);
      info.append(name, meta);
      const useBtn = mk("button", "use", "启用");
      useBtn.title = "设为当前源（切换翻译服务）";
      const visBtn = mk("button", "vis-btn", p.visionExplicit ? "取消识图" : "设为识图");
      visBtn.title = p.visionExplicit ? "不再单独指定识图源（改为跟随当前源）" : "指定为图内文字 OCR 的识图模型源";
      visBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleVision(p.id);
      });
      li.append(grip, info, useBtn, visBtn);
      li.addEventListener("click", (ev) => {
        if (ev.target.classList.contains("use")) return;
        if (p.id === selectedId) return;
        guardDirty(() => {
          selectedId = p.id;
          render();
        });
      });
      li.addEventListener("dblclick", () => activate(p.id));
      li.querySelector(".use").addEventListener("click", (ev) => {
        ev.stopPropagation();
        activate(p.id);
      });
      // drag & drop sorting
      li.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", p.id);
        ev.dataTransfer.effectAllowed = "move";
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        const r = li.getBoundingClientRect();
        const before = ev.clientY < r.top + r.height / 2;
        li.classList.toggle("drop-before", before);
        li.classList.toggle("drop-after", !before);
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
      li.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const dragId = ev.dataTransfer.getData("text/plain");
        const before = li.classList.contains("drop-before");
        li.classList.remove("drop-before", "drop-after");
        if (!dragId || dragId === p.id) return;
        const ids = api.list().map((x) => x.id).filter((x) => x !== dragId);
        let idx = ids.indexOf(p.id);
        if (!before) idx += 1;
        ids.splice(idx, 0, dragId);
        api.reorder(ids);
        status("已调整顺序");
      });
      ul.appendChild(li);
    }
    $("btn-dup").disabled = !selectedId;
    $("btn-del").disabled = !selectedId;
  }

  // ---------- editor ----------
  function fillVisionFormats() {
    const sel = $("f-visionFormat");
    sel.innerHTML = "";
    for (const t of api.visionFormats()) {
      const o = document.createElement("option");
      o.value = t.value;
      o.textContent = t.label;
      sel.appendChild(o);
    }
  }

  function toggleVision(id) {
    try {
      const explicit = api.getVisionId() === id;
      api.setVision(explicit ? "" : id);
      render();
      const p = api.get(id);
      status(explicit ? "已取消单独指定的识图源，OCR 将跟随当前源（需勾选“支持图片输入”）" : `已将「${p.name}」设为识图模型源（位图 OCR 按图计费，请留意费用）`);
    } catch (e) {
      status(String(e.message || e), true);
    }
  }

  function makeTestImage() {
    const c = document.createElement("canvas");
    c.width = 560;
    c.height = 200;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#1f2937";
    g.font = "bold 34px sans-serif";
    g.fillText("Input images", 30, 70);
    g.font = "28px serif";
    g.fillText("Prior Preservation Loss", 30, 150);
    g.strokeStyle = "#2563eb";
    g.lineWidth = 3;
    g.strokeRect(400, 30, 130, 140);
    return c.toDataURL("image/png");
  }

  async function testVision() {
    const box = $("test-result");
    box.hidden = false;
    box.className = "test-result";
    box.textContent = "正在测试识图（发送一张 560×200 的测试图）…";
    $("btn-test-vision").disabled = true;
    try {
      const r = await api.testVision(formData(), makeTestImage(), $("f-key").value.trim());
      box.className = "test-result " + (r.ok ? "ok" : "fail");
      box.textContent = r.ok
        ? `✓ 识图成功，耗时 ${r.ms} ms（期望识别出 “Input images” 与 “Prior Preservation Loss”）\n返回：${r.result}`
        : `✗ 识图失败（${r.ms} ms）\n${r.error}`;
    } catch (e) {
      box.className = "test-result fail";
      box.textContent = "✗ " + (e.message || e);
    }
    $("btn-test-vision").disabled = false;
  }

  function fillTypes() {
    const sel = $("f-type");
    sel.innerHTML = "";
    for (const t of api.types()) {
      const o = document.createElement("option");
      o.value = t.value;
      o.textContent = t.label;
      sel.appendChild(o);
    }
  }

  function renderEditor() {
    const p = selectedId ? api.get(selectedId) : null;
    $("editor").hidden = !p;
    $("no-selection").hidden = !!p;
    $("test-result").hidden = true;
    if (!p) return;
    const view = api.list().find((x) => x.id === p.id) || {};
    $("f-name").value = p.name || "";
    $("f-type").value = p.type || "openai";
    $("f-baseURL").value = p.baseURL || "";
    $("f-model").value = p.model || "";
    $("f-temperature").value = p.temperature != null ? p.temperature : 0.3;
    $("f-maxTokens").value = p.maxTokens || "";
    $("f-stream").checked = !!p.stream;
    $("f-customParams").value = p.customParams || "";
    $("f-extraHeaders").value = p.extraHeaders || "";
    $("f-prompt").value = p.prompt || "";
    $("f-notes").value = p.notes || "";
    $("f-supportsVision").checked = !!p.supportsVision;
    $("f-visionFormat").value = p.visionFormat || "auto";
    $("btn-vision").textContent = view.visionExplicit ? "取消识图源" : "设为识图源";
    $("f-key").value = "";
    $("f-key").type = "password";
    $("f-clear-key").checked = false;
    $("key-state").textContent = view.hasKey ? `已保存：${view.maskedKey}（留空不修改）　` : "尚未保存 Key　";
    $("btn-activate").disabled = !!view.active;
    $("btn-activate").textContent = view.active ? "✓ 当前使用中" : "启用此源";
    updateEndpointPreview();
    dirty = false;
  }

  function formData() {
    return {
      id: selectedId,
      name: $("f-name").value,
      type: $("f-type").value,
      baseURL: $("f-baseURL").value,
      model: $("f-model").value,
      temperature: parseFloat($("f-temperature").value),
      maxTokens: $("f-maxTokens").value ? parseInt($("f-maxTokens").value) : undefined,
      stream: $("f-stream").checked,
      customParams: $("f-customParams").value,
      extraHeaders: $("f-extraHeaders").value,
      prompt: $("f-prompt").value,
      notes: $("f-notes").value,
      supportsVision: $("f-supportsVision").checked,
      visionFormat: $("f-visionFormat").value,
    };
  }

  function keyArg() {
    if ($("f-clear-key").checked) return "";
    const k = $("f-key").value.trim();
    return k ? k : undefined;
  }

  function updateEndpointPreview() {
    try {
      $("endpoint-preview").textContent = "请求地址：" + api.describeEndpoint(formData());
    } catch (e) {
      $("endpoint-preview").textContent = "";
    }
  }

  function save() {
    try {
      const saved = api.save(formData(), keyArg());
      selectedId = saved.id;
      dirty = false;
      render();
      status(`已保存「${saved.name}」`);
      return true;
    } catch (e) {
      status("保存失败：" + (e.message || e), true);
      return false;
    }
  }

  function guardDirty(next) {
    if (!dirty) return next();
    if (window.confirm("当前源有未保存的修改，是否保存？\n（取消 = 放弃修改）")) {
      if (!save()) return;
    }
    dirty = false;
    next();
  }

  function activate(id) {
    const go = () => {
      try {
        api.activate(id);
        render();
        const p = api.get(id);
        status(`已切换到「${p.name}」，划词翻译 / 全文翻译等将立即使用该源`);
      } catch (e) {
        status(String(e.message || e), true);
      }
    };
    if (dirty && id === selectedId) {
      if (!save()) return;
    }
    go();
  }

  async function test() {
    const box = $("test-result");
    box.hidden = false;
    box.className = "test-result";
    box.textContent = "正在测试…";
    $("btn-test").disabled = true;
    try {
      const data = formData();
      const r = await api.test(data, $("f-key").value.trim());
      box.className = "test-result " + (r.ok ? "ok" : "fail");
      box.textContent = r.ok
        ? `✓ 连接成功，耗时 ${r.ms} ms\n返回：${r.result}`
        : `✗ 连接失败（${r.ms} ms）\n${r.error}`;
    } catch (e) {
      box.className = "test-result fail";
      box.textContent = "✗ " + (e.message || e);
    }
    $("btn-test").disabled = false;
  }

  // ---------- import / export ----------
  async function doExport() {
    const includeKeys = $("export-keys").checked;
    if (includeKeys && !window.confirm("导出的文件将包含明文 API Key，请妥善保管，不要分享给他人。继续？")) return;
    const json = api.exportJSON(includeKeys);
    try {
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker();
      fp.init(window, "导出模型源", fp.modeSave);
      fp.appendFilter("JSON", "*.json");
      fp.defaultString = `scholar-suite-profiles${includeKeys ? "-with-keys" : ""}.json`;
      const rv = await fp.show();
      if (rv === fp.returnOK || rv === fp.returnReplace) {
        await IOUtils.writeUTF8(fp.file, json);
        status("已导出到 " + fp.file);
      }
    } catch (e) {
      Zotero.Utilities.Internal.copyTextToClipboard(json);
      status("无法打开文件对话框，已将 JSON 复制到剪贴板");
    }
  }

  function doImport(text) {
    const replace = window.confirm("导入方式：\n确定 = 合并（同 ID 覆盖，其余追加）\n取消 = 替换现有全部源？")
      ? "merge"
      : window.confirm("确认要用导入的内容替换现有全部源吗？")
        ? "replace"
        : null;
    if (!replace) return;
    try {
      const n = api.importJSON(text, replace);
      render();
      status(`已导入 ${n} 个源（${replace === "merge" ? "合并" : "替换"}）`);
    } catch (e) {
      status("导入失败：" + (e.message || e), true);
    }
  }

  // ---------- wiring ----------
  function render() {
    renderList();
    renderEditor();
  }

  function init() {
    buildPresetMenu();
    fillTypes();
    fillVisionFormats();
    $("btn-add").addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("preset-menu").hidden = !$("preset-menu").hidden;
    });
    document.addEventListener("click", () => ($("preset-menu").hidden = true));
    $("btn-dup").addEventListener("click", () =>
      guardDirty(() => {
        try {
          const c = api.duplicate(selectedId);
          selectedId = c.id;
          render();
          status(`已复制为「${c.name}」`);
        } catch (e) {
          status(String(e.message || e), true);
        }
      }),
    );
    $("btn-del").addEventListener("click", () => {
      const p = api.get(selectedId);
      if (!p) return;
      if (!window.confirm(`确定删除「${p.name}」？其保存的 API Key 也会被删除。`)) return;
      api.remove(selectedId);
      dirty = false;
      selectedId = (api.list()[0] || {}).id || null;
      render();
      status(`已删除「${p.name}」`);
    });
    $("btn-import").addEventListener("click", () => $("file-input").click());
    $("file-input").addEventListener("change", async () => {
      const f = $("file-input").files[0];
      if (!f) return;
      doImport(await f.text());
      $("file-input").value = "";
    });
    $("btn-import-clip").addEventListener("click", () => {
      const text = Zotero.Utilities.Internal.getClipboard("text/plain") || "";
      if (!text.trim()) return status("剪贴板为空", true);
      doImport(text);
    });
    $("btn-export").addEventListener("click", doExport);
    $("editor").addEventListener("submit", (ev) => {
      ev.preventDefault();
      save();
    });
    $("editor").addEventListener("input", () => {
      dirty = true;
      updateEndpointPreview();
    });
    $("f-type").addEventListener("change", () => {
      dirty = true;
      updateEndpointPreview();
    });
    $("btn-eye").addEventListener("click", () => {
      $("f-key").type = $("f-key").type === "password" ? "text" : "password";
    });
    $("btn-test").addEventListener("click", test);
    $("btn-test-vision").addEventListener("click", testVision);
    $("btn-vision").addEventListener("click", () => {
      if (dirty && !save()) return;
      toggleVision(selectedId);
    });
    $("f-visionFormat").addEventListener("change", () => (dirty = true));
    $("btn-activate").addEventListener("click", () => activate(selectedId));
    $("btn-revert").addEventListener("click", () => {
      dirty = false;
      renderEditor();
      status("已撤销未保存的修改");
    });

    const off = api.onChange(() => {
      if (!dirty) render();
      else renderList();
    });
    window.addEventListener("unload", () => off && off());
    const list = api.list();
    selectedId = (list.find((p) => p.active) || list[0] || {}).id || null;
    render();
    window.ScholarSourceManager = { api, render, select: (id) => ((selectedId = id), render()) };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
