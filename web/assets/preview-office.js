/* Office 只读适配器；上游源码与变更记录随 vendor/office 提供，AGPL-3.0。 */
(() => {
  "use strict";
  const apiUrl = "/baba-share/vendor/office/v9.3.0.24-1/web-apps/apps/api/documents/api.js";
  const languages = { "zh-CN": "zh", "en-US": "en", "ar-SA": "ar" };
  const status = document.getElementById("office-preview-status");
  let editor = null, worker = null, pending = null, output = null, context = null, ended = false, rendering = false, apiReady = null, loadTimer = null;
  const urls = new Set();
  function report(type) { if (!ended && window.parent !== window) window.parent.postMessage({ type, version: 1 }, location.origin); }
  function engineFrame() { return document.querySelector('iframe[name="frameEditor"]'); }
  function engineMessage(type, payload = {}) { engineFrame()?.contentWindow?.postMessage({ version: 1, type, ...payload }, location.origin); }
  function resetEditor() { engineMessage("office-engine.dispose"); editor?.destroyEditor?.(); editor = null; }
  function dispose() {
    if (ended) return;
    ended = true; clearTimeout(loadTimer); loadTimer = null;
    resetEditor(); worker?.terminate(); worker = null; pending = null; output = null;
    urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear();
    window.removeEventListener("message", receive);
  }
  function error() {
    if (ended) return;
    status.hidden = false; status.textContent = I18n.t("previewRendererFailed"); report("preview-office.error"); dispose();
  }
  function blob(bytes) { const url = URL.createObjectURL(new Blob([bytes])); urls.add(url); return url; }
  function loadApi() {
    if (!apiReady) apiReady = new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = apiUrl;
      script.onload = resolve; script.onerror = reject; document.head.append(script);
    });
    return apiReady;
  }
  async function render() {
    if (!pending || !output || ended || rendering) return;
    rendering = true;
    try {
      await loadApi();
      if (ended) return;
      resetEditor();
      const placeholder = document.createElement("div"); placeholder.id = "office-preview-placeholder";
      document.getElementById("office-preview-editor").replaceChildren(placeholder);
      const extension = pending.name.split(".").pop().toLowerCase();
      const documentType = /^(xls|xlsx|ods|ots|et)$/.test(extension) ? "cell" : /^(ppt|pptx|odp|otp|dps)$/.test(extension) ? "slide" : "word";
      editor = new window.DocsAPI.DocEditor(placeholder.id, {
        title: I18n.t("previewOffice"), width: "100%", height: "100%", type: "desktop", documentType,
        document: { fileType: extension, key: "local-readonly-preview", title: pending.name,
          url: location.origin + "/baba-share/vendor/office/local-readonly-preview",
          permissions: { edit: false, comment: false, chat: false, download: false, print: false, review: false, fillForms: false, modifyFilter: false, modifyContentControl: false, protect: false, rename: false, copy: true } },
        editorConfig: { mode: "view", lang: languages[context.locale], user: { id: "readonly", name: I18n.t("previewReadonly") },
          customization: { uiTheme: context.theme === "dark" ? "theme-dark" : "theme-light", anonymous: { request: false },
            plugins: false, macros: false, macrosMode: "disable", chat: false, comments: false, help: false, feedback: false,
            hideRightMenu: true, hideRulers: true, hideNotes: true, compactHeader: true, compactToolbar: true, toolbarHideFileName: true,
            layout: { toolbar: false, leftMenu: false, rightMenu: false,
              header: { users: false, save: false, editMode: false, user: false },
              statusBar: { textLang: false, docLang: false, actionStatus: false } },
            features: { spellcheck: { change: false }, featuresTips: false } } },
        events: { onAppReady: () => engineMessage("office-engine.context", { context }),
          onDocumentReady: () => {
            if (ended) return;
            clearTimeout(loadTimer); loadTimer = null;
            status.hidden = true; status.textContent = ""; report("preview-office.loaded");
          }, onError: error },
      });
    } catch { error(); }
    finally { rendering = false; }
  }
  function reply(socketId, message) { engineMessage("office-engine.reply", { socketId, message }); }
  function engine(event) {
    if (event.source !== engineFrame()?.contentWindow || !output) return;
    const data = event.data;
    if (typeof data.socketId !== "string" || !/^preview-\d+$/.test(data.socketId)) return;
    if (data.type === "office-engine.connect") {
      engineMessage("office-engine.context", { context });
      reply(data.socketId, { maxPayload: 100000000, pingInterval: 25000, pingTimeout: 20000, sid: "readonly", upgrades: [] });
      reply(data.socketId, { type: "license", license: { type: 3, buildNumber: 8, buildVersion: "9.3.0", light: false, mode: 0, rights: 1, protectionSupport: true, isAnonymousSupport: true, liveViewerSupport: true, branding: false, customization: true, advancedApi: false } });
    }
    if (data.type === "office-engine.auth") {
      reply(data.socketId, { type: "authChanges", changes: [] });
      reply(data.socketId, { type: "auth", result: 1, sessionId: "readonly", participants: [{ connectionId: "readonly", encrypted: false, id: "readonly", idOriginal: "readonly", indexUser: 1, isCloseCoAuthoring: true, isLiveViewer: false, username: I18n.t("previewReadonly"), view: true }], locks: [], indexUser: 1, buildVersion: "9.3.0", buildNumber: 9, licenseType: 3, editorType: 2, mode: "view", permissions: { edit: false, comment: false, chat: false, download: false, print: false, fillForms: false, modifyFilter: false, protect: false, review: false, copy: true } });
      reply(data.socketId, { type: "documentOpen", data: { type: "open", status: "ok", data: output } });
    }
  }
  function validContext(value) { return value && languages[value.locale] && ["light", "dark"].includes(value.theme) && ["ltr", "rtl"].includes(value.dir); }
  function apply(value) {
    const changed = context && (context.locale !== value.locale || context.theme !== value.theme);
    context = { locale: value.locale, theme: value.theme, dir: value.dir }; I18n.apply(context);
    document.querySelector("main").setAttribute("aria-label", I18n.t("previewOffice"));
    status.hidden = !!output; status.textContent = output ? "" : I18n.t("loading");
    if (changed && output) render();
  }
  function receive(event) {
    if (event.origin !== location.origin || event.data?.version !== 1 || ended) return;
    if (event.source !== window.parent) { engine(event); return; }
    const data = event.data;
    if (data.type === "preview-office.dispose") { dispose(); return; }
    if (data.type === "preview-office.context" && validContext(data.context)) { apply(data.context); return; }
    if (data.type !== "preview-office.load" || pending || !(data.bytes instanceof ArrayBuffer) ||
        typeof data.name !== "string" || data.name.length > 1024 || !/\.(docx?|xlsx?|pptx?|od[tpst]|rtf|wps|et|dps)$/i.test(data.name) || !validContext(data.context)) return;
    pending = { name: data.name }; apply(data.context);
    loadTimer = setTimeout(error, 120000);
    try { worker = new Worker("/baba-share/assets/preview-office-worker.js"); }
    catch { error(); return; }
    worker.onerror = error;
    worker.onmessage = ({ data: result }) => {
      if (ended) return;
      if (result.type !== "converted" || !result.binary?.byteLength) { error(); return; }
      output = { "Editor.bin": blob(result.binary) };
      for (const [name, bytes] of Object.entries(result.media || {})) if (/^media\/[a-zA-Z0-9_.-]+$/.test(name)) output[name] = blob(bytes);
      worker.terminate(); worker = null; render();
    };
    worker.postMessage({ bytes: data.bytes, extension: data.name.split(".").pop().toLowerCase() }, [data.bytes]);
  }
  window.addEventListener("message", receive);
  window.addEventListener("pagehide", dispose, { once: true });
  I18n.subscribe(() => { if (!pending) status.textContent = I18n.t("loading"); });
  if (window.parent !== window) { status.textContent = I18n.t("loading"); report("preview-office.ready"); }
  else status.hidden = true;
})();
