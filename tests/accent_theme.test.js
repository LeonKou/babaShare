"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assets = path.join(__dirname, "../web/assets");
const source = (name) => fs.readFileSync(path.join(assets, name), "utf8");
const accents = ["blue", "green", "purple", "red", "orange", "teal"];
const locales = ["zh-CN", "en-US", "ar-SA"];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function allowSharePreviewFetch(app) {
  app.context.fetch = async (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1\/baba-share\/preview\/s\/test\/(?:index|other)\.html$/);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    return { ok: true, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode("<!doctype html><p>preview</p>").buffer };
  };
}

function realm({ stored = "{}", blocked = false, page = "account.html" } = {}) {
  const nodes = [], events = new Map(), warnings = [], writes = [];
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.dataset = {};
      this.attrs = {};
      this.children = [];
      this.events = new Map();
      this.value = "";
      this.style = {};
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; },
      };
      nodes.push(this);
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (key === "value") this.value = String(value);
      if (key === "id") this.id = String(value);
    }
    getAttribute(key) { return this.attrs[key]; }
    removeAttribute(key) { delete this.attrs[key]; }
    focus() { document.activeElement = this; }
    contains(node) { return this === node || this.children.some((child) => child instanceof Element && child.contains(node)); }
    matches(selector) {
      return selector.split(",").some((part) => {
        part = part.trim();
        if (part === ":disabled") return Boolean(this.disabled);
        const exclusion = /:not\(([^)]+)\)/.exec(part);
        if (exclusion) return this.matches(part.replace(exclusion[0], "")) && !this.matches(exclusion[1]);
        const tag = /^([a-z][\w-]*)/i.exec(part);
        if (tag && tag[1].toLowerCase() !== this.tag) return false;
        for (const match of part.matchAll(/\[([\w-]+)(?:="?([^\]"]+)"?)?\]/g)) {
          const value = ["hidden", "inert", "disabled", "open"].includes(match[1])
            ? (this[match[1]] ? "" : undefined) : this.attrs[match[1]];
          if (value === undefined || match[2] !== undefined && value !== match[2]) return false;
        }
        return Boolean(tag || part.startsWith("["));
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (!(child instanceof Element)) continue;
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() { return this.isConnected && !this.closest("[hidden]") && this.style.display !== "none" ? [{}] : []; }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
    select() { this.selected = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    get isConnected() { return document.body.contains(this); }
    get textContent() { return this.children.map((child) => typeof child === "object" ? child.textContent || "" : String(child)).join(""); }
    set textContent(value) { this.replaceChildren(...(String(value) ? [String(value)] : [])); }
    get childNodes() { return this.children; }
    get lastChild() { return this.children.at(-1); }
    cloneNode() { const node = new Element(this.tag); node.id = this.id; Object.assign(node.attrs, this.attrs); return node; }
    replaceWith(node) { this.remove(); this.id = undefined; document.body.append(node); }
    get elements() {
      const inputs = [];
      const walk = (node) => {
        if (node.attrs?.name) inputs.push(node);
        for (const child of node.children || []) if (typeof child === "object") walk(child);
      };
      walk(this);
      inputs.namedItem = (name) => inputs.find((node) => node.attrs.name === name);
      return inputs;
    }
    append(...children) {
      for (const child of children) {
        if (child instanceof Element) { child.remove(); child.parentNode = this; }
        this.children.push(child);
      }
    }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { for (const child of [...this.children]) if (child instanceof Element) child.remove(); this.children = []; this.append(...children); }
    addEventListener(type, fn) {
      if (!this.events.has(type)) this.events.set(type, new Set());
      this.events.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
    fire(type, value = {}) { let result; for (const fn of this.events.get(type) || []) result = fn(value); return result; }
  }
  const document = {
    readyState: "complete",
    documentElement: { lang: "zh-CN", dir: "ltr", dataset: { mode: "dark" } },
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    createTextNode: (value) => Object.assign(new Element("#text"), { textContent: value }),
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(fn);
    },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
    querySelectorAll(selector) {
      if (selector === "#share-tree button[data-path]") return nodes.filter((node) => node.dataset.path);
      if (selector === "dialog[open]") return nodes.filter((node) => node.tag === "dialog" && node.open);
      if (!selector.startsWith("[")) return [];
      const key = selector.slice(1, -1);
      return nodes.filter((node) => Object.hasOwn(node.attrs, key));
    },
    querySelector(selector) {
      if (selector.includes("common.js")) return { src: "http://127.0.0.1/baba-share/assets/common.js" };
      if (selector === ".topbar-title strong") return title;
      if (selector === ".app-main") return nodes.find((node) => node.id === "app-main");
      if (selector === "main") return nodes.find((node) => node.tag === "main");
      return nodes.find((node) => "#" + node.id === selector) || null;
    },
  };
  document.body = new Element("body");
  const title = new Element("strong");
  const context = {
    document, URL, Promise, setTimeout, clearTimeout, queueMicrotask, AbortController, TextDecoder, Uint8Array, Blob,
    crypto: require("node:crypto").webcrypto, requestAnimationFrame: (fn) => setImmediate(fn),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    FormData: class {
      constructor(form) {
        return form.elements.map((node) => [node.attrs.name, node.value]);
      }
    },
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    location: new URL("http://127.0.0.1/baba-share/" + page),
    history: { state: null, replaceState(state, _, url) { this.state = state; context.location = new URL(url); } },
    localStorage: {
      getItem() { if (blocked) throw new Error("禁用存储"); return stored; },
      setItem(key, value) { if (blocked) throw new Error("禁用存储"); writes.push([key, value]); },
    },
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(fn);
    },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
  };
  if (page === "index.html" || page.startsWith("index.html?")) {
    const timers = new Map(); let sequence = 0;
    context.setTimeout = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; };
    context.clearTimeout = (id) => timers.delete(id);
    context.testTimers = timers;
  }
  context.window = context;
  context.parent = context;
  vm.createContext(context);
  const run = (name) => vm.runInContext(source(name), context, { filename: name });
  const dispatch = (type, event) => { for (const fn of events.get(type) || []) fn(event); };
  const snapshot = () => JSON.parse(JSON.stringify(context.I18n.ctx));
  run("boot.js");
  run("i18n.js");
  return { context, run, document, nodes, writes, warnings, Element, dispatch, snapshot };
}

function controls(app) {
  app.run("common.js");
  const holder = new app.Element("div");
  app.context.UI.settingsControls(holder);
  return holder.children;
}

async function shell(app, role = "editor", respond, { realApi = false } = {}) {
  for (const id of ["app-main", "page-loading", "page-load-error", "page-announcement", "brand-home", "page-frame", "shell-controls", "new-workspace-icon", "logout-icon", "workspace-nav", "account-nav", "new-workspace", "shell-account", "logout", "new-workspace"]) {
    const node = new app.Element(id === "page-frame" ? "iframe" : "div");
    node.id = id;
  }
  app.run("bridge-core.js");
  app.run("app-bridge.js");
  app.run("common.js");
  if (realApi) app.run("api.js");
  else app.context.API = async (name) => {
    if (respond) return respond(name);
    if (name === "install") return { setupRequired: false };
    if (name === "me") return { nickname: "测试", role };
    if (name === "workspaces") return [];
    throw new Error("不应写入业务数据 " + name);
  };
  app.run("onboarding-feedback.js");
  await app.run("shell.js");
  return app.document.querySelector("#page-frame");
}

test("首屏门控等待就绪握手、首轮加载文案只显示一次且多次complete共享结果", async () => {
  const app = realm({ page: "account.html?__frame=session" });
  const main = new app.Element("main"); app.document.body.append(main);
  let release; const emitted = [];
  app.run("bridge-core.js");
  app.context.PageBridgeClient = { create: () => ({
    ready: new Promise((resolve) => { release = resolve; }), embedded: true,
    emit: (...args) => emitted.push(args), request: async () => true, on() {}, handle() {}, destroy() {},
  }) };
  app.run("common.js");
  const bridge = app.context.UI.page(); app.context.AppPage = bridge;
  const status = new app.Element("p"); main.append(status);
  app.context.UI.loading(status, "loadingFiles");
  assert.equal(status.textContent, "");
  const first = bridge.complete(), second = bridge.complete();
  assert.equal(first, second);
  release(app.snapshot()); await Promise.all([first, second]);
  assert.equal(status.textContent, "");
  app.context.UI.loading(status, "loadingFiles");
  assert.equal(status.textContent, app.context.I18n.t("loadingFiles"));
  assert.equal(main.getAttribute("aria-busy"), "false");
  assert.equal(emitted.filter(([type]) => type === "page.state").length, 1);
  assert.equal(emitted.find(([type]) => type === "page.state")[1].state, "ready");
});

test("初始化失败状态不冒充ready，独立页面继续显示本地加载反馈", async () => {
  const app = realm({ page: "account.html?__frame=session" });
  const main = new app.Element("main"); app.document.body.append(main);
  let release; const emitted = [];
  app.run("bridge-core.js");
  app.context.PageBridgeClient = { create: () => ({ ready: new Promise((resolve) => { release = resolve; }), embedded: true,
    emit: (...args) => emitted.push(args), request: async () => true, on() {}, handle() {}, destroy() {} }) };
  app.run("common.js"); const bridge = app.context.UI.page();
  bridge.fail(new Error("offline"));
  const completion = bridge.complete(); release(app.snapshot()); await completion;
  assert.equal(emitted.find(([type]) => type === "page.state")[1].state, "error");
  const standalone = realm(); standalone.run("common.js");
  const status = new standalone.Element("p"); standalone.document.body.append(status);
  standalone.context.UI.loading(status, "loadingFiles");
  assert.equal(status.textContent, standalone.context.I18n.t("loadingFiles"));
});

test("异步按钮处理中禁重复、失败恢复且确认取消不提示成功", async () => {
  const app = realm(); app.run("common.js"); const { UI, I18n } = app.context;
  let release, count = 0;
  const control = UI.button("delete", () => { count++; return new Promise((resolve) => { release = resolve; }); }, "", null, { showBusy: true });
  app.document.body.append(control);
  const pending = control.fire("click");
  assert.equal(control.disabled, true); assert.equal(control.getAttribute("aria-busy"), "true");
  assert.equal(control.children[0].textContent, I18n.t("processing"));
  control.fire("click"); assert.equal(count, 1);
  const otherResource = UI.button("delete", () => { count++; }); otherResource.fire("click"); assert.equal(count, 2);
  release(false); await pending;
  assert.equal(control.disabled, false); assert.equal(control.getAttribute("aria-busy"), "false");
  assert.equal(app.document.querySelector("#global-toast"), null);
  const failed = UI.button("remove", async () => { throw { status: "PERMISSION_DENIED" }; });
  await failed.fire("click");
  assert.equal(Boolean(failed.disabled), false);
  assert.equal(app.document.querySelector("#global-toast").dataset.kind, "error");
});

test("打开表单等待交互时不显示处理中且同按钮仍防重复打开", async () => {
  const app = realm(); app.run("common.js"); const { UI, I18n } = app.context;
  let release, opened = 0;
  const control = UI.button("edit", () => { opened++; return new Promise((resolve) => { release = resolve; }); });
  const original = control.textContent, originalChildren = [...control.children];
  const pending = control.fire("click");
  assert.equal(control.textContent, original);
  assert.deepEqual(control.children, originalChildren);
  assert.notEqual(control.getAttribute("aria-busy"), "true");
  control.fire("click"); assert.equal(opened, 1);
  release(null); await pending;
  const again = control.fire("click"); assert.equal(opened, 2);
  release(null); await again;
});

test("语义toast穿过真实iframe桥接到母版，dialog保持本地顶层并关闭后保留通知", async () => {
  const host = realm({ page: "index.html" }); const frame = await shell(host, "admin");
  const child = realm({ page: "settings.html" }); await attach(host, frame, child);
  await child.context.UI.toast("服务器已保存", { kind: "success" });
  const parentToast = host.document.querySelector("#global-toast");
  assert.equal(parentToast.textContent, "服务器已保存"); assert.equal(parentToast.dataset.kind, "success");
  assert.equal(child.document.querySelector("#global-toast"), null);
  const popup = child.context.UI.dialog("测试表单", () => {});
  child.context.UI.toast("权限不足", { kind: "error" });
  const notice = child.document.querySelector("#global-toast");
  assert.equal(notice.parentNode, popup.node); assert.equal(notice.dataset.kind, "error");
  popup.close(null); assert.equal(notice.parentNode, child.document.body);
  const next = child.context.UI.dialog("后续弹窗", () => {});
  assert.equal(notice.parentNode, next.node); next.close(null);
});

test("共享表单等待防重复与Esc取消、失败保留草稿、成功关闭后明确反馈", async () => {
  const app = realm(); app.run("common.js");
  const { UI, I18n } = app.context; const states = [];
  app.context.AppPage = { setDirty(value) { states.push(value); } };
  let release, reject, calls = 0;
  const result = UI.formDialog("编辑", [{ key: "name", value: "初始" }], () => { calls++; return new Promise((ok, fail) => { release = ok; reject = fail; }); }, { dirty: true });
  const popup = app.nodes.findLast((node) => node.tag === "dialog"), form = popup.querySelector("form");
  const input = form.elements.namedItem("name"); input.value = "草稿"; form.fire("input");
  const feedback = form.children.at(-1), status = feedback.children[0], save = form.children[0].children.at(-1).children[1];
  const pending = form.fire("submit", { preventDefault() {} });
  assert.equal(save.disabled, true); assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(status.textContent, I18n.t("saving"));
  await form.fire("submit", { preventDefault() {} }); assert.equal(calls, 1);
  let prevented = false; popup.fire("cancel", { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  reject({ status: "PERMISSION_DENIED" }); await pending;
  assert.equal(input.value, "草稿"); assert.equal(states.at(-1), true); assert.equal(popup.open, true);
  assert.equal(status.textContent, I18n.t("permissionDenied")); assert.equal(save.disabled, false);
  const retry = form.fire("submit", { preventDefault() {} }); release({ id: "saved" }); await retry;
  assert.equal((await result).id, "saved"); assert.equal(states.at(-1), false); assert.equal(popup.open, false);
  assert.equal(app.document.querySelector("#global-toast").dataset.kind, "success");
  assert.equal(app.document.querySelector("#global-toast").parentNode, app.document.body);
});

test("真实直接写操作删除工作区/文件/成员/分享及启停用户仅服务器成功提示成功", async () => {
  const cases = [
    ["workspace.js", "deleteWorkspace", "selectWorkspace", "deleteWorkspace", { id: "w", workspaceName: "测试" }],
    ["workspace.js", "deleteEntry", "previewFile", "delete", { path: "a.html", name: "a.html", kind: "file" }],
    ["workspace.js", "removeMember", "newFolder", "remove", { userId: "member" }],
    ["account.js", "deleteShare", "load", "delete", { id: "s" }],
    ["users.js", "toggleUser", "load", "disableUser", { id: "u", nickname: "成员", isDisabled: false }],
  ];
  for (const [file, name, next, key, target] of cases) for (const outcome of ["success", "failure", "cancel"]) {
    const app = realm(); app.run("common.js"); const ctx = app.context, notices = [], requests = [];
    let release;
    Object.assign(ctx, { target, workspaces: [target], workspace: { id: "workspace" }, members: [], entries: [], shares: [target], users: [target],
      controller: null, requestId: 0, path: "", alwaysOverwrite: false,
      render() {}, renderChrome() {}, updateUrl() {}, notifyChanged() {}, loadMembers: async () => {}, loadFiles: async () => {},
      pager: { reset() {} }, I18n: ctx.I18n, toast: (message, options) => notices.push({ message, options }), errorText: ctx.UI.errorText,
      API: async (route, options) => { requests.push({ route, options }); await new Promise((ok) => { release = ok; }); if (outcome === "failure") throw { status: "PERMISSION_DENIED" }; return { ...target, isDisabled: true }; } });
    const userCards = app.document.createElement("div");
    app.document.activeElement = app.document.body;
    Object.assign(ctx, { $: (selector) => selector === "#user-cards" ? userCards : ctx.UI.$(selector) });
    ctx.UI.confirm = async () => outcome !== "cancel";
    const text = source(file); vm.runInContext(text.slice(text.indexOf("  async function " + name + "("), text.indexOf("  async function " + next + "(")), ctx);
    const control = ctx.UI.button(key, () => ctx[name](target), "", null, { showBusy: true });
    const pending = control.fire("click"); await flush(); if (outcome !== "cancel") control.fire("click");
    assert.equal(requests.length, outcome === "cancel" ? 0 : 1, name + ": " + outcome);
    if (outcome !== "cancel") { assert.equal(control.getAttribute("aria-busy"), "true"); assert.equal(notices.filter((notice) => notice.options?.kind === "success").length, 0); release(); }
    await pending;
    assert.equal(control.disabled, false);
    assert.equal(notices.filter((notice) => notice.options?.kind === "success").length, outcome === "success" ? 1 : 0, name + ": " + outcome);
    if (outcome === "failure") assert.equal(notices.at(-1).options.kind, "error");
    if (outcome === "cancel") assert.equal(notices.length, 0);
  }
});

test("管理员设置菜单与初始固定路由同步，非管理员无菜单且不能导航", async () => {
  const admin = realm({ page: "index.html?route=settings" });
  const frame = await shell(admin, "admin");
  assert.equal(new URL(frame.src).pathname, "/baba-share/settings.html");
  const menu = admin.document.querySelector("#account-nav");
  const settings = menu.children.find((node) => node.attrs["aria-label"] === admin.context.I18n.t("settings"));
  assert(settings); assert.equal(settings.attrs["aria-current"], "page");
  assert.equal(new URL(admin.context.UI.routeUrl("settings")).pathname, "/baba-share/settings.html");
  assert.throws(() => admin.context.UI.routeUrl("https://evil.invalid"), /ROUTE_NOT_ALLOWED/);
  const viewer = realm({ page: "index.html?route=settings" });
  const deniedFrame = await shell(viewer, "editor");
  assert.equal(deniedFrame.src, undefined);
  assert.equal(viewer.document.querySelector("#account-nav").children.some((node) => node.attrs["aria-label"] === viewer.context.I18n.t("settings")), false);
});

async function attach(host, frame, child, wire = {}, start = () => child.context.UI.page(), { deferLoad = false } = {}) {
  wire.child = child;
  wire.hostProxy ||= {
    location: host.context.location,
    postMessage(data) {
      queueMicrotask(() => host.dispatch("message", { origin: host.context.location.origin, source: wire.childProxy, data: structuredClone(data) }));
    },
  };
  wire.childProxy ||= {
    postMessage(data) {
      queueMicrotask(() => wire.child.dispatch("message", { origin: host.context.location.origin, source: wire.hostProxy, data: structuredClone(data) }));
    },
  };
  frame.contentWindow = wire.childProxy;
  if (!deferLoad) {
    wire.childProxy.location = { href: frame.src };
    frame.fire("load");
  }
  child.context.parent = wire.hostProxy;
  child.context.location.searchParams.set("__frame", new URL(frame.src).searchParams.get("__frame"));
  child.run("bridge-core.js");
  child.run("page-bridge.js");
  child.run("common.js");
  const started = start();
  const bridge = child.context.AppPage;
  await bridge.ready;
  await flush();
  return { bridge, wire, started };
}

test("母版首屏和load仍隐藏，真实业务complete后显现，局部加载不重复遮罩", async () => {
  const host = realm({ page: "index.html" }), frame = await shell(host);
  const main = host.document.querySelector(".app-main"), loading = host.document.querySelector("#page-loading");
  assert(frame.classList.contains("page-pending")); assert.equal(frame.inert, true);
  assert.equal(main.attrs["aria-busy"], "true");
  const child = realm(), { bridge } = await attach(host, frame, child);
  assert.equal(frame.dataset.loaded, "true");
  assert(frame.classList.contains("page-pending"));
  const status = new child.Element("p"); child.context.UI.loading(status); assert.equal(status.textContent, "");
  await bridge.complete(); await flush();
  assert.equal(frame.classList.contains("page-pending"), false); assert.equal(frame.inert, false);
  assert.equal(main.attrs["aria-busy"], "false"); assert.equal(loading.hidden, true);
  child.context.UI.loading(status); assert.equal(status.textContent, child.context.I18n.t("loading"));
  await bridge.complete(); frame.fire("load"); assert.equal(loading.hidden, true);
  host.dispatch("pagehide", {}); bridge.destroy();
});

test("iframe目标load先到时仍等待业务ready，about:blank load不放行", async () => {
  const host = realm({ page: "index.html" }), frame = await shell(host);
  const child = realm(), { bridge, wire } = await attach(host, frame, child, {}, undefined, { deferLoad: true });
  wire.childProxy.location = { href: "about:blank" }; frame.fire("load");
  assert(frame.classList.contains("page-pending"));
  wire.childProxy.location = { href: frame.src }; frame.fire("load");
  assert(frame.classList.contains("page-pending"));
  await bridge.complete(); await flush();
  assert.equal(frame.classList.contains("page-pending"), false);
  host.dispatch("pagehide", {}); bridge.destroy();
});

test("业务ready先到仍等待目标文档load且忽略about:blank", async () => {
  const host = realm({ page: "index.html" }), frame = await shell(host);
  const child = realm(), { bridge, wire } = await attach(host, frame, child, {}, undefined, { deferLoad: true });
  await bridge.complete(); await flush();
  assert(frame.classList.contains("page-pending"));
  wire.childProxy.location = { href: "about:blank" }; frame.fire("load");
  assert(frame.classList.contains("page-pending"));
  wire.childProxy.location = { href: frame.src }; frame.fire("load");
  assert.equal(frame.classList.contains("page-pending"), false);
  host.dispatch("pagehide", {}); bridge.destroy();
});

test("业务ready后首屏更新查询参数不阻止目标load，错误路径或会话仍被拒绝", async () => {
  const host = realm({ page: "index.html" }), frame = await shell(host);
  const child = realm(), { bridge, wire } = await attach(host, frame, child, {}, undefined, { deferLoad: true });
  await bridge.complete(); await flush();
  const target = new URL(frame.src);
  for (const change of [
    (url) => { url.pathname = "/baba-share/settings.html"; },
    (url) => { url.searchParams.set("__frame", "old-session"); },
    (url) => { url.searchParams.delete("__frame"); },
    (url) => { url.hostname = "other.invalid"; },
  ]) {
    const invalid = new URL(target); change(invalid);
    wire.childProxy.location = { href: invalid.href }; frame.fire("load");
    assert(frame.classList.contains("page-pending"));
    assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "true");
  }
  target.searchParams.delete("action");
  target.searchParams.set("path", ""); target.searchParams.set("sort", "name"); target.searchParams.set("order", "asc");
  wire.childProxy.location = { href: target.href }; frame.fire("load");
  assert.equal(frame.classList.contains("page-pending"), false);
  assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "false");
  host.dispatch("pagehide", {}); bridge.destroy();
});

test("iframe先error后收到业务ready和load仍保持失败直到重试", async () => {
  const host = realm({ page: "index.html" }), frame = await shell(host);
  const child = realm(), { bridge, wire } = await attach(host, frame, child, {}, undefined, { deferLoad: true });
  frame.fire("error");
  await bridge.complete(); await flush();
  wire.childProxy.location = { href: frame.src }; frame.fire("load");
  assert(frame.classList.contains("page-pending")); assert.equal(frame.inert, true);
  assert.equal(host.document.querySelector("#page-load-error").hidden, false);
  assert.equal(host.document.querySelector("#page-loading").hidden, true);
  assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "false");
  const failure = host.document.querySelector("#page-load-error");
  await failure.children.at(-1).fire("click");
  const current = host.document.querySelector("#page-frame");
  const next = realm(), connected = await attach(host, current, next);
  await connected.bridge.complete(); await flush();
  assert.equal(current.classList.contains("page-pending"), false);
  assert.equal(failure.hidden, true);
  host.dispatch("pagehide", {}); bridge.destroy(); connected.bridge.destroy();
});

test("iframe传输error优先于业务ready及之后的迟到load", async () => {
  const host = realm({ page: "index.html" }), frame = await shell(host);
  const child = realm(), { bridge, wire } = await attach(host, frame, child, {}, undefined, { deferLoad: true });
  await bridge.complete(); await flush();
  frame.fire("error");
  wire.childProxy.location = { href: frame.src }; frame.fire("load");
  assert(frame.classList.contains("page-pending"));
  assert.equal(host.document.querySelector("#page-load-error").hidden, false);
  assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "false");
  host.dispatch("pagehide", {}); bridge.destroy();
});

test("快速切页后旧frame迟到load和error不能替代当前文档load", async () => {
  const host = realm({ page: "index.html" }), old = await shell(host);
  const child = realm(), previous = await attach(host, old, child, {}, undefined, { deferLoad: true });
  await previous.bridge.complete(); await flush();
  await host.document.querySelector("#new-workspace").fire("click");
  const current = host.document.querySelector("#page-frame"); assert.notEqual(current, old);
  const next = realm(), connected = await attach(host, current, next, {}, undefined, { deferLoad: true });
  await connected.bridge.complete(); await flush();
  previous.wire.childProxy.location = { href: old.src }; old.fire("load"); old.fire("error");
  assert(current.classList.contains("page-pending"));
  assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "true");
  assert.equal(host.document.querySelector("#page-load-error").hidden, true);
  connected.wire.childProxy.location = { href: current.src }; current.fire("load");
  assert.equal(current.classList.contains("page-pending"), false);
  host.dispatch("pagehide", {}); previous.bridge.destroy(); connected.bridge.destroy();
});

test("母版启动任一API超时后迟到结果不重新激活，侧栏品牌及新建均不能绕过，重试刷新", async () => {
  const tasks = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
  for (const delayed of ["install", "me", "workspaces", "onboarding"]) for (const rejected of [false, true]) {
    const host = realm({ page: "index.html" }), calls = [];
    let release, reject, reloads = 0;
    host.context.location.reload = () => { reloads++; };
    const values = { install: { setupRequired: false }, me: { nickname: "测试", role: "editor" }, workspaces: [{ id: "space", workspaceName: "空间" }],
      onboarding: { version: 1, enabled: true, tasks: tasks.map((key) => ({ key, completed: false })), totalCount: 6, completedCount: 0, allComplete: false } };
    const starting = shell(host, "editor", (name) => {
      calls.push(name);
      return name === delayed ? new Promise((resolve, fail) => { release = resolve; reject = fail; }) : values[name];
    });
    await flush(); assert.equal(calls.at(-1), delayed);
    const initial = host.document.querySelector("#page-frame"), loading = host.document.querySelector("#page-loading"), failure = host.document.querySelector("#page-load-error");
    const clickNavigation = async () => {
      await host.document.querySelector("#brand-home").fire("click", { button: 0, preventDefault() {} });
      await host.document.querySelector("#new-workspace").fire("click");
      for (const id of ["#workspace-nav", "#account-nav"]) for (const item of host.document.querySelector(id).children) await item.fire("click");
      assert.equal(host.document.querySelector("#page-frame"), initial);
      assert.equal(initial.src, undefined);
    };
    await clickNavigation();
    [...host.context.testTimers.values()].find((timer) => timer.ms === 20000).fn();
    assert.equal(failure.hidden, false); assert.equal(loading.hidden, true);
    const before = calls.length;
    if (rejected) reject(new Error("迟到失败")); else release(values[delayed]);
    await starting; await flush();
    assert.equal(calls.length, before, "超时后不能继续后续启动请求");
    await clickNavigation();
    assert.equal(failure.hidden, false); assert.equal(loading.hidden, true);
    assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "false");
    await failure.children.at(-1).fire("click");
    assert.equal(reloads, 1, delayed + "启动尚未完成须刷新");
    assert.equal(host.document.querySelector("#page-frame"), initial);
    host.dispatch("pagehide", {});
  }
});

test("母版启动过程中离开后迟到API结果不触发导航", async () => {
  const host = realm({ page: "index.html" }); let release;
  const starting = shell(host, "admin", () => new Promise((resolve) => { release = resolve; }));
  await flush();
  const initial = host.document.querySelector("#page-frame");
  host.dispatch("pagehide", {}); release({ setupRequired: false }); await starting;
  assert.equal(host.document.querySelector("#page-frame"), initial); assert.equal(initial.src, undefined);
});

test("真实API包装在启动超时或离开后丢弃迟到401，包括响应头及JSON读取阶段", async () => {
  for (const delayed of ["/session/detail", "/workspace/list", "/onboarding/detail"]) for (const stage of ["fetch", "json"]) for (const invalidation of ["timeout", "pagehide"]) {
    const host = realm({ page: "index.html" }), calls = [], redirects = [];
    let release, pendingSignal;
    host.context.location.replace = (url) => redirects.push(url);
    host.context.fetch = async (url, options) => {
      const route = new URL(url).pathname; calls.push(route);
      if (route.endsWith(delayed)) {
        pendingSignal = options.signal;
        if (stage === "fetch") return new Promise((resolve) => { release = () => resolve({ ok: false, status: 401, json: async () => ({ status: "AUTH_REQUIRED" }) }); });
        return { ok: false, status: 401, json: () => new Promise((resolve) => { release = () => resolve({ status: "AUTH_REQUIRED" }); }) };
      }
      const value = route.endsWith("/install/detail") ? { setupRequired: false } : route.endsWith("/session/detail") ? { role: "editor", nickname: "测试" } : [];
      return { ok: true, status: 200, json: async () => value };
    };
    const starting = shell(host, "editor", null, { realApi: true });
    await flush(); assert.equal(typeof release, "function", delayed + " " + stage);
    const frame = host.document.querySelector("#page-frame"), before = calls.length;
    if (invalidation === "timeout") [...host.context.testTimers.values()].find((timer) => timer.ms === 20000).fn();
    else host.dispatch("pagehide", {});
    assert.equal(pendingSignal.aborted, true);
    const navBefore = host.document.querySelector("#account-nav").children.slice();
    release(); await starting; await flush();
    assert.deepEqual(redirects, [], "迟到401不得跳登录");
    assert.equal(calls.length, before, "不得继续后续启动请求");
    assert.equal(host.document.querySelector("#page-frame"), frame); assert.equal(frame.src, undefined);
    assert.deepEqual(host.document.querySelector("#account-nav").children, navBefore, "失效catch不得再次渲染菜单");
    assert.equal(host.document.querySelector("#global-toast"), null, "失效catch不得再吐toast");
    if (invalidation === "timeout") {
      assert.equal(host.document.querySelector("#page-load-error").hidden, false);
      assert.equal(host.document.querySelector("#page-loading").hidden, true);
      assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], "false");
      host.dispatch("pagehide", {});
    }
  }
});

test("真实API包装保留正常401跳转及匿名和成功业务响应，取消请求不消费迟到响应", async () => {
  for (const key of ["me", "workspaces", "onboarding", "install"]) {
    const app = realm({ page: "index.html" }), redirects = [];
    app.run("common.js"); app.run("api.js");
    app.context.location.replace = (url) => redirects.push(url);
    app.context.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: "AUTH_REQUIRED" }) });
    await assert.rejects(app.context.API(key), (error) => error.httpStatus === 401);
    assert.equal(redirects.length, key === "install" ? 0 : 1);
    if (redirects.length) assert.equal(new URL(redirects[0]).pathname, "/baba-share/auth.html");
  }
  const app = realm({ page: "index.html" }); app.run("common.js"); app.run("api.js");
  app.context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ entries: [{ name: "文档" }] }) });
  assert.equal((await app.context.API("nodes")).entries[0].name, "文档");
  const controller = new AbortController(); let release;
  app.context.fetch = () => new Promise((resolve) => { release = resolve; });
  const pending = app.context.API("me", { signal: controller.signal });
  controller.abort(); release({ status: 204 });
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("母版超时和传输错误可见且重试恢复，旧frame消息与迟到load无效", async () => {
  const host = realm({ page: "index.html" }), old = await shell(host);
  const child = realm(), { bridge, wire } = await attach(host, old, child);
  const oldSession = new URL(old.src).searchParams.get("__frame");
  const timeout = [...host.context.testTimers.values()].find((timer) => timer.ms === 20000);
  timeout.fn();
  const failure = host.document.querySelector("#page-load-error"), loading = host.document.querySelector("#page-loading");
  assert.equal(failure.hidden, false); assert.equal(loading.hidden, true);
  await failure.children.at(-1).fire("click");
  const current = host.document.querySelector("#page-frame"); assert.notEqual(current, old);
  const beforeOldLoad = host.document.querySelector(".app-main").attrs["aria-busy"];
  old.fire("load");
  assert.equal(host.document.querySelector(".app-main").attrs["aria-busy"], beforeOldLoad);
  host.dispatch("message", { origin: host.context.location.origin, source: wire.childProxy,
    data: { babaShare: true, version: 1, session: oldSession, type: "page.state", payload: { version: 1, state: "ready" } } });
  await flush(); assert(current.classList.contains("page-pending"));
  const next = realm(), connected = await attach(host, current, next);
  connected.bridge.fail(new Error("初始数据失败")); await connected.bridge.complete(); await flush();
  assert.equal(current.classList.contains("page-pending"), true); assert.equal(loading.hidden, true);
  assert.equal(failure.hidden, false);
  current.fire("error"); assert.equal(failure.hidden, false);
  host.dispatch("pagehide", {}); bridge.destroy(); connected.bridge.destroy();
});

test("独立页初始反馈与失败结束、三语双主题和RTL保留", async () => {
  for (const locale of locales) for (const theme of ["light", "dark"]) {
    const app = realm({ stored: JSON.stringify({ locale, theme }) }); app.run("page-bridge.js"); app.run("common.js");
    const main = new app.Element("main"); app.document.body.append(main);
    const bridge = app.context.UI.page(); await bridge.ready;
    const status = new app.Element("p"); app.context.UI.loading(status);
    assert.equal(status.textContent, app.context.I18n.t("loading")); assert.equal(main.attrs["aria-busy"], "true");
    bridge.fail(new Error("offline")); await bridge.complete();
    assert.equal(main.attrs["aria-busy"], "false"); assert.equal(bridge.initializing, false);
    assert.equal(app.snapshot().locale, locale); assert.equal(app.snapshot().theme, theme);
    for (const key of ["pageLoadError", "pageLoadTimeout", "pageReady"]) assert.notEqual(app.context.I18n.t(key), key);
    bridge.destroy();
  }
});

test("独立页首轮fatal和业务失败只清理明确登记的加载节点，保留错误及并列业务内容", async () => {
  for (const mode of ["error", "unhandledrejection", "initialError"]) {
    const app = realm(); app.run("page-bridge.js"); app.run("common.js");
    const main = new app.Element("main"); app.document.body.append(main);
    const bridge = app.context.UI.page(); await bridge.ready;
    const pending = app.context.UI.el("p"), replaced = app.context.UI.el("p"), appended = app.context.UI.el("p");
    const unrelated = app.context.UI.el("p", { text: app.context.I18n.t("loading") });
    main.append(pending, replaced, appended, unrelated);
    for (const node of [pending, replaced, appended]) app.context.UI.loading(node);
    const originalLoading = pending.children[0];
    replaced.textContent = "读取失败";
    appended.append(app.context.UI.button("retry", () => {}));
    if (mode === "initialError") bridge.fail(new Error("首轮业务失败"));
    else app.dispatch(mode, mode === "error" ? { error: new Error("脚本失败") } : { reason: new Error("异步失败") });
    await bridge.complete();
    assert.equal(pending.textContent, ""); assert.equal(originalLoading.parentNode, null);
    assert.equal(replaced.textContent, "读取失败");
    assert.equal(appended.children.length, 1); assert.equal(appended.children[0].tag, "button");
    assert.equal(unrelated.textContent, app.context.I18n.t("loading"), "不得按文案泛扫其他内容");
    assert.equal(main.attrs["aria-busy"], "false"); assert.equal(bridge.initializing, false);
    if (mode !== "initialError") assert.equal(app.document.querySelector("#page-initial-error").textContent, app.context.I18n.t("pageLoadError"));
    app.context.UI.loading(pending);
    assert.equal(pending.textContent, app.context.I18n.t("loading"), "后续局部加载仍可正常显示");
    bridge.destroy();
  }
});

test("桥接重连立即关闭旧endpoint的待处理请求", async () => {
  const app = realm(); app.run("bridge-core.js");
  const target = { postMessage() {} };
  const endpoint = app.context.BabaShareBridgeEndpoint(() => target, () => true, null, "session");
  const request = endpoint.request("shell.title", {}, 10000);
  endpoint.cancelPending();
  await assert.rejects(request, /BRIDGE_CLOSED/);
  endpoint.destroy();
});

test("握手超时降级独立页且迟到回复无效，页面离开关闭待处理请求", async () => {
  const app = realm(); app.run("bridge-core.js"); app.run("page-bridge.js"); app.run("common.js");
  const sent = [], timers = new Map(); let sequence = 0;
  app.context.setTimeout = (fn) => { const id = ++sequence; timers.set(id, fn); return id; };
  app.context.clearTimeout = (id) => timers.delete(id);
  app.context.parent = { location: app.context.location, postMessage: (message) => sent.push(message) };
  const bridge = app.context.UI.page(); assert.equal(sent[0].type, "bridge.hello");
  [...timers.values()][0](); await bridge.ready; assert.equal(bridge.embedded, false);
  app.dispatch("message", { origin: app.context.location.origin, source: app.context.parent,
    data: { ...sent[0], replyTo: sent[0].requestId, payload: { theme: "light", locale: "ar-SA" } } });
  await flush(); assert.equal(app.snapshot().locale, "zh-CN");
  app.dispatch("pagehide", {}); await assert.rejects(bridge.request("shell.title", {}), /BRIDGE_CLOSED/);
});

for (const accent of accents) {
  test("首屏恢复预设 " + accent + " 并保留三语双主题", () => {
    for (const locale of locales) for (const theme of ["light", "dark"]) {
      const app = realm({ stored: JSON.stringify({ accent, locale, theme, dir: "wrong", token: "不可传播" }) });
      assert.deepEqual(app.snapshot(), { accent, locale, theme, dir: { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale] });
      assert.equal(app.document.documentElement.dataset.accent, accent);
    }
  });
}

test("缺省、非法色值和损坏存储均回退默认蓝且不注入样式", () => {
  const rawColor = source("tokens.css").match(/--accent:(#[\da-f]+)/)[1];
  for (const value of [undefined, rawColor, "url(evil)", "BLUE", "__proto__", {}, null, 1]) {
    const app = realm({ stored: JSON.stringify({ accent: value }) });
    assert.equal(app.snapshot().accent, "blue");
    app.context.I18n.apply({ accent: value });
    assert.equal(app.document.documentElement.dataset.accent, "blue");
    assert.equal(app.document.documentElement.style, undefined);
  }
  for (const stored of ["broken", "null", "[]", "true", "{}"])
    assert.equal(realm({ stored }).snapshot().accent, "blue");
});

test("真实设置控件执行换色持久化和三语标签更新，不重置主题语言", () => {
  const app = realm();
  const [language, accent, theme] = controls(app);
  assert.equal(accent.tag, "select");
  assert.deepEqual(accent.children.map((node) => node.value), accents);
  for (const locale of locales) for (const value of accents) {
    language.value = locale;
    language.fire("change");
    accent.value = value;
    accent.fire("change");
    const before = app.snapshot().theme;
    theme.fire("click");
    assert.equal(app.snapshot().accent, value);
    assert.equal(app.snapshot().locale, locale);
    assert.notEqual(app.snapshot().theme, before);
    assert.equal(accent.attrs["aria-label"], app.context.I18n.t("accent"));
    assert.equal(language.attrs["aria-label"], app.context.I18n.t("language"));
    assert.equal(accent.children[0].textContent, app.context.I18n.t("accentBlue"));
    assert.deepEqual(JSON.parse(app.writes.at(-1)[1]), app.snapshot());
    assert.deepEqual(realm({ stored: app.writes.at(-1)[1] }).snapshot(), app.snapshot());
  }
  assert.equal(app.warnings.length, 0);
});

test("存储读写全部不可用仍可切换三语明暗强调色", () => {
  const app = realm({ blocked: true });
  const [language, accent, theme] = controls(app);
  language.value = "ar-SA";
  language.fire("change");
  accent.value = "green";
  accent.fire("change");
  theme.fire("click");
  assert.deepEqual(app.snapshot(), { accent: "green", locale: "ar-SA", theme: "light", dir: "rtl" });
  assert.equal(app.writes.length, 0);
  assert(app.warnings.length >= 4);
});

test("单字段语言/主题更新不重置强调色，完整上下文仅保留白名单字段", () => {
  const app = realm({ stored: JSON.stringify({ accent: "purple" }) });
  app.context.I18n.apply({ locale: "ar-SA", token: "不得传播", permissions: ["admin"] });
  app.context.I18n.apply({ theme: "light" });
  assert.deepEqual(app.snapshot(), { accent: "purple", locale: "ar-SA", theme: "light", dir: "rtl" });
  assert.deepEqual(JSON.parse(JSON.stringify(app.context.I18n.normalizeContext({ accent: "red", locale: "en-US", theme: "dark", token: "秘密", dir: "rtl" }))), { accent: "red", locale: "en-US", theme: "dark", dir: "ltr" });
});

test("母版真实shell广播、迟加载iframe、重载及安全消息筛选", async () => {
  const host = realm({ page: "index.html" });
  const frame = await shell(host);
  host.context.I18n.apply({ accent: "purple", locale: "ar-SA", theme: "light" });
  const child = realm({ stored: JSON.stringify({ accent: "red" }) });
  const { bridge, wire } = await attach(host, frame, child);
  assert(bridge.embedded);
  assert.deepEqual(child.snapshot(), host.snapshot());
  assert.equal(child.nodes.filter((node) => node.className === "standalone-controls").length, 0);
  for (const locale of locales) for (const theme of ["light", "dark"]) for (const accent of accents) {
    host.context.I18n.apply({ locale, theme, accent });
    await flush();
    assert.deepEqual(child.snapshot(), host.snapshot());
  }
  const before = child.snapshot();
  const data = { babaShare: true, version: 1, session: new URL(frame.src).searchParams.get("__frame"), type: "context.changed", payload: { locale: "ar-SA", theme: "dark", accent: "red", token: "秘密" } };
  for (const event of [
    { origin: "null", source: wire.hostProxy, data },
    { origin: host.context.location.origin, source: {}, data },
    { origin: host.context.location.origin, source: wire.hostProxy, data: { ...data, version: 2 } },
  ]) child.dispatch("message", event);
  await flush();
  assert.deepEqual(child.snapshot(), before);
  child.dispatch("message", { origin: host.context.location.origin, source: wire.hostProxy, data: { ...data, payload: { ...data.payload, accent: "url(evil)" } } });
  await flush();
  assert.equal(child.snapshot().accent, "blue");
  assert(!Object.hasOwn(child.snapshot(), "token"));
  bridge.destroy();
  const reloaded = realm();
  await attach(host, frame, reloaded, wire);
  assert.deepEqual(reloaded.snapshot(), host.snapshot());
  host.context.I18n.apply({ accent: "green" });
  await flush();
  assert.equal(reloaded.snapshot().accent, "green");
  assert.equal(child.snapshot().accent, "blue");
  host.dispatch("pagehide", {});
  reloaded.context.AppPage.destroy();
});

test("HTTP独立子页通过统一适配器获得换色控件并持久化", async () => {
  const app = realm({ stored: JSON.stringify({ accent: "orange", locale: "en-US", theme: "light" }) });
  app.run("page-bridge.js");
  app.run("common.js");
  const bridge = app.context.UI.page();
  await bridge.ready;
  await flush();
  assert.equal(bridge.embedded, false);
  const holder = app.nodes.find((node) => node.className === "standalone-controls");
  const accent = holder.children.find((node) => node.dataset?.i18nLabel === "accent");
  assert.equal(accent.value, "orange");
  accent.value = "teal";
  accent.fire("change");
  assert.equal(JSON.parse(app.writes.at(-1)[1]).accent, "teal");
});

test("跨域父窗口统一降级且仍保留独立强调色", async () => {
  const app = realm({ stored: JSON.stringify({ accent: "teal" }) });
  app.context.parent = { get location() { const error = new Error("跨域"); error.name = "SecurityError"; throw error; } };
  app.run("page-bridge.js");
  app.run("common.js");
  const bridge = app.context.UI.page();
  await bridge.ready;
  await flush();
  assert.equal(bridge.embedded, false);
  assert.equal(app.snapshot().accent, "teal");
  assert(app.nodes.some((node) => node.className === "standalone-controls"));
});

test("六色令牌白字至少4.5:1、明暗焦点至少3:1、菜单不受强调色污染", () => {
  const css = source("tokens.css"), layout = source("layout.css"), components = source("components.css");
  const luminance = (hex) => {
    const channels = hex.match(/../g).map((part) => parseInt(part, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const values = new Map([["blue", css.match(/:root\{--accent:#([\da-f]{6})/)[1]]]);
  for (const match of css.matchAll(/\[data-accent="(\w+)"\]\{--accent:#([\da-f]{6})\}/g)) values.set(match[1], match[2]);
  assert.deepEqual([...values.keys()], accents);
  for (const [accent, hex] of values) {
    const lum = luminance(hex);
    assert(1.05 / (lum + .05) >= 4.5, accent + "白字对比不足");
    assert((lum + .05) / (luminance("0d0d0d") + .05) >= 3, accent + "深底聚焦对比不足");
  }
  assert(css.includes("--color-primary-subtle:color-mix(in srgb,var(--accent) 10%,transparent)"));
  assert(css.includes("--color-primary-subtle:color-mix(in srgb,var(--accent) 22%,transparent)"));
  assert(css.includes("--color-menu-bg:#fff"));
  assert(css.includes("--color-menu-bg:#0b0b0b"));
  assert(layout.includes('.menu-item[aria-current="page"]{background:var(--color-menu-selected-bg);color:var(--color-menu-selected-text)}'));
  assert(layout.includes('.menu-item[aria-current="page"]:focus-visible{outline-color:var(--color-menu-selected-text)}'));
  assert(layout.includes(".menu-item:hover{background:var(--color-menu-hover-bg)"));
  assert(components.includes(".standalone-controls{display:flex;align-items:center;flex-wrap:wrap"));
});

test("真实登录与分享脚本执行换色，不向原型沙箱发送上下文", async () => {
  for (const page of ["auth", "share"]) {
    const app = realm({ page: page + ".html", stored: JSON.stringify({ accent: "green" }) });
    const names = page === "auth"
      ? ["auth-form", "auth-status", "auth-submit", "auth-settings", "security-icon", "auth-title", "auth-hint", "auth-story-title", "auth-fields", "auth-switch"]
      : ["share-shell", "share-sidebar", "share-controls", "share-layout", "preview-actions", "share-stage", "share-preview-area", "share-loading", "shared-frame", "share-state", "share-status", "share-tree", "share-title", "share-folder-title", "share-expiry", "share-current", "share-navigation", "share-file-type"];
    for (const id of names) {
      const node = new app.Element(id.endsWith("form") ? "form" : "div");
      node.id = id;
    }
    const frame = app.document.querySelector("#shared-frame");
    let messages = 0;
    if (frame) frame.contentWindow = { postMessage() { messages++; } };
    app.run("common.js");
    app.context.API = async (name) => {
      if (name === "install") return { setupRequired: false, registrationEnabled: false };
      if (name === "shareDetail") return { share: { expireTime: null }, previewBaseUrl: "/baba-share/preview/s/test/", listing: { entries: [], pageIndex: 1, totalPage: 1, totalCount: 0, entryPath: "index.html" } };
      throw new Error("不应写入业务数据 " + name);
    };
    if (page === "share") { app.context.location.pathname = "/baba-share/s/test"; allowSharePreviewFetch(app); app.run("preview.js"); }
    await app.run(page + ".js");
    await flush();
    const holder = app.document.querySelector(page === "auth" ? "#auth-settings" : "#share-controls");
    const accent = holder.children.find((node) => node.dataset?.i18nLabel === "accent");
    assert.equal(accent.value, "green");
    accent.value = "purple";
    accent.fire("change");
    assert.equal(app.snapshot().accent, "purple");
    assert.equal(JSON.parse(app.writes.at(-1)[1]).accent, "purple");
    assert.equal(messages, 0);
    if (frame) {
      const rendered = app.nodes.findLast((node) => node.tag === "iframe");
      assert.equal(rendered.src, "http://127.0.0.1/baba-share/preview/s/test/index.html");
      assert.equal(rendered.attrs.sandbox, "allow-scripts");
      rendered.fire("load");
    }
    assert.equal(app.warnings.length, 0);
  }
});

async function sharePreview(mode = "native", page = "s/test", fixture = {}) {
  const app = realm({ page, stored: fixture.stored });
  const shareRequests = [];
  const get = (id) => app.document.querySelector("#" + id);
  for (const id of ["share-shell", "share-sidebar", "share-controls", "share-layout", "preview-actions", "share-stage", "share-preview-area", "share-loading", "shared-frame", "share-state", "share-status", "share-tree", "share-title", "share-folder-title", "share-expiry", "share-current", "share-navigation", "share-file-type"]) {
    const node = new app.Element("div");
    node.id = id;
  }
  const topbar = new app.Element("header"), actions = new app.Element("div");
  const loginMarkup = source("../share.html").match(/<a\s+[^>]*id="share-login"[^>]*>[\s\S]*?<\/a\s*>/)[0];
  const login = new app.Element("a");
  for (const [, key, value] of loginMarkup.matchAll(/([\w-]+)="([^"]*)"/g)) login.setAttribute(key, value);
  login.textContent = loginMarkup.match(/>([^<]*)<\/a/)[1].trim();
  actions.append(get("share-controls"), login);
  topbar.append(actions);
  get("share-shell").append(topbar, get("share-layout"));
  get("share-layout").append(get("share-sidebar"), get("share-stage"));
  get("share-sidebar").append(get("share-tree"));
  get("share-stage").append(get("share-preview-area"));
  get("share-preview-area").append(get("share-loading"), get("shared-frame"));
  const timers = new Map();
  let timer = 0, requests = 0, exits = 0, resolveRequest;
  app.context.setTimeout = (fn) => { timers.set(++timer, fn); return timer; };
  app.context.clearTimeout = (id) => timers.delete(id);
  app.advance = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  app.document.fullscreenElement = null;
  app.document.exitFullscreen = async () => {
    exits++;
    if (mode === "exit-reject") throw new Error("退出被拒绝");
    app.document.fullscreenElement = null;
    app.dispatch("fullscreenchange", {});
  };
  if (mode !== "missing") get("share-shell").requestFullscreen = async () => {
    requests++;
    if (mode === "reject") throw new Error("全屏被拒绝");
    if (mode === "sync-reject") throw new TypeError("同步拒绝");
    if (mode === "pending") await new Promise((resolve) => { resolveRequest = resolve; });
    app.document.fullscreenElement = get("share-shell");
    app.dispatch("fullscreenchange", {});
  };
  Object.defineProperty(get("shared-frame"), "contentDocument", { get() { throw new Error("禁止读取原型DOM"); } });
  get("shared-frame").contentWindow = { postMessage() { throw new Error("禁止向原型注入消息"); } };
  app.run("common.js");
  app.context.API = async (name, options) => {
    assert.equal(name, "shareDetail");
    shareRequests.push(options);
    if (fixture.listing) return { share: { expireTime: null }, previewBaseUrl: "/baba-share/preview/s/test/", listing: await fixture.listing(options.query) };
    return { share: { expireTime: null }, previewBaseUrl: "/baba-share/preview/s/test/", listing: { entries: [{ name: "index.html", path: "index.html", kind: "file" }, { name: "other.html", path: "other.html", kind: "file" }], pageIndex: 1, totalPage: 1, totalCount: 2, entryPath: "index.html" } };
  };
  allowSharePreviewFetch(app);
  if (fixture.fetch) app.context.fetch = fixture.fetch;
  app.context.matchMedia = () => ({ matches: Boolean(fixture.narrow) });
  app.run("preview.js");
  await app.run("share.js");
  await flush();
  app.shareRequests = shareRequests;
  app.get = get;
  app.currentFrame = () => app.nodes.findLast((node) => node.tag === "iframe");
  if (!app.currentFrame()) return app;
  Object.defineProperty(app.currentFrame(), "contentDocument", { get() { throw new Error("禁止读取原型DOM"); } });
  app.currentFrame().contentWindow = { postMessage() { throw new Error("禁止向原型注入消息"); } };
  app.currentFrame().fire("load");
  app.get = get;
  app.fullscreen = get("preview-actions").children[0];
  app.toggle = get("share-navigation").children[0];
  app.edge = app.nodes.find((node) => node.className === "share-tree-edge");
  app.exit = app.nodes.find((node) => node.className === "share-fullscreen-exit");
  app.isImmersive = () => get("share-shell").classList.contains("share-immersive");
  app.isTreeOpen = () => !get("share-layout").classList.contains("tree-collapsed");
  app.counts = () => ({ requests, exits });
  app.resolveRequest = () => resolveRequest();
  return app;
}

test("分享登录入口独立于设置控件，三语双主题切换保留原生新窗口链接及预览", async () => {
  const app = await sharePreview(), login = app.get("share-login");
  const address = app.context.location.href, frame = app.currentFrame();
  assert.equal(login.tag, "a");
  assert.equal(login.getAttribute("href"), "/baba-share/auth.html");
  assert.equal(login.getAttribute("target"), "_blank");
  assert.equal(login.getAttribute("rel"), "noopener noreferrer");
  assert.equal(app.get("share-controls").contains(login), false);
  assert.equal(login.parentNode.contains(app.get("share-controls")), true);
  assert(login.getAttribute("class").split(" ").includes("button-link"));
  const controls = app.get("share-controls").children;
  const language = controls.find((node) => node.dataset.i18nLabel === "language");
  const theme = controls.find((node) => node.dataset.i18nLabel === "theme");
  const labels = { "zh-CN": "登录", "en-US": "Sign in", "ar-SA": "تسجيل الدخول" };
  for (const locale of locales) for (const mode of ["light", "dark"]) {
    language.value = locale;
    language.fire("change");
    if (app.snapshot().theme !== mode) theme.fire("click");
    assert.equal(login.textContent, labels[locale]);
    assert.equal(app.snapshot().theme, mode);
    assert.equal(app.document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
    assert.equal(app.context.location.href, address);
    assert.equal(app.currentFrame(), frame);
    assert.equal(app.shareRequests.length, 1, "设置和入口不应新增鉴权或分享请求");
  }
  const layout = source("layout.css"), components = source("components.css");
  assert.match(layout, /\.share-topbar\{[^}]*flex-wrap:wrap/);
  assert.match(components, /\.toolbar,\.row,\.actions\{[^}]*flex-wrap:wrap/);
  assert.match(components, /button,\.button-link\{[^}]*background:var\(--color-bg-surface\)/);
  assert.match(components, /button,input,select,\.button-link\{min-block-size:40px\}/);
  assert.match(components, /\.button-link\.primary:focus-visible\{outline-color:var\(--color-on-primary\)\}/);
  assert.match(layout, /\.share-immersive>\.share-topbar[^}]*\{display:none\}/);
  assert.match(source("preview.css"), /\.share-file-view :is\(\.share-topbar,[^}]*display: none/);
});

test("访客标题显示当前文件与类型，主要操作直达选中文件且三语切换不重载", async () => {
  const app = await sharePreview();
  const [fullscreen, open, download] = app.get("preview-actions").children;
  assert.equal(fullscreen.tag, "button");
  assert.equal(app.toggle.parentNode, app.get("share-navigation"));
  for (const name of ["index.html", "other.html"]) {
    if (name === "other.html") app.get("share-tree").children[1].children[0].fire("click");
    assert.equal(app.get("share-title").textContent, name);
    assert.equal(app.document.title, name + " · babaShare");
    assert.equal(app.get("share-file-type").textContent, "HTML");
    assert.equal(app.get("share-file-type").hidden, false);
    assert.equal(open.hidden, false); assert.equal(download.hidden, false);
    assert.equal(new URL(open.href).searchParams.get("file"), name);
    assert.equal(new URL(open.href).searchParams.get("view"), "file");
    assert.equal(open.attrs.target, "_blank"); assert.equal(open.attrs.rel, "noopener noreferrer");
    assert.equal(new URL(download.href).pathname, "/baba-share/preview/s/test/" + name);
    assert.equal(new URL(download.href).searchParams.get("download"), "1");
    assert.equal(download.download, name);
    for (const locale of locales) {
      app.context.I18n.apply({ locale });
      assert.equal(app.get("share-title").textContent, name);
      assert.equal(open.textContent, app.context.I18n.t("shareOpenWindow"));
      assert.equal(fullscreen.attrs["aria-label"], app.context.I18n.t("fullscreen"));
    }
  }
  assert.equal(app.shareRequests.length, 1);
  const empty = await sharePreview("native", "s/test", { listing: async () => ({ entries: [], pageIndex: 1, totalPage: 1, totalCount: 0 }) });
  assert(empty.get("preview-actions").children.slice(1).every((node) => node.hidden));
});
test("窄屏优先展示预览，目录可展开且选中文件后收起并把焦点还给入口", async () => {
  const app = await sharePreview("native", "s/test", { narrow: true });
  assert.equal(app.isTreeOpen(), false);
  assert.equal(app.toggle.attrs["aria-expanded"], "false");
  app.toggle.fire("click");
  assert.equal(app.isTreeOpen(), true);
  const item = app.get("share-tree").children[1].children[0];
  item.focus(); item.fire("click");
  assert.equal(app.get("share-title").textContent, "other.html");
  assert.equal(app.isTreeOpen(), false);
  assert.equal(app.document.activeElement, app.toggle);
  assert.equal(app.get("share-sidebar").inert, true);
  const css = source("preview.css");
  assert.match(css, /grid-template-rows: minmax\(0, min\(28dvh, 200px\)\) minmax\(0, 1fr\)/);
  assert.match(css, /\.share-file-heading \.share-title[^}]*overflow-wrap: anywhere/);
});
test("分享所有文件的原生菜单保留下载授权与独立文件窗口，三语双主题可用", async () => {
  for (const locale of locales) for (const theme of ["light", "dark"]) {
    const app = await sharePreview("native", "s/test", { stored: JSON.stringify({ locale, theme }) });
    for (const row of app.get("share-tree").children) {
      const [file, menu] = row.children;
      assert.equal(file.tag, "button");
      assert.equal(menu.tag, "details");
      const [summary, panel] = menu.children;
      assert(summary.attrs["aria-label"].includes(file.dataset.path));
      const [download, open] = panel.children;
      assert.equal(download.tag, "a");
      assert.equal(new URL(download.attrs.href).pathname, "/baba-share/preview/s/test/" + file.dataset.path);
      assert.equal(new URL(download.attrs.href).searchParams.get("download"), "1");
      assert.equal(download.attrs.download, file.dataset.path);
      assert.equal(open.attrs.target, "_blank");
      assert.equal(open.attrs.rel, "noopener noreferrer");
      assert.equal(open.attrs.referrerpolicy, "no-referrer");
      assert.equal(new URL(open.attrs.href).searchParams.get("file"), file.dataset.path);
      assert.equal(new URL(open.attrs.href).searchParams.get("view"), "file");
      assert.equal(open.textContent, app.context.I18n.t("shareOpenWindow"));
    }
    assert.equal(app.document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
    assert.equal(app.document.documentElement.dataset.mode, theme);
  }
});

test("纯预览新窗口只打开指定文件且不请求浏览器原生全屏", async () => {
  const app = await sharePreview("native", "s/test?file=other.html&view=file");
  assert.equal(app.get("share-current").textContent, "other.html");
  assert(app.get("share-shell").classList.contains("share-file-view"));
  assert.equal(app.document.documentElement.dataset.shareView, "file");
  assert.equal(app.get("share-sidebar").hidden, true);
  assert.equal(app.currentFrame().attrs.sandbox, "allow-scripts");
  assert.equal(app.currentFrame().attrs.referrerpolicy, "no-referrer");
  assert.deepEqual(app.counts(), { requests: 0, exits: 0 });
  const missing = await sharePreview("native", "s/test?view=file");
  assert.equal(missing.currentFrame(), undefined);
  assert.equal(missing.get("share-state").hidden, false);
});

test("默认文件遍历根目录分页及深层目录，缓存内每个文件仍有菜单", async () => {
  const listing = ({ path, pageIndex }) => {
    const entries = path === "" ? [{ name: pageIndex === 1 ? "empty" : "deep", path: pageIndex === 1 ? "empty" : "deep", kind: "folder" }]
      : path === "deep" ? [{ name: "nested", path: "deep/nested", kind: "folder" }]
      : path === "deep/nested" ? [{ name: "a.txt", path: "deep/nested/a.txt", kind: "file" }] : [];
    return { entries, pageIndex, totalPage: path === "" ? 2 : 1, totalCount: entries.length, entryPath: null };
  };
  const app = await sharePreview("native", "s/test", { listing, fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode("deep file").buffer }) });
  assert.equal(app.get("share-current").textContent, "deep/nested/a.txt");
  assert.deepEqual(app.shareRequests.map((request) => [request.query.path, request.query.pageIndex]), [["", 1], ["", 2], ["empty", 1], ["deep", 1], ["deep/nested", 1]]);
  const row = app.nodes.find((node) => node.className === "share-file-row" && node.children[0].dataset.path === "deep/nested/a.txt");
  assert(row && app.get("share-tree").contains(row));
  const trigger = row.children[1].children[0];
  assert.equal(trigger.children[0].children[0].attrs.d, "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5");
  assert.equal(trigger.attrs["aria-label"], app.context.I18n.t("previewDownload") + " / " + app.context.I18n.t("shareOpenWindow") + ": a.txt");
  assert.equal(row.children[1].children[1].children.length, 2);
  assert.equal(new URL(row.children[1].children[1].children[1].attrs.href).searchParams.get("file"), "deep/nested/a.txt");
});

test("根目录第二页的首个文件自动选中，普通展开的深层文件也有独立菜单", async () => {
  const listing = ({ path, pageIndex }) => ({
    entries: path === "folder" ? [{ name: "nested.html", path: "folder/nested.html", kind: "file" }]
      : pageIndex === 1 ? [{ name: "folder", path: "folder", kind: "folder" }]
      : [{ name: "other.html", path: "other.html", kind: "file" }],
    pageIndex, totalPage: path === "" ? 2 : 1, totalCount: 2, entryPath: null,
  });
  const app = await sharePreview("native", "s/test", { listing });
  assert.equal(app.get("share-current").textContent, "other.html");
  assert.equal(app.shareRequests.length, 2);
  const folder = app.get("share-tree").children[0].children[0];
  folder.open = true;
  await folder.fire("toggle");
  const fileRow = folder.children[1].children[0];
  assert.equal(fileRow.children[0].dataset.path, "folder/nested.html");
  const [download, open] = fileRow.children[1].children[1].children;
  assert.equal(new URL(download.attrs.href).pathname, "/baba-share/preview/s/test/folder/nested.html");
  assert.equal(new URL(open.attrs.href).searchParams.get("file"), "folder/nested.html");
  assert.equal(new URL(open.attrs.href).searchParams.get("view"), "file");
  assert.equal(app.get("share-current").textContent, "other.html");
});

test("默认优先入口不依赖当前分页，显式文件编码一次且空分享不假造文件", async () => {
  const home = await sharePreview("native", "s/test", { listing: () => ({ entries: [], pageIndex: 1, totalPage: 3, totalCount: 120, entryPath: "HOME.HTML" }), fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode("<p>home</p>").buffer }) });
  assert.equal(home.get("share-current").textContent, "HOME.HTML");
  assert.equal(home.shareRequests.length, 1);
  const path = "目录/100% #+& %2e%2e.html";
  const encoded = await sharePreview("native", "s/test?view=file&file=" + encodeURIComponent(path), { fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode("<p>encoded</p>").buffer }) });
  assert.equal(new URL(encoded.currentFrame().src).pathname, "/baba-share/preview/s/test/" + path.split("/").map(encodeURIComponent).join("/"));
  assert.equal(encoded.get("share-current").textContent, path);
  const empty = await sharePreview("native", "s/test", { listing: () => ({ entries: [], pageIndex: 1, totalPage: 0, totalCount: 0, entryPath: null }) });
  assert.equal(empty.currentFrame(), undefined);
  assert.equal(empty.get("share-state").hidden, false);
});

test("分享仅从正式路径读取token，保留file定位并忽略查询token", async () => {
  const app = await sharePreview("native", "s/path-token?token=ignored&file=other.html");
  assert.equal(app.shareRequests.length, 1);
  assert.equal(app.shareRequests[0].query.token, "path-token");
  assert.equal(app.get("share-current").textContent, "other.html");
  assert.equal(new URL(app.currentFrame().src).pathname, "/baba-share/preview/s/test/other.html");
  app.get("share-tree").children[0].children[0].fire("click");
  assert.equal(app.context.location.pathname, "/baba-share/s/path-token");
  assert.equal(app.context.location.searchParams.get("file"), "index.html");
  for (const page of ["share.html?token=legacy&file=other.html", "s/?token=legacy", "s/test/extra?token=legacy"]) {
    const invalid = await sharePreview("native", page);
    assert.equal(invalid.shareRequests.length, 0, page);
    assert.equal(invalid.currentFrame(), undefined);
    assert.equal(invalid.get("share-state").hidden, false);
    assert(invalid.get("share-state").children.some((node) => node.tag === "button"));
  }
  assert.doesNotMatch(source("share.js"), /searchParams\.get\(["']token["']\)/);
});

test("分享全屏请求外层容器、默认收起目录、退出恢复目录与焦点", async () => {
  for (const initiallyCollapsed of [false, true]) {
    const app = await sharePreview();
    if (initiallyCollapsed) app.toggle.fire("click");
    await app.fullscreen.fire("click");
    assert(app.isImmersive());
    assert.equal(app.document.fullscreenElement, app.get("share-shell"));
    assert(!app.isTreeOpen());
    assert.equal(app.get("share-sidebar").inert, true);
    assert.equal(app.get("share-sidebar").attrs["aria-hidden"], "true");
    assert.equal(app.edge.attrs["aria-expanded"], "false");
    assert.equal(app.edge.hidden, false);
    assert.equal(app.exit, undefined);
    await app.document.exitFullscreen();
    assert(!app.isImmersive());
    assert.equal(app.isTreeOpen(), !initiallyCollapsed);
    assert.equal(app.document.activeElement, app.fullscreen);
    assert.equal(app.edge.hidden, true);
    assert.deepEqual(app.counts(), { requests: 1, exits: 1 });
  }
});

test("分享Esc与原生fullscreenchange退出同步，嵌套原型全屏不会提前退出", async () => {
  const app = await sharePreview();
  await app.fullscreen.fire("click");
  app.document.fullscreenElement = app.get("shared-frame");
  app.dispatch("fullscreenchange", {});
  assert(app.isImmersive());
  let prevented = false;
  app.dispatch("keydown", { key: "Escape", preventDefault() { prevented = true; } });
  await flush();
  assert(!prevented, "不得拦截浏览器原生Esc");
  assert(app.isImmersive());
  await app.document.exitFullscreen();
  assert(!app.isImmersive());
  await app.fullscreen.fire("click");
  app.document.fullscreenElement = null;
  app.dispatch("fullscreenchange", {});
  assert(!app.isImmersive());
  assert.equal(app.document.activeElement, app.fullscreen);
});

test("原生全屏缺失、Promise拒绝或同步抛错均留在普通预览并可见提示", async () => {
  for (const mode of ["missing", "reject", "sync-reject"]) {
    const app = await sharePreview(mode);
    if (mode === "sync-reject") app.get("share-shell").requestFullscreen = () => { throw new TypeError("同步拒绝"); };
    await app.fullscreen.fire("click");
    assert(!app.isImmersive(), mode);
    assert.equal(app.exit, undefined);
    assert.equal(app.edge.hidden, true);
    assert(app.isTreeOpen());
    assert.equal(app.currentFrame().src, "http://127.0.0.1/baba-share/preview/s/test/index.html");
    assert.equal(app.currentFrame().attrs.sandbox, "allow-scripts");
    assert.equal(app.document.querySelector("#global-toast").textContent, app.context.I18n.t("fullscreenUnavailable"));
    assert.equal(app.fullscreen.disabled || false, false);
    assert.equal(app.counts().exits, 0);
  }
});

test("全屏请求未完成不提前隐藏界面且防止重复请求", async () => {
  const app = await sharePreview("pending");
  const entering = app.fullscreen.fire("click");
  await app.fullscreen.fire("click");
  assert(!app.isImmersive());
  assert.equal(app.fullscreen.disabled, true);
  assert.equal(app.counts().requests, 1);
  app.resolveRequest();
  await entering;
  assert(app.isImmersive());
  assert.equal(app.fullscreen.disabled, false);
  await app.document.exitFullscreen();
  assert(!app.isImmersive());
});

test("目录悬停靠边展开、延迟收起、重入取消计时且键盘焦点阻止自动收起", async () => {
  const app = await sharePreview();
  await app.fullscreen.fire("click");
  app.edge.fire("pointerenter", { pointerType: "mouse" });
  assert(app.isTreeOpen());
  app.edge.fire("click", { pointerType: "mouse" });
  assert(app.isTreeOpen(), "鼠标移入后首次点击不能反向收起目录");
  app.edge.fire("pointerleave", { pointerType: "mouse", relatedTarget: app.get("share-sidebar") });
  app.advance();
  assert(app.isTreeOpen());
  app.get("share-sidebar").fire("pointerleave", { pointerType: "mouse", relatedTarget: null });
  assert(app.isTreeOpen());
  app.edge.fire("pointerenter", { pointerType: "mouse" });
  app.advance();
  assert(app.isTreeOpen());
  const item = app.get("share-tree").children[0].children[0];
  item.focus();
  app.get("share-sidebar").fire("focusin");
  app.get("share-sidebar").fire("pointerleave", { pointerType: "mouse", relatedTarget: null });
  app.advance();
  assert(app.isTreeOpen());
  app.get("shared-frame").focus();
  app.get("share-sidebar").fire("focusout");
  app.advance();
  assert(!app.isTreeOpen());
  assert.equal(app.document.activeElement, app.get("shared-frame"));
});

test("触屏点击与键盘目录开关保持全屏、隐藏焦点回入口，切文件不退出", async () => {
  const app = await sharePreview();
  await app.fullscreen.fire("click");
  app.edge.fire("pointerenter", { pointerType: "touch" });
  assert(!app.isTreeOpen());
  app.edge.focus();
  app.edge.fire("click");
  assert(app.isTreeOpen());
  assert.equal(app.edge.attrs["aria-expanded"], "true");
  const item = app.get("share-tree").children[1].children[0];
  item.focus();
  item.fire("click");
  await flush();
  assert(app.isImmersive());
  const previous = app.nodes.filter((node) => node.tag === "iframe").at(-2);
  assert.equal(previous.src, "about:blank", "切换必须停止旧原型");
  assert.equal(app.currentFrame().src, "http://127.0.0.1/baba-share/preview/s/test/other.html");
  assert.equal(app.currentFrame().attrs.sandbox, "allow-scripts");
  assert.deepEqual(app.counts(), { requests: 1, exits: 0 });
  app.edge.fire("click");
  assert(!app.isTreeOpen());
  assert.equal(app.document.activeElement, app.edge);
  app.advance();
  assert(!app.isTreeOpen());
});

test("无常驻退出按钮且浏览器退出恢复普通预览", async () => {
  const app = await sharePreview();
  await app.fullscreen.fire("click");
  assert.equal(app.exit, undefined);
  assert.equal(app.edge.children.length, 0);
  app.document.fullscreenElement = null;
  app.dispatch("fullscreenchange", {});
  assert(!app.isImmersive());
});

test("沉浸目录三语、双主题、六强调色切换不退出，RTL位置与减少动画采用原生CSS", async () => {
  const app = await sharePreview();
  await app.fullscreen.fire("click");
  for (const locale of locales) for (const theme of ["light", "dark"]) for (const accent of accents) {
    app.context.I18n.apply({ locale, theme, accent });
    assert(app.isImmersive());
    assert.equal(app.edge.attrs["aria-label"], app.context.I18n.t("toggleTree"));
    assert.equal(app.exit, undefined);
    assert.equal(app.document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
    assert.equal(app.document.documentElement.dataset.accent, accent);
    assert.equal(app.document.documentElement.dataset.mode, theme);
  }
  const css = source("layout.css");
  assert(css.includes('.share-immersive>.share-topbar,.share-immersive .preview-bar,.share-immersive .status-line:empty{display:none}'));
  assert(css.includes('.share-immersive .preview-frame{flex:1;inline-size:100%;block-size:100%;min-block-size:0;border:0}'));
  assert(css.includes('inset-inline-start:0'));
  assert(css.includes('inset-block:0;inline-size:24px;block-size:100%'));
  assert(css.includes('inline-size:2px;block-size:48px;background:var(--color-border-strong)'));
  assert(!css.includes('share-tree-breathe'));
  assert(!css.includes('share-fullscreen-exit'));
  assert(!/\.share-(?:tree-edge|fullscreen-exit)[^{]*\{[^}]*(?:left:|right:|#[\da-f]{3})/i.test(css));
  assert(!source("share.js").includes("contentDocument"));
  assert(!source("share.js").includes("postMessage"));
});

function copyRuntime() {
  const app = realm();
  const timers = new Map();
  let timer = 0;
  app.context.setTimeout = (fn) => { timers.set(++timer, fn); return timer; };
  app.context.clearTimeout = (id) => timers.delete(id);
  app.advance = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  app.context.navigator = { clipboard: { writeText: async () => {} } };
  app.run("common.js");
  return app;
}

test("复制通知移到最上层dialog内，关闭后可回普通页或全屏容器", async () => {
  const app = copyRuntime(), { UI } = app.context;
  const first = UI.dialog("第一层", () => {}), second = UI.dialog("第二层", () => {});
  await UI.copy("https://example.invalid/share");
  let notice = app.document.querySelector("#global-toast");
  assert.equal(notice.parentNode, second.node);
  assert.equal(notice.attrs.role, "status");
  assert.equal(notice.attrs["aria-live"], "polite");
  second.close();
  UI.toast("第一层可见");
  notice = app.document.querySelector("#global-toast");
  assert.equal(notice.parentNode, first.node);
  first.close();
  const full = new app.Element("section");
  app.document.body.append(full);
  app.document.fullscreenElement = full;
  UI.toast("全屏可见");
  assert.equal(app.document.querySelector("#global-toast").parentNode, full);
});

test("复制按钮三语loading、成功与延迟恢复，等待中禁止重复请求且不泄漏内容", async () => {
  for (const locale of locales) {
    const app = copyRuntime(), { UI, I18n } = app.context;
    I18n.apply({ locale });
    let resolve, writes = 0;
    app.context.navigator.clipboard.writeText = () => { writes++; return new Promise((done) => { resolve = done; }); };
    const control = UI.copyButton("copyLink", () => UI.copy("private-invitation-token"), "primary", "link");
    app.document.body.append(control);
    const pending = control.fire("click");
    assert.equal(control.dataset.copyState, "loading");
    assert.equal(control.attrs["aria-busy"], "true");
    assert.equal(control.attrs["aria-label"], I18n.t("copying"));
    await control.fire("click");
    assert.equal(writes, 1);
    resolve(); await pending;
    assert.equal(control.dataset.copyState, "success");
    assert.equal(control.disabled, false);
    assert.equal(control.attrs["aria-busy"], "false");
    assert.equal(control.children[1].textContent, I18n.t("copySuccess"));
    assert.equal(app.document.querySelector("#global-toast").textContent, I18n.t("copied"));
    I18n.apply({ locale: { "zh-CN": "en-US", "en-US": "ar-SA", "ar-SA": "en-US" }[locale] });
    assert.equal(control.attrs["aria-label"], I18n.t("copySuccess"));
    app.advance();
    assert.equal(control.dataset.copyState, undefined);
    assert.equal(control.attrs["aria-label"], I18n.t("copyLink"));
    assert.equal(app.warnings.length, 0);
    assert(!JSON.stringify(control.attrs).includes("private-invitation-token"));
  }
});

test("剪贴板缺失或拒绝时只显示手动复制，不宣称成功，清空敏感内容后可重试", async () => {
  for (const missing of [false, true]) {
    const app = copyRuntime(), { UI, I18n } = app.context;
    if (missing) delete app.context.navigator.clipboard;
    else app.context.navigator.clipboard.writeText = async () => { throw new Error("不得显示的秘密"); };
    const control = UI.copyButton("copyLink", () => UI.copy("private-token"));
    app.document.body.append(control);
    const copying = control.fire("click");
    await flush();
    const fallback = app.nodes.find((node) => node.tag === "dialog" && node.open);
    assert(fallback);
    const input = fallback.children.find((node) => node.tag === "input");
    assert.equal(input.value, "private-token");
    assert.equal(input.selected, true);
    const notice = app.document.querySelector("#global-toast");
    assert.equal(notice.parentNode, fallback);
    assert.equal(notice.textContent, I18n.t("copyFailed"));
    fallback.close(); await copying;
    assert.equal(input.value, "");
    assert.equal(control.dataset.copyState, "failure");
    app.context.navigator.clipboard = { writeText: async () => {} };
    await control.fire("click");
    assert.equal(control.dataset.copyState, "success");
    assert.equal(app.warnings.length, 0);
  }
});

test("MCP三语复制说明先读取目录树并确认目标，不承诺客户端统一树UI", () => {
  const app = copyRuntime(); app.run("mcp-help.js");
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) {
    app.context.I18n.apply({ locale, theme: "dark" });
    const text = app.context.McpHelp.instructions("bsk_private_test");
    for (const item of ["initialize", "directory_tree {}", "complete=false", "relativePath", "treeToken", "targetId", "memberRole", "viewer/editor/manager", "NULL", "Base64", "opaque", "localStorage", "connect-src", "currentLocale", "DOMContentLoaded", "runtime.lastError"]) assert(text.includes(item), locale + " " + item);
    assert(text.includes(app.context.I18n.t("mcpDirectorySelection")));
    assert.notEqual(app.context.I18n.t("mcpDirectorySelection"), "mcpDirectorySelection");
    assert.doesNotMatch(text, /19 tools|19 个工具|19 أداة/);
  }
  assert.equal(app.context.I18n.ctx.dir, "rtl");
  app.context.I18n.apply({ locale: "zh-CN" });
  const text = app.context.McpHelp.instructions("bsk_private_test");
  assert.match(text, /编号和完整路径.*无需手输路径/);
  assert.match(text, /不保证所有客户端均有可点选树 UI/);
  assert.match(text, /过期.*刷新目录树并重新确认/);
});

test("恢复MCP密钥复制同样返回真实结果并保留动态origin与手动敏感清理", async () => {
  const app = copyRuntime(), { UI } = app.context;
  app.run("mcp-help.js");
  let requests = 0;
  app.context.API = async () => { requests++; return { key: "bsk_private_test" }; };
  let text;
  app.context.navigator.clipboard.writeText = async (value) => { text = value; };
  assert.equal(await app.context.McpHelp.copyUse("id"), true);
  assert(text.includes(app.context.location.origin + "/api/baba-share/core/v1/mcp"));
  assert(text.includes("bsk_private_test"));
  const shown = app.context.McpHelp.showCreated("id", () => assert.fail("不应失败"));
  const dialog = app.nodes.find((node) => node.tag === "dialog" && node.open);
  const control = app.nodes.find((node) => node.classList.contains("copy-feedback"));
  await control.fire("click");
  assert.equal(control.dataset.copyState, "success");
  assert.equal(app.document.querySelector("#global-toast").parentNode, dialog);
  assert.equal(requests, 2);
  dialog.close(); await shown;
  app.context.navigator.clipboard.writeText = async () => { throw new Error("blocked"); };
  const fallbackResult = app.context.McpHelp.copyUse("id");
  await flush();
  const fallback = app.nodes.find((node) => node.tag === "dialog" && node.open);
  const area = fallback.children.find((node) => node.tag === "textarea");
  assert(area.value.includes("bsk_private_test"));
  fallback.close();
  assert.equal(await fallbackResult, false);
  assert.equal(area.value, "");
  assert.equal(app.warnings.length, 0);
  assert(UI.copyButton);
});

test("分享和邀请所有复制入口使用公共状态按钮且反馈预留宽度", () => {
  const workspace = source("workspace.js"), account = source("account.js"), css = source("components.css");
  assert(workspace.includes('UI.copyButton("copyLink", () => UI.copy(inviteUrl)'));
  assert(workspace.includes('UI.copyButton(\n              "copyLink",\n              () => UI.copy(result.shareUrl)'));
  assert(account.includes('UI.copyButton("copyLink", () => UI.copy(share.shareUrl)'));
  assert(account.includes('UI.copyButton("mcpCopyUse"'));
  assert(css.includes('grid-area:1/1'));
  assert(css.includes('dialog>.toast{position:fixed'));
});

test("品牌使用固定原生首页链接，成员邀请按钮同高留距且邀请删除仅在本卡底部铺满", () => {
  for (const name of ["index", "auth", "share"]) {
    const html = fs.readFileSync(path.join(assets, "../" + name + ".html"), "utf8");
    assert.match(html, /<a\b[^>]*class="[^"]*brand-home[^"]*"[^>]*href="\/baba-share\/"[^>]*>/);
  }
  const html = fs.readFileSync(path.join(assets, "../workspace.html"), "utf8"), css = source("components.css");
  assert(html.includes('id="member-actions" class="actions member-actions"'));
  assert(css.includes('.actions.member-actions{align-items:center;justify-content:flex-start;gap:var(--space-2);flex-wrap:wrap;margin-block-start:var(--space-4)}'));
  assert(css.includes('.member-actions>button{min-block-size:32px;block-size:32px}'));
  assert(css.includes('.invitation-card>footer>button{inline-size:100%}'));
  assert(css.includes('.card.invitation-card>footer{padding-block-start:var(--space-4)}'));
  const app = realm();
  for (const [locale, expected] of [["zh-CN", "我的邀请"], ["en-US", "My invitations"], ["ar-SA", "دعواتي"]]) {
    app.context.I18n.apply({ locale });
    assert.equal(app.context.I18n.t("inviteManage"), expected);
  }
});

test("独立子页品牌导航保留未保存确认且只回固定母版首页", async () => {
  const app = realm();
  app.run("bridge-core.js"); app.run("page-bridge.js"); app.run("common.js");
  const bridge = app.context.UI.page();
  await bridge.ready; await flush();
  const controls = app.nodes.find((node) => node.className === "standalone-controls"), home = controls.children[0];
  const original = app.context.location.href;
  bridge.setDirty(true);
  const denied = home.fire("click", { button: 0, preventDefault() {} });
  await flush();
  app.nodes.find((node) => node.tag === "dialog" && node.open).close();
  assert.equal(await denied, false);
  assert.equal(app.context.location.href, original);
  bridge.setDirty(false);
  assert.equal(await home.fire("click", { button: 0, preventDefault() {} }), true);
  assert.equal(new URL(app.context.location.href).pathname, "/baba-share/index.html");
});

test("母版新建工作区经真实离页协议转入子页，不创建母版表单且取消保留原页", async () => {
  const app = realm({ page: "index.html" });
  const frame = await shell(app), child = realm();
  const { bridge } = await attach(app, frame, child);
  const original = frame.src, create = app.document.querySelector("#new-workspace");
  bridge.setDirty(true);
  const refused = create.fire("click"); await flush();
  child.nodes.find((node) => node.tag === "dialog" && node.open).close();
  assert.equal(await refused, false);
  assert.equal(frame.src, original);
  assert.equal(app.nodes.some((node) => node.tag === "dialog"), false);
  bridge.setDirty(false);
  assert.equal(await create.fire("click"), true);
  const target = new URL(app.document.querySelector("#page-frame").src);
  assert.equal(target.pathname, "/baba-share/workspace.html");
  assert.equal(target.searchParams.get("action"), "create");
  assert.equal(app.nodes.some((node) => node.tag === "dialog"), false);
  const viewer = realm({ page: "index.html" }), viewerFrame = await shell(viewer, "");
  const previous = viewerFrame.src;
  await viewer.document.querySelector("#new-workspace").fire("click");
  assert.equal(viewer.document.querySelector("#new-workspace").hidden, true);
  assert.equal(viewerFrame.src, previous);
});

test("侧栏新建经过完整工作区脚本和真实握手后打开子页表单且仅消费一次", async () => {
  const host = realm({ page: "index.html" });
  await shell(host, "editor");
  await host.document.querySelector("#new-workspace").fire("click");
  const frame = host.document.querySelector("#page-frame");
  assert.equal(new URL(frame.src).searchParams.get("action"), "create");
  const child = realm({ page: "workspace.html" + new URL(frame.src).search });
  const workspaceHtml = fs.readFileSync(path.join(assets, "../workspace.html"), "utf8");
  for (const match of workspaceHtml.matchAll(/\bid="([^"]+)"/g)) {
    const node = new child.Element("div"); node.id = match[1]; child.document.body.append(node);
  }
  const requests = [];
  child.context.API = async (name, options = {}) => {
    requests.push({ name, method: options.method || "GET" });
    assert.equal(options.method || "GET", "GET", "初始化及取消不能写真实数据");
    if (name === "me") return { id: "user", role: "editor" };
    if (name === "workspaces") return [];
    throw new Error("意外的 API " + name);
  };
  child.document.readyState = "loading";
  const { bridge, wire, started } = await attach(host, frame, child, {}, () => {
    child.run("pagination.js");
    const pending = child.run("workspace.js");
    assert.equal(requests.length, 0, "真实握手前不应加载业务或消费导航参数");
    assert.equal(child.context.location.searchParams.get("action"), "create");
    queueMicrotask(() => {
      child.document.readyState = "complete";
      child.dispatch("load", {});
    });
    return pending;
  });
  assert.equal(bridge.embedded, true);
  assert.equal(child.context.location.searchParams.has("action"), false);
  await flush();
  const drawer = child.nodes.find((node) => node.tag === "dialog" && node.open);
  assert(drawer, "完成真实桥接初始化后必须打开新建抽屉");
  assert.equal(drawer.className.includes("form-drawer"), true);
  assert.equal(host.nodes.some((node) => node.tag === "dialog"), false);
  drawer.close(); await started;
  assert.equal(requests.length, 2);
  bridge.destroy();
  const reloaded = realm({ page: "workspace.html" + child.context.location.search });
  for (const match of workspaceHtml.matchAll(/\bid="([^"]+)"/g)) {
    const node = new reloaded.Element("div"); node.id = match[1]; reloaded.document.body.append(node);
  }
  reloaded.context.API = child.context.API;
  const again = await attach(host, frame, reloaded, wire, () => {
    reloaded.run("pagination.js");
    return reloaded.run("workspace.js");
  });
  await again.started;
  assert.equal(again.bridge.embedded, true);
  assert.equal(reloaded.nodes.some((node) => node.tag === "dialog" && node.open), false);
  assert.equal(requests.length, 4);
  again.bridge.destroy(); host.dispatch("pagehide", {});
});

test("母版品牌普通点击走真实beforeLeave导航，取消保留当前页且修饰键维持原生链接", async () => {
  const app = realm({ page: "index.html" });
  const frame = await shell(app), child = realm();
  const { bridge } = await attach(app, frame, child);
  const original = frame.src, logo = app.document.querySelector("#brand-home");
  bridge.setDirty(true);
  let prevented = false;
  const refused = logo.fire("click", { button: 0, preventDefault() { prevented = true; } });
  await flush();
  const confirmation = child.nodes.find((node) => node.tag === "dialog" && node.open);
  assert(confirmation);
  confirmation.close(); await refused;
  assert(prevented);
  assert.equal(frame.src, original);
  bridge.setDirty(false);
  assert.equal(await logo.fire("click", { button: 0, preventDefault() {} }), true);
  const target = new URL(app.document.querySelector("#page-frame").src);
  assert.equal(target.pathname, "/baba-share/workspace.html");
  target.searchParams.delete("__frame");
  assert.equal(target.search, "");
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    let blocked = false;
    logo.fire("click", { ...init, preventDefault() { blocked = true; } });
    assert.equal(blocked, false);
  }
});

test("所有产品页首屏显式加载boot和tokens，登录分享复用控件且原型保持沙箱隔离", () => {
  for (const name of ["index", "account", "workspace", "users", "auth", "share"]) {
    const html = fs.readFileSync(path.join(assets, "../" + name + ".html"), "utf8");
    assert(html.indexOf("boot.js") < html.indexOf("tokens.css"));
    assert(html.indexOf("boot.js") < html.indexOf("<body"));
  }
  for (const name of ["auth.js", "share.js"]) assert(source(name).includes("settingsControls("));
  const share = fs.readFileSync(path.join(assets, "../share.html"), "utf8");
  assert(share.includes('sandbox="allow-scripts"'));
  assert(!share.includes("app-bridge.js"));
  assert(source("common.js").includes('sandbox: "allow-scripts"'));
  assert(!source("common.js").includes("allow-same-origin"));
  assert(!source("share.js").includes("AppBridgeHost"));
});
