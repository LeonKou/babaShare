"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict"), { test } = require("node:test");
const assets = path.join(__dirname, "../web/assets");
class Element {
  constructor(tag = "div") {
    Object.assign(this, { tag, children: [], events: {}, dataset: {}, style: {}, value: "", textContent: "", disabled: false, attrs: {} });
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...items) { this.children.push(...items.filter((item) => item != null)); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attrs[key] = String(value); if (["value", "name", "id"].includes(key)) this[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(key, action) { this.events[key] = action; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get elements() {
    const found = [];
    const walk = (node) => { if (node.name) found.push(node); for (const child of node.children || []) if (typeof child === "object") walk(child); };
    walk(this); found.namedItem = (name) => found.find((node) => node.name === name); return found;
  }
}
function runtime(address, fetcher) {
  const nodes = new Map(), requests = [], replacements = [];
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const initial = new URL(address);
  const location = { href: initial.href, hash: initial.hash, origin: initial.origin, protocol: initial.protocol, pathname: initial.pathname,
    replace(url) { replacements.push(url); }, reload() {} };
  const document = { title: "", documentElement: { lang: "zh-CN", dir: "ltr", dataset: { mode: "dark", accent: "blue" } }, body: new Element("body"),
    createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: String,
    querySelector: (selector) => selector === 'script[src$="common.js"]' ? { src: initial.origin + "/baba-share/assets/common.js" } : get(selector), querySelectorAll: () => [] };
  const context = { URL, console, setTimeout, clearTimeout, queueMicrotask, location, document,
    history: { state: null, replaceState(_, __, value) { const url = new URL(value); location.href = url.href; location.hash = url.hash; } },
    FormData: class { constructor(form) { return form.elements.filter((node) => node.name && !node.disabled).map((node) => [node.name, node.value]); } },
    fetch: async (url, options) => { requests.push({ url: String(url), options }); return fetcher(url, options); },
    addEventListener() {}, localStorage: { getItem() { return null; }, setItem() {} } };
  context.window = context;
  vm.createContext(context);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(assets, file), "utf8"), context);
  load("i18n.js"); load("common.js"); load("api.js");
  return { context, get, load, requests, replacements };
}
const response = (status, data) => ({ status, ok: status < 400, json: async () => data });
const token = "a".repeat(43), origin = "http://127.0.0.1:8080";
const address = (name, fragment = "#invite=" + token) => origin + "/baba-share/" + name + fragment;

async function unitCases() {
  for (const bad of ["", "#invite=" + "a".repeat(42), "#invite=" + "a".repeat(44), "#invite=" + token + "&returnUrl=https://evil.invalid", "#invite=" + "a".repeat(42) + "/", "#returnUrl=https://evil.invalid"]) {
    const app = runtime(address("invite.html", bad), async () => { throw Error("非法token不得请求"); });
    await app.load("invite.js");
    assert.equal(app.requests.length, 0);
    assert.equal(app.context.location.hash, "");
    assert.equal(app.replacements.length, 0);
  }
  const anonymous = runtime(address("invite.html"), async () => response(401, { status: "AUTH_REQUIRED" }));
  await anonymous.load("invite.js");
  assert.equal(anonymous.context.location.hash, "");
  assert.deepEqual(anonymous.replacements, [address("auth.html")]);
  assert.equal(anonymous.requests.length, 1);
  assert.equal(anonymous.requests[0].options.method, "POST");
  assert.equal(JSON.parse(anonymous.requests[0].options.body).token, token);
  for (const [status, data] of [[404, { status: "INVITATION_INVALID" }], [403, { status: "PERMISSION_DENIED" }]]) {
    const app = runtime(address("invite.html"), async () => response(status, data));
    await app.load("invite.js");
    assert.equal(app.replacements.length, 0);
    assert.equal(app.get("#invite-status").attrs["aria-busy"], "false");
  }
  const auth = runtime(address("auth.html?mode=register&returnUrl=https://evil.invalid"), async (url) => String(url).endsWith("/visitor/install/detail")
    ? response(200, { setupRequired: false, registrationEnabled: true }) : response(200, {}));
  await auth.load("auth.js");
  assert.equal(auth.context.location.hash, "");
  assert.equal(auth.get("#auth-switch").children.length, 0);
  auth.get("#auth-form").append(auth.get("#auth-fields"));
  for (const input of auth.get("#auth-form").elements) input.value = input.name === "password" ? "123456" : "existing";
  await auth.get("#auth-form").events.submit({ preventDefault() {} });
  assert(auth.requests.at(-1).url.endsWith("/visitor/session"));
  assert.equal(auth.context.location.href, address("invite.html"));
  assert.equal(auth.get("#auth-submit").disabled, false);
  const failed = runtime(address("auth.html"), async (url) => String(url).endsWith("/visitor/install/detail")
    ? response(200, { setupRequired: false, registrationEnabled: true }) : response(401, { status: "LOGIN_FAILED" }));
  await failed.load("auth.js");
  failed.get("#auth-form").append(failed.get("#auth-fields"));
  for (const input of failed.get("#auth-form").elements) input.value = input.name === "password" ? "123456" : "missing";
  await failed.get("#auth-form").events.submit({ preventDefault() {} });
  assert.equal(failed.replacements.length, 0);
  assert.equal(failed.requests.length, 2);
  assert(failed.requests.at(-1).url.endsWith("/visitor/session"));
  assert.equal(failed.get("#auth-submit").disabled, false);
}

if (process.argv.includes("--http")) {
  (async () => {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const fetcher = (url, options) => fetch(url, { ...options, headers: { ...options.headers, Cookie: input.cookie, Origin: input.origin } });
    const app = runtime(input.origin + "/baba-share/invite.html#invite=" + input.token, fetcher);
    await app.load("invite.js");
    assert.deepEqual(app.replacements, [input.origin + "/baba-share/workspace.html?workspaceId=" + input.workspaceId]);
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].options.method, "POST");
    const missing = runtime(input.origin + "/baba-share/invite.html#invite=" + input.token, (url, options) => fetch(url, options));
    await missing.load("invite.js");
    assert.deepEqual(missing.replacements, [input.origin + "/baba-share/auth.html#invite=" + input.token]);
    let sessionCookie = "";
    const auth = runtime(missing.replacements[0], async (url, options) => {
      const result = await fetch(url, { ...options, headers: { ...options.headers, Origin: input.origin } });
      const cookie = result.headers.get("set-cookie");
      if (cookie) sessionCookie = cookie.split(";", 1)[0];
      return result;
    });
    await auth.load("auth.js");
    auth.get("#auth-form").append(auth.get("#auth-fields"));
    for (const field of auth.get("#auth-form").elements)
      field.value = field.name === "password" ? "qa-isolated-password-123" : "qa-peer";
    await auth.get("#auth-form").events.submit({ preventDefault() {} });
    assert(sessionCookie);
    assert.equal(auth.context.location.href, input.origin + "/baba-share/invite.html#invite=" + input.token);
    const resumed = runtime(auth.context.location.href, (url, options) => fetch(url,
      { ...options, headers: { ...options.headers, Origin: input.origin, Cookie: sessionCookie } }));
    await resumed.load("invite.js");
    assert.deepEqual(resumed.replacements, [input.origin + "/baba-share/workspace.html?workspaceId=" + input.workspaceId]);
    assert.equal(resumed.requests.length, 1);
    await unitCases();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  test("真实邀请与登录脚本严格白名单、安全401续接、固定回跳、失败恢复且不注册", unitCases);
  test("邀请新文案三语齐全且不覆盖accent白名单", () => {
    const app = runtime(address("invite.html"), async () => response(200, {}));
    for (const locale of ["zh-CN", "en-US", "ar-SA"]) {
      app.context.I18n.apply({ locale, theme: "dark", accent: "purple" });
      assert.equal(app.context.I18n.ctx.accent, "purple");
      for (const key of ["inviteGenerate", "inviteManage", "inviteCreated", "inviteOnce", "inviteDeleteConfirm", "inviteLoginHint", "inviteJoining", "inviteJoined", "INVITATION_INVALID", "INVITATION_ALREADY_CREATED", "shareDeleteConfirm", "mcpDeleteConfirm", "breadcrumbs"])
        assert.notEqual(app.context.I18n.t(key), key);
    }
  });
}
