"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict"), { test } = require("node:test");
const assets = path.join(__dirname, "../web/assets");
class Element {
  constructor() {
    Object.assign(this, { children: [], events: {}, dataset: {}, style: {}, value: "", textContent: "", disabled: false, attrs: {}, validity: { valid: true } });
    this.classList = { add() {}, remove() {} };
  }
  append(...items) {
    this.children.push(...items.filter((item) => item != null));
    for (const item of items) {
      if (item && typeof item === "object") item.parentNode = this;
      if (item?.attrs?.selected !== undefined) this.value = item.value;
    }
  }
  replaceWith(node) {
    const parent = this.parentNode;
    parent.children.splice(parent.children.indexOf(this), 1, node);
    node.parentNode = parent;
    this.parentNode = null;
  }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attrs[key] = String(value); if (["value", "name", "id"].includes(key)) this[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(key, action) { this.events[key] = action; }
  removeEventListener(key, action) { if (this.events[key] === action) delete this.events[key]; }
  contains(node) { return this === node || this.children.some((child) => child?.contains?.(node)); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  reset() { this.elements.forEach((item) => item.value = ""); }
  scrollIntoView() {}
  focus() { this.focused = true; }
  get elements() {
    const result = [];
    const walk = (node) => { if (node.name) result.push(node); for (const child of node.children || []) if (typeof child === "object") walk(child); };
    walk(this); result.namedItem = (name) => result.find((item) => item.name === name); return result;
  }
}
function runtime(page, fetcher, origin = "https://share.example.com") {
  const nodes = new Map(), calls = [], events = {}, replacements = [], storage = [];
  const initial = new URL(origin + "/baba-share/" + page);
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const location = { href: initial.href, hash: initial.hash, origin: initial.origin, protocol: initial.protocol, pathname: initial.pathname,
    replace(url) { replacements.push(url); } };
  const document = { title: "", documentElement: { lang: "zh-CN", dir: "ltr", dataset: { mode: "dark", accent: "blue" } }, body: new Element(),
    createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: String,
    querySelector: (selector) => selector === 'script[src$="common.js"]' ? { src: initial.origin + "/baba-share/assets/common.js" } : get(selector), querySelectorAll: () => [] };
  const context = { URL, console, setTimeout, clearTimeout, location, document,
    FormData: class { constructor(form) { return form.elements.map((node) => [node.name, node.value]); } },
    history: { state: null, replaceState(_, __, value) { const clean = new URL(value); location.href = clean.href; location.hash = clean.hash; } },
    addEventListener(name, action) { events[name] = action; },
    localStorage: { getItem() { return null; }, setItem(...args) { storage.push(args); } },
    sessionStorage: { setItem() { throw Error("令牌不得持久化"); } },
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return fetcher(url, options); } };
  context.window = context;
  vm.createContext(context);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(assets, file), "utf8"), context);
  const response = (status, data) => ({ status, ok: status < 400, json: async () => data });
  return { context, load, get, calls, events, replacements, storage, response };
}
const result = (status, data) => ({ status, ok: status < 400, json: async () => data });
const token = "a".repeat(43);

test("激活凭据立即清地址、GET不调用激活、确认密码后POST自动登录固定首页", async () => {
  const app = runtime("activate.html#activation=" + token, async () => result(200, {}));
  app.load("activate.js");
  assert.equal(app.context.location.hash, "");
  assert.equal(app.calls.length, 0);
  app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  app.get("#activation-form").append(app.get("#activation-fields"));
  app.events.DOMContentLoaded();
  const form = app.get("#activation-form");
  form.elements.namedItem("password").value = "123456";
  form.elements.namedItem("passwordConfirm").value = "different";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 0);
  assert.equal(form.elements.namedItem("passwordConfirm").focused, true);
  form.elements.namedItem("passwordConfirm").value = "123456";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 1);
  assert(app.calls[0].url.endsWith("/visitor/email/activation"));
  assert.equal(app.calls[0].options.method, "POST");
  assert.equal(JSON.parse(app.calls[0].options.body).token, token);
  assert.deepEqual(app.replacements, ["https://share.example.com/baba-share/index.html"]);
  assert.equal(form.elements.namedItem("password").value, "");
  assert.equal(form.elements.namedItem("passwordConfirm").value, "");
  assert.equal(app.get("#activation-status").textContent, app.context.I18n.t("activationCompleted"));
  assert.equal(app.storage.length, 0);
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 1);
});

test("激活响应不能改变固定首页导航，成功清理密码及凭据", async () => {
  const app = runtime("activate.html?redirect=https://evil.invalid#activation=" + token,
    async () => result(200, { redirect: "https://evil.invalid", token: "不得持久化" }));
  app.load("activate.js"); app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  app.get("#activation-form").append(app.get("#activation-fields"));
  app.events.DOMContentLoaded();
  const form = app.get("#activation-form");
  for (const name of ["password", "passwordConfirm"]) form.elements.namedItem(name).value = "123456";
  await form.events.submit({ preventDefault() {} });
  assert.deepEqual(app.replacements, ["https://share.example.com/baba-share/index.html"]);
  assert.equal(app.storage.length, 0);
  for (const name of ["password", "passwordConfirm"]) assert.equal(form.elements.namedItem(name).value, "");
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 1);
});

test("激活失败不导航，显示错误并允许原凭据重试", async () => {
  let attempts = 0;
  const app = runtime("activate.html#activation=" + token, async () => ++attempts === 1
    ? result(500, { status: "INTERNAL_ERROR" }) : result(200, {}));
  app.load("activate.js"); app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  app.get("#activation-form").append(app.get("#activation-fields"));
  app.events.DOMContentLoaded();
  const form = app.get("#activation-form");
  for (const name of ["password", "passwordConfirm"]) form.elements.namedItem(name).value = "123456";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.replacements.length, 0);
  assert.equal(app.get("#activation-submit").disabled, false);
  assert.equal(form.getAttribute("aria-busy"), "false");
  assert.equal(app.storage.length, 0);
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 2);
  assert.equal(JSON.parse(app.calls[1].options.body).token, token);
  assert.deepEqual(app.replacements, ["https://share.example.com/baba-share/index.html"]);
});

test("离开激活页立即清空密码和内存凭据，恢复后不能提交旧令牌", async () => {
  const app = runtime("activate.html#activation=" + token, async () => { throw Error("不得请求"); });
  app.load("activate.js"); app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  app.get("#activation-form").append(app.get("#activation-fields"));
  app.events.DOMContentLoaded();
  const form = app.get("#activation-form");
  form.elements.namedItem("password").value = "123456";
  form.elements.namedItem("passwordConfirm").value = "123456";
  app.events.pagehide();
  assert.equal(form.elements.namedItem("password").value, "");
  form.elements.namedItem("password").value = "123456";
  form.elements.namedItem("passwordConfirm").value = "123456";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 0);
});

test("邮箱登录支持254字符及加号而不扩大普通注册账号规则", async () => {
  const email = "a+" + "b".repeat(62) + "@" + "c".repeat(63) + "." + "d".repeat(63) + "." + "e".repeat(61);
  assert.equal(email.length, 254);
  for (const name of [email, email + "x"]) {
    const app = runtime("auth.html", async (url) => String(url).endsWith("/visitor/install/detail")
      ? result(200, { setupRequired: false, registrationEnabled: true }) : result(200, {}));
    app.load("i18n.js"); app.load("common.js"); app.load("api.js");
    app.get("#auth-form").append(app.get("#auth-fields"));
    await app.load("auth.js");
    const form = app.get("#auth-form");
    form.elements.namedItem("userName").value = name;
    form.elements.namedItem("password").value = "123456";
    await form.events.submit({ preventDefault() {} });
    assert.equal(app.calls.length, name.length === 254 ? 2 : 1);
    if (name.length === 254) assert(app.calls.at(-1).url.endsWith("/visitor/session"));
  }
});

test("非法激活fragment不请求、不持久化、不采用任意回跳", () => {
  for (const fragment of ["", "#activation=x", "#activation=" + token + "&returnUrl=https://evil.invalid"]) {
    const app = runtime("activate.html" + fragment, async () => { throw Error("不得请求"); });
    app.load("activate.js");
    assert.equal(app.context.location.hash, "");
    app.load("i18n.js"); app.load("common.js"); app.load("api.js");
    app.get("#activation-form").append(app.get("#activation-fields"));
    app.events.DOMContentLoaded();
    assert.equal(app.calls.length, 0);
    assert.equal(app.get("#activation-submit").disabled, true);
    assert.equal(app.replacements.length, 0);
    assert.equal(app.storage.length, 0);
  }
});

test("邮箱模式注册收集独立账号、邮箱及名称并发送邮件，不请求旧注册或创建会话", async () => {
  const app = runtime("auth.html?mode=register", async (url) => String(url).endsWith("/visitor/install/detail")
    ? result(200, { setupRequired: false, registrationEnabled: true, emailRegistrationEnabled: true }) : result(200, {}));
  app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  app.get("#auth-form").append(app.get("#auth-fields"));
  await app.load("auth.js");
  const form = app.get("#auth-form");
  assert(form.elements.namedItem("email"));
  assert.equal(form.elements.namedItem("password"), undefined);
  form.elements.namedItem("userName").value = "separate-account";
  form.elements.namedItem("email").value = "user@example.com";
  form.elements.namedItem("nickname").value = "新成员";
  await form.events.submit({ preventDefault() {} });
  assert(app.calls.at(-1).url.endsWith("/visitor/email/registration"));
  assert.equal(app.context.location.href, "https://share.example.com/baba-share/auth.html?mode=register");
  assert.equal(app.get("#auth-submit").disabled, false);
  assert.equal(app.calls.length, 2);
});

test("账户编辑包含完整业务字段、只读审计及三语校验，提交不含技术字段", async () => {
  const user = { id: "user-id", userName: "old+name@example.com", nickname: "待编辑", role: "editor", isDisabled: false, createTime: 1, updateTime: 2 };
  const app = runtime("users.html", async (url) => String(url).endsWith("/session/detail") ? result(200, { role: "admin" }) : result(200, [user]));
  app.context.AbortController = AbortController;
  app.load("i18n.js"); app.load("common.js"); app.load("api.js"); app.load("pagination.js");
  app.context.UI.page = () => ({ ready: Promise.resolve(), complete: async () => {}, fail() {} });
  let dialog;
  app.context.UI.formDialog = async (title, fields, submit, options) => { dialog = { title, fields, submit, options }; return null; };
  await app.load("users.js");
  const source = fs.readFileSync(path.join(assets, "users.js"), "utf8");
  app.context.formDialog = app.context.UI.formDialog;
  app.context.$ = app.context.UI.$;
  app.context.me = { id: "other-admin" };
  app.context.roles = () => ["editor", "admin"].map((value) => ({ value, label: app.context.I18n.t(value) }));
  vm.runInContext(source.slice(source.indexOf("  async function editUser("), source.indexOf("  async function toggleUser(")), app.context);
  const requests = [];
  app.context.API = async (route, options) => { requests.push({ route, ...options }); return {}; };
  const email = "a+" + "b".repeat(62) + "@" + "c".repeat(63) + "." + "d".repeat(63) + "." + "e".repeat(61);
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) {
    app.context.I18n.apply({ locale, theme: "dark" });
    await app.context.editUser(user);
    assert.deepEqual(Array.from(dialog.fields, (field) => field.name), ["userName", "nickname", "email", "emailVerified", "role", "isDisabled", "password", "fileCountLimitMode", "fileCountLimit", "storageBytesLimitMode", "storageBytesLimit", "storageBytesLimitUnit", "createTime", "updateTime"]);
    assert.deepEqual(Array.from(dialog.fields.filter((field) => field.group), (field) => field.group), ["userAccountDetails", "userSecurity", "quotaFiles", "quotaStorage", "userAudit"]);
    assert.equal(dialog.options.dirty, true);
    assert(dialog.options.intro);
    const byName = (name) => dialog.fields.find((field) => field.name === name);
    for (const name of ["createTime", "updateTime"]) { assert.equal(byName(name).readOnly, true); assert.equal(byName(name).className, "num"); }
    assert.equal(byName("email").readOnly, true);
    assert.equal(byName("emailVerified").readOnly, true);
    assert.equal(byName("password").value, undefined);
    assert.equal(byName("password").required, undefined);
    assert.equal(byName("password").type, "password");
    assert.equal(byName("userName").value, user.userName);
    for (const valid of [user.userName, "ordinary_user", email]) assert.equal(byName("userName").validator(valid), "");
    for (const invalid of ["ab", "a+bad", "a+@invalid", "a".repeat(65), email + "x", "bad name"]) assert.equal(byName("userName").validator(invalid), app.context.I18n.t("userAccountError"));
    for (const valid of ["", "123456", "x".repeat(256)]) assert.equal(byName("password").validator(valid), "");
    for (const invalid of ["12345", "x".repeat(257)]) assert.equal(byName("password").validator(invalid), app.context.I18n.t("passwordError"));
    assert.equal(byName("nickname").validator("x".repeat(65)), app.context.I18n.t("userNicknameError"));
    assert.equal(byName("nickname").validator("   "), app.context.I18n.t("requiredError"));
    assert.equal(app.context.UI.errorText({ status: "SELF_DISABLE_FORBIDDEN" }), app.context.I18n.t("SELF_DISABLE_FORBIDDEN"));
    for (const field of dialog.fields) { assert.notEqual(app.context.I18n.t(field.key), app.context.I18n.t("unknownError")); if (field.group) assert.notEqual(app.context.I18n.t(field.group), app.context.I18n.t("unknownError")); }
    assert.equal(app.context.UI.errorText({ status: "USER_EXISTS" }), app.context.I18n.t("userAccountExists"));
    await dialog.submit({ fileCountLimitMode: "inherit", storageBytesLimitMode: "inherit", userName: email, nickname: "编辑后", role: "editor", isDisabled: "true", password: "", createTime: "tampered", id: "tampered", password_hash: "secret" });
    assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1))), { route: "user", method: "PATCH", body: { fileCountLimit: null, storageBytesLimit: null, id: user.id, userName: email, nickname: "编辑后", role: "editor", isDisabled: true } });
    await dialog.submit({ fileCountLimitMode: "inherit", storageBytesLimitMode: "inherit", userName: "new-name", nickname: "新名称", role: "admin", isDisabled: "false", password: "123456" });
    assert.equal(requests.at(-1).body.password, "123456");
    assert.equal(requests.at(-1).body.isDisabled, false);
    app.context.me = { id: user.id };
    await app.context.editUser(user);
    const selfStatus = dialog.fields.find((field) => field.name === "isDisabled");
    assert.equal(selfStatus.readOnly, true);
    assert.equal(selfStatus.value, app.context.I18n.t("enabled"));
    assert.equal(selfStatus.hint, app.context.I18n.t("SELF_DISABLE_FORBIDDEN"));
    await dialog.submit({ fileCountLimitMode: "inherit", storageBytesLimitMode: "inherit", userName: user.userName, nickname: user.nickname, role: "editor", isDisabled: "true" });
    assert.equal(requests.at(-1).body.isDisabled, false);
    app.context.me = { id: "other-admin" };
  }
  assert.equal(app.context.document.documentElement.dir, "rtl");
});

test("共享表单只读字段呈现文字并排除提交值，分组语义不改变普通表单", async () => {
  const app = runtime("users.html", async () => result(200, {}));
  app.load("i18n.js"); app.load("common.js");
  const form = new Element();
  const text = app.context.UI.field(form, { key: "created", name: "createTime", value: "2026-11-02 10:00:00", readOnly: true, className: "num" });
  assert.equal(text.textContent, "2026-11-02 10:00:00");
  assert.equal(text.getAttribute("aria-labelledby"), "field-createTime-label");
  assert.equal(text.className, "num");
  assert.equal(form.elements.length, 0);
  const nickname = app.context.UI.field(form, { key: "displayName", name: "nickname", required: true });
  assert.equal(form.elements.length, 1);
  assert.equal(nickname.getAttribute("required"), "");
  assert.equal(nickname.validate(), false);
  nickname.value = "合规名称";
  assert.equal(nickname.validate(), true);
  app.context.document.createElement = (tag) => {
    const node = new Element();
    node.tagName = tag;
    node.addEventListener = (name, action) => {
      const previous = node.events[name];
      node.events[name] = (...args) => { previous?.(...args); return action(...args); };
    };
    node.showModal = () => { node.open = true; };
    node.close = () => { node.open = false; return Promise.resolve().then(() => node.events.close?.()); };
    node.remove = () => {};
    return node;
  };
  let submitted;
  const resultPromise = app.context.UI.formDialog("编辑", [
    { group: "userAccountDetails", key: "displayName", name: "nickname", value: "名称" },
    { group: "userAudit", key: "created", name: "createTime", value: "审计时间", readOnly: true },
  ], async (values) => { submitted = values; return true; });
  const node = app.context.document.body.children.at(-1), groupedForm = node.children.find((child) => child.tagName === "form");
  const groups = groupedForm.children.find((child) => child.className === "form-drawer-body").children.filter((child) => child.tagName === "fieldset");
  assert.equal(groups.length, 2);
  assert(groups.every((group) => group.children[0].tagName === "legend"));
  await groupedForm.events.submit({ preventDefault() {} });
  assert.equal(await resultPromise, true);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), { nickname: "名称" });
  let attempts = 0;
  const states = [];
  app.context.AppPage = { setDirty(value) { states.push(value); } };
  const passwordResult = app.context.UI.formDialog("密码", [{ key: "newPassword", name: "password", type: "password" }],
    async () => { if (++attempts === 1) throw Object.assign(new Error(), { status: "USER_EXISTS" }); return true; }, { dirty: true });
  const passwordDialog = app.context.document.body.children.at(-1), passwordForm = passwordDialog.children.find((child) => child.tagName === "form");
  const input = passwordForm.elements.namedItem("password");
  assert.equal(input.getAttribute("autocomplete"), "new-password");
  input.value = "draft-password";
  passwordForm.events.input();
  assert.equal(states.at(-1), true);
  await passwordForm.events.submit({ preventDefault() {} });
  assert.equal(input.value, "draft-password");
  assert.equal(states.at(-1), true);
  await passwordForm.events.submit({ preventDefault() {} });
  assert.equal(await passwordResult, true);
  assert.equal(input.value, "");
  assert.equal(states.at(-1), false);
  const cancelled = app.context.UI.formDialog("取消密码", [{ key: "newPassword", name: "password", type: "password" }], async () => true);
  const cancelDialog = app.context.document.body.children.at(-1), cancelForm = cancelDialog.children.find((child) => child.tagName === "form");
  const cancelledInput = cancelForm.elements.namedItem("password");
  cancelledInput.value = "cancelled-password";
  cancelDialog.close();
  assert.equal(await cancelled, null);
  assert.equal(cancelledInput.value, "");
  const dirtyResult = app.context.UI.formDialog("未保存密码", [{ key: "newPassword", name: "password", type: "password" }], async () => true, { dirty: true });
  const dirtyDialog = app.context.document.body.children.at(-1), dirtyForm = dirtyDialog.children.find((child) => child.tagName === "form");
  const draft = dirtyForm.elements.namedItem("password");
  draft.value = "unsaved-password";
  dirtyForm.events.input();
  let prevented = false;
  dirtyDialog.events.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const decline = app.context.document.body.children.at(-1);
  decline.children.find((child) => child.className === "actions").children[0].events.click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(draft.value, "unsaved-password");
  assert.equal(states.at(-1), true);
  const cancelAction = dirtyForm.children[0].children.at(-1).children[0].events.click();
  const confirm = app.context.document.body.children.at(-1);
  confirm.children.find((child) => child.className === "actions").children[1].events.click();
  await cancelAction;
  assert.equal(await dirtyResult, null);
  assert.equal(draft.value, "");
  assert.equal(states.at(-1), false);
});

test("本人账户列表不提供禁用按钮并展示原因", async () => {
  const self = { id: "self-admin", nickname: "本人", userName: "admin", role: "admin", isDisabled: false, createTime: 1 };
  const other = { ...self, id: "other-admin", nickname: "其他管理员", userName: "other" };
  const app = runtime("users.html", async (url) => String(url).endsWith("/session/detail") ? result(200, self) : result(200, [self, other]));
  app.context.AbortController = AbortController;
  app.load("i18n.js"); app.load("common.js"); app.load("api.js"); app.load("pagination.js");
  app.context.UI.page = () => ({ ready: Promise.resolve(), complete: async () => {}, fail() {} });
  await app.load("users.js");
  const cards = app.get("#user-cards").children;
  const selfNotice = cards[0].children.at(-2);
  assert.equal(selfNotice.textContent, app.context.I18n.t("SELF_DISABLE_FORBIDDEN"));
  assert.equal(selfNotice.events.click, undefined);
  const selfActions = cards[0].children.at(-1);
  const otherActions = cards[1].children.at(-1);
  const selfButtons = selfActions.children.flatMap((node) => [node, ...node.children]);
  for (const key of ["disableUser", "deleteAccount"]) assert.equal(selfButtons.some((node) => node.attrs?.["data-i18n"] === key), false);
  const menu = otherActions.children.at(-1);
  assert.equal(menu.className, "card-action-menu");
  assert.equal(menu.children[0].attrs["aria-label"], app.context.I18n.t("actions"));
  assert.equal(menu.children[0].textContent, "…");
  for (const key of ["disableUser", "deleteAccount"]) {
    const control = menu.children[1].children.find((node) => node.attrs?.["data-i18n"] === key);
    assert.ok(control, key);
    assert.equal(typeof control.events.click, "function");
  }
  for (const actions of [selfActions, otherActions]) assert.ok(actions.children.some((node) => node.attrs.href && node.textContent === app.context.I18n.t("userWorkspaces")));
});

test("用户管理仅请求身份与账户列表，不依赖注册或邮件设置接口", async () => {
  const app = runtime("users.html", async (url) => {
    if (String(url).endsWith("/session/detail")) return result(200, { id: "admin", nickname: "管理员" });
    if (String(url).endsWith("/user/list")) return result(200, [{ id: "user", nickname: "正常账户", userName: "tester", role: "editor", createTime: 1 }]);
    throw Error("不得请求设置");
  });
  app.context.AbortController = AbortController;
  app.load("i18n.js"); app.load("common.js"); app.load("api.js"); app.load("pagination.js");
  app.context.UI.page = () => ({ ready: Promise.resolve(), complete: async () => {}, fail() {} });
  await app.load("users.js");
  assert.equal(app.get("#user-cards").children.length, 1);
  assert.equal(app.calls.length, 2);
  assert.equal(app.get("#user-status").textContent, "");
});

async function settingsRuntime({ patchGate = null, mailStatus = 200, role = "admin", patchStatus = 200, registrationEnabled = false, emailRegistrationEnabled = false, origin = "https://share.example.com", siteOrigin = "http://share.example.com:8080" } = {}) {
  const initial = { registrationEnabled, emailRegistrationEnabled };
  const mail = { host: "smtp.example.com", port: 465, security: "ssl", username: "sender", fromAddress: "sender@example.com", fromName: "测试", siteOrigin, activationHours: 24, hasPassword: true };
  const app = runtime("settings.html", async (url, options) => {
    if (String(url).endsWith("/session/detail")) return result(200, { role });
    if (String(url).endsWith("/setting/detail")) return result(200, initial);
    if (String(url).endsWith("/mail-setting/detail")) return result(mailStatus, mailStatus === 200 ? mail : { status: mailStatus === 404 ? "ROUTE_NOT_EXIST" : "PERMISSION_DENIED" });
    if (patchGate) await patchGate;
    return result(patchStatus, patchStatus === 200 ? { ...initial, ...JSON.parse(options.body) } : { status: "MAIL_NOT_CONFIGURED" });
  }, origin);
  app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  const bridge = { ready: Promise.resolve(), complete: async () => {}, fail() {}, dirty: false, setDirty(value) { this.dirty = value; } };
  app.context.UI.page = () => bridge;
  app.context.UI.confirm = async () => true;
  const mailFields = app.get("#registration-mail-fields");
  mailFields.append(app.get("#smtp-fields"), app.get("#smtp-clear-password"), app.get("#activation-fields"));
  app.get("#email-registration-row").append(app.get("#email-registration-toggle"));
  app.get("#registration-form").append(app.get("#registration-toggle"), app.get("#email-registration-row"), mailFields);
  await app.load("settings.js");
  return { ...app, bridge };
}

test("邮件配置不渲染站点来源输入或校验，常驻自动识别提示提供三语文案", async () => {
  const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true });
  const form = app.get("#registration-form");
  assert.deepEqual(form.elements.filter((node) => node.name).map((node) => node.name),
    ["host", "port", "security", "username", "password", "fromAddress", "fromName", "activationHours"]);
  assert.equal(form.elements.namedItem("siteOrigin"), undefined);
  const html = fs.readFileSync(path.join(assets, "../settings.html"), "utf8");
  assert.match(html, /<p class="form-note" data-i18n="siteOriginHint">[^<]+<\/p>/);
  assert.doesNotMatch(html, /<(?:input|select|textarea)\b[^>]*(?:name|id)="(?:field-)?siteOrigin"/);
  for (const [locale, text] of [
    ["zh-CN", "浏览器发送邮件时，服务端优先使用本次访问地址生成链接。保存配置会自动保存当前地址，供无浏览器来源的请求兜底；请使用用户可访问的地址，公网须使用 HTTPS。"],
    ["en-US", "For browser email requests, the server prefers the current request origin. Saving settings also stores the current address as a fallback for requests without a browser origin. Use an address accessible to users and HTTPS for public access."],
    ["ar-SA", "لطلبات البريد من المتصفح، يفضّل الخادم عنوان الطلب الحالي. يحفظ الإعداد أيضًا العنوان الحالي كبديل للطلبات دون مصدر متصفح. استخدم عنوانًا متاحًا للمستخدمين وHTTPS للوصول العام."],
  ]) {
    app.context.I18n.apply({ locale });
    assert.equal(app.context.I18n.t("siteOriginHint"), text);
    assert.equal(app.bridge.dirty, false);
  }
  assert.equal(app.calls.length, 3);
});

test("真实VM自动保存当前Origin作为兜底，浏览器发信仍由后端优先使用实时Origin", async () => {
  for (const origin of ["https://share.example.com", "https://mail.example.com:8443", "http://share.example.com:18080"]) {
    for (const mode of ["enable", "reopen", "edit"]) {
      const app = await settingsRuntime({ origin, siteOrigin: "", registrationEnabled: mode !== "reopen", emailRegistrationEnabled: mode !== "enable" });
      const form = app.get("#registration-form");
      if (mode === "enable") {
        const email = app.get("#email-registration-toggle"); email.checked = true; email.events.change();
      } else if (mode === "reopen") {
        const registration = app.get("#registration-toggle"); registration.checked = true; registration.events.change();
      } else {
        form.elements.namedItem("fromName").value = "新发件名称"; form.events.input();
      }
      await form.events.submit({ preventDefault() {} });
      assert.equal(app.calls.length, 4);
      const body = JSON.parse(app.calls.at(-1).options.body);
      assert.equal(body.mailSettings.siteOrigin, origin);
      assert.equal(body.mailSettings.password, "");
      assert.equal(app.bridge.dirty, false);
      assert.equal(form.elements.namedItem("password").value, "");
      await form.events.submit({ preventDefault() {} });
      assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), {});
    }
  }
});

test("来源与旧值不同不会独立触发邮件保存，关闭总注册或邮箱只提交开关", async () => {
  for (const siteOrigin of ["", "http://share.example.com:8080"]) {
    for (const selector of [null, "#registration-toggle", "#email-registration-toggle"]) {
      const app = await settingsRuntime({ origin: "https://mail.example.com:8443", siteOrigin, registrationEnabled: true, emailRegistrationEnabled: true });
      if (selector) { app.get(selector).checked = false; app.get(selector).events.change(); }
      else assert.equal(app.bridge.dirty, false);
      app.context.UI.validate = () => { throw Error("来源差异或单关不得校验邮件"); };
      await app.get("#registration-form").events.submit({ preventDefault() {} });
      const expected = selector ? { [selector === "#registration-toggle" ? "registrationEnabled" : "emailRegistrationEnabled"]: false } : {};
      assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), expected);
      assert.equal(app.bridge.dirty, false);
    }
  }
});

test("仅开放普通注册不因自动来源差异提交邮件配置", async () => {
  const app = await settingsRuntime({ origin: "https://mail.example.com:8443", siteOrigin: "" });
  const registration = app.get("#registration-toggle"); registration.checked = true; registration.events.change();
  app.context.UI.validate = () => { throw Error("普通注册不得校验邮件"); };
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { registrationEnabled: true });
  assert.equal(app.get("#email-registration-toggle").checked, false);
});

test("设置页以紧凑语义开关和独立原生折叠提供配置入口", () => {
  const html = fs.readFileSync(path.join(assets, "../settings.html"), "utf8");
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  assert.equal((html.match(/type="checkbox" role="switch"/g) || []).length, 2);
  assert.match(html, /<details id="registration-mail-fields"[^>]*hidden>/);
  assert.match(html, /<div id="email-registration-row" class="settings-row" hidden>/);
  assert.match(html, /id="registration-toggle"[^>]*aria-controls="email-registration-row registration-mail-fields"/);
  assert.match(css, /#registration-form \.settings-row\[hidden\]\{display:none\}/);
  const summary = html.match(/<summary>([\s\S]*?)<\/summary>/)[1];
  assert.doesNotMatch(summary, /<input|<button/);
  for (const key of ["mailSettings", "smtpServer", "activationSettings"]) assert(summary.includes(`data-i18n="${key}"`));
  assert.doesNotMatch(html, /id="email-registration-toggle"[^>]*aria-expanded/);
  assert.match(css, /#registration-form \.settings-switch>\.settings-control-visual\{inline-size:32px;block-size:20px/);
  assert.match(css, /#registration-form \.settings-checkbox>\.settings-control-visual\{inline-size:16px;block-size:16px/);
  assert.match(css, /#registration-form \.settings-control\{[^}]*inline-size:40px;block-size:40px/);
  assert.match(css, /html\[dir="rtl"\] #registration-form \.settings-mail:not\(\[open\]\)/);
});

test("邮件配置折叠仅改变布局，不改开关、不提交、不标记草稿", async () => {
  const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true });
  const details = app.get("#registration-mail-fields"), email = app.get("#email-registration-toggle");
  const form = app.get("#registration-form"), password = form.elements.namedItem("password");
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  assert.equal(app.bridge.dirty, false);
  for (const open of [false, true, false]) {
    details.open = open;
    details.events.toggle?.();
    assert.equal(email.checked, true);
    assert.equal(app.bridge.dirty, false);
    assert.equal(app.calls.length, 3);
    assert.equal(password.disabled, false);
  }
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 4);
  assert.equal(app.calls.at(-1).options.body, "{}");
  assert.equal(app.bridge.dirty, false);
});

test("关闭邮箱草稿收起但保留配置，再开启重新展开，取消恢复已保存折叠状态", async () => {
  const app = await settingsRuntime({ registrationEnabled: true });
  const email = app.get("#email-registration-toggle"), details = app.get("#registration-mail-fields");
  const form = app.get("#registration-form"), host = form.elements.namedItem("host"), password = form.elements.namedItem("password");
  assert.equal(details.hidden, true); assert.equal(details.open, false);
  email.checked = true; email.events.change();
  host.value = "draft.example.com"; password.value = "draft-secret";
  details.open = false;
  email.checked = false; email.events.change();
  assert.equal(details.hidden, true); assert.equal(details.open, false);
  assert.equal(host.disabled, true);
  assert.equal(host.value, "draft.example.com"); assert.equal(password.value, "draft-secret");
  email.checked = true; email.events.change();
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  assert.equal(host.disabled, false); assert.equal(password.value, "draft-secret");
  assert.equal(app.calls.length, 3); assert.equal(app.bridge.dirty, true);
  await app.get("#settings-cancel").events.click();
  assert.equal(details.hidden, true); assert.equal(details.open, false);
  assert.equal(form.elements.namedItem("host").value, "smtp.example.com");
  assert.equal(form.elements.namedItem("password").value, "");
  assert.equal(app.bridge.dirty, false); assert.equal(app.calls.length, 3);
});

test("提交前先展开邮件配置，真实字段校验首错可见可聚焦且不提交", async () => {
  for (const emailRegistrationEnabled of [false, true]) {
    const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled });
    const email = app.get("#email-registration-toggle"), details = app.get("#registration-mail-fields"), form = app.get("#registration-form");
    if (!email.checked) { email.checked = true; email.events.change(); }
    const host = form.elements.namedItem("host");
    host.value = ""; form.events.input(); details.open = false;
    const validate = app.context.UI.validate;
    app.context.UI.validate = (node) => {
      assert.equal(details.open, true); assert.equal(details.hidden, false);
      return validate(node);
    };
    host.focus = () => { assert.equal(details.open, true); host.focused = true; };
    await form.events.submit({ preventDefault() {} });
    assert.equal(host.focused, true); assert.equal(host.getAttribute("aria-invalid"), "true");
    assert.equal(details.open, true); assert.equal(email.checked, true);
    assert.equal(app.bridge.dirty, true); assert.equal(app.calls.length, 3);
  }
});

test("折叠与切换语言不清除密码草稿，离开页面立即清除密码", async () => {
  const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true });
  const details = app.get("#registration-mail-fields"), password = app.get("#registration-form").elements.namedItem("password");
  password.value = "draft-secret"; app.get("#registration-form").events.input();
  details.open = false;
  app.context.I18n.apply({ locale: "ar-SA", theme: "light", accent: "green" });
  assert.equal(details.open, false); assert.equal(password.value, "draft-secret");
  assert.equal(app.bridge.dirty, true); assert.equal(app.calls.length, 3);
  app.events.pagehide();
  assert.equal(password.value, "");
});

test("邮箱勾选只展开草稿、一次提交配置与开关成功才生效", async () => {
  const app = await settingsRuntime();
  const email = app.get("#email-registration-toggle"), registration = app.get("#registration-toggle");
  assert.equal(app.get("#email-registration-row").hidden, true);
  registration.checked = true; registration.events.change();
  assert.equal(app.get("#email-registration-row").hidden, false);
  email.checked = true; email.events.change();
  assert.equal(app.calls.length, 3);
  assert.equal(app.get("#registration-mail-fields").hidden, false);
  assert.equal(app.bridge.dirty, true);
  assert(app.get("#registration-current").textContent.includes("注册已关闭"));
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 4);
  const body = JSON.parse(app.calls.at(-1).options.body);
  assert.equal(body.registrationEnabled, true); assert.equal(body.emailRegistrationEnabled, true);
  assert.equal(body.mailSettings.host, "smtp.example.com"); assert.equal(body.mailSettings.activationHours, 24);
  assert.equal(app.bridge.dirty, false);
  assert(app.get("#registration-current").textContent.includes("邮箱验证注册"));
});

test("取消与失败不会改变已保存状态，失败保留草稿和离开提醒", async () => {
  const app = await settingsRuntime({ patchStatus: 400 });
  const email = app.get("#email-registration-toggle"), registration = app.get("#registration-toggle");
  registration.checked = true; registration.events.change();
  email.checked = true; email.events.change();
  app.get("#registration-form").elements.namedItem("password").value = "new-secret";
  app.get("#registration-mail-fields").open = false;
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.equal(app.get("#registration-form").elements.namedItem("password").value, "new-secret");
  assert.equal(app.get("#registration-mail-fields").open, true);
  assert.equal(app.bridge.dirty, true); assert.equal(email.checked, true);
  assert(app.get("#registration-current").textContent.includes("注册已关闭"));
  app.context.UI.confirm = async () => false;
  await app.get("#settings-cancel").events.click();
  assert.equal(email.checked, true);
  app.context.UI.confirm = async () => true;
  await app.get("#settings-cancel").events.click();
  assert.equal(email.checked, false); assert.equal(app.bridge.dirty, false);
  assert.equal(app.get("#registration-form").elements.namedItem("password").value, "");
  assert.equal(app.calls.length, 4);
  assert.equal(app.get("#registration-mail-fields").hidden, true);
});

test("有效小时数前端限制1至720，取消清除密码确认不提交", async () => {
  const app = await settingsRuntime({ registrationEnabled: true });
  const email = app.get("#email-registration-toggle"), form = app.get("#registration-form");
  email.checked = true; email.events.change();
  const hours = form.elements.namedItem("activationHours");
  for (const value of ["0", "721", "1.5", "x"]) {
    hours.value = value;
    await form.events.submit({ preventDefault() {} });
    assert.equal(app.calls.length, 3);
    assert.equal(hours.focused, true);
  }
  hours.value = "720";
  const clear = app.get("#smtp-clear-password"); clear.checked = true; clear.events.change();
  app.context.UI.confirm = async () => false;
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 3); assert.equal(app.bridge.dirty, true);
  assert.equal(app.get("#settings-submit").disabled, false);
});

test("坏秘密导致邮件503时，单关总开关只提交false且不校验旧邮件字段", async () => {
  const app = await settingsRuntime({ mailStatus: 503, registrationEnabled: true, emailRegistrationEnabled: true });
  const registration = app.get("#registration-toggle");
  registration.checked = false; registration.events.change();
  app.context.UI.validate = () => { throw Error("紧急关闭不得校验邮件"); };
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 4);
  assert.equal(app.calls.at(-1).options.body, JSON.stringify({ registrationEnabled: false }));
  assert.equal(app.bridge.dirty, false);
  assert(app.get("#registration-current").textContent.includes("注册已关闭"));
});

test("已开邮箱只关总或邮箱不携带未改邮件配置，总关时不提交隐藏的新启邮箱草稿", async () => {
  for (const selector of ["#registration-toggle", "#email-registration-toggle"]) {
    const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true });
    app.get(selector).checked = false; app.get(selector).events.change();
    app.context.UI.validate = () => { throw Error("单关不得校验邮件"); };
    await app.get("#registration-form").events.submit({ preventDefault() {} });
    assert.equal(Object.keys(JSON.parse(app.calls.at(-1).options.body)).length, 1);
    assert.equal(JSON.parse(app.calls.at(-1).options.body)[selector === "#registration-toggle" ? "registrationEnabled" : "emailRegistrationEnabled"], false);
  }
  const app = await settingsRuntime();
  const registration = app.get("#registration-toggle");
  registration.checked = true; registration.events.change();
  app.get("#email-registration-toggle").checked = true; app.get("#email-registration-toggle").events.change();
  app.get("#registration-form").elements.namedItem("host").value = "";
  registration.checked = false; registration.events.change();
  app.context.UI.validate = () => { throw Error("隐藏的邮箱草稿不得校验"); };
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 4);
  assert.equal(app.calls.at(-1).options.body, "{}");
  assert.equal(app.get("#email-registration-toggle").checked, false);
  assert.equal(app.get("#email-registration-row").hidden, true);
  assert.equal(app.bridge.dirty, false);
});

test("初始化按总注册与邮箱的已保存组合同步层级和禁用状态", async () => {
  for (const registrationEnabled of [false, true]) for (const emailRegistrationEnabled of [false, true]) {
    const app = await settingsRuntime({ registrationEnabled, emailRegistrationEnabled });
    const form = app.get("#registration-form"), details = app.get("#registration-mail-fields");
    assert.equal(app.get("#email-registration-row").hidden, !registrationEnabled);
    assert.equal(app.get("#email-registration-toggle").checked, emailRegistrationEnabled);
    assert.equal(app.get("#email-registration-toggle").disabled, !registrationEnabled);
    assert.equal(details.hidden, !(registrationEnabled && emailRegistrationEnabled));
    assert.equal(details.open, registrationEnabled && emailRegistrationEnabled);
    for (const input of form.elements.filter((input) => input.name)) assert.equal(input.disabled, details.hidden);
    assert.equal(app.get("#smtp-clear-password").disabled, details.hidden);
    assert.equal(app.bridge.dirty, false); assert.equal(app.calls.length, 3);
  }
});

test("关闭总注册保留邮箱选择和全部邮件草稿，重开恢复邮箱行并按选择展开", async () => {
  for (const emailRegistrationEnabled of [false, true]) {
    const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled });
    const registration = app.get("#registration-toggle"), email = app.get("#email-registration-toggle");
    const form = app.get("#registration-form"), details = app.get("#registration-mail-fields"), clear = app.get("#smtp-clear-password");
    const host = form.elements.namedItem("host"), password = form.elements.namedItem("password");
    host.value = "draft.example.com"; clear.checked = true; password.value = "draft-secret";
    details.open = false;
    registration.checked = false; registration.events.change();
    assert.equal(app.get("#email-registration-row").hidden, true);
    assert.equal(email.checked, emailRegistrationEnabled);
    assert.equal(details.hidden, true); assert.equal(details.open, false);
    assert.equal(host.disabled, true); assert.equal(clear.disabled, true);
    assert.equal(host.value, "draft.example.com"); assert.equal(password.value, "draft-secret"); assert.equal(clear.checked, true);
    registration.checked = true; registration.events.change();
    assert.equal(app.get("#email-registration-row").hidden, false);
    assert.equal(details.hidden, !emailRegistrationEnabled); assert.equal(details.open, emailRegistrationEnabled);
    assert.equal(host.disabled, !emailRegistrationEnabled); assert.equal(clear.disabled, !emailRegistrationEnabled);
    assert.equal(host.value, "draft.example.com"); assert.equal(password.value, "draft-secret"); assert.equal(clear.checked, true);
    assert.equal(app.bridge.dirty, true); assert.equal(app.calls.length, 3);
    await app.get("#settings-cancel").events.click();
    assert.equal(registration.checked, true); assert.equal(email.checked, emailRegistrationEnabled);
    assert.equal(app.get("#email-registration-row").hidden, false);
    assert.equal(details.open, emailRegistrationEnabled); assert.equal(details.hidden, !emailRegistrationEnabled);
    assert.equal(form.elements.namedItem("host").value, "smtp.example.com");
    assert.equal(form.elements.namedItem("password").value, ""); assert.equal(clear.checked, false);
    assert.equal(app.bridge.dirty, false); assert.equal(app.calls.length, 3);
  }
});

test("关闭总注册只提交总开关差异，不提交隐藏邮箱选择、SMTP改动或清密请求", async () => {
  for (const savedEmail of [false, true]) for (const draftEmail of [false, true]) {
    const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: savedEmail });
    const form = app.get("#registration-form"), registration = app.get("#registration-toggle"), email = app.get("#email-registration-toggle");
    const clear = app.get("#smtp-clear-password");
    email.checked = true; email.events.change();
    form.elements.namedItem("host").value = "";
    form.elements.namedItem("port").value = "0";
    clear.checked = true; clear.events.change();
    email.checked = draftEmail; email.events.change();
    registration.checked = false; registration.events.change();
    app.context.UI.validate = () => { throw Error("关闭总注册不得被隐藏字段校验阻塞"); };
    app.context.UI.confirm = async () => { throw Error("关闭总注册不得确认隐藏的清密草稿"); };
    await form.events.submit({ preventDefault() {} });
    assert.equal(app.calls.length, 4);
    assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { registrationEnabled: false });
    assert.equal(email.checked, savedEmail);
    assert.equal(app.get("#email-registration-row").hidden, true);
    assert.equal(app.get("#registration-mail-fields").hidden, true);
    assert.equal(app.get("#registration-mail-fields").open, false);
    assert.equal(form.elements.namedItem("host").value, "smtp.example.com");
    assert.equal(form.elements.namedItem("port").value, "465");
    assert.equal(clear.checked, false); assert.equal(clear.disabled, true);
    assert.equal(app.bridge.dirty, false);
    assert(app.get("#registration-current").textContent.includes("注册已关闭"));
    registration.checked = true; registration.events.change();
    assert.equal(app.get("#email-registration-row").hidden, false);
    assert.equal(app.get("#registration-mail-fields").open, savedEmail);
    assert.equal(form.elements.namedItem("host").value, "smtp.example.com");
  }
});

test("关闭邮箱不静默提交此前清密和无效SMTP草稿", async () => {
  const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true });
  const form = app.get("#registration-form"), email = app.get("#email-registration-toggle"), clear = app.get("#smtp-clear-password");
  clear.checked = true; clear.events.change();
  form.elements.namedItem("host").value = "";
  email.checked = false; email.events.change();
  app.context.UI.validate = () => { throw Error("关闭邮箱不得校验隐藏字段"); };
  app.context.UI.confirm = async () => { throw Error("不得提交隐藏的清密草稿"); };
  await form.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { emailRegistrationEnabled: false });
  assert.equal(app.get("#email-registration-row").hidden, false);
  assert.equal(app.get("#registration-mail-fields").hidden, true);
  assert.equal(form.elements.namedItem("host").value, "smtp.example.com");
  assert.equal(clear.checked, false); assert.equal(app.bridge.dirty, false);
});

test("关闭总注册提交失败保留隐藏草稿与已生效摘要，重开恢复，取消同步已保存状态", async () => {
  const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true, patchStatus: 400 });
  const form = app.get("#registration-form"), registration = app.get("#registration-toggle");
  const details = app.get("#registration-mail-fields");
  form.elements.namedItem("host").value = "draft.example.com";
  form.elements.namedItem("password").value = "draft-secret";
  registration.checked = false; registration.events.change();
  await form.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { registrationEnabled: false });
  assert.equal(registration.checked, false); assert.equal(details.hidden, true); assert.equal(details.open, false);
  assert.equal(app.get("#email-registration-row").hidden, true);
  assert.equal(app.bridge.dirty, true);
  assert(app.get("#registration-current").textContent.includes("邮箱验证注册"));
  registration.checked = true; registration.events.change();
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  assert.equal(form.elements.namedItem("host").value, "draft.example.com");
  assert.equal(form.elements.namedItem("password").value, "draft-secret");
  registration.checked = false; registration.events.change();
  await app.get("#settings-cancel").events.click();
  assert.equal(registration.checked, true); assert.equal(app.get("#email-registration-row").hidden, false);
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  assert.equal(form.elements.namedItem("host").disabled, false);
  assert.equal(form.elements.namedItem("password").value, ""); assert.equal(app.bridge.dirty, false);
});

test("已保存邮箱开启但总注册关闭时，重新开放注册仍须校验配置并成功同步", async () => {
  const app = await settingsRuntime({ emailRegistrationEnabled: true });
  const registration = app.get("#registration-toggle"), form = app.get("#registration-form"), details = app.get("#registration-mail-fields");
  registration.checked = true; registration.events.change();
  assert.equal(app.get("#email-registration-row").hidden, false);
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  form.elements.namedItem("host").value = ""; details.open = false;
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 3); assert.equal(details.open, true);
  assert.equal(form.elements.namedItem("host").focused, true);
  form.elements.namedItem("host").value = "smtp.example.com";
  await form.events.submit({ preventDefault() {} });
  const body = JSON.parse(app.calls.at(-1).options.body);
  assert.equal(body.registrationEnabled, true); assert.equal(body.emailRegistrationEnabled, undefined);
  assert.equal(body.mailSettings.host, "smtp.example.com");
  assert.equal(app.bridge.dirty, false); assert.equal(details.hidden, false); assert.equal(details.open, true);
  assert(app.get("#registration-current").textContent.includes("邮箱验证注册"));
});

test("邮件读取失败不阻塞总注册关闭，但开放邮箱注册仍不发请求", async () => {
  const app = await settingsRuntime({ emailRegistrationEnabled: true, mailStatus: 503 });
  const registration = app.get("#registration-toggle");
  registration.checked = true; registration.events.change();
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 3); assert.equal(app.bridge.dirty, true);
  assert.equal(app.get("#settings-status").children.length, 1);
  registration.checked = false; registration.events.change();
  await app.get("#registration-form").events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 4); assert.equal(app.calls.at(-1).options.body, "{}");
  assert.equal(app.get("#email-registration-toggle").checked, true);
  assert.equal(app.get("#email-registration-row").hidden, true);
});

test("非管理员不能读取设置，邮件配置故障保留重试且不伪装权限错误", async () => {
  const denied = await settingsRuntime({ role: "editor" });
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.get("#settings-status").textContent, denied.context.I18n.t("permissionDenied"));
  for (const mailStatus of [404, 403]) {
    const app = await settingsRuntime({ mailStatus });
    assert.equal(app.get("#settings-status").textContent, app.context.I18n.t(mailStatus === 404 ? "mailSettingsUnavailable" : "permissionDenied"));
    assert.equal(app.get("#settings-status").children.length, 1);
  }
});

test("设置提交等待时按钮与吸底反馈可见、防重复，服务器成功后才清草稿", async () => {
  let release;
  const app = await settingsRuntime({ patchGate: new Promise((resolve) => { release = resolve; }) });
  const form = app.get("#registration-form"), submit = app.get("#settings-submit"), feedback = app.get("#settings-feedback");
  app.get("#registration-toggle").checked = true; app.get("#registration-toggle").events.change();
  const pending = form.events.submit({ preventDefault() {} });
  assert.equal(submit.disabled, true); assert.equal(submit.getAttribute("aria-busy"), "true");
  assert.equal(submit.textContent, app.context.I18n.t("saving"));
  assert.equal(feedback.textContent, app.context.I18n.t("saving"));
  assert.equal(feedback.dataset.state, "loading"); assert.equal(app.bridge.dirty, true);
  await form.events.submit({ preventDefault() {} }); assert.equal(app.calls.length, 4);
  release(); await pending;
  assert.equal(submit.disabled, false); assert.equal(submit.getAttribute("aria-busy"), "false");
  assert.equal(feedback.dataset.state, "success"); assert.equal(app.bridge.dirty, false);
  assert.equal(app.get("#global-toast").dataset.kind, "success");
  assert.equal(app.get("#global-toast").textContent, app.context.I18n.t("registrationSaved"));
  const html = fs.readFileSync(path.join(assets, "../settings.html"), "utf8");
  assert.match(html, /class="section settings-actions"><div id="settings-feedback"/);
});

test("设置失败在吸底操作区显示本地化原因且不清草稿和密码", async () => {
  const app = await settingsRuntime({ patchStatus: 400, registrationEnabled: true, emailRegistrationEnabled: true });
  const form = app.get("#registration-form"); form.elements.namedItem("password").value = "draft-password"; form.events.input();
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.get("#settings-feedback").dataset.state, "error");
  assert.equal(app.get("#settings-feedback").textContent, app.context.I18n.t("MAIL_NOT_CONFIGURED"));
  assert.equal(app.get("#global-toast").dataset.kind, "error");
  assert.equal(app.bridge.dirty, true); assert.equal(form.elements.namedItem("password").value, "draft-password");
});

for (const conflictStatus of ["USER_EXISTS", "EMAIL_EXISTS"]) for (const locale of ["zh-CN", "en-US", "ar-SA"]) test(`注册冲突 ${conflictStatus} 在 ${locale} 提示账号已存在并保留草稿`, async () => {
  const app = runtime("auth.html?mode=register", async (url) => String(url).endsWith("/visitor/install/detail")
    ? result(200, { setupRequired: false, registrationEnabled: true, emailRegistrationEnabled: true }) : result(409, { status: conflictStatus }));
  app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  app.get("#auth-form").append(app.get("#auth-fields")); await app.load("auth.js");
  const form = app.get("#auth-form");
  app.context.I18n.apply({ locale });
  form.elements.namedItem("userName").value = "account-one";
  form.elements.namedItem("email").value = "used@example.com";
  form.elements.namedItem("nickname").value = "新成员";
  await form.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { userName: "account-one", email: "used@example.com", nickname: "新成员" });
  assert.equal(app.get("#auth-status").textContent, app.context.I18n.t("registrationAccountExists"));
  assert.notEqual(app.get("#auth-status").textContent, app.context.I18n.t("activationSent"));
  assert.equal(app.get("#global-toast").dataset.kind, "error");
  assert.notEqual(app.get("#auth-status").textContent, app.context.I18n.t("conflict"));
  assert.equal(form.elements.namedItem("userName").value, "account-one");
  assert.equal(app.get("#auth-submit").disabled, false);
});

async function identityPage(page, script, fetcher) {
  const app = runtime(page, fetcher);
  app.load(script);
  assert.equal(app.context.location.hash, "");
  assert.equal(app.calls.length, 0);
  app.load("i18n.js"); app.load("common.js"); app.load("api.js");
  if (script === "reset-password.js") app.get("#reset-form").append(app.get("#reset-fields"));
  else {
    app.get("#verification-form").append(app.get("#verification-fields"));
    app.get("#verification-login").append(app.get("#verification-login-fields"));
  }
  await app.events.DOMContentLoaded();
  return app;
}

test("忘记密码统一成功消息、输入邮箱及一次提交，不泄漏账户是否存在", async () => {
  const app = await identityPage("reset-password.html", "reset-password.js", async () => result(200, {}));
  const form = app.get("#reset-form");
  assert.equal(app.calls.length, 0);
  form.elements.namedItem("email").value = "missing@example.com";
  await form.events.submit({ preventDefault() {} });
  assert(app.calls[0].url.endsWith("/visitor/password-reset/request"));
  assert.deepEqual(JSON.parse(app.calls[0].options.body), { email: "missing@example.com" });
  assert.equal(app.get("#reset-status").textContent, app.context.I18n.t("passwordResetSent"));
  assert.equal(app.replacements.length, 0);
  assert.equal(app.storage.length, 0);
});

test("密码重置只在主动提交后POST，校验确认密码，成功不自动登录", async () => {
  const app = await identityPage("reset-password.html#reset=" + token, "reset-password.js", async () => result(200, {}));
  const form = app.get("#reset-form");
  assert.equal(app.calls.length, 0);
  form.elements.namedItem("password").value = "new-password";
  form.elements.namedItem("passwordConfirm").value = "different";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, 0); assert.equal(form.elements.namedItem("passwordConfirm").focused, true);
  form.elements.namedItem("passwordConfirm").value = "new-password";
  await form.events.submit({ preventDefault() {} });
  assert(app.calls[0].url.endsWith("/visitor/password-reset/confirmation"));
  assert.deepEqual(JSON.parse(app.calls[0].options.body), { password: "new-password", passwordConfirm: "new-password", token });
  assert.equal(app.get("#reset-submit").disabled, true);
  assert.equal(app.get("#reset-status").textContent, app.context.I18n.t("passwordResetCompleted"));
  assert.equal(form.elements.namedItem("password").value, "");
  assert.equal(app.replacements.length, 0); assert.equal(app.storage.length, 0);
  await form.events.submit({ preventDefault() {} }); assert.equal(app.calls.length, 1);
});

test("重置无效链接不请求且失败可重试，页面离开清除内存令牌", async () => {
  for (const fragment of ["#reset=x", "#reset=" + token + "&redirect=evil"]) {
    const app = await identityPage("reset-password.html" + fragment, "reset-password.js", async () => result(200, {}));
    assert.equal(app.get("#reset-submit").disabled, true); assert.equal(app.calls.length, 0);
  }
  const app = await identityPage("reset-password.html#reset=" + token, "reset-password.js", async () => result(400, { status: "PASSWORD_RESET_INVALID" }));
  const form = app.get("#reset-form");
  for (const name of ["password", "passwordConfirm"]) form.elements.namedItem(name).value = "123456";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.get("#reset-status").textContent, app.context.I18n.t("PASSWORD_RESET_INVALID"));
  assert.equal(app.get("#reset-submit").disabled, false);
  app.events.pagehide();
  for (const name of ["password", "passwordConfirm"]) { assert.equal(form.elements.namedItem(name).value, ""); form.elements.namedItem(name).value = "123456"; }
  await form.events.submit({ preventDefault() {} }); assert.equal(app.calls.length, 1);
});

test("邮箱验证GET仅检查登录，原邮箱主动确认后填写新邮箱且不自动换绑", async () => {
  const app = await identityPage("email-verification.html#purpose=email-change-old&token=" + token, "email-verification.js", async (url) =>
    String(url).endsWith("/session/detail") ? result(200, { userName: "tester" }) : result(200, {}));
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].options.method, "GET");
  const form = app.get("#verification-form"); assert.equal(form.hidden, false);
  await form.events.submit({ preventDefault() {} });
  assert(app.calls.at(-1).url.endsWith("/account/email-change/verification"));
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { token });
  assert.equal(app.get("#verification-status").textContent, app.context.I18n.t("oldEmailVerified"));
  assert(form.elements.namedItem("email"));
  form.elements.namedItem("email").value = "new@example.com";
  await form.events.submit({ preventDefault() {} });
  assert(app.calls.at(-1).url.endsWith("/account/email-change/proposal"));
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { email: "new@example.com" });
  assert.equal(form.hidden, true); assert.equal(app.calls.length, 3);
  assert.equal(app.replacements.length, 0); assert.equal(app.storage.length, 0);
});

test("邮箱确认未登录留在原页面登录，凭据仅内存保留且登录成功后仍需主动确认", async () => {
  for (const purpose of ["email-change-new", "email-binding"]) {
    let loggedIn = false;
    const app = await identityPage("email-verification.html#purpose=" + purpose + "&token=" + token, "email-verification.js", async (url, options) => {
      if (String(url).endsWith("/session/detail")) return loggedIn ? result(200, { userName: "tester" }) : result(401, { status: "AUTH_REQUIRED" });
      if (String(url).endsWith("/visitor/session")) { loggedIn = true; return result(200, {}); }
      assert.equal(options.method, "POST"); return result(200, {});
    });
    const login = app.get("#verification-login"), form = app.get("#verification-form");
    assert.equal(login.hidden, false); assert.equal(form.hidden, true); assert.equal(app.replacements.length, 0);
    login.elements.namedItem("userName").value = "tester"; login.elements.namedItem("password").value = "123456";
    await login.events.submit({ preventDefault() {} });
    assert.equal(login.hidden, true); assert.equal(form.hidden, false); assert.equal(app.calls.length, 3);
    assert.equal(login.elements.namedItem("password").value, "");
    await form.events.submit({ preventDefault() {} });
    assert(app.calls.at(-1).url.endsWith(purpose === "email-binding" ? "/account/email-binding/confirmation" : "/account/email-change/confirmation"));
    assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { token });
    assert.equal(app.get("#verification-status").textContent, app.context.I18n.t("emailVerifiedCompleted"));
    assert.equal(app.replacements.length, 0); assert.equal(app.storage.length, 0);
  }
});

test("邮箱错身份、过期或频控显示明确错误，绝不降级匿名确认或丢失令牌", async () => {
  for (const status of ["EMAIL_IDENTITY_MISMATCH", "EMAIL_TOKEN_INVALID", "EMAIL_CHANGE_STATE_INVALID", "MAIL_THROTTLED"]) {
    const app = await identityPage("email-verification.html#purpose=email-binding&token=" + token, "email-verification.js", async (url) =>
      String(url).endsWith("/session/detail") ? result(200, { userName: "other" }) : result(409, { status }));
    const form = app.get("#verification-form");
    await form.events.submit({ preventDefault() {} });
    assert.equal(app.get("#verification-status").textContent, app.context.I18n.t(status));
    assert.equal(app.get("#verification-submit").disabled, false); assert.equal(app.calls.length, 2);
    assert.equal(app.replacements.length, 0);
    app.events.pagehide();
    await form.events.submit({ preventDefault() {} }); assert.equal(app.calls.length, 2);
  }
});

test("原邮箱验证后会话失效终止旧流程，提示个人中心重新发起而非再次登录循环", async () => {
  const app = await identityPage("email-verification.html#purpose=email-change-old&token=" + token, "email-verification.js", async (url) => {
    if (String(url).endsWith("/session/detail")) return result(200, { userName: "tester" });
    if (String(url).endsWith("/email-change/verification")) return result(200, { stage: "new-email" });
    return result(401, { status: "AUTH_REQUIRED" });
  });
  const form = app.get("#verification-form");
  await form.events.submit({ preventDefault() {} });
  form.elements.namedItem("email").value = "new@example.com";
  await form.events.submit({ preventDefault() {} });
  assert.equal(app.get("#verification-status").textContent, app.context.I18n.t("EMAIL_CHANGE_STATE_INVALID"));
  assert.equal(app.get("#verification-login").hidden, true); assert.equal(form.hidden, true);
  const count = app.calls.length;
  await app.get("#verification-login").events.submit({ preventDefault() {} });
  assert.equal(app.calls.length, count); assert.equal(app.replacements.length, 0);
});

test("账户首屏等待邮箱数据完成并传播邮箱初始化错误", async () => {
  for (const failure of [false, true]) {
    let release;
    const gate = new Promise((resolve, reject) => { release = failure ? () => reject(new Error("邮箱请求失败")) : () => resolve(result(200, { email: "a@example.com", emailVerified: true, stage: "none" })); });
    const app = runtime("account.html", async () => gate);
    app.load("i18n.js"); app.load("common.js"); app.load("api.js");
    const failures = [];
    app.context.AppPage = { ready: Promise.resolve(), fail: (error) => failures.push(error.message) };
    const script = vm.runInContext(fs.readFileSync(path.join(assets, "account-email.js"), "utf8"), app.context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.calls.length, 1);
    release();
    await script;
    assert.deepEqual(failures, failure ? ["邮箱请求失败"] : []);
    assert.equal(app.get("#account-email-actions").children.length, failure ? 1 : 2);
    if (failure) assert.notEqual(app.get("#account-email-status").textContent, "");
  }
});

test("待新邮箱确认仅可刷新不会误重新开始，重置页缓存恢复显示令牌已失效", async () => {
  const app = runtime("account.html", async () => result(200, { email: "old@example.com", emailVerified: true, stage: "new-pending" }));
  app.load("i18n.js"); app.load("common.js"); app.load("api.js"); app.context.AppPage = { ready: Promise.resolve(), complete: async () => {}, fail() {} };
  await app.load("account-email.js");
  assert.equal(app.get("#account-email-actions").children.length, 1);
  assert.equal(app.get("#account-email-actions").children[0].dataset.emailAction, "refresh");
  assert.equal(app.calls.length, 1);
  const reset = await identityPage("reset-password.html#reset=" + token, "reset-password.js", async () => result(200, {}));
  assert.equal(reset.get("#reset-form").elements.namedItem("password").autocomplete, "new-password");
  assert.equal(reset.get("#reset-form").elements.namedItem("passwordConfirm").autocomplete, "new-password");
  reset.events.pagehide(); reset.events.pageshow({ persisted: true });
  assert.equal(reset.get("#reset-submit").disabled, true);
  assert.equal(reset.get("#reset-status").textContent, reset.context.I18n.t("PASSWORD_RESET_INVALID"));
});

test("邮箱验证与重置提交防重复并在三语主题切换后保留草稿", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = await identityPage("reset-password.html#reset=" + token, "reset-password.js", async () => { await gate; return result(200, {}); });
  const form = app.get("#reset-form");
  for (const name of ["password", "passwordConfirm"]) form.elements.namedItem(name).value = "123456";
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) {
    app.context.I18n.apply({ locale, theme: "light" });
    assert.equal(form.elements.namedItem("password").value, "123456");
  }
  const pending = form.events.submit({ preventDefault() {} });
  assert.equal(app.get("#reset-submit").disabled, true);
  await form.events.submit({ preventDefault() {} }); assert.equal(app.calls.length, 1);
  release(); await pending; assert.equal(app.get("#reset-submit").disabled, true);
});

test("个人邮箱独立显示与发起，既有邮箱须先验证原邮箱且管理员编辑不传邮箱", async () => {
  for (const emailVerified of [false, true]) {
    const app = runtime("account.html", async (url) => String(url).endsWith("/account/email/detail")
      ? result(200, { email: emailVerified ? "old@example.com" : "", emailVerified, stage: "none" }) : result(200, {}));
    app.load("i18n.js"); app.load("common.js"); app.load("api.js");
    app.context.AppPage = { ready: Promise.resolve(), complete: async () => {}, fail() {} };
    let dialog;
    app.context.UI.formDialog = async (title, fields, submit) => { dialog = { fields, submit }; return null; };
    await app.load("account-email.js");
    assert.equal(app.calls.length, 1);
    const action = app.get("#account-email-actions").children.at(-1);
    await action.events.click();
    if (emailVerified) {
      assert(app.calls.at(-1).url.endsWith("/account/email-change/request"));
      assert.equal(app.calls.at(-1).options.body, "{}");
      assert.equal(app.get("#account-email-status").textContent, app.context.I18n.t("oldEmailSent"));
    } else {
      assert.equal(dialog.fields[0].name, "email");
      await dialog.submit({ email: "new@example.com", userName: "tampered" });
      assert(app.calls.at(-1).url.endsWith("/account/email-binding/request"));
      assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { email: "new@example.com" });
    }
  }
});

test("最终后端邮件错误码全部映射三语操作提示，不暴露原始服务端错误", () => {
  const app = runtime("email-verification.html", async () => result(200, {}));
  app.load("i18n.js"); app.load("common.js");
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) {
    app.context.I18n.apply({ locale });
    for (const status of ["MAIL_ORIGIN_REQUIRED", "EMAIL_SESSION_MISMATCH", "EMAIL_CHANGED", "EMAIL_UNCHANGED", "EMAIL_NOT_VERIFIED"]) {
      const message = app.context.UI.errorText({ status, msg: "internal detail" });
      assert.equal(message, app.context.I18n.t(status));
      assert.notEqual(message, app.context.I18n.t("unknownError"));
      assert.notEqual(message, status); assert(!message.includes("internal detail"));
    }
  }
  app.context.I18n.apply({ locale: "zh-CN" });
  assert.match(app.context.I18n.t("EMAIL_SESSION_MISMATCH"), /重新发起.*不要重复使用旧链接/);
  assert.match(app.context.I18n.t("MAIL_ORIGIN_REQUIRED"), /管理员.*可访问.*保存邮件设置/);
});

test("配额两维独立继承和不限，容量换算精确且拒绝溢出及小数bytes", () => {
  const app = runtime("users.html", async () => result(200, {}));
  app.load("i18n.js"); app.load("common.js");
  const { quotaValue, quotaPayload, quotaFields } = app.context.UI;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(quotaPayload({ fileCountLimitMode: "inherit", storageBytesLimitMode: "custom", storageBytesLimit: "1.5", storageBytesLimitUnit: "MiB" })), { fileCountLimit: null, storageBytesLimit: 1572864 });
  assert.deepEqual(plain(quotaPayload({ fileCountLimitMode: "unlimited", storageBytesLimitMode: "inherit" })), { fileCountLimit: 0, storageBytesLimit: null });
  assert.deepEqual(plain(quotaPayload({ defaultFileCountLimitMode: "custom", defaultFileCountLimit: "100", defaultStorageBytesLimitMode: "unlimited" }, true)), { defaultFileCountLimit: 100, defaultStorageBytesLimit: 0 });
  assert.equal(quotaValue("custom", "0.00000095367431640625", "MiB"), 1);
  assert.equal(quotaValue("custom", "9007199254740991", "B"), Number.MAX_SAFE_INTEGER);
  for (const [value, unit] of [["1.1", "B"], ["0.1", "MiB"], ["9007199254740992", "B"], ["-1", "B"], ["1e3", "B"], ["0", "B"], ["", "B"]])
    assert.throws(() => quotaValue("custom", value, unit), (error) => error.status === "QUOTA_INVALID");
  const fields = quotaFields({ fileCountLimit: null, storageBytesLimit: 0 });
  assert.equal(fields.find((field) => field.name === "fileCountLimitMode").value, "inherit");
  assert.equal(fields.find((field) => field.name === "storageBytesLimitMode").value, "unlimited");
  for (const bytes of [1, 1048577, 1073741824, Number.MAX_SAFE_INTEGER]) {
    const fields = quotaFields({ storageBytesLimit: bytes });
    const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
    assert.equal(quotaPayload(values).storageBytesLimit, bytes);
  }
});

test("默认配额独立保存不校验SMTP且保留注册邮件草稿，取消不写入", async () => {
  const app = await settingsRuntime({ registrationEnabled: true, emailRegistrationEnabled: true });
  const form = app.get("#registration-form"), host = form.elements.namedItem("host");
  host.value = ""; form.events.input();
  app.context.UI.validate = () => { throw Error("配额不能校验SMTP草稿"); };
  let dialog;
  app.context.UI.formDialog = async (title, fields, submit, options) => { dialog = { fields, submit, options }; return null; };
  await app.get("#quota-settings-edit").events.click();
  assert.equal(app.calls.length, 3); assert.equal(app.bridge.dirty, true); assert.equal(host.value, "");
  assert.equal(dialog.options.dirty, true);
  await dialog.submit({ defaultFileCountLimitMode: "custom", defaultFileCountLimit: "5", defaultStorageBytesLimitMode: "custom", defaultStorageBytesLimit: "2", defaultStorageBytesLimitUnit: "GiB" });
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { defaultFileCountLimit: 5, defaultStorageBytesLimit: 2147483648 });
  assert.equal(app.bridge.dirty, true); assert.equal(host.value, "");
});

test("配额和空间角色三语文案、错误反馈与RTL数字隔离", () => {
  const app = runtime("users.html", async () => result(200, {})); app.load("i18n.js"); app.load("common.js");
  const keys = ["quotaDefaults", "quotaDefaultsHint", "quotaFiles", "quotaStorage", "quotaMode", "quotaInherit", "quotaUnlimited", "quotaCustom", "quotaUnit", "quotaUnitHint", "quotaValueHint", "memberRole", "memberRoleHint", "memberRole_viewer", "memberRole_editor", "memberRole_manager", "QUOTA_INVALID", "FILE_COUNT_QUOTA_EXCEEDED", "STORAGE_QUOTA_EXCEEDED"];
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) for (const theme of ["light", "dark"]) {
    app.context.I18n.apply({ locale, theme });
    for (const key of keys) { assert.notEqual(app.context.I18n.t(key), key); assert.notEqual(app.context.I18n.t(key), app.context.I18n.t("unknownError")); }
    for (const status of keys.slice(-3)) assert.equal(app.context.UI.errorText({ status }), app.context.I18n.t(status));
    const summary = app.context.UI.quotaSummary({ usedFileCount: 2, usedStorageBytes: 1048576, effectiveFileCountLimit: 0, effectiveStorageBytesLimit: 2147483648 });
    assert.equal(summary.children.length, 2);
    assert(summary.children.every((line) => line.children.at(-1).attrs.dir === "ltr"));
  }
  assert.equal(app.context.I18n.ctx.dir, "rtl");
  app.context.I18n.apply({ locale: "zh-CN" });
  assert.equal(app.context.I18n.t("memberSummary", { total: 3, collaborators: 2 }), "3 人 · 2 人可编辑");
  app.context.I18n.apply({ locale: "en-US" });
  assert.equal(app.context.I18n.t("memberSummary", { total: 3, collaborators: 2 }), "3 members · 2 with write access");
  const users = fs.readFileSync(path.join(assets, "users.js"), "utf8");
  assert.match(users, /return \["editor", "admin"\]/);
  assert.match(users, /value: "editor", options: roles\(\)/);
});

test("邮箱新文案三语齐全并兼容六强调色、双主题、阿语方向", () => {
  const app = runtime("activate.html", async () => result(200, {}));
  app.load("i18n.js");
  const keys = ["settings", "settingsHint", "submitSettings", "registrationCurrent", "registrationOff", "registrationEmailOn", "registrationNormalOn", "smtpPortHint", "clearSmtpPasswordHint", "userTabs", "registrationSettings", "mailSettings", "emailRegistration", "emailRegistrationHint", "emailRegisterHint", "emailLoginHint", "sendActivation", "activationSent", "activationTitle", "activationHint", "activationCompleted", "activateAccount", "passwordConfirm", "smtpSecretWarning", "smtpServer", "activationSettings", "smtpHost", "smtpPort", "smtpSecurity", "smtpPasswordHint", "siteOriginHint", "activationHoursHint", "testMailConfirm", "EMAIL_VERIFICATION_REQUIRED", "MAIL_NOT_CONFIGURED", "MAIL_SEND_FAILED", "SMTP_SECRET_UNAVAILABLE", "SMTP_PASSWORD_ENVIRONMENT", "REGISTRATION_THROTTLED", "ACTIVATION_INVALID", "PASSWORD_MISMATCH"];
  keys.push("refreshEmailStatus", "EMAIL_EXISTS", "PASSWORD_RESET_INVALID", "EMAIL_TOKEN_INVALID", "EMAIL_IDENTITY_MISMATCH", "EMAIL_CHANGE_STATE_INVALID", "MAIL_THROTTLED", "loginAccountHint", "emailIdentityHint", "forgotPassword", "forgotPasswordHint", "resetPassword", "resetPasswordHint", "sendResetEmail", "passwordResetSent", "passwordResetCompleted", "accountReadOnlyHint", "accountEmail", "emailNotBound", "emailVerified", "emailUnverified", "emailVerificationStatus", "adminEmailReadOnlyHint", "emailSameBrowserHint", "emailChangeHint", "oldEmailPending", "newEmailPending", "oldEmailVerified", "oldEmailSent", "newEmailSent", "bindEmail", "changeEmail", "newEmail", "sendNewEmail", "sendVerificationEmail", "emailVerification", "emailVerificationHint", "verificationLoginHint", "verificationSignedIn", "confirmEmail", "emailVerifiedCompleted");
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) for (const theme of ["light", "dark"]) for (const accent of ["blue", "green", "purple", "red", "orange", "teal"]) {
    app.context.I18n.apply({ locale, theme, accent });
    assert.equal(app.context.I18n.ctx.accent, accent);
    assert.equal(app.context.I18n.ctx.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
    for (const key of keys) assert.notEqual(app.context.I18n.t(key), "操作失败，请稍后重试。", key);
  }
});
