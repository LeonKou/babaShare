"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, ".."), source = fs.readFileSync(path.join(root, "web/assets/onboarding.js"), "utf8");
const keys = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
function state(overrides = {}) { return { version: 1, enabled: true, nickname: "<img onerror=evil>", tasks: keys.map((key) => ({ key, completed: overrides.allComplete === true, completedTime: null })), completedCount: overrides.allComplete ? 6 : 0, totalCount: 6, allComplete: false, celebrationSeen: false, dismissed: false, ...overrides }; }
async function environment(options = {}) {
  const nodes = [], requests = [], navigation = [], events = new Map(), elements = new Map();
  let current = state(options.state), componentOptions, dialog;
  class Element {
    constructor(tag, attrs = {}) { this.tag = tag; this.attrs = attrs; this.children = []; this.hidden = false; this.textContent = attrs.text || ""; this.events = new Map(); this.classList = { add() {}, remove() {} }; nodes.push(this); }
    append(...items) { this.children.push(...items.filter(Boolean)); }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    setAttribute(key, value) { this.attrs[key] = value; }
    querySelector(selector) { return this.children.find((node) => node.tag === selector) || this.children.map((node) => node.querySelector?.(selector)).find(Boolean); }
    addEventListener(type, fn) { this.events.set(type, fn); }
  }
  const el = (tag, attrs, ...items) => { const node = new Element(tag, attrs); node.append(...items); return node; };
  const context = {
    console, URL, location: new URL("http://localhost/baba-share/onboarding.html"),
    I18n: { t: (key) => key, subscribe: () => () => {} },
    UI: { loading: (node) => { node.textContent = "loading"; }, $: (selector) => { if (!elements.has(selector)) elements.set(selector, el("div")); return elements.get(selector); }, el,
      button: (key, action) => { const node = el("button", { text: key }); node.action = action; return node; },
      page: () => ({ ready: Promise.resolve(), complete: async () => {}, fail() {}, embedded: true, on() {}, request: async (type, payload) => { navigation.push({ type, payload }); return true; } }),
      errorText: () => "error", toast() {},
      dialog: (title, build) => {
        const node = el("dialog", {}, el("h2", { text: title }));
        const close = () => node.events.get("close")?.(); build(node, close); dialog = { node, close }; return dialog;
      },
    },
    API: async (key, request) => {
      requests.push({ key, request });
      if (key === "me") return { role: options.role || "editor" };
      if (key === "workspaces") return options.spaces || [{ id: "viewer", canWrite: false }, { id: "owner", canWrite: true }];
      if (key === "onboardingUpdate") { if (options.patchFails) throw new Error("offline"); current = { ...current, ...request.body }; }
      if (key === "onboarding" && options.getFails) throw new Error("offline");
      return current;
    },
    OnboardingCelebration: { mount: (_, opts) => { componentOptions = opts; if (options.reduceMotion) opts.onComplete(); return { skip: () => opts.onComplete(), replay: () => {}, destroy: () => {}, updateLabels() {} }; } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: (type, fn) => events.set(type, fn), removeEventListener() {},
  };
  context.window = context; await vm.runInNewContext(source, context);
  return { nodes, requests, navigation, events, elements, get componentOptions() { return componentOptions; }, get dialog() { return dialog; }, current: () => current, setState: (value) => { current = state(value); } };
}
test("只展示后端任务完成状态，管理员隐藏且不请求任务", async () => {
  const app = await environment({ state: { tasks: keys.map((key, i) => ({ key, completed: i === 2 })), completedCount: 1 } });
  assert.equal(app.nodes.filter((node) => node.textContent === "onboardingDone").length, 1);
  assert.equal(app.nodes.filter((node) => node.textContent === "onboardingGo").length, 5);
  assert.equal(app.requests.some(({ key }) => key === "onboardingUpdate"), false);
  const admin = await environment({ role: "admin" });
  assert.equal(admin.requests.some(({ key }) => key === "onboarding"), false);
  assert.equal(admin.nodes.some((node) => node.textContent === "onboardingGo"), false);
});
test("任务响应必须六项唯一完整且计数一致，异常不渲染并保留重试", async () => {
  const tasks = state().tasks;
  const invalid = [
    { tasks: tasks.slice(0, 3), totalCount: 3 },
    { tasks: tasks.slice(0, 5) },
    { tasks: [] }, { tasks: [...tasks, tasks[0]] }, { tasks: [...tasks.slice(0, 5), null] },
    { tasks: [...tasks.slice(0, 5), tasks[0]] },
    { tasks: [...tasks.slice(0, 5), { key: "unknown_task", completed: false }] },
    { tasks: tasks.map(({ completed }) => ({ completed })) },
    { totalCount: 5 }, { totalCount: "6" },
    { completedCount: -1 }, { completedCount: 7 }, { completedCount: 0.5 }, { completedCount: "0" },
    { completedCount: 1 }, { allComplete: true, tasks, completedCount: 0 },
    { tasks: tasks.map((task) => ({ ...task, completed: "false" })) },
    { version: 2 }, { enabled: undefined }, { tasks: null },
    { enabled: false, tasks: tasks.slice(0, 3), totalCount: 3 },
    { enabled: false, tasks: [], totalCount: 0, completedCount: 0 },
  ];
  for (const value of invalid) {
    const app = await environment({ state: value });
    assert.equal(app.elements.get("#onboarding-status").textContent, "error", JSON.stringify(value));
    assert.equal(app.elements.get("#onboarding-retry").children[0].textContent, "onboardingRetry");
    assert.equal(app.elements.get("#onboarding-content").children.length, 0);
    assert.equal(app.nodes.some((node) => node.tag === "ol"), false);
  }
});
test("错误响应重试后恢复六项，刷新及更新错误不渲染部分任务", async () => {
  const app = await environment({ state: { tasks: state().tasks.slice(0, 5) } });
  app.setState({});
  await app.elements.get("#onboarding-retry").children[0].action();
  const content = app.elements.get("#onboarding-content");
  assert.equal(content.children[1].children.length, 6);
  assert.equal(app.elements.get("#onboarding-retry").children.length, 0);
  const rendered = content.children[1];
  app.setState({ tasks: state().tasks.slice(0, 3) });
  await app.events.get("focus")();
  assert.equal(content.children[1], rendered);
  assert.equal(rendered.children.length, 6);
  assert.equal(app.elements.get("#onboarding-status").textContent, "error");
  await app.nodes.find((node) => node.textContent === "onboardingCollapse").action();
  assert.equal(content.children[1], rendered);
  assert.equal(app.elements.get("#onboarding-status").textContent, "error");
});
test("母版同样拒绝不完整响应，不展示错误进度且可重新请求", async () => {
  const shell = fs.readFileSync(path.join(root, "web/assets/shell.js"), "utf8");
  const refresh = shell.slice(shell.indexOf("  let onboarding ="), shell.indexOf('  window.addEventListener("focus", refreshOnboarding)'));
  let value = state(), renders = 0, requests = 0;
  const context = { user: { role: "editor" }, OnboardingFeedback: { create: () => ({ accept() {} }) }, disposed: false, startupState: "ready", startupController: new AbortController(), API: async () => { requests++; return value; }, renderNav: () => renders++, console: { warn() {} } };
  vm.runInNewContext(refresh + ";globalThis.refresh = refreshOnboarding; globalThis.current = () => onboarding;", context);
  await context.refresh();
  assert.equal(context.current(), value);
  for (const invalid of [
    { tasks: state().tasks.slice(0, 3), totalCount: 3 },
    { tasks: state().tasks.slice(0, 5) },
    { tasks: Array(6).fill(state().tasks[0]) },
    { tasks: [...state().tasks.slice(0, 5), null] },
    { enabled: false, tasks: [], totalCount: 0, completedCount: 0 },
    { tasks: [...state().tasks.slice(0, 5), { key: "unknown_task", completed: false }] },
    { totalCount: 5 }, { completedCount: 1 }, { completedCount: -1 }, { completedCount: 7 }, { version: 2 },
  ]) {
    value = state(invalid);
    await context.refresh();
    assert.equal(context.current(), null, JSON.stringify(invalid));
  }
  value = state(); await context.refresh();
  assert.equal(context.current(), value);
  value = state({ enabled: false });
  await context.refresh(); assert.equal(context.current().enabled, false);
  assert.equal(renders, requests);
  context.user.role = "admin";
  const before = requests;
  await context.refresh(); assert.equal(requests, before);
});
test("六任务响应可乱序但展示固定顺序，完整禁用响应隐藏任务", async () => {
  const app = await environment({ state: { tasks: state().tasks.reverse() } });
  assert.deepEqual(app.nodes.filter((node) => node.tag === "h2").map((node) => node.textContent), keys.map((key) => "onboarding_" + key));
  for (const value of [{ enabled: false }, { enabled: false, tasks: state().tasks.reverse() }]) {
    const disabled = await environment({ state: value });
    assert.equal(disabled.elements.get("#onboarding-content").hidden, true);
    assert.equal(disabled.elements.get("#onboarding-status").textContent, "onboardingUnavailable");
    assert.equal(disabled.elements.get("#onboarding-retry").children.length, 0);
  }
});
test("写任务仅跳转可写空间，全只读时引导创建自己的工作区", async () => {
  const app = await environment();
  await app.nodes.filter((node) => node.textContent === "onboardingGo")[1].action();
  const nav = app.navigation.find(({ type }) => type === "shell.navigate");
  assert.equal(nav.payload.params.workspaceId, "owner"); assert.equal(nav.payload.params.onboardingTask, "create_folder");
  const viewer = await environment({ spaces: [{ id: "readonly", canWrite: false }] });
  await viewer.nodes.filter((node) => node.textContent === "onboardingGo")[2].action();
  const redirect = viewer.navigation.find(({ type }) => type === "shell.navigate");
  assert.equal(redirect.payload.params.action, "create"); assert.equal(redirect.payload.params.workspaceId, undefined);
});
test("六项任务有序展示，MCP任务复用个人中心密钥页且不伪造完成", async () => {
  const app = await environment({ spaces: [] });
  const titles = app.nodes.filter((node) => node.tag === "h2").map((node) => node.textContent);
  assert.deepEqual(titles, keys.map((key) => "onboarding_" + key));
  const actions = app.nodes.filter((node) => node.textContent === "onboardingGo");
  for (const index of [4, 5]) {
    const before = app.requests.length;
    await actions[index].action();
    const nav = app.navigation.at(-1);
    assert.equal(nav.type, "shell.navigate");
    assert.equal(nav.payload.routeId, "account");
    assert.equal(nav.payload.params.accountTab, "keys");
    assert.equal(Object.keys(nav.payload.params).length, 1);
    assert.equal(app.requests.length, before);
  }
  assert.equal(app.current().completedCount, 0);
  assert.equal(app.requests.some(({ key }) => key === "onboardingUpdate"), false);
});
test("任务数据与母版接收版本1，桥事件保持协议1", async () => {
  const app = await environment();
  await app.nodes.find((node) => node.textContent === "onboardingCollapse").action();
  const changed = app.navigation.find(({ type }) => type === "onboarding.changed");
  assert.equal(app.current().version, 1);
  assert.equal(changed.payload.version, 1);
  const shell = fs.readFileSync(path.join(root, "web/assets/shell.js"), "utf8");
  assert.match(shell, /value\?\.version !== 1/);
  assert.match(shell, /if \(payload\?\.version !== 1\) return false/);
});
test("收起持久化只使用服务端响应，失败保留任务并可重试", async () => {
  const app = await environment();
  await app.nodes.find((node) => node.textContent === "onboardingCollapse").action();
  assert.equal(app.current().dismissed, true);
  assert.equal(app.nodes.filter((node) => node.tag === "ol").at(-1).hidden, true);
  const failed = await environment({ patchFails: true });
  await failed.nodes.find((node) => node.textContent === "onboardingCollapse").action();
  assert.equal(failed.current().dismissed, false); assert(failed.nodes.some((node) => node.textContent === "onboardingRetry"));
});
test("全完成只解锁入口，显式打开且真实终态才保存，重看保持可用", async () => {
  const app = await environment({ state: { allComplete: true, completedCount: 6 } });
  assert.equal(app.dialog, undefined);
  await app.nodes.find((node) => node.textContent === "onboardingLaunch").action();
  assert(app.dialog); assert.equal(app.requests.some(({ key }) => key === "onboardingUpdate"), false);
  assert.equal(app.componentOptions.nickname, "<img onerror=evil>");
  app.componentOptions.onComplete(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.current().celebrationSeen, true);
  assert(app.nodes.some((node) => node.textContent === "onboardingReplay"));
});
test("减少动画mount同步终态也可保存，重复终态与收起并发不重复提交", async () => {
  const app = await environment({ state: { allComplete: true }, reduceMotion: true });
  await app.nodes.find((node) => node.textContent === "onboardingLaunch").action();
  app.componentOptions.onComplete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.current().celebrationSeen, true);
  assert.equal(app.requests.filter(({ key }) => key === "onboardingUpdate").length, 1);
  const plain = await environment();
  const toggle = plain.nodes.find((node) => node.textContent === "onboardingCollapse");
  await Promise.all([toggle.action(), toggle.action()]);
  assert.equal(plain.requests.filter(({ key }) => key === "onboardingUpdate").length, 1);
});
test("关闭中途不保存seen，保存失败保留显式重试且不假成功", async () => {
  const app = await environment({ state: { allComplete: true } });
  await app.nodes.find((node) => node.textContent === "onboardingLaunch").action();
  app.dialog.close(); app.componentOptions.onComplete();
  assert.equal(app.requests.some(({ key }) => key === "onboardingUpdate"), false);
  const failed = await environment({ state: { allComplete: true }, patchFails: true });
  await failed.nodes.find((node) => node.textContent === "onboardingLaunch").action();
  failed.componentOptions.onComplete(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed.current().celebrationSeen, false);
  assert(failed.nodes.some((node) => node.textContent === "onboardingRetry" && !node.hidden));
});
test("加载失败保留重试、无轮询及跨iframe DOM，三语资源与无障碍外壳齐备", async () => {
  const app = await environment({ getFails: true });
  assert(app.nodes.some((node) => node.textContent === "onboardingRetry"));
  assert.doesNotMatch(source, /setInterval|parent\.document|contentDocument|localStorage/);
  const css = fs.readFileSync(path.join(root, "web/assets/onboarding.css"), "utf8");
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /html\[dir="rtl"\]/);
  assert.match(source, /initialFocus: "\.onboarding-stage-close"/);
  const i18n = fs.readFileSync(path.join(root, "web/assets/i18n.js"), "utf8");
  for (const key of ["onboardingIntro", "onboardingSaveFailed", "onboardingStage_message", "onboardingStage_sceneDescription", "onboardingStage_achievement6", ...keys.flatMap((key) => ["onboarding_" + key, "onboardingHint_" + key])]) assert.equal((i18n.match(new RegExp(key + ":", "g")) || []).length, 3);
  assert.doesNotMatch(i18n, /onboarding(?:Hint)?_(?:create_file|edit_file):|onboardingEditHint:/);
  assert.doesNotMatch(source, /create_file|edit_file/);
  assert.match(i18n, /六个小步骤/); assert.match(i18n, /Six small steps/); assert.match(i18n, /ست خطوات/);
});
