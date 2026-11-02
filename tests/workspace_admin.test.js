"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../web");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("管理员新增文案三语完整且阿语方向由公共层确定", () => {
  const document = { documentElement: { lang: "zh-CN", dataset: {} }, querySelectorAll: () => [] };
  const warnings = [];
  const context = vm.createContext({ window: {}, document, console: { warn: (...values) => warnings.push(values) } });
  vm.runInContext(source("assets/i18n.js"), context);
  const i18n = context.window.I18n;
  const keys = ["workspaceFilters", "appliedFilters", "noAppliedFilters", "resetFilters", "workspace-admin", "workspaceAdminHint", "userWorkspaces", "deleteAccount", "accountDeleted", "deleteAccountConfirm", "SELF_DELETE_FORBIDDEN", "OWNER_INVALID", "WORKSPACE_NAME_CONFLICT", "systemCustody", "accountOwned", "originalCreator", "ownerStatus", "allOwners", "allUsers", "userAssociation", "associationType", "associationAny", "associationOwner", "associationMember", "workspaceSearch", "creatorSearch", "transferWorkspace", "recipient", "transferHint", "workspaceMembers", "memberSummary", "collaborator", "independentMember", "noWorkspaceMembers", "noTransferRecipient", "openWorkspace", "emptyManagedSpaces", "managedSpaceEmptyHint", "unknownCreator"];
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) {
    i18n.apply({ locale });
    for (const key of keys) assert.ok(i18n.t(key).length, `${locale}:${key}`);
    assert.equal(document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
  }
  assert.equal(warnings.length, 0);
});

test("管理员独立页面使用共用资源与原生搜索、无嵌入DOM越界", () => {
  const html = source("workspace-admin.html");
  const script = source("assets/workspace-admin.js");
  for (const resource of ["tokens.css", "components.css", "boot.js", "common.js", "page-bridge.js", "pagination.js"]) assert.ok(html.includes(resource));
  assert.match(html, /<form id="admin-search"/);
  assert.match(html, /<button type="submit"/);
  for (const id of ["admin-user", "admin-relation", "admin-owner", "admin-query", "admin-creator"]) assert.ok(html.includes(`for="${id}"`));
  assert.ok(html.indexOf('id="admin-pagination"') < html.indexOf('id="admin-cards"'));
  assert.doesNotMatch(script, /parent\.document|innerHTML|window\.prompt|window\.alert/);
  assert.match(source("assets/api.js"), /workspaceAdmin: "\/workspace-admin\/list"/);
  assert.match(source("assets/api.js"), /workspaceOwnership: "\/workspace\/ownership"/);
  assert.match(source("assets/shell.js"), /\["users", "settings", "workspace-admin"\].includes/);
  assert.match(source("assets/common.js"), /["']?workspace-admin["']?\s*:\s*["']workspace-admin\.html/);
});

function focusDom() {
  const document = { createTextNode: (text) => text, activeElement: null };
  const create = (tag, attrs = {}, ...children) => {
    const node = {
      tag, ...attrs, children: [], attrs, value: attrs.value || "", hidden: false, disabled: false,
      handlers: {}, classList: { add() {}, remove() {} },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      append(...items) { items = items.filter((item) => item != null); this.children.push(...items); for (const item of items) if (typeof item === "object") item.parentElement = this; },
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; }, removeAttribute(key) { delete this.attrs[key]; },
      addEventListener(key, callback) { this.handlers[key] = callback; },
      contains(target) { return this === target || this.children.some((item) => typeof item === "object" && item.contains(target)); },
      closest(selector) { return this.tag === selector ? this : this.parentElement?.closest(selector); },
      querySelector(selector) {
        if (selector === "footer button") return this.querySelector("footer")?.querySelector("button");
        const matches = (item) => selector.split(",").some((part) => part === item.tag || part === "a[href]" && item.tag === "a" && item.href);
        for (const item of this.children) if (typeof item === "object") { if (matches(item)) return item; const found = item.querySelector(selector); if (found) return found; }
        return null;
      },
      focus() { document.activeElement = this; },
    };
    node.append(...children);
    return node;
  };
  return { document, create };
}

function pageRealm({ afterTransfer, formDialog } = {}) {
  const nodes = new Map(), calls = [], events = [], dialogs = [];
  const { document, create } = focusDom();
  for (const id of ["admin-search", "admin-user", "admin-relation", "admin-owner", "admin-query", "admin-creator", "admin-status", "admin-cards", "admin-empty", "admin-pagination", "admin-filter-summary", "admin-reset", "admin-filters"]) nodes.set("#" + id, create("div"));
  const submit = create("button");
  nodes.get("#admin-search").querySelector = () => submit;
  nodes.get("#admin-search").elements = { namedItem: (key) => nodes.get({ userId: "#admin-user", relation: "#admin-relation", ownerStatus: "#admin-owner", search: "#admin-query", creator: "#admin-creator" }[key]) };
  const users = [
    { id: "editor", nickname: "Editor", userName: "editor", role: "editor", isDisabled: false },
    { id: "admin", nickname: "Admin", userName: "admin", role: "admin", isDisabled: false },
    { id: "viewer", nickname: "Viewer", userName: "viewer", role: "viewer", isDisabled: false },
    { id: "disabled", nickname: "Disabled", userName: "disabled", role: "editor", isDisabled: true },
  ];
  const row = { id: "space", workspaceName: "Shared", owner: null, ownerId: null, creatorNickname: "Original", members: [], memberCount: 0, collaboratorCount: 0 };
  const bridge = { embedded: true, ready: Promise.resolve(), request: async (...args) => events.push(args), emit: (...args) => events.push(args) };
  const pager = { pageIndex: 1, pageSize: 20, accept: () => true, reset() { this.pageIndex = 1; }, busy() {} };
  const context = vm.createContext({
    URL, AbortController, console,
    location: { href: "http://localhost/workspace-admin.html?userId=editor&relation=member" }, history: { replaceState() {} },
    document, window: { addEventListener() {} },
    FormData: class { *[Symbol.iterator]() { yield ["userId", "editor"]; yield ["relation", "member"]; yield ["ownerStatus", "system"]; yield ["search", "Sha"]; yield ["creator", "Orig"]; } },
    I18n: { t: (key) => key, subscribe() {} },
    LocalPager: () => pager,
    API: async (key, options) => { calls.push({ key, options }); if (key === "workspaceOwnership") await afterTransfer?.({ document, nodes }); return key === "users" ? users : key === "workspaceAdmin" ? { totalCount: 1, totalPage: 1, data: [row] } : {}; },
    UI: {
      $: (key) => nodes.get(key), el: create,
      button: (key, callback) => create("button", { key, onclick: callback }),
      page: () => bridge, toast() {}, errorText: (error) => error.message,
      routeUrl: (route, params) => route + ".html?" + new URLSearchParams(params), empty: () => create("p"),
      formDialog: async (title, fields, callback, options) => { dialogs.push({ title, fields, options }); return formDialog ? formDialog({ callback, document, create, nodes }) : callback({ ownerId: "editor" }); },
    },
    URLSearchParams,
  });
  return { context, nodes, calls, events, dialogs, submit, document, create };
}

async function userRealm({ ids = ["target"], afterDelete, confirm } = {}) {
  const nodes = new Map(), calls = [], notices = [];
  const { document, create } = focusDom();
  for (const id of ["user-pagination", "user-cards", "user-empty", "user-actions", "user-status", "user-search", "user-query"]) nodes.set("#" + id, create("div"));
  let list = ids.map((id) => ({ id, nickname: id, userName: id, role: "editor", isDisabled: false }));
  const context = vm.createContext({
    window: {}, document, AbortController, console,
    I18n: { t: (key) => key, subscribe() {} },
    LocalPager: () => ({ slice: (items) => items, busy() {}, reset() {} }),
    UI: { $: (selector) => nodes.get(selector), el: create, button: (key, action) => create("button", { key, onclick: action }), formDialog() {}, toast: (text) => notices.push(text), errorText: (error) => error.message, date: () => "", empty: () => create("p"), routeUrl: (route) => route + ".html", confirm: async () => confirm ? confirm({ document, create, nodes }) : true, page: () => ({ ready: Promise.resolve(), embedded: false }) },
    API: async (key, options) => { calls.push({ key, options }); if (key === "me") return { id: "admin" }; if (key === "users") return list; if (key === "user" && options.method === "DELETE") { list = list.filter((user) => user.id !== options.query.id); await afterDelete?.({ document, nodes }); return {}; } },
  });
  vm.runInContext(source("assets/users.js"), context);
  await flush();
  const card = (id) => nodes.get("#user-cards").children.find((node) => node.getAttribute("data-id") === id);
  const remove = (id) => card(id).querySelector("details").querySelector("div").children.find((node) => node.key === "deleteAccount");
  return { document, nodes, calls, notices, card, remove };
}

test("账户物理删除须确认并按query调用，取消不提交", async () => {
  let confirmed = false;
  const realm = await userRealm({ confirm: () => confirmed });
  await realm.remove("target").onclick();
  assert.equal(realm.calls.filter((call) => call.key === "user").length, 0);
  confirmed = true;
  await realm.remove("target").onclick();
  const deletion = realm.calls.find((call) => call.key === "user");
  assert.equal(deletion.options.method, "DELETE");
  assert.equal(deletion.options.query.id, "target");
  assert.equal(realm.nodes.get("#user-cards").children.length, 0);
  assert.equal(realm.notices.at(-1), "accountDeleted");
});

test("删除后依次恢复下一卡、上一卡和无卡搜索入口", async () => {
  for (const [ids, target, expected] of [
    [["before", "target", "after"], "target", "after"],
    [["before", "target"], "target", "before"],
    [["target"], "target", null],
  ]) {
    const realm = await userRealm({ ids });
    realm.remove(target).focus();
    await realm.remove(target).onclick();
    assert.equal(realm.document.activeElement, expected ? realm.card(expected).querySelector("button") : realm.nodes.get("#user-query"));
  }
});

test("删除等待期间用户移至搜索框则不抢焦点", async () => {
  const realm = await userRealm({ ids: ["target", "after"], afterDelete: ({ nodes }) => nodes.get("#user-query").focus() });
  realm.remove("target").focus();
  await realm.remove("target").onclick();
  assert.equal(realm.document.activeElement, realm.nodes.get("#user-query"));
});

test("删除确认dialog仍在触发链中时恢复下一卡", async () => {
  const realm = await userRealm({ ids: ["target", "after"], confirm: ({ create }) => { const control = create("button"); create("dialog", {}, control); control.focus(); return true; } });
  realm.remove("target").focus();
  await realm.remove("target").onclick();
  assert.equal(realm.document.activeElement, realm.card("after").querySelector("button"));
});

test("转交刷新保留当前卡入口且不抢主动离开的焦点", async () => {
  for (const leave of [false, true]) {
    const realm = pageRealm({ afterTransfer: leave ? ({ nodes }) => nodes.get("#admin-query").focus() : null });
    vm.runInContext(source("assets/workspace-admin.js"), realm.context);
    await flush();
    const control = realm.nodes.get("#admin-cards").children[0].querySelector("footer button");
    control.focus();
    await control.onclick();
    const current = realm.nodes.get("#admin-cards").children[0];
    assert.equal(current.getAttribute("data-id"), "space");
    assert.equal(realm.document.activeElement, leave ? realm.nodes.get("#admin-query") : current.querySelector("footer button"));
  }
});

test("转交提交dialog焦点尚未归还时仍恢复当前卡入口", async () => {
  const realm = pageRealm({ formDialog: ({ callback, create }) => { const control = create("button"); create("dialog", {}, control); control.focus(); return callback({ ownerId: "editor" }); } });
  vm.runInContext(source("assets/workspace-admin.js"), realm.context);
  await flush();
  const control = realm.nodes.get("#admin-cards").children[0].querySelector("footer button");
  control.focus();
  await control.onclick();
  assert.equal(realm.document.activeElement, realm.nodes.get("#admin-cards").children[0].querySelector("footer button"));
});

test("管理员页面恢复关联筛选、原生提交和转交只展示有效editor/admin", async () => {
  const realm = pageRealm();
  vm.runInContext(source("assets/workspace-admin.js"), realm.context);
  await flush();
  const initial = realm.calls.find((call) => call.key === "workspaceAdmin");
  assert.equal(initial.options.query.userId, "editor");
  assert.equal(initial.options.query.relation, "member");
  assert.equal(realm.nodes.get("#admin-user").value, "editor");
  assert.equal(realm.submit.disabled, false);
  let prevented = false;
  realm.nodes.get("#admin-search").handlers.submit({ preventDefault() { prevented = true; } });
  await flush();
  assert.ok(prevented);
  const latest = realm.calls.filter((call) => call.key === "workspaceAdmin").at(-1);
  assert.equal(latest.options.query.search, "Sha");
  assert.equal(latest.options.query.ownerStatus, "system");
  const card = realm.nodes.get("#admin-cards").children[0];
  const transfer = card.children.at(-1).children.find((node) => node.key === "transferWorkspace");
  await transfer.onclick();
  assert.deepEqual(Array.from(realm.dialogs[0].fields[0].options, (option) => option.value), ["editor", "admin"]);
  const request = realm.calls.find((call) => call.key === "workspaceOwnership");
  assert.equal(request.options.method, "PATCH");
  assert.equal(request.options.body.id, "space");
  assert.equal(request.options.body.ownerId, "editor");
  assert.equal(realm.events.at(-1)[0], "workspace.changed");
});
