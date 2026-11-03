"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../web");
function engine() {
  const sent = [], events = new Map(); let nativeCalls = 0;
  class XHR { open() { nativeCalls++; } }
  const context = { URL, Request, console, setTimeout: (fn) => fn(), location: new URL("http://localhost/baba-share/vendor/office/editor.html"),
    document: { documentElement: { dataset: {} }, addEventListener() {} }, XMLHttpRequest: XHR,
    fetch: async () => { nativeCalls++; return {}; },
    addEventListener: (name, fn) => events.set(name, fn), parent: { postMessage: (...args) => sent.push(args) } };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets/preview-office-engine.js"), "utf8"), context);
  return { context, sent, events, calls: () => nativeCalls };
}
test("Office本地socket只实现读取，修改消息不发给服务端", () => {
  const app = engine(), socket = app.context.io(), messages = [];
  socket.on("message", (message) => messages.push(message));
  socket.emit("message", { type: "auth" });
  for (const type of ["saveChanges", "getLock", "isSaveLock", "upload", "downloadAs"]) socket.emit("message", { type, secret: "private" });
  assert.equal(app.sent.length, 2);
  assert.equal(app.sent[0][0].type, "office-engine.connect");
  assert.equal(app.sent[1][0].type, "office-engine.auth");
  const handler = app.events.get("message"), data = { version: 1, type: "office-engine.reply", socketId: socket.id, message: { type: "auth" } };
  handler({ origin: "null", source: app.context.parent, data });
  handler({ origin: "http://localhost", source: {}, data });
  assert.equal(messages.length, 0);
  handler({ origin: "http://localhost", source: app.context.parent, data });
  assert.equal(messages.length, 1);
  app.events.get("pagehide")();
  assert.equal(socket.connected, false);
});
test("Office引擎拒绝远程、API和所有写请求，仅允许本地资源与blob", async () => {
  const app = engine();
  for (const url of ["https://evil.test/upload", "http://localhost/api/private", "http://localhost/baba-share/preview/s/secret/file"]) {
    await assert.rejects(app.context.fetch(url), /READONLY_RESOURCE_DENIED/);
    assert.throws(() => new app.context.XMLHttpRequest().open("GET", url), /READONLY_RESOURCE_DENIED/);
  }
  await assert.rejects(app.context.fetch("http://localhost/baba-share/vendor/office/save", { method: "POST", body: "secret" }), /READONLY_RESOURCE_DENIED/);
  assert.equal(app.calls(), 0);
  await app.context.fetch("http://localhost/baba-share/vendor/office/fonts/a.bin");
  await app.context.fetch("blob:http://localhost/sample");
  assert.equal(app.calls(), 2);
});
test("Office适配器硬编码只读配置、上下文白名单和资源释放，不读写父或子DOM", () => {
  const source = fs.readFileSync(path.join(root, "assets/preview-office.js"), "utf8");
  assert.match(source, /mode: "view"/);
  assert.match(source, /edit: false/);
  assert.match(source, /macrosMode: "disable"/);
  assert.match(source, /worker\?\.terminate\(\)/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /event\.source !== engineFrame\(\)\?\.contentWindow/);
  assert.doesNotMatch(source, /contentDocument|parent\.document|contentWindow\.[a-z]+\s*=/);
  assert.doesNotMatch(source, /https?:\/\//);
});
function viewer(bytes = new ArrayBuffer(8), name = "sample.docx") {
  const events = new Map(), timers = new Map(), sent = [], revoked = [], workers = [], configs = [];
  let destroyed = 0;
  class FakeWorker {
    constructor() { this.terminated = 0; workers.push(this); }
    postMessage() {}
    terminate() { this.terminated++; }
  }
  const nodes = new Map(["office-preview-status", "office-preview-editor"].map((id) => [id, { textContent: "", replaceChildren() {} }]));
  const context = { ArrayBuffer, Blob, Worker: FakeWorker, location: new URL("http://localhost/baba-share/preview-office.html"),
    URL: { createObjectURL: () => "blob:local/" + revoked.length, revokeObjectURL: (url) => revoked.push(url) },
    setTimeout: (fn, delay) => { timers.set(1, { fn, delay }); return 1; }, clearTimeout: (id) => timers.delete(id),
    document: { getElementById: (id) => nodes.get(id), querySelector: (selector) => selector === "main" ? { setAttribute() {} } : null,
      createElement: () => ({}), head: { append: (script) => script.onload() } },
    I18n: { t: (key) => key, apply() {}, subscribe() {} },
    DocsAPI: { DocEditor: function (id, config) { configs.push(config); this.destroyEditor = () => destroyed++; } },
    parent: { postMessage: (data) => sent.push(data) }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name) => events.delete(name) };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets/preview-office.js"), "utf8"), context);
  const handler = events.get("message");
  handler({ origin: "http://localhost", source: context.parent, data: { type: "preview-office.load", version: 1,
    bytes, name, context: { locale: "zh-CN", theme: "dark", dir: "ltr" } } });
  return { workers, timers, sent, revoked, configs, nodes, destroyed: () => destroyed };
}
test("Office适配器接受超过32MiB，仍拒绝非二进制及非Office格式", () => {
  assert.equal(viewer(new ArrayBuffer(33 * 1024 * 1024)).workers.length, 1);
  assert.equal(viewer("not-an-arraybuffer").workers.length, 0);
  assert.equal(viewer(new ArrayBuffer(8), "sample.text").workers.length, 0);
});
test("Office加载成功隐藏状态，工具栏收起且许可证入口仍可访问", async () => {
  const app = viewer();
  assert.equal(app.nodes.get("office-preview-status").hidden, false);
  app.workers[0].onmessage({ data: { type: "converted", binary: new Uint8Array([1]) } });
  await Promise.resolve(); await Promise.resolve();
  const config = app.configs[0];
  assert.equal(config.editorConfig.customization.layout.toolbar, false);
  assert.equal(config.editorConfig.customization.layout.leftMenu, false);
  config.events.onDocumentReady();
  assert.equal(app.nodes.get("office-preview-status").hidden, true);
  assert.equal(app.nodes.get("office-preview-status").textContent, "");
  assert.equal(app.sent.at(-1).type, "preview-office.loaded");
  const html = fs.readFileSync(path.join(root, "preview-office.html"), "utf8");
  assert.match(html, /<details class="office-preview-license">/);
  assert.match(html, /href="https:\/\/github\.com\/LeonKou\/babaShare\/releases\/download\/office-source-v9\.3\.0\.24\/upstream-source\.zip"[^>]+data-i18n="previewOfficeSource"/);
  assert.match(html, /href="vendor\/office\/LICENSE"/);
});
test("Office转换错误和超时真正终止Worker并拒绝迟到结果", () => {
  for (const trigger of ["error", "timeout"]) {
    const app = viewer(), worker = app.workers[0];
    assert.equal(app.timers.get(1).delay, 120000);
    if (trigger === "error") worker.onerror(); else app.timers.get(1).fn();
    assert.equal(worker.terminated, 1);
    assert.equal(app.timers.size, 0);
    assert.equal(app.sent.at(-1).type, "preview-office.error");
    worker.onmessage({ data: { type: "converted", binary: new Uint8Array([1]) } });
    assert.equal(app.configs.length, 0);
    assert.equal(app.nodes.get("office-preview-status").textContent, "previewRendererFailed");
  }
});
test("Office渲染错误释放输出blob和编辑器", async () => {
  const app = viewer();
  app.workers[0].onmessage({ data: { type: "converted", binary: new Uint8Array([1]) } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(app.configs.length, 1);
  app.configs[0].events.onError();
  assert.equal(app.revoked.length, 1);
  assert.equal(app.destroyed(), 1);
  assert.equal(app.timers.size, 0);
});
test("Office转换器非零返回码即失败，不读取伪成功输出", async () => {
  const results = []; let reads = 0;
  const context = { ArrayBuffer, Uint8Array, location: { origin: "http://localhost" }, postMessage: (data) => results.push(data) };
  context.self = context;
  context.importScripts = () => {
    context.Module.FS = { mkdir() {}, writeFile() {}, readFile() { reads++; return new Uint8Array([1]); } };
    context.Module.ccall = () => 7; context.Module.onRuntimeInitialized();
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets/preview-office-worker.js"), "utf8"), context);
  await context.onmessage({ data: { bytes: new ArrayBuffer(8), extension: "docx" } });
  assert.equal(results[0].type, "error"); assert.equal(reads, 0);
});
test("Office Worker接受超过32MiB，格式与负载类型校验仍生效", async () => {
  const results = []; let writes = 0;
  const context = { ArrayBuffer, Uint8Array, location: { origin: "http://localhost" }, postMessage: (data) => results.push(data) };
  context.self = context;
  context.importScripts = () => {
    context.Module.FS = { mkdir() {}, writeFile() { writes++; }, readFile: () => new Uint8Array([1]), readdir: () => [] };
    context.Module.ccall = () => 0; context.Module.onRuntimeInitialized();
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets/preview-office-worker.js"), "utf8"), context);
  await context.onmessage({ data: { bytes: "invalid", extension: "docx" } });
  await context.onmessage({ data: { bytes: new ArrayBuffer(8), extension: "text" } });
  assert.equal(writes, 0);
  await context.onmessage({ data: { bytes: new ArrayBuffer(33 * 1024 * 1024), extension: "docx" } });
  assert.equal(results[0].type, "converted");
  assert.equal(writes, 2);
});
test("DocsAPI实际补丁绑定来源窗口且不使用通配目标", () => {
  const source = fs.readFileSync(path.join(root, "vendor/office/v9.3.0.24-1/web-apps/apps/api/documents/api.js"), "utf8");
  assert.match(source, /_scope\.frameOrigin==msg\.origin && msg\.source === document\.querySelector/);
  assert.match(source, /wnd\.postMessage\(msg, location\.origin, \[buffer\]\)/);
  assert.match(source, /iframe\.setAttribute\("sandbox", "allow-scripts allow-same-origin"\)/);
});
test("Office运行依赖、许可证及独立源码入口齐备且不附带源码包", () => {
  assert.equal(fs.existsSync(path.join(root, "vendor/office/upstream-source.zip")), false);
  for (const file of ["x2t-1/x2t.js", "x2t-1/x2t.wasm", "v9.3.0.24-1/web-apps/apps/api/documents/api.js", "v9.3.0.24-1/sdkjs", "v9.3.0.24-1/fonts", "LICENSE", "build-manifest.json"]) {
    assert(fs.existsSync(path.join(root, "vendor/office", file)), file);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "vendor/office/build-manifest.json"), "utf8"));
  assert.equal(manifest.archiveSha256, "0b91dcd9772d46effc7512681e4b5d1a41322dd06c6063c5bd21f509f1daf69b");
  assert.equal(manifest.sourceCommit, "02befd843ff32257a3d796d9e0d8d77914f8886f");
  const html = fs.readFileSync(path.join(root, "vendor/office/v9.3.0.24-1/web-apps/apps/documenteditor/main/index.html"), "utf8");
  assert.match(html, /preview-office-engine\.js/);
  assert.doesNotMatch(html, /<base[^>]+https:\/\/office-editor/);
});
