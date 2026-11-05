"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, ".."), read = (name) => fs.readFileSync(path.join(root, "web/assets", name), "utf8");
const source = read("onboarding-feedback.js");
const keys = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
function state(completed = [], extra = {}) { return { version: 1, enabled: true, totalCount: 6, completedCount: completed.length, allComplete: completed.length === 6, tasks: keys.map((key) => ({ key, completed: completed.includes(key) })), ...extra }; }
function runtime({ reduced = false, hidden = false, canvasAvailable = true } = {}) {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type) { for (const fn of [...this.listeners.get(type) || []]) fn({}); }
  }
  const body = { children: [], append(node) { this.children.push(node); } };
  const media = Object.assign(new Events(), { matches: reduced });
  let clock = 0, seq = 0, painted = 0, stars = 0, circles = 0, apiCalls = 0, apiValue = state(), listener;
  const timers = new Map(), frames = new Map(), translations = new Set(), positions = [];
  const document = Object.assign(new Events(), { hidden, body, documentElement: {}, createElement(tag) {
    return { tag, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
      getContext() { return canvasAvailable ? { scale() {}, clearRect() {}, save() {}, translate(x, y) { positions.push([x, y]); }, rotate() {}, beginPath() {}, arc() { circles++; }, moveTo() { stars++; }, lineTo() {}, closePath() {}, fill() { painted++; }, fillRect() { painted++; }, restore() {} } : null; },
      remove() { body.children = body.children.filter((node) => node !== this); },
      set innerHTML(_) { assert.fail("反馈文案不得解析HTML"); } };
  } });
  const context = Object.assign(new Events(), { console, document, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 3,
    performance: { now: () => clock }, matchMedia: () => media,
    getComputedStyle: () => ({ getPropertyValue: (name) => name }),
    I18n: { t: (key, params = {}) => key + JSON.stringify(params), subscribe(fn) { translations.add(fn); return () => translations.delete(fn); } },
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(fn) { const id = ++seq; frames.set(id, fn); return id; }, cancelAnimationFrame: (id) => frames.delete(id),
    API: async () => { apiCalls++; if (listener) return listener(); return apiValue; },
  });
  context.window = context; vm.runInNewContext(source, context);
  return { context, document, body, media, timers, frames, translations, positions, feedback: context.OnboardingFeedback.create(),
    get painted() { return painted; }, get stars() { return stars; }, get circles() { return circles; }, get apiCalls() { return apiCalls; },
    setValue(value) { apiValue = value; }, setApi(fn) { listener = fn; },
    notice: () => body.children.find((node) => node.tag === "div"), canvas: () => body.children.find((node) => node.tag === "canvas"),
    advance(ms) { const target = clock + ms; while ([...timers.values()].some((timer) => timer.at <= target)) { const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]; clock = timer.at; timers.delete(id); timer.fn(); } clock = target; },
    frame(ms = 16) { clock += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn(clock)); },
  };
}
test("首次完整响应仅建基线，旧进度与刷新不回放，异常响应不能建立基线", () => {
  const app = runtime(); app.feedback.accept(state([], { tasks: [] }));
  app.feedback.accept(state(keys.slice(0, 3))); app.advance(3000);
  assert.equal(app.body.children.length, 0);
  app.feedback.accept(state(keys.slice(0, 3))); app.advance(3000); assert.equal(app.body.children.length, 0);
  const refreshed = runtime(); refreshed.feedback.accept(state(keys)); refreshed.advance(3000); assert.equal(refreshed.body.children.length, 0);
});
test("六任务全完成上升沿立即替换单任务场次，星星圆形纸屑多波持续15秒且只触发一次", () => {
  const app = runtime(); app.feedback.accept(state(keys.slice(0, 4)));
  app.feedback.accept(state(keys.slice(0, 5))); app.advance(120);
  const single = app.canvas(), stale = [...app.frames.values()][0];
  app.feedback.accept(state(keys));
  assert.notEqual(app.canvas(), single); assert.equal(app.notice().textContent, "onboardingUnlocked{}");
  assert.equal(app.body.children.length, 2); assert.equal(app.timers.size, 1); assert.equal(app.frames.size, 1);
  const full = app.canvas(); stale(121); assert.equal(app.canvas(), full); assert.equal(app.frames.size, 1);
  app.frame(0); assert.equal(app.painted, 220); assert(app.stars > 0); assert(app.circles > 0);
  for (const origin of [0.2, 0.5, 0.8]) {
    const points = app.positions.filter(([x]) => x === 1200 * origin);
    assert.equal(points.length, 30); assert(points.every(([, y]) => y >= 800 * 0.15 && y < 800 * 0.45));
  }
  app.frame(16);
  for (let group = 0; group < 3; group++) {
    const start = 130 + group * 30, [x, y] = app.positions[start], scattered = app.positions.slice(220 + start, 220 + start + 30);
    assert(scattered.some(([nextX]) => nextX < x)); assert(scattered.some(([nextX]) => nextX > x));
    assert(scattered.some(([, nextY]) => nextY < y)); assert(scattered.some(([, nextY]) => nextY > y));
  }
  const first = app.painted; app.frame(500); assert.equal(app.painted - first, 420);
  app.frame(500); const before = app.painted; app.frame(500); assert(app.painted - before <= 420);
  app.frame(10000); assert.equal(app.canvas(), full); assert.equal(app.frames.size, 1);
  app.feedback.accept(state(keys)); app.feedback.accept(state(keys.slice(0, 5))); app.feedback.accept(state(keys));
  assert.equal(app.canvas(), full); assert.equal(app.timers.size, 1);
  app.advance(4000); assert.equal(app.body.children.length, 0); assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0);
  app.feedback.accept(state(keys)); app.advance(120); assert.equal(app.body.children.length, 0);
});
test("最后任务直接取代排队的短礼花，初始完整基线和禁用完成均不补播", () => {
  const app = runtime(); app.feedback.accept(state(keys.slice(0, 4)));
  app.feedback.accept(state(keys.slice(0, 5))); app.feedback.accept(state(keys));
  assert.equal(app.notice().textContent, "onboardingUnlocked{}"); assert.equal(app.timers.size, 1);
  const full = app.canvas(); app.advance(3000); assert.equal(app.canvas(), full);
  const baseline = runtime(); baseline.feedback.accept(state(keys)); baseline.feedback.accept(state(keys.slice(0, 5))); baseline.feedback.accept(state(keys)); baseline.advance(120);
  assert.equal(baseline.body.children.length, 0);
  const disabled = runtime(); disabled.feedback.accept(state(keys.slice(0, 5))); disabled.feedback.accept(state(keys, { enabled: false })); disabled.feedback.accept(state(keys)); disabled.advance(120);
  assert.equal(disabled.body.children.length, 0);
});
test("全完成礼花支持后台延后、减少动画、禁用和卸载清理", () => {
  const hidden = runtime({ hidden: true }); hidden.feedback.accept(state(keys.slice(0, 5))); hidden.feedback.accept(state(keys));
  assert.equal(hidden.body.children.length, 0); hidden.document.hidden = false; hidden.document.fire("visibilitychange");
  assert(hidden.canvas()); assert.equal(hidden.notice().textContent, "onboardingUnlocked{}");
  hidden.media.matches = true; hidden.media.fire("change"); assert(hidden.notice()); assert.equal(hidden.canvas(), undefined); assert.equal(hidden.frames.size, 0);
  hidden.context.fire("pagehide"); assert.equal(hidden.body.children.length, 0); assert.equal(hidden.timers.size, 0);
  const reduced = runtime({ reduced: true }); reduced.feedback.accept(state(keys.slice(0, 5))); reduced.feedback.accept(state(keys));
  assert(reduced.notice()); assert.equal(reduced.canvas(), undefined); assert.equal(reduced.frames.size, 0);
  reduced.feedback.accept(state(keys, { enabled: false })); assert.equal(reduced.body.children.length, 0); assert.equal(reduced.timers.size, 0);
  const unavailable = runtime({ canvasAvailable: false }); unavailable.feedback.accept(state(keys.slice(0, 5))); unavailable.feedback.accept(state(keys));
  assert(unavailable.notice()); assert.equal(unavailable.canvas(), undefined);
});
test("单任务首次真实变化发射双侧纸屑和文字，实际逐帧绘制且2.6秒结束", () => {
  const app = runtime(); app.feedback.accept(state()); app.feedback.accept(state([keys[0]])); app.advance(120);
  assert(app.notice().textContent.includes("onboarding_" + keys[0]));
  assert.equal(app.canvas().attrs["aria-hidden"], "true"); assert.equal(app.canvas().width, 2400);
  app.frame(); assert.equal(app.painted, 130);
  assert.equal(app.frames.size, 1); app.frame(2700); assert.equal(app.canvas(), undefined); assert.equal(app.frames.size, 0);
  app.advance(3000); assert.equal(app.body.children.length, 0); assert.equal(app.timers.size, 0);
});
test("重复通知、短时旧响应及多任务同批合并，不重复也不叠加粒子", () => {
  const app = runtime(); app.feedback.accept(state());
  app.feedback.accept(state([keys[0]])); app.feedback.accept(state(keys.slice(0, 3))); app.feedback.accept(state(keys.slice(0, 3)));
  app.advance(120); assert(app.notice().textContent.includes('"count":3')); assert.equal(app.body.children.length, 2);
  const canvas = app.canvas(); app.feedback.accept(state(keys.slice(0, 4))); app.advance(120);
  assert.equal(app.canvas(), canvas); assert(app.notice().textContent.includes('"count":4'));
  app.advance(4000); app.feedback.accept(state()); app.feedback.accept(state(keys.slice(0, 4))); app.advance(120);
  assert.equal(app.body.children.length, 0);
});
test("减少动画仅文字，运行中开启立即撤销帧且文字保留；无canvas可用也显示反馈", () => {
  const app = runtime({ reduced: true }); app.feedback.accept(state()); app.feedback.accept(state([keys[0]])); app.advance(120);
  assert(app.notice()); assert.equal(app.canvas(), undefined); assert.equal(app.frames.size, 0);
  app.advance(3000); assert.equal(app.body.children.length, 0);
  const playing = runtime(); playing.feedback.accept(state()); playing.feedback.accept(state([keys[1]])); playing.advance(120);
  playing.media.matches = true; playing.media.fire("change"); assert(playing.notice()); assert.equal(playing.canvas(), undefined); assert.equal(playing.frames.size, 0);
  const unavailable = runtime({ canvasAvailable: false }); unavailable.feedback.accept(state()); unavailable.feedback.accept(state([keys[0]])); unavailable.advance(120);
  assert(unavailable.notice()); assert.equal(unavailable.canvas(), undefined); assert.equal(unavailable.frames.size, 0);
});
test("隐藏页清理动画，后台新完成合并至可见时展示，pagehide彻底清理且迟到回调无效", () => {
  const app = runtime(); app.feedback.accept(state()); app.feedback.accept(state([keys[0]])); app.advance(120);
  const stale = [...app.frames.values()][0]; app.document.hidden = true; app.document.fire("visibilitychange");
  assert.equal(app.body.children.length, 0); assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0);
  app.feedback.accept(state(keys.slice(0, 3))); app.advance(60000); assert.equal(app.body.children.length, 0);
  app.document.hidden = false; app.document.fire("visibilitychange"); assert(app.notice().textContent.includes('"count":2'));
  app.context.fire("pagehide"); stale(70000); app.feedback.accept(state(keys));
  assert.equal(app.body.children.length, 0); assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0); assert.equal(app.translations.size, 0);
  for (const events of [app.context, app.document, app.media]) assert([...events.listeners.values()].every((set) => set.size === 0));
});
test("禁用时仅记录完成不播动画，启用不会补播；可见文字切语言原地更新", () => {
  const app = runtime(); app.feedback.accept(state()); app.feedback.accept(state([keys[0]], { enabled: false })); app.feedback.accept(state([keys[0]])); app.advance(120);
  assert.equal(app.body.children.length, 0); app.feedback.accept(state(keys.slice(0, 2))); app.advance(120);
  app.context.I18n.t = (key) => "العربية:" + key; [...app.translations][0]();
  assert(app.notice().textContent.startsWith("العربية:")); assert.equal(app.frames.size, 1);
});
test("独立页建立基线并在focus同步MCP变化；嵌入与管理员不重复请求，卸载后忽略响应", async () => {
  const app = runtime(); const module = app.context.OnboardingFeedback;
  assert.equal(await module.connect({ embedded: true }, { role: "editor" }), null);
  assert.equal(await module.connect({ embedded: false }, { role: "admin" }), null); assert.equal(app.apiCalls, 0);
  const connection = await module.connect({ embedded: false }, { role: "editor" }); assert.equal(app.apiCalls, 1);
  app.setValue(state([keys[5]])); app.context.fire("focus"); await connection.refresh(); app.advance(120);
  assert(app.notice().textContent.includes("onboarding_" + keys[5]));
  let resolve; app.setApi(() => new Promise((done) => { resolve = done; })); const pending = connection.refresh(); app.context.fire("pagehide"); resolve(state(keys)); await pending;
  assert.equal(app.body.children.length, 0); assert.equal(app.frames.size, 0);
});
test("同步在途收到另一完成通知会补一次真实请求，避免遗漏竞态中的任务", async () => {
  const app = runtime(); let resolve;
  app.setApi(() => new Promise((done) => { resolve = done; }));
  const connecting = app.context.OnboardingFeedback.connect({ embedded: false }, { role: "editor" });
  const coalesced = app.context.OnboardingFeedback.refresh();
  resolve(state()); await new Promise((done) => setImmediate(done));
  resolve(state([keys[0]])); await connecting; await coalesced; app.advance(120);
  assert.equal(app.apiCalls, 2); assert(app.notice());
});
test("母版首次基线与在途通知补刷联动实际反馈，错误响应不伪造完成", async () => {
  const app = runtime(); const context = app.context;
  Object.assign(context, { user: { role: "editor" }, disposed: false, startupState: "ready", renderNav() {} });
  const shell = read("shell.js");
  const refreshSource = shell.slice(shell.indexOf("  let onboarding ="), shell.indexOf('  window.addEventListener("focus", refreshOnboarding)'));
  vm.runInContext(refreshSource + ";globalThis.refreshShell = refreshOnboarding;", vm.createContext(context));
  await context.refreshShell(); assert.equal(app.body.children.length, 0);
  let resolve; app.setApi(() => new Promise((done) => { resolve = done; }));
  const first = context.refreshShell(), second = context.refreshShell();
  resolve(state()); await new Promise((done) => setImmediate(done));
  resolve(state([keys[4], keys[5]])); await first; await second; app.advance(120);
  assert.equal(app.apiCalls, 3); assert(app.notice().textContent.includes('"count":2'));
  app.advance(3000); app.setApi(async () => state(keys, { tasks: [] })); await context.refreshShell(); app.advance(120);
  assert.equal(app.body.children.length, 0);
});
test("iframe既有onboarding.changed桥接在母版全屏自动发射，重复桥接不重播", async () => {
  const app = runtime(), context = app.context, shell = read("shell.js");
  Object.assign(context, { user: { role: "editor" }, disposed: false, startupState: "ready", renderNav() {}, iframe: {}, navigate() {}, AppBridgeHost: { create: (config) => config } });
  const refreshSource = shell.slice(shell.indexOf("  let onboarding ="), shell.indexOf('  window.addEventListener("focus", refreshOnboarding)'));
  const hostSource = shell.slice(shell.indexOf("  function createHost("), shell.indexOf('  window.addEventListener("pageshow"'));
  vm.runInContext(refreshSource + hostSource + ';globalThis.refreshShell = refreshOnboarding;globalThis.shellHost = createHost("session", () => {});', vm.createContext(context));
  app.setValue(state(keys.slice(0, 5))); await context.refreshShell();
  const changed = context.shellHost.handlers["onboarding.changed"];
  app.setValue(state(keys)); assert.equal(await changed({ version: 2 }), false); assert.equal(app.apiCalls, 1);
  assert.equal(await changed({ version: 1 }), true); assert.equal(app.apiCalls, 2);
  const canvas = app.canvas(); assert(canvas); assert.equal(canvas.width, 2400); assert.equal(app.notice().textContent, "onboardingUnlocked{}");
  app.frame(); assert(app.stars > 0); assert(app.circles > 0); app.advance(3000); assert.equal(app.canvas(), canvas);
  await changed({ version: 1 }); assert.equal(app.canvas(), canvas); assert.equal(app.timers.size, 1);
  app.advance(12000); assert.equal(app.body.children.length, 0); assert.equal(app.frames.size, 0);
});
test("独立页对话框和全屏宿主内呈现，关闭对话框清除粒子及帧", () => {
  const app = runtime(); const listeners = new Map();
  const host = { children: [], append(node) { this.children.push(node); }, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
  app.document.querySelectorAll = () => [host]; app.feedback.accept(state()); app.feedback.accept(state([keys[3]])); app.advance(120);
  assert.equal(host.children.length, 2); assert.equal(app.body.children.length, 0);
  listeners.get("close")(); assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0); assert.equal(listeners.size, 0);
});
test("母版、独立页与业务触发均接入，分享页与Office不引入；样式不截获交互并支持RTL主题", () => {
  for (const file of ["index.html", "workspace.html", "account.html", "onboarding.html"]) assert(fs.readFileSync(path.join(root, "web", file), "utf8").includes('src="assets/onboarding-feedback.js"'));
  assert(!fs.readFileSync(path.join(root, "web/share.html"), "utf8").includes("onboarding-feedback"));
  assert(read("shell.js").includes("taskFeedback.accept(value)"));
  assert(read("workspace.js").includes("OnboardingFeedback?.connect(page, me)"));
  assert(read("account.js").includes('bridge.request("onboarding.changed", { version: 1 })'));
  assert(read("preview.js").includes("else window.OnboardingFeedback?.refresh()"));
  const css = read("components.css"); assert(css.includes("pointer-events:none")); assert(css.includes(".onboarding-confetti{inset:0")); assert(css.includes(".onboarding-task-notice{inset-block-start:"));
  assert(!/parent\.document|contentDocument|innerHTML|setInterval|https?:|localStorage|sessionStorage/.test(source));
  assert.equal((read("i18n.js").match(/onboardingTaskCongratulations:/g) || []).length, 3);
});
