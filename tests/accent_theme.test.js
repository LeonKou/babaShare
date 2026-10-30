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
    querySelector() { return null; }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
    select() { this.selected = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    get isConnected() { return document.body.contains(this); }
    get childNodes() { return this.children; }
    replaceWith() {}
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
    createTextNode: (value) => value,
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(fn);
    },
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
      return nodes.find((node) => "#" + node.id === selector) || null;
    },
  };
  document.body = new Element("body");
  const title = new Element("strong");
  const context = {
    document, URL, Promise, setTimeout, clearTimeout, queueMicrotask,
    FormData: class {
      constructor(form) {
        return form.elements.map((node) => [node.attrs.name, node.value]);
      }
    },
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    location: new URL("http://127.0.0.1/baba-share/" + page),
    history: { replaceState() {} },
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

async function shell(app) {
  for (const id of ["brand-home", "page-frame", "shell-controls", "new-workspace-icon", "logout-icon", "workspace-nav", "account-nav", "new-workspace", "shell-account", "logout", "new-workspace"]) {
    const node = new app.Element(id === "page-frame" ? "iframe" : "div");
    node.id = id;
  }
  app.run("bridge-core.js");
  app.run("app-bridge.js");
  app.run("common.js");
  app.context.API = async (name) => {
    if (name === "install") return { setupRequired: false };
    if (name === "me") return { nickname: "测试", role: "user" };
    if (name === "workspaces") return [];
    throw new Error("不应写入业务数据 " + name);
  };
  await app.run("shell.js");
  return app.document.querySelector("#page-frame");
}

async function attach(host, frame, child, wire = {}) {
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
  frame.fire("load");
  child.context.parent = wire.hostProxy;
  child.run("bridge-core.js");
  child.run("page-bridge.js");
  child.run("common.js");
  const bridge = child.context.UI.page();
  await bridge.ready;
  await flush();
  return { bridge, wire };
}

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
  const data = { babaShare: true, version: 1, type: "context.changed", payload: { locale: "ar-SA", theme: "dark", accent: "red", token: "秘密" } };
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
      : ["share-shell", "share-sidebar", "share-controls", "share-layout", "preview-actions", "share-stage", "shared-frame", "share-state", "share-status", "share-tree", "share-title", "share-folder-title", "share-expiry", "share-current"];
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
      if (name === "shareDetail") return { share: { expireTime: null }, previewBaseUrl: "/baba-share/preview/test/", listing: { entries: [], pageIndex: 1, totalPage: 1, totalCount: 0, entryPath: "index.html" } };
      throw new Error("不应写入业务数据 " + name);
    };
    await app.run(page + ".js");
    const holder = app.document.querySelector(page === "auth" ? "#auth-settings" : "#share-controls");
    const accent = holder.children.find((node) => node.dataset?.i18nLabel === "accent");
    assert.equal(accent.value, "green");
    accent.value = "purple";
    accent.fire("change");
    assert.equal(app.snapshot().accent, "purple");
    assert.equal(JSON.parse(app.writes.at(-1)[1]).accent, "purple");
    assert.equal(messages, 0);
    if (frame) assert.equal(frame.src, "/baba-share/preview/test/index.html");
    assert.equal(app.warnings.length, 0);
  }
});

async function sharePreview(mode = "native") {
  const app = realm({ page: "share.html" });
  const get = (id) => app.document.querySelector("#" + id);
  for (const id of ["share-shell", "share-sidebar", "share-controls", "share-layout", "preview-actions", "share-stage", "shared-frame", "share-state", "share-status", "share-tree", "share-title", "share-folder-title", "share-expiry", "share-current"]) {
    const node = new app.Element("div");
    node.id = id;
  }
  get("share-shell").append(get("share-layout"));
  get("share-layout").append(get("share-sidebar"), get("share-stage"));
  get("share-sidebar").append(get("share-tree"));
  get("share-stage").append(get("shared-frame"));
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
  app.context.API = async (name) => {
    assert.equal(name, "shareDetail");
    return { share: { expireTime: null }, previewBaseUrl: "/baba-share/preview/test/", listing: { entries: [{ name: "index.html", path: "index.html", kind: "file" }, { name: "other.html", path: "other.html", kind: "file" }], pageIndex: 1, totalPage: 1, totalCount: 2, entryPath: "index.html" } };
  };
  await app.run("share.js");
  app.get = get;
  app.fullscreen = get("preview-actions").children[0];
  app.toggle = get("share-controls").children[0];
  app.edge = app.nodes.find((node) => node.className === "share-tree-edge");
  app.exit = app.nodes.find((node) => node.className === "share-fullscreen-exit");
  app.isImmersive = () => get("share-shell").classList.contains("share-immersive");
  app.isTreeOpen = () => !get("share-layout").classList.contains("tree-collapsed");
  app.counts = () => ({ requests, exits });
  app.resolveRequest = () => resolveRequest();
  return app;
}

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
    assert.equal(app.get("shared-frame").src, "/baba-share/preview/test/index.html");
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
  assert(app.isImmersive());
  assert.equal(app.get("shared-frame").src, "/baba-share/preview/test/other.html");
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
  assert(css.includes('dialog>.toast{position:sticky'));
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
  assert.equal(new URL(frame.src).pathname, "/baba-share/workspace.html");
  assert.equal(new URL(frame.src).search, "");
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
