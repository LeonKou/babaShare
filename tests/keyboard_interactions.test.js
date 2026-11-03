"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assets = path.join(__dirname, "../web/assets");

function runtime(query = "") {
  let document, now = 1000;
  const listeners = new Map();
  function listen(host, type, fn, options) {
    if (!host.has(type)) host.set(type, []);
    host.get(type).push({ fn, capture: options === true || options?.capture, once: options?.once });
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = {};
      this.events = new Map();
      this.dataset = {};
      this.style = {};
      this.hidden = this.disabled = this.inert = false;
      this.value = this.textContent = "";
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    get disabled() { return this._disabled || false; }
    set disabled(value) {
      this._disabled = Boolean(value);
      if (value && document?.activeElement === this) document.activeElement = document.body;
    }
    get form() { return this.closest("form"); }
    get childNodes() { return this.children; }
    get elements() {
      const result = this.querySelectorAll("input,textarea,select,button");
      result.namedItem = (name) => result.find((node) => node.name === name);
      return result;
    }
    setAttribute(key, value) {
      const previous = this.attrs[key];
      this.attrs[key] = String(value);
      if (["id", "type", "name", "value", "src"].includes(key)) this[key] = String(value);
      if (["hidden", "disabled", "inert"].includes(key)) this[key] = true;
      if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (key === "open" && previous === undefined && this.tagName === "DETAILS") dispatch(this, "toggle");
    }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) {
      const previous = this.attrs[key];
      delete this.attrs[key];
      if (key === "open" && previous !== undefined && this.tagName === "DETAILS") dispatch(this, "toggle");
    }
    append(...nodes) {
      for (const item of nodes.flat().filter((item) => item != null)) {
        const node = typeof item === "object" ? item : document.createTextNode(String(item));
        node.remove?.();
        this.children.push(node);
        node.parentNode = this;
      }
    }
    replaceWith(node) {
      const parent = this.parentNode, index = parent.children.indexOf(this);
      this.remove();
      parent.children.splice(index, 0, node);
      node.parentNode = parent;
    }
    prepend(...nodes) { this.append(...nodes); this.children.unshift(...this.children.splice(-nodes.length)); }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
      this.parentNode = null;
      if (this.contains(document.activeElement)) document.activeElement = document.body;
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) {
      return selector.split(",").some((part) => {
        part = part.trim();
        if (part === ":disabled") return this.disabled;
        if (part.includes(" ")) {
          const bits = part.split(/\s+/), last = bits.pop();
          return this.matches(last) && Boolean(this.parentNode?.closest(bits.join(" ")));
        }
        if (part.includes(":not([type=hidden])")) return this.matches(part.replace(":not([type=hidden])", "")) && this.type !== "hidden";
        if (part.includes(':not([contenteditable="false"])')) return this.matches(part.replace(':not([contenteditable="false"])', "")) && this.getAttribute("contenteditable") !== "false";
        const tag = /^([a-z][\w-]*)/i.exec(part);
        if (tag && this.tagName !== tag[1].toUpperCase()) return false;
        const id = /#([\w-]+)/.exec(part);
        if (id && this.id !== id[1]) return false;
        const cls = /\.([\w-]+)/.exec(part);
        if (cls && !(this.className || "").split(" ").includes(cls[1])) return false;
        for (const match of part.matchAll(/\[([\w-]+)(?:="?([^\]"]+)"?)?\]/g)) {
          const value = ["hidden", "inert", "disabled"].includes(match[1]) ? (this[match[1]] ? "" : null) : this.getAttribute(match[1]);
          if (value === null || match[2] !== undefined && value !== match[2]) return false;
        }
        return Boolean(tag || id || cls || part.startsWith("["));
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.children) {
        if (child.matches(selector)) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() {
      if (this.rect) return this.rect;
      const width = Math.min(220, parseFloat(this.style.maxInlineSize) || 220);
      return { left: 100, right: 132, top: 100, bottom: 132, width, height: Math.min(80, parseFloat(this.style.maxBlockSize) || 80) };
    }
    getClientRects() { return this.isConnected && !this.closest("[hidden]") && this.style.display !== "none" ? [{}] : []; }
    focus() {
      if (this.disabled || !this.getClientRects().length || this.closest("[inert]")) return;
      const previous = document.activeElement;
      if (previous === this) return;
      document.activeElement = this;
      if (previous) dispatch(previous, "focusout", { relatedTarget: this });
      dispatch(this, "focusin", { relatedTarget: previous });
    }
    scrollIntoView() {}
    addEventListener(type, fn, options) { listen(this.events, type, fn, options); }
    removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter((entry) => entry.fn !== fn)); }
    showModal() { this.setAttribute("open", ""); }
    close() { this.removeAttribute("open"); dispatch(this, "close"); }
  }
  document = {
    activeElement: null,
    documentElement: { lang: "zh-CN", dir: "ltr", clientWidth: 800, dataset: { mode: "dark" } },
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    createTextNode: (value) => Object.assign(new Element("#text"), { textContent: value }),
    querySelector(selector) {
      if (selector === 'script[src$="common.js"]') return { src: "http://localhost/baba-share/assets/common.js" };
      return this.body.querySelector(selector);
    },
    querySelectorAll: (selector) => document.body.querySelectorAll(selector),
  };
  document.body = new Element("body");
  document.activeElement = document.body;
  const context = {
    console, URL, AbortController, Uint8Array, document, innerHeight: 600,
    Date: class extends Date { static now() { return now; } },
    location: new URL("http://localhost/baba-share/account.html" + query),
    history: { state: null, replaceState(state, _, url) { this.state = state; context.location = new URL(url); } },
    addEventListener(type, fn, options) { listen(listeners, type, fn, options); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((entry) => entry.fn !== fn)); },
    setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    getComputedStyle: (node) => ({ visibility: node.style.visibility || "visible" }),
    I18n: { t: (key) => key, ctx: { dir: "ltr", locale: "zh-CN" }, subscribe() {} },
    FormData: class {
      constructor(form) { return form.elements.filter((node) => node.name && !node.disabled).map((node) => [node.name, node.value]); }
    },
  };
  context.window = context;
  vm.createContext(context);
  function invoke(host, event, capture) {
    for (const entry of [...host.get(event.type) || []]) {
      if (Boolean(entry.capture) !== capture) continue;
      entry.fn(event);
      if (entry.once) host.set(event.type, host.get(event.type).filter((item) => item !== entry));
      if (event.stopped) break;
    }
  }
  function dispatch(target, type, init = {}) {
    const event = { type, target, ...init, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    const parents = [];
    for (let node = target; node; node = node.parentNode) parents.push(node);
    invoke(listeners, event, true);
    for (const node of [...parents].reverse()) if (!event.stopped) invoke(node.events, event, true);
    for (const node of parents) if (!event.stopped) invoke(node.events, event, false);
    if (!event.stopped) invoke(listeners, event, false);
    if (!event.defaultPrevented && type === "cancel") target.close();
    return event;
  }
  function enter(target, init = {}) {
    const event = dispatch(target, "keydown", { key: "Enter", ...init });
    if (!event.defaultPrevented && !target.disabled) {
      if (target.tagName === "BUTTON") {
        const click = dispatch(target, "click");
        if (!click.defaultPrevented && target.type === "submit" && target.form) dispatch(target.form, "submit");
      } else if (target.tagName === "INPUT" && target.form) dispatch(target.form, "submit");
      else if (target.tagName === "TEXTAREA") target.value += "\n";
      else if (target.tagName === "SUMMARY") {
        const details = target.closest("details");
        if (details.getAttribute("open") === null) details.setAttribute("open", "");
        else details.removeAttribute("open");
      }
    }
    dispatch(target, "keyup", { key: "Enter", ...init });
    return event;
  }
  function load(name) { return vm.runInContext(fs.readFileSync(path.join(assets, name), "utf8"), context); }
  load("common.js");
  load("pagination.js");
  return { context, document, dispatch, enter, load, tick: (ms) => { now += ms; },
    el: context.UI.el, $: (selector) => document.querySelector(selector) };
}

async function authFixture({ state = {}, submit = async () => ({}), query = "" } = {}) {
  const app = runtime(query);
  app.context.location = new URL("http://localhost/baba-share/auth.html" + query);
  app.load("i18n.js");
  const form = app.el("form", { id: "auth-form", novalidate: "" });
  for (const id of ["auth-title", "auth-hint", "auth-fields", "auth-status", "auth-switch"])
    form.append(app.el("div", { id }));
  form.append(app.el("button", { id: "auth-submit", type: "submit" }));
  app.document.body.append(form);
  for (const id of ["auth-settings", "security-icon", "auth-story-title"])
    app.document.body.append(app.el("div", { id }));
  const demo = app.el("div", { id: "auth-product-demo" }), covers = [];
  demo.setPasswordCovered = (value) => { assert.equal(typeof value, "boolean"); covers.push(value); };
  app.document.body.append(demo);
  const calls = [];
  app.context.API = async (route, options) => {
    if (route === "install") return { setupRequired: false, registrationEnabled: true, ...state };
    calls.push({ route, options });
    return submit(route, options);
  };
  let submissions = 0;
  form.addEventListener("submit", () => { submissions++; });
  await app.load("auth.js");
  return { ...app, form, calls, covers, submissions: () => submissions,
    password: () => form.elements.namedItem("password"), toggle: () => app.$(".auth-password-toggle") };
}

test("密码组仅以焦点驱动捂眼，组内往返无解除帧，明文离组仍恢复", async () => {
  const app = await authFixture(), input = app.password(), toggle = app.toggle();
  Object.defineProperty(input, "value", { get() { assert.fail("焦点联动不得读取密码"); } });
  input.focus();
  assert.equal(app.covers.at(-1), true);
  app.covers.length = 0;
  toggle.focus();
  app.enter(toggle);
  input.focus();
  toggle.focus();
  assert(app.covers.length > 0 && app.covers.every((value) => value === true));
  assert.equal(input.type, "text");
  app.form.elements.namedItem("userName").focus();
  assert.equal(app.covers.at(-1), false);
  assert.equal(input.type, "text");
  toggle.focus();
  assert.equal(app.covers.at(-1), true);
  app.dispatch(toggle, "focusout", { relatedTarget: null });
  assert.equal(app.covers.at(-1), false);
  assert.equal(app.calls.length, 0);
});

test("模式和主题重绘释放旧组事件，页面离开清理，缓存返回重新绑定", async () => {
  const app = await authFixture();
  for (const redraw of [() => app.context.I18n.apply({ locale: "ar-SA", theme: "light" }), () => app.enter(app.$("#auth-switch button"))]) {
    const input = app.password(), control = input.parentNode, toggle = app.toggle();
    input.focus();
    redraw();
    assert.equal(app.covers.at(-1), false);
    for (const name of ["focusin", "focusout"]) assert.equal(control.events.get(name).length, 0);
    assert.equal(toggle.events.get("click").length, 0);
    const count = app.covers.length;
    app.dispatch(control, "focusin"); app.dispatch(toggle, "click");
    assert.equal(app.covers.length, count);
  }
  app.enter(app.$("#auth-switch button"));
  const toggle = app.toggle(), control = app.password().parentNode;
  app.dispatch(toggle, "click");
  app.dispatch(app.document.body, "pagehide", { persisted: true });
  assert.equal(app.covers.at(-1), false);
  assert.equal(app.password().type, "password");
  assert.equal(control.events.get("focusin").length, 0);
  app.dispatch(app.document.body, "pageshow", { persisted: true });
  assert.equal(control.events.get("focusin").length, 1);
  assert.equal(app.covers.at(-1), true);
  app.dispatch(app.document.body, "pagehide", { persisted: false });
  assert.equal(app.covers.at(-1), false);
  app.dispatch(app.document.body, "pageshow");
  assert.equal(control.events.get("focusin").length, 0);
  const old = app.password();
  app.context.I18n.apply({ locale: "en-US" });
  assert.equal(app.password(), old, "卸载后不再响应重绘");
});

test("提交期间解除捂眼并移除交互，失败后重新按当前焦点响应", async () => {
  let reject;
  const app = await authFixture({ submit: () => new Promise((_, fail) => { reject = fail; }) });
  app.form.elements.namedItem("userName").value = "fictional-user";
  app.password().value = "fictional-password";
  app.password().focus();
  app.enter(app.password());
  assert.equal(app.covers.at(-1), false);
  assert.equal(app.password().parentNode.events.get("focusin").length, 0);
  app.dispatch(app.password(), "focusin");
  assert.equal(app.covers.at(-1), false);
  reject({ status: "LOGIN_FAILED" });
  await settleUsers();
  assert.equal(app.password().parentNode.events.get("focusin").length, 1);
  assert.equal(app.covers.at(-1), true);
  app.form.elements.namedItem("userName").focus();
  assert.equal(app.covers.at(-1), false);
});

test("登录密码默认掩码，点击显隐两次不提交、不替换输入或改变值和自动填充", async () => {
  const app = await authFixture(), password = app.password(), toggle = app.toggle();
  password.value = "  测试-only-سري  ";
  assert.equal(password.type, "password");
  assert.equal(password.autocomplete, "current-password");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.name, undefined);
  assert.equal(toggle.getAttribute("aria-controls"), password.id);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "显示密码");
  assert.equal(password.parentNode.children[1], toggle);
  const description = password.getAttribute("aria-describedby");
  const icon = toggle.querySelector("path").getAttribute("d");
  for (const visible of [true, false]) {
    app.dispatch(toggle, "click");
    assert.equal(app.password(), password);
    assert.equal(password.type, visible ? "text" : "password");
    assert.equal(password.value, "  测试-only-سري  ");
    assert.equal(password.autocomplete, "current-password");
    assert.equal(password.name, "password");
    assert.equal(password.getAttribute("aria-describedby"), description);
    assert.equal(toggle.getAttribute("aria-pressed"), String(visible));
    assert.equal(toggle.getAttribute("aria-label"), visible ? "隐藏密码" : "显示密码");
    assert.equal(toggle.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.equal(toggle.querySelector("path").getAttribute("d") === icon, !visible);
  }
  toggle.focus();
  app.enter(toggle);
  assert.equal(password.type, "text");
  assert.equal(app.document.activeElement, toggle);
  app.enter(toggle);
  assert.equal(password.type, "password");
  for (const expected of ["text", "password"]) {
    const down = app.dispatch(toggle, "keydown", { key: " " });
    const up = app.dispatch(toggle, "keyup", { key: " " });
    if (!down.defaultPrevented && !up.defaultPrevented && !toggle.disabled) {
      const click = app.dispatch(toggle, "click");
      if (!click.defaultPrevented && toggle.type === "submit") app.dispatch(app.form, "submit");
    }
    assert.equal(password.type, expected);
    assert.equal(app.document.activeElement, toggle);
  }
  assert.equal(app.submissions(), 0);
  assert.equal(app.calls.length, 0);
});

test("登录注册模式往返恢复掩码，旧输入也被掩码且注册不出现眼睛", async () => {
  for (const emailRegistrationEnabled of [false, true]) {
    const app = await authFixture({ state: { emailRegistrationEnabled } }), old = app.password();
    old.value = "test-password";
    app.dispatch(app.toggle(), "click");
    app.enter(app.$("#auth-switch button"));
    assert.equal(old.type, "password");
    assert.equal(app.toggle(), null);
    if (!emailRegistrationEnabled) {
      assert.equal(app.password().type, "password");
      assert.equal(app.password().value, "test-password");
      assert.equal(app.password().autocomplete, "new-password");
    } else assert.equal(app.password(), undefined);
    app.enter(app.$("#auth-switch button"));
    assert.equal(app.password().type, "password");
    assert.equal(app.toggle().getAttribute("aria-pressed"), "false");
    assert.equal(app.password().autocomplete, "current-password");
  }
  const setup = await authFixture({ state: { setupRequired: true } });
  assert.equal(setup.toggle(), null);
  assert.equal(setup.password().type, "password");
});

test("无效提交也立即恢复掩码，校验和密码值保持", async () => {
  const app = await authFixture();
  app.password().value = "test-password";
  app.dispatch(app.toggle(), "click");
  app.enter(app.password());
  assert.equal(app.password().type, "password");
  assert.equal(app.password().value, "test-password");
  assert.equal(app.toggle().disabled, false);
  assert.equal(app.toggle().getAttribute("aria-label"), "显示密码");
  assert.equal(app.calls.length, 0);
  assert.equal(app.document.activeElement.name, "userName");
});

test("提交前恢复掩码，等待中禁止再显示，成功失败及语言重绘后均保持掩码", async () => {
  for (const failure of [false, true]) {
    let finish;
    const app = await authFixture({ submit: () => new Promise((resolve, reject) => {
      finish = () => failure ? reject({ status: "LOGIN_FAILED" }) : resolve({});
    }) });
    app.form.elements.namedItem("userName").value = "test-user";
    app.password().value = "test-password";
    app.dispatch(app.toggle(), "click");
    app.enter(app.password());
    assert.equal(app.password().type, "password");
    assert.equal(app.toggle().disabled, true);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].route, "login");
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0].options.body)), { userName: "test-user", password: "test-password" });
    app.context.I18n.apply({ locale: "en-US" });
    assert.equal(app.toggle().disabled, true);
    app.dispatch(app.toggle(), "click");
    app.dispatch(app.form, "submit");
    assert.equal(app.password().type, "password");
    assert.equal(app.calls.length, 1);
    finish();
    await settleUsers();
    assert.equal(app.password().type, "password");
    assert.equal(app.password().value, "test-password");
    assert.equal(app.toggle().disabled, false);
    assert.equal(app.toggle().getAttribute("aria-pressed"), "false");
    assert.equal(app.toggle().getAttribute("aria-label"), "Show password");
    assert.equal(app.form.getAttribute("aria-busy"), "false");
  }
});

test("密码按钮中英阿名称与状态同步，语言切换恢复掩码并保留值及主题方向", async () => {
  const app = await authFixture();
  app.password().value = "test-password";
  for (const [locale, show, hide, dir] of [
    ["zh-CN", "显示密码", "隐藏密码", "ltr"],
    ["en-US", "Show password", "Hide password", "ltr"],
    ["ar-SA", "إظهار كلمة المرور", "إخفاء كلمة المرور", "rtl"],
  ]) for (const theme of ["light", "dark"]) {
    app.context.I18n.apply({ locale, theme });
    assert.equal(app.password().type, "password");
    assert.equal(app.password().value, "test-password");
    assert.equal(app.toggle().getAttribute("aria-label"), show);
    assert.equal(app.toggle().getAttribute("data-i18n-label"), "authShowPassword");
    assert.equal(app.document.documentElement.dir, dir);
    assert.equal(app.document.documentElement.dataset.mode, theme);
    app.dispatch(app.toggle(), "click");
    assert.equal(app.toggle().getAttribute("aria-label"), hide);
    assert.equal(app.toggle().getAttribute("data-i18n-label"), "authHidePassword");
    assert.equal(app.toggle().getAttribute("aria-pressed"), "true");
  }
});

test("密码按钮样式限定登录表单，逻辑末端镜像并预留40像素热区与文字空间", () => {
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  assert.match(css, /#auth-form \.auth-password-control\{position:relative;min-inline-size:0\}/);
  assert.match(css, /#auth-form \.auth-password-control>input\{[^}]*padding-inline-end:calc\(40px \+ var\(--space-2\)\)/);
  assert.match(css, /#auth-form \.auth-password-toggle\{[^}]*inset-inline-end:0;inset-block:0;inline-size:40px;min-block-size:40px/);
});

test("登录密码仅屏蔽自定义控件内的Edge原生显隐，沿用主题焦点和图标色", () => {
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  const revealRules = css.split("}").filter((rule) => rule.includes("::-ms-reveal"));
  assert.equal(revealRules.length, 1);
  assert.match(revealRules[0], /#auth-form \.auth-password-control>input::-ms-reveal\{display:none$/);
  assert.match(css, /:focus-visible\{outline:2px solid var\(--color-border-focus\)\}/);
  assert.match(css, /button,a,input,select,summary,textarea\{outline-offset:-2px\}/);
  assert.match(css, /#auth-form \.auth-password-toggle\{[^}]*color:var\(--color-text-secondary\)/);
});

test("密码显隐及语言主题重绘不记录密码，偏好存储仅包含界面上下文", async () => {
  const app = await authFixture(), writes = [], logs = [];
  app.context.localStorage = { setItem: (...args) => writes.push(args) };
  app.context.sessionStorage = { setItem: (...args) => writes.push(args) };
  app.context.console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((key) => [key, (...args) => logs.push(args)]));
  const secret = "fictional-私密-Only-789";
  app.password().value = secret;
  app.dispatch(app.toggle(), "click");
  app.dispatch(app.toggle(), "click");
  assert.equal(writes.length, 0);
  app.dispatch(app.toggle(), "click");
  const language = app.$('#auth-settings select[data-i18n-label="language"]');
  language.value = "ar-SA";
  app.dispatch(language, "change");
  app.dispatch(app.$('#auth-settings button[data-i18n-label="theme"]'), "click");
  assert.equal(app.password().type, "password");
  assert.equal(app.password().value, secret);
  assert.equal(writes.length, 2);
  for (const [key, value] of writes) {
    assert.equal(key, "baba-share-context");
    assert.equal(value.includes(secret), false);
    assert.equal(Object.hasOwn(JSON.parse(value), "password"), false);
  }
  assert.deepEqual(logs, []);
  assert.equal(app.context.location.href.includes(secret), false);
  assert.equal(app.calls.length, 0);
});

test("显隐不改变普通及邀请登录请求和成功跳转，密码不进入URL", async () => {
  const token = "a".repeat(43);
  for (const query of ["", "#invite=" + token]) {
    const app = await authFixture({ query, submit: () => {
      assert.equal(app.password().type, "password");
      return {};
    } });
    app.form.elements.namedItem("userName").value = "fictional-user";
    app.password().value = "  fictional-password  ";
    app.dispatch(app.toggle(), "click");
    app.enter(app.password());
    await settleUsers();
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].route, "login");
    assert.equal(app.calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0].options.body)), {
      userName: "fictional-user", password: "  fictional-password  ",
    });
    assert.equal(app.context.location.href, query
      ? app.context.UI.invitationUrl("invite", token) : app.context.UI.routeUrl("shell"));
    assert.equal(app.password().type, "password");
  }
});

function formFixture(app) {
  const form = app.el("form"), input = app.el("input", { type: "text" }), textarea = app.el("textarea");
  form.append(input, textarea, app.el("button", { type: "submit" }));
  app.document.body.append(form);
  let submissions = 0;
  form.addEventListener("submit", (event) => { event.preventDefault(); submissions++; });
  return { form, input, textarea, count: () => submissions };
}

test("新增原生搜索表单中文组合确认不提交，下一次普通Enter仍走原生提交", () => {
  const app = runtime(), fixture = formFixture(app);
  fixture.input.focus();
  app.dispatch(fixture.input, "compositionstart");
  assert.equal(app.enter(fixture.input, { isComposing: true }).defaultPrevented, false);
  assert.equal(fixture.count(), 0);
  app.dispatch(fixture.input, "compositionend");
  app.enter(fixture.input);
  assert.equal(fixture.count(), 0);
  app.tick(100);
  app.enter(fixture.input);
  assert.equal(fixture.count(), 1);
  app.enter(fixture.input);
  assert.equal(fixture.count(), 2);
});

test("isComposing和旧版229保护生效，组合结束先于keydown也不误提交", () => {
  const app = runtime(), fixture = formFixture(app);
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    app.enter(fixture.input, init);
    assert.equal(fixture.count(), 0);
  }
  app.dispatch(fixture.input, "compositionend");
  app.enter(fixture.input);
  assert.equal(fixture.count(), 0);
  app.enter(fixture.input);
  assert.equal(fixture.count(), 1);
});

test("textarea保持换行，Ctrl/Cmd+Enter不擅自提交，Monaco和contenteditable不被劫持", () => {
  const app = runtime(), fixture = formFixture(app);
  for (const init of [{}, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(app.enter(fixture.textarea, init).defaultPrevented, false);
    assert.equal(fixture.count(), 0);
  }
  assert.equal(fixture.textarea.value, "\n\n\n");
  for (const attrs of [{ class: "monaco-editor" }, { contenteditable: "true" }]) {
    const editor = app.el("div", attrs), input = app.el("input");
    editor.append(input); fixture.form.append(editor);
    app.dispatch(input, "compositionstart");
    assert.equal(app.dispatch(input, "keydown", { key: "Enter", isComposing: true }).defaultPrevented, false);
    const submit = app.dispatch(fixture.form, "submit");
    assert.equal(submit.stopped, false);
  }
});

test("输入法提交保护仅限所属表单，明确点击提交不受残余组合时间影响", () => {
  const app = runtime(), first = formFixture(app), second = formFixture(app);
  app.dispatch(first.input, "compositionend");
  app.enter(second.input);
  assert.equal(second.count(), 1);
  app.dispatch(first.form.querySelector("button"), "pointerdown");
  app.dispatch(first.form, "submit");
  assert.equal(first.count(), 1);
});

test("真实共享formDialog以普通Enter提交、输入法确认不调用业务且多行Enter仅换行", async () => {
  const app = runtime();
  let calls = 0, values;
  const result = app.context.UI.formDialog("创建", [
    { key: "name", value: "测试名称", required: true },
    { key: "description", type: "textarea", value: "首行" },
  ], async (body) => { calls++; values = body; return "created"; });
  const form = app.$("dialog form"), input = form.querySelector("input"), textarea = form.querySelector("textarea");
  assert.equal(app.document.activeElement, input);
  app.dispatch(input, "compositionstart"); app.enter(input, { isComposing: true });
  assert.equal(calls, 0);
  app.dispatch(input, "compositionend"); app.tick(100);
  app.enter(textarea);
  assert.equal(calls, 0);
  assert.equal(textarea.value, "首行\n");
  app.enter(input);
  assert.equal(calls, 1);
  assert.equal(await result, "created");
  assert.equal(values.name, "测试名称");
  assert.equal(values.description, "首行\n");
});

test("共享表单铺满当前文档，初始焦点仍到字段，返回/关闭/面包屑退出回触发点", async () => {
  for (const selector of [".form-drawer-back", ".form-drawer-close", ".form-drawer-crumbs button"]) {
    const app = runtime(), main = app.el("main"), trigger = app.el("button");
    main.append(app.el("h1", { text: "用户" }), trigger); app.document.body.append(main);
    app.document.body.style.overflow = "auto"; trigger.focus();
    const result = app.context.UI.formDialog("编辑用户", [{ key: "name", value: "原值" }], async () => true);
    const drawer = app.$("dialog[open]");
    assert.equal(drawer.className, "form-drawer");
    assert.equal(drawer.querySelector("h2").textContent, "编辑用户");
    assert.equal(drawer.querySelector('[aria-current="page"]').textContent, "编辑用户");
    assert.equal(drawer.getAttribute("aria-labelledby"), drawer.querySelector("h2").id);
    assert.equal(app.document.activeElement, drawer.querySelector("input"));
    assert.equal(app.document.body.style.overflow, "hidden");
    assert.equal(drawer.querySelector(".form-feedback").parentNode, drawer.querySelector("form"));
    assert.equal(drawer.querySelector("input").closest(".form-drawer-body") !== null, true);
    app.enter(drawer.querySelector(selector));
    assert.equal(await result, null);
    assert.equal(app.document.body.style.overflow, "auto");
    assert.equal(app.document.activeElement, trigger);
  }
});

test("返回关闭取消及Esc共用未保存确认，取消保留草稿且确认弹窗不变整页", async () => {
  for (const selector of [".form-drawer-back", ".form-drawer-close", '.actions button[data-i18n="cancel"]', "Escape"]) {
    const app = runtime();
    const bridge = { dirty: false, setDirty(value) { this.dirty = value; } };
    app.context.AppPage = bridge;
    const result = app.context.UI.formDialog("编辑", [{ key: "name", value: "原值" }], async () => true);
    const drawer = app.$("dialog[open]"), input = drawer.querySelector("input");
    input.value = "未保存草稿"; app.dispatch(input, "input");
    assert.equal(bridge.dirty, true);
    if (selector === "Escape") app.dispatch(drawer, "cancel");
    else app.enter(drawer.querySelector(selector));
    const confirm = app.document.querySelectorAll("dialog[open]").at(-1);
    assert.notEqual(confirm, drawer);
    assert.equal(confirm.className, "");
    app.enter(confirm.querySelector('[data-confirm-action="cancel"]'));
    await settleUsers();
    assert.equal(input.value, "未保存草稿");
    assert.equal(bridge.dirty, true);
    assert.equal(app.document.body.style.overflow, "hidden");
    app.dispatch(drawer, "cancel");
    app.enter(app.$('[data-confirm-action="confirm"]'));
    assert.equal(await result, null);
    assert.equal(bridge.dirty, false);
    assert.equal(app.$("dialog[open]"), null);
  }
});

test("选择字段change触发dirty，嵌套表单关闭保留外层dirty和滚动锁", async () => {
  const app = runtime();
  app.context.AppPage = { dirty: false, setDirty(value) { this.dirty = value; } };
  const outer = app.context.UI.formDialog("外层", [{ key: "role", options: [{ value: "a", label: "角色" }] }], async () => true);
  const first = app.$("dialog[open]");
  app.dispatch(first.querySelector("select"), "change");
  assert.equal(app.context.AppPage.dirty, true);
  const inner = app.context.UI.formDialog("内层", [{ key: "name" }], async () => true);
  app.dispatch(app.document.querySelectorAll("dialog[open]").at(-1), "cancel");
  await inner;
  assert.equal(app.context.AppPage.dirty, true);
  assert.equal(app.document.body.style.overflow, "hidden");
  app.dispatch(first, "cancel"); app.enter(app.$('[data-confirm-action="confirm"]'));
  await outer;
  assert.equal(app.context.AppPage.dirty, false);
});

test("整页表单提交期间全部退出入口禁用且Esc不关闭，失败恢复并保留草稿", async () => {
  const app = runtime();
  let reject, calls = 0;
  app.context.AppPage = { dirty: false, setDirty(value) { this.dirty = value; } };
  const result = app.context.UI.formDialog("编辑", [{ key: "name", required: true, value: "原值" }], () => {
    calls++; return new Promise((_, fail) => { reject = fail; });
  });
  const drawer = app.$("dialog[open]"), form = drawer.querySelector("form"), input = form.querySelector("input");
  input.value = "草稿"; app.dispatch(input, "input"); app.enter(input);
  assert.equal(calls, 1);
  assert.equal(form.getAttribute("aria-busy"), "true");
  for (const control of drawer.querySelectorAll("button")) assert.equal(control.disabled, true);
  assert.equal(app.dispatch(drawer, "cancel").defaultPrevented, true);
  assert.equal(app.document.querySelectorAll("dialog[open]").length, 1);
  app.dispatch(form, "submit"); assert.equal(calls, 1);
  reject({ status: "PARAM_INVALID" }); await settleUsers();
  assert.equal(form.getAttribute("aria-busy"), "false");
  assert.equal(input.value, "草稿"); assert.equal(app.context.AppPage.dirty, true);
  for (const control of drawer.querySelectorAll("button")) assert.equal(control.disabled, false);
  app.dispatch(drawer, "cancel"); app.enter(app.$('[data-confirm-action="confirm"]')); await result;
});

test("整页表单返回关闭和路径名称三语可读，语言方向和双主题不被覆盖", async () => {
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) for (const theme of ["light", "dark"]) {
    const app = runtime(); app.load("i18n.js"); app.context.I18n.apply({ locale, theme });
    const result = app.context.UI.formDialog(app.context.I18n.t("edit"), [{ key: "name" }], async () => true);
    const drawer = app.$("dialog[open]");
    assert.equal(drawer.querySelector(".form-drawer-back").getAttribute("aria-label"), app.context.I18n.t("back"));
    assert.equal(drawer.querySelector(".form-drawer-close").getAttribute("aria-label"), app.context.I18n.t("close"));
    assert.equal(drawer.querySelector("nav").getAttribute("aria-label"), app.context.I18n.t("breadcrumb"));
    assert.equal(app.document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
    assert.equal(app.document.documentElement.dataset.mode, theme);
    app.dispatch(drawer, "cancel"); await result;
  }
});

test("整页样式全视口无窄抽屉，正文单独滚动、底栏保留、RTL与减少动画生效", () => {
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  assert.match(css, /dialog\.form-drawer\[open\]\{[^}]*inset:0;[^}]*inline-size:100%;block-size:100%;max-inline-size:none;max-block-size:none/);
  assert.match(css, /\.form-drawer-body\{[^}]*min-block-size:0;[^}]*overflow:auto/);
  assert.match(css, /\.form-drawer-form>\.form-feedback\{flex-shrink:0/);
  assert.match(css, /html\[dir="rtl"\] \.form-drawer\{--form-drawer-direction:-1\}/);
  assert.match(css, /translateX\(calc\(100% \* var\(--form-drawer-direction\)\)\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{dialog\.form-drawer\[open\]\{animation:none\}\}/);
});

test("确认弹窗安全默认聚焦取消，Enter原生激活取消或确认，Esc取消", async () => {
  const app = runtime(), trigger = app.el("button");
  app.document.body.append(trigger); trigger.focus();
  let result = app.context.UI.confirm("确认删除");
  assert.equal(app.document.activeElement.getAttribute("data-confirm-action"), "cancel");
  assert.equal(app.enter(app.document.activeElement).defaultPrevented, false);
  assert.equal(await result, false);
  assert.equal(app.document.activeElement, trigger);
  result = app.context.UI.confirm("确认删除", { initialFocus: "confirm" });
  assert.equal(app.document.activeElement.getAttribute("data-confirm-action"), "confirm");
  app.enter(app.document.activeElement);
  assert.equal(await result, true);
  result = app.context.UI.confirm("确认删除");
  app.dispatch(app.$("dialog[open]"), "cancel");
  assert.equal(await result, false);
});

test("dialog隐藏/禁用/重绘触发点回本页主标题，正常触发点及指定后备优先", () => {
  for (const invalidate of [(node) => { node.hidden = true; }, (node) => { node.disabled = true; }, (node) => node.remove(),
    (node) => { node.style.visibility = "hidden"; }]) {
    const app = runtime(), main = app.el("main"), heading = app.el("h1"), trigger = app.el("button");
    main.append(heading, trigger); app.document.body.append(main); trigger.focus();
    const dialog = app.context.UI.dialog("标题", (node, close) => node.append(app.context.UI.button("close", close)));
    invalidate(trigger); dialog.close(null);
    assert.equal(app.document.activeElement, heading);
    assert.equal(heading.getAttribute("tabindex"), "-1");
  }
  const app = runtime(), trigger = app.el("button"), fallback = app.el("h2");
  app.document.body.append(trigger, fallback); trigger.focus();
  const dialog = app.context.UI.dialog("标题", (node) => node.append(app.el("input")), { returnFocus: () => fallback });
  trigger.remove(); dialog.close(null);
  assert.equal(app.document.activeElement, fallback);
});

test("对话框首次打开只聚焦可用输入，嵌套确认取消回原对话框", async () => {
  const app = runtime();
  assert.equal(app.document.activeElement, app.document.body);
  const dialog = app.context.UI.dialog("表单", (node) => node.append(app.el("input", { disabled: "" }), app.el("textarea")));
  const textarea = dialog.node.querySelector("textarea");
  assert.equal(app.document.activeElement, textarea);
  const result = app.context.UI.confirm("放弃更改");
  app.dispatch(app.$("dialog[open]") === dialog.node ? app.document.querySelectorAll("dialog[open]").at(-1) : app.$("dialog[open]"), "cancel");
  assert.equal(await result, false);
  assert.equal(app.document.activeElement, textarea);
});

test("LocalPager原生Enter翻页重绘保留语义焦点，末页安全回退容量控件", () => {
  const app = runtime(), container = app.el("nav");
  app.document.body.append(container);
  const items = Array.from({ length: 45 }, (_, index) => index);
  let visible;
  const pager = app.context.LocalPager(container, () => { visible = pager.slice(items); });
  pager.slice(items);
  assert.equal(app.document.activeElement, app.document.body);
  container.querySelectorAll("button")[1].focus();
  app.enter(app.document.activeElement);
  assert.equal(pager.pageIndex, 2);
  assert.equal(visible[0], 20);
  assert.equal(app.document.activeElement, container.querySelectorAll("button")[1]);
  app.enter(app.document.activeElement);
  assert.equal(pager.pageIndex, 3);
  assert.equal(app.document.activeElement, container.querySelector("select"));
});

test("LocalPager异步busy暂存焦点且响应后还原，用户移走焦点不被抢回", () => {
  const app = runtime(), container = app.el("nav"), other = app.el("button");
  app.document.body.append(container, other);
  const pager = app.context.LocalPager(container, () => pager.busy(true), { remote: true });
  pager.accept({ totalCount: 80, totalPage: 4 });
  container.querySelectorAll("button")[1].focus();
  app.enter(app.document.activeElement);
  assert.equal(app.document.activeElement, container);
  assert.equal(container.getAttribute("aria-busy"), "true");
  pager.accept({ totalCount: 80, totalPage: 4 });
  pager.busy(false);
  assert.equal(app.document.activeElement, container.querySelectorAll("button")[1]);
  app.enter(app.document.activeElement);
  other.focus();
  pager.accept({ totalCount: 80, totalPage: 4 }); pager.busy(false);
  assert.equal(app.document.activeElement, other);
});

test("LocalPager容量变更与语言重绘不丢焦点，外部结果刷新不抢焦点", () => {
  const app = runtime(), container = app.el("nav"), other = app.el("button");
  app.document.body.append(container, other);
  const pager = app.context.LocalPager(container, () => pager.slice(Array(60).fill(1)));
  pager.slice(Array(60).fill(1));
  let select = container.querySelector("select"); select.focus(); select.value = "10";
  app.dispatch(select, "change");
  assert.equal(pager.pageSize, 10);
  assert.equal(app.document.activeElement, container.querySelector("select"));
  other.focus(); pager.slice(Array(60).fill(1));
  assert.equal(app.document.activeElement, other);
});

test("真实account.js MCP分页键盘翻页重绘保留焦点且隐藏面板不被聚焦", async () => {
  const app = runtime("?accountTab=keys");
  const html = fs.readFileSync(path.join(assets, "../account.html"), "utf8");
  const root = app.document.body, stack = [root];
  for (const match of html.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    if (["html", "body", "head", "meta", "link", "script", "title"].includes(tag)) continue;
    if (match[0].startsWith("</")) { if (stack.at(-1).tagName === tag.toUpperCase()) stack.pop(); continue; }
    const attrs = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), (part) => [part[1], part[2]]));
    if (/\bhidden\b/.test(match[2])) attrs.hidden = "";
    const node = app.el(tag, attrs); stack.at(-1).append(node);
    if (!["input", "br", "hr", "img"].includes(tag)) stack.push(node);
  }
  app.context.UI.page = () => ({ ready: Promise.resolve() });
  app.context.API = async (name) => {
    if (name === "me") return { nickname: "测试", userName: "tester", role: "user", createTime: 1 };
    if (name === "shares" || name === "workspaces") return [];
    if (name === "mcpKeys") return Array.from({ length: 25 }, (_, index) => ({ id: String(index), keyName: "密钥" + index, keyPrefix: "bsk_", createTime: 1 }));
    throw Error("未预期业务调用 " + name);
  };
  await app.load("account.js");
  const pager = app.$("#mcp-pagination");
  pager.querySelectorAll("button")[1].focus();
  app.enter(app.document.activeElement);
  assert.equal(app.context.location.searchParams.get("mcpPageIndex"), "2");
  assert.equal(app.document.activeElement, pager.querySelectorAll("button")[1]);
  app.enter(app.document.activeElement);
  assert.equal(app.context.location.searchParams.get("mcpPageIndex"), "3");
  assert.equal(app.document.activeElement, pager.querySelector("select"));
  app.$("#account-tab-profile").focus(); app.enter(app.document.activeElement);
  assert.equal(app.document.activeElement, app.$("#account-tab-profile"));
});

async function workspaceAdminRuntime({ query = "?userId=editor&relation=member", respond } = {}) {
  const app = runtime(query);
  app.load("i18n.js");
  const html = fs.readFileSync(path.join(assets, "../workspace-admin.html"), "utf8");
  const stack = [app.document.body];
  for (const match of html.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    if (["html", "body", "head", "meta", "link", "script", "title", "style"].includes(tag)) continue;
    if (match[0].startsWith("</")) { if (stack.at(-1).tagName === tag.toUpperCase()) stack.pop(); continue; }
    const attrs = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), (part) => [part[1], part[2]]));
    if (/\bhidden\b/.test(match[2])) attrs.hidden = "";
    const node = app.el(tag, attrs); stack.at(-1).append(node);
    if (!["input", "br", "hr", "img"].includes(tag)) stack.push(node);
  }
  const calls = [];
  app.context.UI.page = () => ({ ready: Promise.resolve(), embedded: false });
  app.context.API = async (key, options) => {
    calls.push({ key, options });
    if (key === "users") return [{ id: "editor", nickname: "Editor", userName: "editor", role: "editor" }];
    if (key === "workspaceAdmin") return respond ? respond(options, calls) : { pageIndex: options.query.pageIndex, pageSize: options.query.pageSize, totalCount: 80, totalPage: 4, data: [] };
    throw Error("未预期业务调用 " + key);
  };
  await app.load("workspace-admin.js");
  return { ...app, calls, listCalls: () => calls.filter((call) => call.key === "workspaceAdmin"),
    summaryText: () => {
      const text = (node) => node.textContent + node.children.map(text).join("");
      return text(app.$("#admin-filter-summary"));
    } };
}

test("空间筛选默认收起，原生Enter仅切换展开且不查不清草稿和已应用条件", async () => {
  const app = await workspaceAdminRuntime();
  const details = app.$("#admin-filters"), summary = details.querySelector("summary");
  assert.equal(details.getAttribute("open"), null);
  const initialSummary = app.summaryText();
  assert.match(initialSummary, /已应用 2 项.*Editor.*仅成员/);
  app.$("#admin-query").value = "未提交";
  app.$("#admin-user").value = "";
  summary.focus(); app.enter(summary);
  assert.equal(details.getAttribute("open"), "");
  app.enter(summary);
  assert.equal(details.getAttribute("open"), null);
  assert.equal(app.document.activeElement, summary);
  assert.equal(app.listCalls().length, 1);
  assert.equal(app.$("#admin-query").value, "未提交");
  assert.equal(app.$("#admin-user").value, "");
  assert.equal(app.summaryText(), initialSummary);
  app.context.I18n.apply({ locale: "en-US" });
  assert.equal(app.$("#admin-user").value, "");
  assert.match(app.summaryText(), /2 filters applied.*Editor.*Member only/);
  assert.doesNotMatch(app.summaryText(), /未提交/);
  assert.equal(app.listCalls().length, 1);
  assert.equal(details.getAttribute("open"), null);
});

test("空间筛选保留IME保护与Enter提交，重置清条件和URL、回首页且保持展开状态", async () => {
  const app = await workspaceAdminRuntime({ query: "?userId=editor&relation=member&pageIndex=3&pageSize=20&extra=keep" });
  const details = app.$("#admin-filters"), input = app.$("#admin-query");
  app.enter(details.querySelector("summary"));
  input.value = "Shared"; input.focus();
  app.dispatch(input, "compositionstart"); app.enter(input, { isComposing: true });
  assert.equal(app.listCalls().length, 1);
  app.dispatch(input, "compositionend"); app.tick(100); app.enter(input);
  await settleUsers();
  assert.equal(app.listCalls().length, 2);
  assert.equal(app.listCalls().at(-1).options.query.search, "Shared");
  assert.equal(app.listCalls().at(-1).options.query.pageIndex, 1);
  assert.equal(app.context.location.searchParams.get("search"), "Shared");
  assert.match(app.summaryText(), /已应用 3 项.*Shared/);
  app.context.I18n.apply({ locale: "ar-SA", theme: "light" });
  assert.match(app.summaryText(), /المرشحات المطبّقة: 3/);
  assert.equal(app.document.documentElement.dir, "rtl");
  app.$("#admin-reset").focus(); app.enter(app.document.activeElement);
  await settleUsers();
  assert.equal(app.listCalls().length, 3);
  const latest = app.listCalls().at(-1).options.query;
  for (const key of ["userId", "search", "creator"]) assert.equal(latest[key], "");
  assert.equal(latest.relation, "any"); assert.equal(latest.ownerStatus, "all");
  assert.equal(latest.pageIndex, 1);
  assert.equal(app.context.location.searchParams.get("extra"), "keep");
  assert.equal(app.context.location.searchParams.has("search"), false);
  assert.equal(app.context.location.searchParams.has("userId"), false);
  assert.equal(details.getAttribute("open"), "");
  assert.equal(app.summaryText(), app.context.I18n.t("noAppliedFilters"));
});

test("空间筛选新旧请求倒序与过期失败不覆盖当前结果或摘要", async () => {
  for (const failure of [false, true]) {
    let pending;
    const app = await workspaceAdminRuntime({ respond: (options) => {
      if (options.query.search === "旧条件") return new Promise((resolve, reject) => { pending = { resolve, reject }; });
      return { totalCount: 0, totalPage: 0, data: [] };
    } });
    app.enter(app.$("#admin-filters").querySelector("summary"));
    const input = app.$("#admin-query");
    input.value = "旧条件"; app.enter(input);
    assert.equal(app.$('button[type="submit"]').disabled, true);
    app.dispatch(app.$("#admin-reset"), "click");
    await settleUsers();
    assert.equal(app.listCalls().length, 3);
    assert.equal(app.listCalls()[1].options.signal.aborted, true);
    assert.equal(app.$('button[type="submit"]').disabled, false);
    if (failure) pending.reject(Error("过期请求失败"));
    else pending.resolve({ totalCount: 1, totalPage: 1, data: [{ id: "过期记录" }] });
    await settleUsers();
    assert.equal(app.$("#admin-status").textContent, "");
    assert.equal(app.summaryText(), app.context.I18n.t("noAppliedFilters"));
    assert.equal(app.$("#admin-cards").children.length, 0);
    assert.equal(app.$('button[type="submit"]').disabled, false);
    assert.equal(app.$("#admin-cards").getAttribute("aria-busy"), "false");
  }
});

test("空间筛选响应式栅格宽屏自适应多列、窄屏受100%约束且操作末位", () => {
  const html = fs.readFileSync(path.join(assets, "../workspace-admin.html"), "utf8");
  assert.match(html, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,240px\),1fr\)\)/);
  assert.match(html, /#admin-search \.field\{min-inline-size:0;margin:0\}/);
  assert.match(html, /inline-size:100%;min-inline-size:0;max-inline-size:100%/);
  assert.match(html, /#admin-filters>summary\{cursor:pointer;min-block-size:32px;overflow-wrap:anywhere\}/);
  assert.match(html, /\.actions\{display:flex;flex-wrap:wrap;gap:var\(--space-2\);justify-content:flex-end/);
  assert.doesNotMatch(html, /grid-template-columns:repeat\(\d|width:\d+px|row-reverse/);
  assert.ok(html.indexOf('id="admin-reset"') < html.indexOf('type="submit"'));
  assert.doesNotMatch(html, /<details id="admin-filters"[^>]*\bopen\b|<summary[^>]*role="button"/);
});

const settleUsers = () => new Promise((resolve) => setImmediate(resolve));
async function userRuntime({ disabled = false, afterPatch, afterList, selfId = "admin", locale, theme } = {}) {
  const app = runtime();
  if (locale) { app.load("i18n.js"); app.context.I18n.apply({ locale, theme }); }
  for (const id of ["user-pagination", "user-cards", "user-empty", "user-actions", "user-status", "user-search", "user-query"]) {
    app.document.body.append(app.el(id === "user-query" ? "input" : "div", { id }));
  }
  let users = ["before", "target", "after"].map((id) => ({ id, nickname: id, userName: id, role: "editor", isDisabled: disabled, createTime: 1 }));
  const calls = [];
  let lists = 0;
  app.context.UI.page = () => ({ ready: Promise.resolve(), embedded: false });
  app.context.API = async (key, options) => {
    calls.push({ key, options });
    if (key === "me") return { id: selfId };
    if (key === "users") {
      if (lists++) await afterList?.(app, users);
      return users;
    }
    if (key === "user" && options.method === "PATCH") {
      const updated = { ...users.find((user) => user.id === options.body.id), ...options.body };
      await afterPatch?.(app, updated);
      users = users.map((user) => user.id === updated.id ? updated : user);
      return updated;
    }
    throw Error("未预期业务调用 " + key);
  };
  await app.load("users.js");
  const card = (id = "target") => app.$("#user-cards").children.find((node) => node.getAttribute("data-id") === id);
  const edit = (id) => card(id).querySelector("footer button");
  const toggle = (id) => card(id).querySelector("details button");
  const submit = async () => {
    const form = app.$("dialog form");
    form.elements.namedItem("role").value = "editor";
    form.elements.namedItem("isDisabled").value = String(disabled);
    const save = form.querySelectorAll("button").at(-1);
    save.focus();
    app.enter(save);
    await settleUsers();
  };
  return { ...app, calls, card, edit, toggle, submit };
}

test("用户卡片外显编辑与工作区，三点菜单在末端且收纳启停和删除", async () => {
  const app = await userRuntime();
  for (const card of app.$("#user-cards").children) {
    const footer = card.querySelector("footer"), menu = footer.children.at(-1);
    assert.equal(menu.tagName, "DETAILS");
    assert.equal(menu.className, "card-action-menu");
    assert.equal(menu.getAttribute("name"), "user-card-actions");
    assert.deepEqual(footer.children.map((node) => node.tagName), ["BUTTON", "A", "DETAILS"]);
    assert.equal(footer.children[0].getAttribute("data-i18n"), "edit");
    assert.equal(footer.children[1].textContent, "userWorkspaces");
    assert.equal(menu.querySelector("summary").textContent, "…");
    assert.equal(menu.querySelector("summary").getAttribute("aria-label"), "actions");
    assert.deepEqual(menu.querySelectorAll("button").map((node) => node.getAttribute("data-i18n")), ["disableUser", "deleteAccount"]);
  }
});

test("三语双主题的三点名称可访问且自账号限制说明不挤入操作栏", async () => {
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) for (const theme of ["light", "dark"]) {
    const app = await userRuntime({ locale, theme, selfId: "target" });
    const self = app.card(), footer = self.querySelector("footer");
    assert.equal(self.querySelector("details"), null);
    assert.deepEqual(footer.children.map((node) => node.tagName), ["BUTTON", "A"]);
    assert.equal(self.querySelector("small").textContent, app.context.I18n.t("SELF_DISABLE_FORBIDDEN"));
    const summary = app.card("before").querySelector("summary");
    assert.equal(summary.getAttribute("aria-label"), app.context.I18n.t("actions"));
    assert.equal(summary.getAttribute("title"), app.context.I18n.t("actions"));
    assert.equal(app.document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
    assert.equal(app.document.documentElement.dataset.mode, theme);
  }
});

test("卡片三点原生Enter展开、Esc关闭恢复焦点，焦点或指针离开关闭且不抢焦点", async () => {
  const app = await userRuntime(), menu = app.card().querySelector("details"), summary = menu.querySelector("summary");
  summary.focus(); app.enter(summary);
  assert.equal(menu.getAttribute("open"), "");
  app.toggle().focus();
  assert.equal(menu.getAttribute("open"), "");
  const escape = app.dispatch(app.toggle(), "keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(menu.getAttribute("open"), null);
  assert.equal(app.document.activeElement, summary);
  app.enter(summary); app.$("#user-query").focus();
  assert.equal(menu.getAttribute("open"), null);
  assert.equal(app.document.activeElement, app.$("#user-query"));
  summary.focus(); app.enter(summary);
  app.dispatch(app.$("#user-query"), "pointerdown");
  assert.equal(menu.getAttribute("open"), null);
});

test("卡片菜单按真实summary几何上下翻转、左右夹取，短视口内部滚动", async () => {
  for (const dir of ["ltr", "rtl"]) for (const rect of [
    { left: 280, right: 312, top: 200, bottom: 232 },
    { left: 8, right: 40, top: 8, bottom: 40 },
    { left: 144, right: 176, top: 24, bottom: 56 },
  ]) {
    const app = await userRuntime(), menu = app.card().querySelector("details"), summary = menu.querySelector("summary"), popover = menu.querySelector(".card-action-popover");
    app.context.I18n.ctx.dir = dir;
    app.document.documentElement.clientWidth = 320;
    app.context.innerHeight = rect.top === 24 ? 80 : 240;
    summary.rect = rect;
    summary.focus(); app.enter(summary);
    const left = parseFloat(popover.style.left), top = parseFloat(popover.style.top);
    const height = parseFloat(popover.style.maxBlockSize);
    assert.ok(left >= 8 && left + 220 <= 312, `${dir}水平菜单必须夹在视口内`);
    assert.ok(top >= 8 && top + Math.min(80, height) <= app.context.innerHeight - 8);
    if (rect.top === 200) assert.ok(top + 80 <= rect.top, "底行菜单向上展开");
    if (rect.top === 8) assert.equal(top, rect.bottom, "顶行菜单向下展开");
    if (rect.top === 24) assert.ok(height < 80, "短视口限制菜单内部高度");
  }
});

test("卡片菜单处理可视视口偏移、单一展开、内部滚动和外部resize关闭", async () => {
  const app = await userRuntime(), first = app.card("before").querySelector("details"), second = app.card().querySelector("details");
  app.context.visualViewport = { offsetLeft: 40, offsetTop: 80, width: 240, height: 160 };
  const summary = first.querySelector("summary"), popover = first.querySelector(".card-action-popover");
  summary.rect = { left: 256, right: 288, top: 200, bottom: 232 };
  summary.focus(); app.enter(summary);
  assert.ok(parseFloat(popover.style.left) >= 48);
  assert.ok(parseFloat(popover.style.left) + 220 <= 272);
  assert.ok(parseFloat(popover.style.top) >= 88);
  second.setAttribute("open", "");
  assert.equal(first.getAttribute("open"), null);
  assert.equal(second.getAttribute("open"), "");
  app.toggle().focus();
  app.dispatch(second.querySelector(".card-action-popover"), "scroll");
  assert.equal(second.getAttribute("open"), "");
  app.dispatch(app.document.body, "resize");
  assert.equal(second.getAttribute("open"), null);
  assert.equal(app.document.activeElement, second.querySelector("summary"));
  second.setAttribute("open", ""); app.toggle().focus();
  app.dispatch(app.document.body, "scroll");
  assert.equal(second.getAttribute("open"), null);
  assert.equal(app.document.activeElement, second.querySelector("summary"));
  app.context.visualViewport = { offsetLeft: 0, offsetTop: 0, width: 160, height: 120 };
  second.querySelector("summary").rect = { left: 128, right: 160, top: 80, bottom: 112 };
  second.setAttribute("open", "");
  const narrow = second.querySelector(".card-action-popover");
  assert.equal(parseFloat(narrow.style.maxInlineSize), 144);
  assert.equal(parseFloat(narrow.style.left), 8);
  assert.ok(parseFloat(narrow.style.top) >= 8);
});

test("卡片共用footer底部对齐、按钮组末端统一，展开菜单脱离文档流并按RTL逻辑定位", () => {
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  const rule = (selector) => css.split("}").find((block) => block.startsWith(selector + "{")).slice(selector.length + 1);
  assert.match(rule(".cards"), /align-items:stretch/);
  assert.match(rule(".card"), /display:flex;flex-direction:column/);
  for (const value of ["margin-block-start:auto", "align-items:flex-end", "justify-content:flex-end", "flex-shrink:0"]) assert.ok(rule(".card>footer").includes(value));
  assert.doesNotMatch(rule(".card.workspace-card>footer"), /justify-content|align-items/);
  assert.match(rule(".card-action-menu"), /align-self:flex-end/);
  const popover = rule(".card-action-popover");
  assert.match(popover, /position:fixed/);
  assert.match(popover, /max-inline-size:calc\(100vw - var\(--space-4\)\)/);
  assert.match(popover, /overflow-y:auto;overflow-x:hidden/);
  assert.match(popover, /background:var\(--color-menu-bg\)/);
});

test("账户编辑经真实弹窗保存后按稳定ID恢复新编辑按钮，列表重排不影响目标", async () => {
  const app = await userRuntime({ afterList: (_, users) => users.reverse() });
  const original = app.edit();
  original.focus(); app.enter(original);
  await app.submit();
  assert.notEqual(app.edit(), original);
  assert.equal(app.document.activeElement, app.edit());
  assert.equal(app.edit().disabled, false);
  assert.equal(app.calls.filter((call) => call.key === "user").length, 1);
});

test("账户编辑刷新期间主动移至搜索框不被恢复逻辑抢回", async () => {
  const app = await userRuntime({ afterList: (app) => app.$("#user-query").focus() });
  app.edit().focus(); app.enter(app.edit());
  await app.submit();
  assert.equal(app.document.activeElement, app.$("#user-query"));
});

test("账户改名后不再匹配筛选时，编辑焦点安全回搜索入口", async () => {
  const app = await userRuntime();
  app.$("#user-query").value = "target";
  app.dispatch(app.$("#user-search"), "submit");
  app.edit().focus(); app.enter(app.edit());
  app.$("dialog form").elements.namedItem("nickname").value = "renamed";
  app.$("dialog form").elements.namedItem("userName").value = "renamed";
  await app.submit();
  assert.equal(app.card(), undefined);
  assert.equal(app.document.activeElement, app.$("#user-query"));
});

test("账户启用与确认停用重绘后恢复同卡新动作，且不受旧按钮finally影响", async () => {
  for (const disabled of [true, false]) {
    const app = await userRuntime({ disabled });
    const original = app.toggle();
    original.closest("details").setAttribute("open", "");
    original.focus(); app.enter(original);
    assert.equal(original.disabled, true);
    if (!disabled) {
      const confirm = app.$('[data-confirm-action="confirm"]');
      confirm.focus(); app.enter(confirm);
    }
    await settleUsers();
    const current = app.toggle();
    assert.notEqual(current, original);
    assert.equal(current.getAttribute("data-i18n"), disabled ? "disableUser" : "enableUser");
    assert.equal(current.disabled, false);
    assert.equal(current.closest("details").getAttribute("open"), "");
    assert.equal(app.document.activeElement, current);
    assert.equal(original.disabled, false);
  }
});

test("账户启停等待期间主动移至搜索框不抢焦点", async () => {
  for (const disabled of [true, false]) {
    const app = await userRuntime({ disabled, afterPatch: (app) => app.$("#user-query").focus() });
    app.toggle().focus(); app.enter(app.toggle());
    if (!disabled) app.enter(app.$('[data-confirm-action="confirm"]'));
    await settleUsers();
    assert.equal(app.document.activeElement, app.$("#user-query"));
  }
});

test("账户启停更新后脱离筛选时回搜索框，失败和取消不重绘且保留可用入口", async () => {
  const filtered = await userRuntime({ disabled: true, afterPatch: (_, updated) => { updated.userName = updated.nickname = "renamed"; } });
  filtered.$("#user-query").value = "target";
  filtered.dispatch(filtered.$("#user-search"), "submit");
  filtered.toggle().focus(); filtered.enter(filtered.toggle());
  await settleUsers();
  assert.equal(filtered.card(), undefined);
  assert.equal(filtered.document.activeElement, filtered.$("#user-query"));
  const failed = await userRuntime({ disabled: true, afterPatch: () => { throw Error("失败"); } });
  const original = failed.toggle();
  original.focus(); failed.enter(original);
  await settleUsers();
  assert.equal(failed.toggle(), original);
  assert.equal(original.disabled, false);
  assert.equal(failed.document.activeElement, failed.card().querySelector("summary"));
  const cancelled = await userRuntime();
  cancelled.toggle().focus(); cancelled.enter(cancelled.toggle());
  cancelled.enter(cancelled.$('[data-confirm-action="cancel"]'));
  await settleUsers();
  assert.equal(cancelled.calls.filter((call) => call.key === "user").length, 0);
  assert.equal(cancelled.toggle().disabled, false);
  assert.equal(cancelled.document.activeElement, cancelled.card().querySelector("summary"));
});
