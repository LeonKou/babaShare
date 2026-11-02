"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../web/assets/preview-code.js"), "utf8");
function setup() {
  const handlers = new Map(), messages = [], models = [], editors = [], applied = [], nodes = new Map();
  for (const id of ["code-preview-editor", "code-preview-hint", "main"]) nodes.set(id, { setAttribute() {} });
  const monaco = { editor: { setTheme() {}, createModel(value, language) { const model = { value, language, getValue: () => value, dispose() { this.disposed = true; } }; models.push(model); return model; }, create(_, options) { const editor = { options, dispose() { this.disposed = true; }, updateOptions() {} }; editors.push(editor); return editor; } } };
  const require = (_, ready) => ready(); require.config = () => {};
  const parent = { postMessage: (...args) => messages.push(args) };
  const context = { console, location: { origin: "http://localhost" }, document: { getElementById: (id) => nodes.get(id), querySelector: () => nodes.get("main") }, parent, monaco, require, I18n: { apply: (value) => applied.push(value) }, addEventListener: (name, action) => handlers.set(name, action) };
  context.window = context;
  vm.runInNewContext(source, context);
  const payload = { type: "preview-code.load", version: 1, text: "const x = 1;", language: "javascript", context: { locale: "zh-CN", dir: "ltr", theme: "dark" }, label: "源码预览", hint: "只读" };
  return { models, editors, applied, messages, send: (data = payload, origin = "http://localhost", sender = parent) => handlers.get("message")({ origin, source: sender, data }), payload, close: () => handlers.get("pagehide")() };
}
test("Monaco专用页拒绝非父窗口、外源及无效负载", () => {
  const app = setup();
  app.send(app.payload, "https://evil.test");
  app.send(app.payload, "http://localhost", {});
  app.send({ ...app.payload, language: "javascript:evil()" });
  app.send({ ...app.payload, context: { locale: "invalid", dir: "ltr", theme: "dark" } });
  assert.equal(app.models.length, 0);
  app.send();
  assert.equal(app.models.length, 1);
  assert.equal(app.editors[0].options.readOnly, true);
  assert.equal(app.editors[0].options.domReadOnly, true);
  assert.equal(app.editors[0].options.links, false);
  assert.equal(app.editors[0].options.ariaDescribedBy, "code-preview-hint");
  const html = fs.readFileSync(path.join(__dirname, "../web/preview-code.html"), "utf8");
  assert.match(html, /id="code-preview-hint" class="sr-only"/);
});
test("主题语言同步复用model，内容变化或关闭销毁model及editor", () => {
  const app = setup(); app.send();
  app.send({ ...app.payload, context: { locale: "ar-SA", dir: "rtl", theme: "light" } });
  assert.equal(app.models.length, 1); assert.equal(app.applied.at(-1).locale, "ar-SA");
  app.send({ ...app.payload, text: "updated" });
  assert.equal(app.models[0].disposed, true); assert.equal(app.editors[0].disposed, true);
  assert.equal(app.models.length, 2);
  app.send({ type: "preview-code.dispose", version: 1 });
  assert.equal(app.models[1].disposed, true); assert.equal(app.editors[1].disposed, true);
  app.send(); assert.equal(app.models.length, 2);
  app.close();
});
