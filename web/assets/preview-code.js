(() => {
  "use strict";
  let editor = null, model = null, pending = null, api = null, disposed = false;
  const host = document.getElementById("code-preview-editor");
  const hint = document.getElementById("code-preview-hint");
  function report(type) { if (window.parent !== window) window.parent.postMessage({ type, version: 1 }, location.origin); }
  function dispose() {
    disposed = true;
    editor?.dispose(); model?.dispose(); editor = null; model = null; pending = null;
  }
  function render() {
    if (!api || !pending || disposed) return;
    const { text, language, context, label, hint: message } = pending;
    I18n.apply(context);
    document.querySelector("main").setAttribute("aria-label", label);
    document.title = label + " · babaShare";
    hint.textContent = message;
    api.editor.setTheme(context.theme === "dark" ? "vs-dark" : "vs");
    if (!model) model = api.editor.createModel(text, language);
    else if (model.getValue() !== text) { editor?.dispose(); model.dispose(); editor = null; model = api.editor.createModel(text, language); }
    if (!editor) editor = api.editor.create(host, {
      model, readOnly: true, domReadOnly: true, automaticLayout: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false,
      accessibilitySupport: "on", ariaLabel: label, tabIndex: 0,
      ariaDescribedBy: "code-preview-hint",
      wordWrap: "on", contextmenu: false, links: false, renderValidationDecorations: "off",
    });
    editor.updateOptions({ ariaLabel: label });
    // Monaco只读模式默认让Tab移动焦点，不向文件插入制表符。
    report("preview-code.loaded");
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.version !== 1) return;
    if (event.data.type === "preview-code.dispose") { dispose(); return; }
    if (event.data.type !== "preview-code.load" || typeof event.data.text !== "string" || event.data.text.length > 2 * 1024 * 1024 ||
        !/^[a-z]+$/.test(event.data.language || "") || !["zh-CN", "en-US", "ar-SA"].includes(event.data.context?.locale) ||
        !["light", "dark"].includes(event.data.context?.theme) || !["ltr", "rtl"].includes(event.data.context?.dir) ||
        typeof event.data.label !== "string" || typeof event.data.hint !== "string" || disposed) return;
    pending = event.data;
    try { render(); } catch { report("preview-code.error"); }
  });
  window.addEventListener("pagehide", dispose, { once: true });
  window.MonacoEnvironment = { getWorkerUrl: () => "/baba-share/assets/preview-code-worker.js" };
  window.require.config({ paths: { vs: "/baba-share/vendor/monaco/vs" }, "vs/nls": { availableLanguages: {} } });
  window.require(["vs/editor/editor.main"], () => {
    api = window.monaco;
    report("preview-code.ready");
    try { render(); } catch { report("preview-code.error"); }
  }, () => report("preview-code.error"));
})();
