"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const script = fs.readFileSync(path.join(__dirname, "../web/assets/workspace.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../web/workspace.html"), "utf8");
const section = (start, end) => script.slice(script.indexOf(start), script.indexOf(end));

function realm({ canWrite = true, kind = "file", name = "index.html", dir = "ltr", width = 320, height = 240 } = {}) {
  const events = {}, calls = [], links = [], nodes = new Map();
  const document = { documentElement: { clientWidth: width }, activeElement: null,
    addEventListener: (type, callback) => { events[type] = callback; } };
  function el(tag, attrs = {}, ...children) {
    const node = { tag, attrs: { ...attrs }, children: [], style: {}, isConnected: true,
      classList: { remove() {}, add() {} },
      append(...items) { this.children.push(...items.filter(Boolean)); },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      addEventListener(key, fn) { this[key] = fn; },
      contains(target) { return this === target || this.children.some((item) => typeof item === "object" && item.contains(target)); },
      querySelectorAll() { return this.children.filter((item) => item.tag === "button"); },
      getBoundingClientRect() { return tag === "button" ? { left: 280, right: 312, top: 200, bottom: 232 } : { width: 200, height: 144 }; },
      focus() { document.activeElement = this; },
      remove() { this.isConnected = false; },
      click() { if (tag === "a") links.push(this.attrs); else return attrs.onclick?.(); },
      ...Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("on"))),
    };
    node.append(...children);
    return node;
  }
  document.body = el("body");
  for (const id of ["file-list", "file-table-wrap", "file-empty", "workspace-title", "file-actions", "drop-zone", "file-status", "upload-input", "directory-input"]) nodes.set("#" + id, el("div"));
  for (const id of ["sort-name", "sort-size", "sort-time"]) nodes.set("#" + id, { parentElement: el("th") });
  nodes.set("#file-actions summary", el("summary"));
  const button = (key, action, cls) => el("button", { key, onclick: action, class: cls });
  const context = vm.createContext({ document, window: { innerHeight: height, addEventListener: (type, fn) => { events[type] = fn; } },
    URL, location: new URL("https://example.test/baba-share/workspace.html"),
    I18n: { t: (key) => key, ctx: { dir } },
    UI: { size: () => "1KB", date: () => "", empty: () => el("p") },
    el, button, icon: () => el("svg"), iconButton: (key) => el("button", { key }), $: (key) => nodes.get(key),
    workspace: { id: "space", canWrite, workspaceName: "空间" },
    entries: [{ kind, name, path: "目录/" + name, size: 1, canWrite }],
    path: "", sort: "name", ascending: true, uploading: false, alwaysOverwrite: false, activeMenu: null,
    API: async (key, options) => { calls.push({ key, options }); return { previewBaseUrl: "https://example.test/baba-share/preview/p/" + "a".repeat(43) + "/" }; },
    parentPath: (value) => value.slice(0, value.lastIndexOf("/")), isHtml: (value) => /\.html?$/i.test(value),
    crumbs() {}, openFolder() {}, previewFile() {}, editFile() {}, renameEntry() {}, deleteEntry() {},
    toast() {}, errorText: (error) => error.message,
  });
  vm.runInContext(section("  function closeRowMenu", "  function renderFiles"), context);
  vm.runInContext(section("  function renderFiles", "  function iconButton"), context);
  vm.runInContext(section("  async function downloadFile", "  async function previewFile"), context);
  return { context, document, nodes, events, calls, links, el, button, run: (code) => vm.runInContext(code, context) };
}

test("文件行仅预览和三点，HTML编辑及目录写操作统一收纳菜单", () => {
  for (const kind of ["file", "folder"]) {
    const app = realm({ kind });
    app.run("renderFiles()");
    const actions = app.nodes.get("#file-list").children[0].children.at(-1).children[0];
    assert.deepEqual(actions.children.map((node) => node.attrs.key || node.attrs["aria-label"]), kind === "file" ? ["preview", "actions"] : ["actions"]);
    const trigger = actions.children.at(-1);
    trigger.onclick();
    assert.deepEqual(Array.from(app.context.activeMenu.menu.children, (node) => node.attrs.key), kind === "file" ? ["previewDownload", "edit", "rename", "delete"] : ["rename", "delete"]);
  }
});

test("只读用户仍可下载文件，无编辑重命名删除入口，目录不创建空菜单", () => {
  for (const kind of ["file", "folder"]) {
    const app = realm({ canWrite: false, kind });
    app.run("renderFiles()");
    const actions = app.nodes.get("#file-list").children[0].children.at(-1).children[0];
    assert.equal(actions.children.length, kind === "file" ? 2 : 0);
    if (kind === "file") {
      actions.children.at(-1).onclick();
      assert.deepEqual(Array.from(app.context.activeMenu.menu.children, (node) => node.attrs.key), ["previewDownload"]);
    }
  }
});

test("下载按父目录获取ticket，文件名安全编码并使用raw download=1附件", async () => {
  const app = realm({ canWrite: false, name: "报表 #?%.txt" });
  await app.run("downloadFile(entries[0])");
  assert.equal(app.calls[0].key, "ticket");
  assert.equal(app.calls[0].options.method, "POST");
  assert.equal(app.calls[0].options.body.workspaceId, "space");
  assert.equal(app.calls[0].options.body.path, "目录");
  const link = app.links[0], url = new URL(link.href);
  assert.equal(decodeURIComponent(url.pathname.split("/").at(-1)), "报表 #?%.txt");
  assert.equal(url.searchParams.get("download"), "1");
  assert.equal(url.hash, "");
  assert.equal(link.download, "报表 #?%.txt");
  assert.equal(link.rel, "noreferrer");
});

test("下载拒绝跨域、非ticket、错误协议及附带查询片段的返回地址", async () => {
  for (const previewBaseUrl of ["https://evil.test/baba-share/preview/p/" + "a".repeat(43) + "/", "javascript:alert(1)", "https://example.test/baba-share/preview/s/" + "a".repeat(43) + "/", "https://example.test/baba-share/preview/p/invalid/", "https://example.test/baba-share/preview/p/" + "a".repeat(43) + "/?x=1", "https://example.test/baba-share/preview/p/" + "a".repeat(43) + "/#x"]) {
    const app = realm();
    app.context.API = async () => ({ previewBaseUrl });
    await assert.rejects(app.run("downloadFile(entries[0])"), /ROUTE_NOT_ALLOWED/);
    assert.equal(app.links.length, 0);
  }
});

test("菜单方向键Home End、Esc、Tab、点击外部关闭均恢复正确焦点", async () => {
  const app = realm();
  const trigger = app.run("rowActions(entries[0])");
  trigger.onclick();
  const menu = app.context.activeMenu.menu, items = menu.children;
  assert.equal(app.document.activeElement, items[0]);
  menu.keydown({ key: "End", preventDefault() {} });
  assert.equal(app.document.activeElement, items.at(-1));
  menu.keydown({ key: "ArrowDown", preventDefault() {} });
  assert.equal(app.document.activeElement, items[0]);
  menu.keydown({ key: "Home", preventDefault() {} });
  assert.equal(app.document.activeElement, items[0]);
  for (const key of ["Escape", "Tab"]) {
    app.events.keydown({ key, preventDefault() {} });
    assert.equal(app.context.activeMenu, null);
    assert.equal(app.document.activeElement, trigger);
    assert.equal(trigger.attrs["aria-expanded"], "false");
    trigger.onclick();
  }
  app.events.pointerdown({ target: app.document.body });
  assert.equal(app.context.activeMenu, null);
  assert.equal(app.document.activeElement, trigger);
  trigger.onclick();
  await app.context.activeMenu.menu.children[0].onclick();
  assert.equal(app.context.activeMenu, null);
  assert.equal(app.document.activeElement, trigger);
});

test("菜单在LTR RTL窄视口内固定定位且不影响列表滚动区", () => {
  for (const dir of ["ltr", "rtl"]) {
    const app = realm({ dir });
    app.run("rowActions(entries[0]).onclick()");
    const style = app.context.activeMenu.menu.style;
    assert.ok(parseFloat(style.left) >= 8 && parseFloat(style.left) + 200 <= 312);
    assert.ok(parseFloat(style.top) >= 8 && parseFloat(style.top) + 144 <= 232);
  }
  assert.match(html, /\.workspace-row-popover\s*\{[^}]*position: fixed;[^}]*top: 0;[^}]*left: 0;/);
  assert.match(html, /max-inline-size: calc\(100vw - var\(--space-4\)\)/);
  assert.match(html, /max-block-size: calc\(100dvh - var\(--space-4\)\)/);
  assert.match(html, /overflow-x: hidden/);
});

test("上传入口使用主题primary，繁忙时语义禁用并在结束后恢复", async () => {
  const app = realm();
  vm.runInContext(section("  function uploadMenu", "  function closeRowMenu"), app.context);
  const details = app.run("uploadMenu()"), summary = details.children[0];
  assert.equal(summary.attrs.class, "primary");
  assert.equal(summary.attrs["aria-disabled"], "false");
  assert.match(html, /\.upload-menu > summary\.primary\s*\{[^}]*background: var\(--color-primary\);[^}]*color: var\(--color-on-primary\);/);
  assert.match(html, /summary\.primary\[aria-disabled="true"\]/);
  let resolve;
  app.context.fileBase64 = async () => "YQ==";
  app.context.crypto = { randomUUID: () => "request" };
  app.context.loadFiles = async () => {};
  app.context.API = () => new Promise((done) => { resolve = done; });
  vm.runInContext(section("  async function uploadFiles", '  $("#file-search")'), app.context);
  const pending = app.run('uploadFiles([{ name: "a.txt" }])');
  await new Promise((done) => setImmediate(done));
  assert.equal(app.nodes.get("#file-actions").inert, true);
  assert.equal(app.nodes.get("#file-actions").attrs["aria-busy"], "true");
  assert.equal(app.nodes.get("#file-actions summary").attrs["aria-disabled"], "true");
  let prevented = false;
  summary.onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  resolve({});
  await pending;
  assert.equal(app.nodes.get("#file-actions").inert, false);
  assert.equal(app.nodes.get("#file-actions").attrs["aria-busy"], "false");
  assert.equal(app.nodes.get("#file-actions summary").attrs["aria-disabled"], "false");
});
