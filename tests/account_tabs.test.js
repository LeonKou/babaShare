"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assets = path.join(__dirname, "../web/assets");
const html = fs.readFileSync(path.join(assets, "../account.html"), "utf8");

async function account(query = "", failure = false) {
  const nodes = new Map(), events = new Map(), requests = [];
  let document;
  class Element {
    constructor(tag, attrs = {}) {
      this.tag = tag;
      this.attrs = { ...attrs };
      this.children = [];
      this.events = new Map();
      this.dataset = {};
      this.value = attrs.value || "";
      this.hidden = Object.hasOwn(attrs, "hidden");
      this.textContent = attrs.text || "";
      this.classList = { add() {}, remove() {} };
      for (const [key, value] of Object.entries(attrs))
        if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    append(...children) { this.children.push(...children.flat().filter((child) => child != null)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(name, action) { this.events.set(name, action); }
    focus() { document.activeElement = this; }
    contains(node) { return node === this || this.children.some((child) => child instanceof Element && child.contains(node)); }
    fire(name, init = {}) {
      const event = { ...init, prevented: false, preventDefault() { this.prevented = true; } };
      this.events.get(name)?.(event);
      return event;
    }
  }
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="[^"]+"[^>]*)>/g)) {
    const attrs = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), (part) => [part[1], part[2]]));
    if (/\shidden(?:\s|$)/.test(match[2])) attrs.hidden = "";
    nodes.set(attrs.id, new Element(match[1], attrs));
  }
  const $ = (selector) => {
    const result = nodes.get(selector.slice(1));
    assert(result, "账号页面必须存在节点 " + selector);
    return result;
  };
  $("#mcp-filter").value = "all";
  document = {
    documentElement: { lang: "zh-CN", dir: "ltr", dataset: { mode: "dark" } },
    activeElement: null,
    querySelectorAll(selector) {
      const attribute = selector.slice(1, -1);
      return [...nodes.values()].filter((node) => Object.hasOwn(node.attrs, attribute));
    },
  };
  const el = (tag, attrs, ...children) => {
    const node = new Element(tag, attrs);
    node.append(...children);
    return node;
  };
  const context = {
    console, URL, AbortController, Date, document,
    location: new URL("http://127.0.0.1/baba-share/account.html" + query),
    history: { state: { keep: true }, replaceState(state, _, url) { this.state = state; context.location = new URL(url); } },
    addEventListener(name, action) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(action);
    },
    UI: {
      $, el, toast() {}, errorText: (error) => error.message, date: String,
      empty: () => el("p", {}), page: () => ({ ready: Promise.resolve() }),
      button(key, action) { const node = el("button", { text: key }); node.addEventListener("click", action); return node; },
      copyButton(key, action) { const node = el("button", { text: key }); node.addEventListener("click", action); return node; },
    },
    API: async (name) => {
      requests.push(name);
      if (failure && name === "me") throw new Error("登录已失效");
      if (name === "me") return { nickname: "测试账户", userName: "tester", role: "user", createTime: 1 };
      if (name === "shares") return Array.from({ length: 25 }, (_, index) => ({ id: String(index), workspaceId: "workspace", path: "folder" + index, shareUrl: "#" + index, createTime: 1 }));
      if (name === "workspaces") return [{ id: "workspace", workspaceName: "测试工作区" }];
      if (name === "mcpKeys") return [{ id: "key", keyName: "测试密钥", keyPrefix: "bsk_", createTime: 1 }];
      throw new Error("不应触发写入请求 " + name);
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["i18n.js", "pagination.js"])
    vm.runInContext(fs.readFileSync(path.join(assets, file), "utf8"), context);
  await vm.runInContext(fs.readFileSync(path.join(assets, "account.js"), "utf8"), context);
  return { context, $, requests, popstate() { for (const action of events.get("popstate") || []) action(); } };
}

function selected(app, section) {
  for (const name of ["profile", "keys", "shares"]) {
    assert.equal(app.$("#account-tab-" + name).attrs["aria-selected"], String(name === section));
    assert.equal(app.$("#account-tab-" + name).attrs.tabindex, name === section ? "0" : "-1");
    assert.equal(app.$("#account-panel-" + name).hidden, name !== section);
    assert.equal(app.$("#account-tab-" + name).attrs["aria-controls"], "account-panel-" + name);
    assert.equal(app.$("#account-panel-" + name).attrs["aria-labelledby"], "account-tab-" + name);
  }
}

test("账号三个语义面板仅显示资料且不自动抢焦点", async () => {
  const app = await account();
  selected(app, "profile");
  assert.equal(app.context.document.activeElement, null);
  assert.equal(app.$("#account-tabs").attrs.role, "tablist");
  assert.equal(app.$("#account-tabs").attrs["aria-orientation"], "horizontal");
  assert.equal(app.$("#profile-summary").children.length, 2);
  assert.equal(app.$("#mcp-cards").children.length, 1);
  assert.equal(app.$("#share-cards").children.length, 20);
});

test("点击切换保留双分页和筛选参数且不重取业务数据", async () => {
  const app = await account("?pageIndex=2&pageSize=10&mcpStatus=active&mcpPageSize=20&mcpPageIndex=1");
  const initial = app.requests.length;
  app.$("#account-tab-keys").fire("click");
  selected(app, "keys");
  assert.equal(app.context.location.searchParams.get("accountTab"), "keys");
  for (const [name, value] of [["pageIndex", "2"], ["pageSize", "10"], ["mcpStatus", "active"], ["mcpPageSize", "20"], ["mcpPageIndex", "1"]])
    assert.equal(app.context.location.searchParams.get(name), value);
  assert.deepEqual(app.context.history.state, { keep: true });
  app.$("#account-tab-shares").fire("click");
  selected(app, "shares");
  assert.equal(app.$("#share-cards").children.length, 10);
  assert.equal(app.requests.length, initial);
});

test("白名单Tab恢复与非法参数回退", async () => {
  for (const section of ["profile", "keys", "shares"])
    selected(await account("?accountTab=" + section), section);
  selected(await account("?accountTab=javascript%3Aalert(1)"), "profile");
});

test("LTR方向键循环、Home/End和原生Enter/Space激活", async () => {
  const app = await account();
  assert(app.$("#account-tab-profile").fire("keydown", { key: "ArrowRight" }).prevented);
  selected(app, "keys");
  assert.equal(app.context.document.activeElement, app.$("#account-tab-keys"));
  app.$("#account-tab-keys").fire("keydown", { key: "End" });
  selected(app, "shares");
  app.$("#account-tab-shares").fire("keydown", { key: "ArrowRight" });
  selected(app, "profile");
  app.$("#account-tab-profile").fire("keydown", { key: "ArrowLeft" });
  selected(app, "shares");
  app.$("#account-tab-shares").fire("keydown", { key: "Home" });
  selected(app, "profile");
  for (const key of ["Enter", " ", "Tab", "ArrowDown"])
    assert.equal(app.$("#account-tab-profile").fire("keydown", { key }).prevented, false);
  for (const section of ["profile", "keys", "shares"])
    assert.equal(app.$("#account-tab-" + section).tag, "button");
});

test("三语主题切换保留选中并按实时RTL镜像导航", async () => {
  const app = await account("?accountTab=keys");
  for (const locale of ["zh-CN", "en-US", "ar-SA"])
    for (const theme of ["light", "dark"]) {
      app.context.I18n.apply({ locale, theme });
      selected(app, "keys");
      assert.equal(app.$("#account-tabs").attrs["aria-label"], app.context.I18n.t("accountTabs"));
      assert.equal(app.context.document.documentElement.dataset.mode, theme);
      assert.notEqual(app.context.I18n.t("accountTabs"), app.context.I18n.t("unknownError"));
    }
  app.$("#account-tab-keys").fire("keydown", { key: "ArrowRight" });
  selected(app, "profile");
  app.$("#account-tab-profile").fire("keydown", { key: "ArrowLeft" });
  selected(app, "keys");
});

test("历史恢复同步Tab且只在旧焦点隐藏时移动到新Tab", async () => {
  const app = await account();
  app.context.location.searchParams.set("accountTab", "shares");
  app.popstate();
  selected(app, "shares");
  assert.equal(app.context.document.activeElement, null);
  const focused = app.$("#share-cards");
  app.$("#account-panel-shares").append(focused);
  focused.focus();
  app.popstate();
  assert.equal(app.context.document.activeElement, focused);
  app.context.location.searchParams.set("accountTab", "keys");
  app.popstate();
  selected(app, "keys");
  assert.equal(app.context.document.activeElement, app.$("#account-tab-keys"));
});

test("资料与分享加载错误始终在Tab外可见并保留重试", async () => {
  const app = await account("?accountTab=keys", true);
  selected(app, "keys");
  assert.equal(app.$("#account-status").textContent, "登录已失效");
  assert.equal(app.$("#account-status").children.at(-1).textContent, "retry");
  assert(html.indexOf('id="account-status"') < html.indexOf('id="account-panel-profile"'));
  assert.equal(app.$("#profile-summary").attrs["aria-busy"], "false");
});

test("卡片纵向布局将操作栏推至底部并允许长文本及窄屏按钮换行", () => {
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  const card = css.match(/\.card\{([^}]+)\}/)[1];
  for (const expected of ["display:flex", "flex-direction:column", "min-inline-size:0", "overflow-wrap:anywhere"])
    assert(card.includes(expected), expected);
  const footer = css.match(/\.card>footer\{([^}]+)\}/)[1];
  for (const expected of ["margin-block-start:auto", "padding-block-start:var(--space-3)", "flex-shrink:0", "flex-wrap:wrap", "justify-content:flex-end"])
    assert(footer.includes(expected), expected);
  assert(css.includes(".card>footer button,.card>footer a{max-inline-size:100%;white-space:normal;overflow-wrap:anywhere}"));
  assert(!/\.card>footer\{[^}]*(?:position:absolute|position:fixed|block-size:)/.test(css));
});

test("窄屏Tab采用逻辑属性、可换行等宽控件与40px触控高度", () => {
  const css = fs.readFileSync(path.join(assets, "components.css"), "utf8");
  const rule = css.match(/\.account-tabs \[role="tab"\]\{([^}]+)\}/)[1];
  for (const expected of ["flex:1 1 0", "min-inline-size:0", "white-space:normal", "overflow-wrap:anywhere", "min-block-size:40px"])
    assert(rule.includes(expected), expected);
  assert(css.includes(".account-panel[hidden]{display:none}"));
});
