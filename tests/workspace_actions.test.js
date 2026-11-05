"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const script = fs.readFileSync(path.join(__dirname, "../web/assets/workspace.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../web/workspace.html"), "utf8");
const section = (start, end) => script.slice(script.indexOf(start), script.indexOf(end));

test("工作区搜索与标题同行，创建入口固定起始侧，多排操作固定末侧", () => {
  const heading = html.slice(html.indexOf('<header class="page-head workspace-heading">'), html.indexOf('</header>', html.indexOf('<header class="page-head workspace-heading">')));
  assert(heading.includes('id="workspace-title"'));
  assert(heading.includes('id="file-search"'));
  assert.equal((html.match(/id="file-search"/g) || []).length, 1);
  assert.match(html, /\.workspace-heading #file-search \{[^}]*margin-inline-start: auto/);
  assert.match(html, /\.page:has\(#workspace-picker:not\(\[hidden\]\)\) \.workspace-operation-grid \{[^}]*margin-inline-start: 0;[^}]*margin-inline-end: auto/);
  assert.match(html, /\.workspace-action-row > :first-child:nth-last-child\(2\) \{ grid-column: 2/);
  assert.match(html, /\.workspace-action-row > :only-child \{ grid-column: 3/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?flex-basis: 100%/);
});

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
    UI: { loading: (node, key) => { node.textContent = key; }, size: () => "1KB", date: () => "", empty: () => el("p") },
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

test("文件夹整行非交互区域进入，按钮及原生交互冒泡不误导航", async () => {
  const app = realm({ kind: "folder", name: "文档" }), opened = [];
  app.context.openFolder = async (value) => opened.push(value);
  app.context.window.getSelection = () => ({ toString: () => "" });
  app.run("renderFiles()");
  const row = app.nodes.get("#file-list").children[0];
  const click = (target, init = {}) => {
    const event = { button: 0, target, preventDefault() { this.defaultPrevented = true; }, ...init };
    row.onclick(event); return event;
  };
  for (const target of [row, ...row.children.slice(0, -1)]) {
    target.closest = () => null;
    assert.equal(click(target).defaultPrevented, true);
  }
  const actionsCell = row.children.at(-1), actionsContainer = actionsCell.children[0];
  assert.equal(actionsCell.attrs.class, "file-row-actions");
  for (const target of [actionsCell, actionsContainer]) {
    target.closest = (selector) => selector.includes(".file-row-actions") ? actionsCell : null;
    assert.equal(click(target).defaultPrevented, undefined, "操作单元格及容器空白均不进入目录");
  }
  assert.equal(opened.length, row.children.length);
  assert(opened.every((value) => value === "目录/文档"));
  const before = opened.length;
  for (const tag of ["a", "button", "input", "select", "textarea", "details", "summary", "label", '[role="button"]', '[role="menu"]', '[contenteditable]:not([contenteditable="false"])']) {
    const target = { closest(selector) { assert(selector.includes(tag)); return this; } };
    click(target);
  }
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) click(row, init);
  app.context.window.getSelection = () => ({ toString: () => "已选文本" });
  click(row);
  assert.equal(opened.length, before);
  await row.children[0].children[0].onclick();
  assert.equal(opened.length, before + 1, "名称按钮的原生键盘click仍可进入");
  const file = realm(); file.run("renderFiles()");
  assert.equal(file.nodes.get("#file-list").children[0].onclick, undefined);
});

test("三档成员权限由空间契约控制，manager显示管理按钮且不依赖账户角色", () => {
  for (const memberRole of ["viewer", "editor", "manager"]) {
    const app = realm({ canWrite: memberRole !== "viewer" });
    for (const key of ["#member-list", "#member-count", "#member-actions"]) app.nodes.set(key, app.el("div"));
    app.context.workspace.memberRole = memberRole;
    app.context.workspace.canManage = memberRole === "manager";
    app.context.me = { role: "editor" };
    app.context.members = [{ nickname: "成员", userId: "member", memberRole, isOwner: false }];
    app.context.inviteMember = () => {}; app.context.manageInvitations = () => {};
    app.run(section("  function renderMembers", "  function memberRoles"));
    app.run("renderMembers()");
    const actions = app.nodes.get("#member-actions").children;
    assert.deepEqual(actions.map((node) => node.attrs.key), memberRole === "manager" ? ["invite", "inviteManage"] : []);
    assert.equal(app.nodes.get("#member-list").children[0].children.length, memberRole === "manager" ? 3 : 2);
    assert.equal(app.nodes.get("#member-list").children[0].children[1].children[1].attrs.text, "memberRole_" + memberRole);
  }
  assert.doesNotMatch(script, /collaborate|member\.role/);
  assert.match(script, /if \(workspace\?\.canManage\)/);
  assert.match(script, /if \(workspace\?\.canWrite\)/);
  assert.match(script, /memberRole: v\.memberRole/);
});

test("编辑成员仅对服务端允许的本人文件展示写操作，其他文件仍可下载", () => {
  const app = realm({ canWrite: false });
  app.context.workspace.canWrite = true;
  app.context.workspace.memberRole = "editor";
  app.run("renderFiles()");
  app.nodes.get("#file-list").children[0].children.at(-1).children[0].children.at(-1).onclick();
  assert.deepEqual(Array.from(app.context.activeMenu.menu.children, (node) => node.attrs.key), ["previewDownload"]);
});

test("文件刷新后获取个人配额并展示，服务端配额错误不被当成上传成功", async () => {
  const app = realm();
  app.context.me = {};
  app.nodes.set("#personal-quota", app.el("div"));
  app.context.UI.quotaSummary = (quota) => app.el("p", { text: String(quota.usedFileCount) });
  app.context.API = async (key) => { assert.equal(key, "quota"); return { usedFileCount: 7 }; };
  app.run(section("  async function refreshQuota", "  async function loadFiles"));
  await app.run("refreshQuota()");
  assert.equal(app.context.me.quota.usedFileCount, 7);
  assert.equal(app.nodes.get("#personal-quota").children[0].attrs.text, "7");
  app.context.API = async () => { throw new Error("额度读取失败"); };
  await app.run("refreshQuota()");
  assert.equal(app.context.me.quota, null);
  assert.equal(app.nodes.get("#personal-quota").children[0].attrs.text, "额度读取失败");
  assert.match(section("  async function loadFiles", "  async function loadMembers"), /await refreshQuota\(\)/);
  assert.match(section("  async function uploadFiles", '  $("#file-search")'), /failed = true;\s*toast\(errorText\(e\), \{ kind: "error" \}\)/);
});

test("真实文件列表成功渲染后才发进入空间回执，失败不记账且可刷新重试", async () => {
  for (const failed of [false, true]) {
    const app = realm(), calls = [];
    app.nodes.set("#file-browser", app.el("section"));
    Object.assign(app.context, { AbortController, controller: null, requestId: 0, query: "", me: { role: "editor" },
      page: { embedded: false, fail() {} }, pager: { pageIndex: 1, pageSize: 20, busy() {}, accept: () => true },
      updateUrl() {}, refreshQuota: async () => {}, renderFiles: () => calls.push("render"),
      API: async (key) => { calls.push(key); if (key === "nodes" && failed) throw new Error("offline"); return { entries: [] }; },
    });
    app.run(section("  async function loadFiles", "  async function loadMembers"));
    await app.run("loadFiles()");
    assert.deepEqual(calls, failed ? ["nodes"] : ["nodes", "render", "onboardingVisit"]);
  }
});
test("预览出票绑定真实文件路径并仅内存传递回执票据", async () => {
  const app = realm(), calls = [];
  app.context.API = async (key, options) => { calls.push({ key, options }); return { previewUrl: "https://example.test/baba-share/preview/p/ticket/index.html", onboardingTicket: "memory-only" }; };
  app.context.FilePreview = { open: async (...args) => calls.push({ preview: args }) };
  app.run(section("  async function previewFile", "  async function shareFolder"));
  await app.run("previewFile(entries[0])");
  assert.equal(calls[0].options.body.path, "目录/index.html");
  assert.equal(calls[0].options.body.previewPath, undefined);
  assert.equal(calls[1].preview[1], "https://example.test/baba-share/preview/p/ticket/index.html");
  assert.equal(calls[1].preview[2].onboardingTicket, "memory-only");
});
test("现存分享只依据有效期判断可复用，不依赖已移除的撤销时间", () => {
  const context = vm.createContext({ Date });
  vm.runInContext(section("  const shareIsActive", "  async function shareFolder") + ";globalThis.isActive = shareIsActive;", context);
  for (const expireTime of [null, undefined, Date.now() + 60000]) assert.equal(context.isActive({ expireTime }), true);
  for (const expireTime of [0, Date.now(), Date.now() - 1]) assert.equal(context.isActive({ expireTime }), false);
  assert.doesNotMatch(script, /revokedTime/);
});

test("工作区操作保留等宽列和末侧对齐，按内容定行高并维持触控尺寸", () => {
  const operationGrid = html.match(/\.workspace-operation-grid\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(operationGrid, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(operationGrid, /gap: var\(--space-2\)/);
  assert.doesNotMatch(operationGrid, /grid-auto-rows/);
  assert.match(html, /\.workspace-action-row\s*\{[^}]*grid-column: 1 \/ -1;[^}]*grid-template-columns: subgrid/);
  const controls = html.match(/\.workspace-action-row > button,[\s\S]*?\{([^}]*)\}/)?.[1] || "";
  assert.match(controls, /min-block-size: 40px/);
  assert.doesNotMatch(controls, /block-size: 100%/);
  assert.doesNotMatch(html, /\.workspace-action-row\s*\{[^}]*grid-auto-rows/);
  assert.match(html, /@media \(max-width: 420px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /white-space: normal;\s*overflow-wrap: anywhere/);
  const group = html.slice(html.indexOf('<div class="workspace-operation-grid"'), html.indexOf('<section id="workspace-picker"'));
  assert.equal((group.match(/class="workspace-action-row"/g) || []).length, 2);
  assert.ok(group.indexOf('id="workspace-head-actions"') < group.indexOf('id="file-actions"'));
  assert.doesNotMatch(group, /file-pagination|file-search/);
  assert.equal((html.match(/id="file-actions"/g) || []).length, 1);
  assert.doesNotMatch(group, /row-reverse|margin-left|margin-right/);
});

test("创建入口参数在子页消费一次，取消重载不重复打开且未知账户角色不打开", async () => {
  for (const action of ["create", "unknown", null]) for (const role of ["editor", ""]) {
    const context = { URL, location: new URL("https://example.test/baba-share/workspace.html" + (action ? "?action=" + action : "")),
      me: null, workspaces: [], workspace: null, page: { ready: Promise.resolve(), complete: async () => {}, fail() {} },
      history: { state: null, replaceState(_, __, url) { context.location = new URL(url); } },
      API: async (key) => key === "me" ? { role } : [], readUrl() {}, renderChrome() {},
      async createWorkspace() { if (["admin", "editor"].includes(context.me.role)) context.opened++; }, opened: 0,
      $: () => ({ classList: { add() {} } }), errorText: () => "失败" };
    context.window = context;
    vm.createContext(context);
    const startup = script.slice(script.indexOf("  await page.ready;"), script.lastIndexOf("})();"));
    await vm.runInContext("(async () => {" + startup + "})()", context);
    assert.equal(context.opened, action === "create" && role === "editor" ? 1 : 0);
    assert.equal(context.location.searchParams.has("action"), false);
    await vm.runInContext("(async () => {" + startup + "})()", context);
    assert.equal(context.opened, action === "create" && role === "editor" ? 1 : 0);
  }
});

test("子页创建复用服务与名称校验，未知账户角色直接调用不创建表单", async () => {
  const context = { me: { role: "" }, I18n: { t: (key) => key }, workspaces: [],
    forms: [], formDialog: async (...args) => { context.forms.push(args); return { id: "created" }; },
    API: async () => [], notifyChanged() {}, async selectWorkspace(id) { context.selected = id; } };
  vm.createContext(context);
  vm.runInContext(section("  async function createWorkspace", "  async function editWorkspace"), context);
  await context.createWorkspace(); assert.equal(context.forms.length, 0);
  context.me.role = "editor";
  await context.createWorkspace();
  assert.equal(context.forms.length, 1); assert.equal(context.selected, "created");
  assert.equal(context.forms[0][1][0].validator("x".repeat(101)), "invalidInput");
  assert.equal(context.forms[0][1][0].validator("有效名称"), "");
});

test("网页新增文件统一上传，移除HTML新建模板但保留已有文件编辑重命名", () => {
  assert.doesNotMatch(script, /newHtml|Hello, babaShare|create_file|edit_file/);
  const actions = section('    $("#file-actions").replaceChildren();', '    $("#drop-zone").hidden');
  assert.match(actions, /button\("newFolder"/);
  assert.match(actions, /uploadMenu\(\)/);
  assert.doesNotMatch(actions, /API\("content"|editFile|newHtml/);
  assert.match(section("  async function editFile", "  async function renameEntry"), /method: "PUT"[\s\S]*path: entry\.path/);
  assert.match(section("  async function renameEntry", "  async function deleteEntry"), /method: "PATCH"/);
});

test("上传新手引导复用上传菜单，参数仅消费一次且只读不触发上传", async () => {
  for (const canWrite of [false, true]) {
    const menu = { open: false, querySelector: () => ({ focus() { context.focused++; } }) };
    const context = { URL, location: new URL("https://example.test/baba-share/workspace.html?workspaceId=space&onboardingTask=upload_file"),
      me: null, workspace: null, workspaces: [], page: { ready: Promise.resolve(), complete: async () => {}, fail() {} }, focused: 0, notices: [],
      history: { state: null, replaceState(_, __, url) { context.location = new URL(url); } },
      API: async (key) => key === "me" ? { role: "editor" } : [{ id: "space", canWrite }],
      readUrl() {}, renderChrome() {}, loadFiles: async () => {}, loadMembers: async () => {},
      $: (selector) => { assert.equal(selector, "#file-actions .upload-menu"); return menu; },
      toast: (message) => context.notices.push(message), I18n: { t: (key) => key }, errorText: (error) => error.message };
    context.window = context;
    vm.createContext(context);
    const startup = script.slice(script.indexOf("  await page.ready;"), script.lastIndexOf("})();"));
    await vm.runInContext("(async () => {" + startup + "})()", context);
    assert.equal(context.location.searchParams.has("onboardingTask"), false);
    assert.equal(menu.open, canWrite);
    assert.equal(context.focused, canWrite ? 1 : 0);
    assert.deepEqual(context.notices, canWrite ? [] : ["onboardingOwnSpace"]);
    await vm.runInContext("(async () => {" + startup + "})()", context);
    assert.equal(context.focused, canWrite ? 1 : 0);
  }
});

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
