"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (name) => fs.readFileSync(path.join(__dirname, "../web/assets", name), "utf8");
const source = read("onboarding-celebration.js");
const css = read("onboarding-celebration.css");
const keys = ["eyebrow", "title", "message", "dedication", "creator", "brand", "sceneDescription", "completed", "achievement1", "achievement2", "achievement3", "achievement4", "achievement5", "achievement6"];

function runtime({ reduced = false, hidden = false, options = {} } = {}) {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
  }
  class Element extends Events {
    constructor(tag) { super(); this.tag = tag; this.dataset = {}; this.attrs = {}; this.children = []; this.parentNode = null; this.textContent = ""; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); this.parentNode = null; }
    querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
    set innerHTML(_) { assert.fail("昵称与文案禁止经过 HTML 解析"); }
    get offsetWidth() { return 800; }
  }
  const document = Object.assign(new Events(), { hidden });
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  const media = Object.assign(new Events(), { matches: reduced });
  const timers = new Map(), warnings = [];
  let clock = 0, nextTimer = 0, completions = 0;
  const context = Object.assign(new Events(), {
    document, matchMedia: () => media, performance: { now: () => clock },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { assert.fail("彩蛋不能无限循环"); },
    requestAnimationFrame() { assert.fail("彩蛋不创建 JS 逐帧工作"); },
    fetch() { assert.fail("彩蛋不得访问网络或伪造完成任务"); },
  });
  context.window = context;
  document.defaultView = context;
  const container = new Element("div");
  container.ownerDocument = document;
  const sibling = new Element("button"); container.append(sibling);
  for (const key of ["localStorage", "sessionStorage", "location"]) Object.defineProperty(context, key, { get() { assert.fail("彩蛋不得读取 " + key); } });
  vm.createContext(context);
  vm.runInContext(source, context);
  const mountOptions = { nickname: "小林", onComplete: () => { completions += 1; }, ...options };
  const api = context.OnboardingCelebration.mount(container, mountOptions);
  const root = container.children[1];
  const nodes = root.querySelectorAll();
  return { context, document, media, container, sibling, root, nodes, api, timers, warnings, mountOptions,
    get completions() { return completions; },
    byClass(name) { return nodes.find((node) => (node.className || node.attrs.class || "").split(" ").includes(name)); },
    advance(ms) {
      const target = clock + ms;
      while ([...timers.values()].some((timer) => timer.at <= target)) {
        const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        clock = timer.at; timers.delete(id); timer.fn();
      }
      clock = target;
    },
  };
}

test("默认十秒有限动画，六项成就和双角色矢量主视觉，完成仅回调一次", () => {
  const app = runtime();
  assert.equal(app.root.dataset.state, "playing");
  assert.equal(app.timers.size, 1);
  assert.equal(app.nodes.filter((node) => node.attrs.class?.split(" ").includes("oc-character")).length, 2);
  assert.equal(app.nodes.filter((node) => node.attrs.class?.split(" ").includes("oc-star")).length, 6);
  for (const part of ["oc-face", "oc-hair", "oc-eye", "oc-smile", "oc-trousers", "oc-shoes", "oc-document", "oc-fold", "oc-plane-wing"]) assert(app.byClass(part));
  assert.equal(app.byClass("oc-scene").attrs.role, "img");
  assert.equal(app.byClass("oc-scene").attrs.viewBox, "0 0 800 440");
  app.advance(9999); assert.equal(app.completions, 0);
  app.advance(1); assert.equal(app.completions, 1);
  assert.equal(app.root.dataset.state, "complete");
  assert.equal(app.timers.size, 0);
  assert(app.byClass("oc-status").textContent);
  app.api.skip(); app.advance(100000);
  assert.equal(app.completions, 1);
});

test("跳过、重播均保持原昵称 DOM，重播重置完整十秒并可再次完成", () => {
  const app = runtime();
  const name = app.byClass("oc-nickname");
  app.advance(3500); app.api.skip();
  assert.equal(app.completions, 1);
  assert.equal(app.timers.size, 0);
  app.api.replay();
  assert.equal(app.root.dataset.state, "playing");
  assert.equal(app.byClass("oc-nickname"), name);
  assert.equal(app.byClass("oc-status").textContent, "");
  app.advance(9999); assert.equal(app.completions, 1);
  app.advance(1); assert.equal(app.completions, 2);
  app.api.replay(); app.advance(2000); app.api.replay(); app.advance(9999);
  assert.equal(app.completions, 2);
  app.advance(1); assert.equal(app.completions, 3);
});

test("减少动画立即静态终态，无定时器；运行中切换同样结束且不自动重播", () => {
  const reduced = runtime({ reduced: true });
  assert.equal(reduced.root.dataset.state, "complete");
  assert.equal(reduced.timers.size, 0); assert.equal(reduced.completions, 1);
  reduced.api.replay(); assert.equal(reduced.completions, 2); assert.equal(reduced.timers.size, 0);
  const app = runtime(); app.advance(1000);
  app.media.matches = true; app.media.fire("change");
  assert.equal(app.root.dataset.state, "complete"); assert.equal(app.timers.size, 0);
  app.media.matches = false; app.media.fire("change");
  assert.equal(app.root.dataset.state, "complete"); assert.equal(app.completions, 1);
});

test("后台暂停剩余时间与CSS动画，恢复继续；初始后台不启动计时", () => {
  const app = runtime(); app.advance(3200);
  app.document.hidden = true; app.document.fire("visibilitychange");
  assert.equal(app.root.dataset.paused, "true"); assert.equal(app.timers.size, 0);
  app.advance(60000); assert.equal(app.completions, 0);
  app.document.hidden = false; app.document.fire("visibilitychange");
  assert.equal(app.root.dataset.paused, "false");
  app.advance(6799); assert.equal(app.completions, 0);
  app.advance(1); assert.equal(app.completions, 1);
  const hidden = runtime({ hidden: true }); hidden.advance(20000);
  assert.equal(hidden.timers.size, 0); assert.equal(hidden.completions, 0);
  hidden.document.hidden = false; hidden.document.fire("visibilitychange");
  hidden.advance(10000); assert.equal(hidden.completions, 1);
});

test("BFCache 暂停恢复，普通卸载与显式销毁清理所有监听与计时，不移除宿主其他子项", () => {
  const app = runtime(); app.advance(2000);
  app.context.fire("pagehide", { persisted: true });
  app.advance(30000); assert.equal(app.completions, 0);
  app.context.fire("pageshow"); app.advance(7999); assert.equal(app.completions, 0);
  app.advance(1); assert.equal(app.completions, 1);
  app.api.replay();
  const stale = [...app.timers.values()][0].fn;
  app.context.fire("pagehide", { persisted: false });
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.container.children, [app.sibling]);
  for (const target of [app.document, app.context, app.media]) assert([...target.listeners.values()].every((entries) => entries.size === 0));
  app.api.destroy(); app.api.replay(); app.api.skip(); stale();
  app.context.fire("pageshow"); app.document.fire("visibilitychange");
  assert.equal(app.timers.size, 0); assert.equal(app.completions, 1);
});

test("同容器重新挂载先销毁旧实例，迟到旧回调不会干扰新实例", () => {
  const app = runtime();
  const stale = [...app.timers.values()][0].fn;
  const second = app.context.OnboardingCelebration.mount(app.container, app.mountOptions);
  assert.equal(app.container.children.length, 2);
  assert.equal(app.timers.size, 1);
  app.api.replay(); stale(); assert.equal(app.completions, 0);
  app.advance(10000); assert.equal(app.completions, 1);
  second.destroy(); assert.deepEqual(app.container.children, [app.sibling]);
});

test("昵称、品牌、翻译只用textContent，无网络、存储、任务数据和HTML注入", () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const labels = Object.fromEntries(keys.map((key) => [key, malicious + key]));
  const app = runtime({ options: { nickname: malicious, labels } });
  assert.equal(app.byClass("oc-nickname").textContent, malicious);
  assert.equal(app.byClass("oc-nickname").attrs.dir, "auto");
  assert.equal(app.byClass("oc-brand").textContent, malicious + "brand");
  assert.equal(app.warnings.length, 0);
  assert(!app.nodes.some((node) => ["img", "script", "iframe"].includes(node.tag)));
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|fetch\(|localStorage|sessionStorage|setInterval/.test(source));
});

test("外部三语标签全量接入，缺key有中文回退提示，昵称为空不留下空署名", () => {
  for (const marker of ["中文", "English", "العربية"]) {
    const labels = Object.fromEntries(keys.map((key) => [key, marker + key]));
    const app = runtime({ options: { nickname: "", labels } });
    assert.equal(app.byClass("oc-title").textContent, labels.title);
    assert.equal(app.byClass("oc-nickname").textContent, labels.creator);
    assert(app.byClass("oc-scene").attrs["aria-label"].includes(labels.achievement6));
    assert.equal(app.warnings.length, 0);
    app.api.skip(); assert.equal(app.byClass("oc-status").textContent, labels.completed);
  }
  const fallback = runtime(); assert.equal(fallback.warnings.length, 1);
  assert.equal(fallback.byClass("oc-title").textContent, "让作品，启航。");
  assert.equal(fallback.byClass("oc-brand").textContent, "babaShare");
  assert.deepEqual(fallback.nodes.filter((node) => node.tag === "title").map((node) => node.textContent), ["进入空间", "建立文件夹", "上传作品", "成功预览作品", "创建 MCP Key", "成功调用 MCP 工具"]);
});

test("运行中切换语言原地更新所有文案，不重播、不改变剩余时间或重复完成回调", () => {
  const app = runtime();
  const scene = app.byClass("oc-scene"), plane = app.byClass("oc-plane");
  app.advance(3500);
  const timer = [...app.timers.values()][0];
  const labels = Object.fromEntries(keys.map((key) => [key, "العربية " + key]));
  app.api.updateLabels(labels);
  assert.equal(app.byClass("oc-title").textContent, labels.title);
  assert.equal(app.byClass("oc-message").textContent, labels.message);
  assert.equal(app.byClass("oc-dedication").textContent, labels.dedication);
  assert.equal(app.byClass("oc-nickname").textContent, "小林");
  assert.equal(app.root.attrs["aria-label"], labels.title);
  assert(scene.attrs["aria-label"].includes(labels.achievement6));
  assert.equal(app.nodes.filter((node) => node.tag === "title")[0].textContent, labels.achievement1);
  assert.equal(app.byClass("oc-scene"), scene); assert.equal(app.byClass("oc-plane"), plane);
  assert.equal([...app.timers.values()][0], timer);
  assert.equal(app.root.dataset.state, "playing"); assert.equal(app.completions, 0);
  app.advance(6500); assert.equal(app.completions, 1);
  assert.equal(app.byClass("oc-status").textContent, labels.completed);
  const updated = { ...labels, completed: "Finished", title: "Ready" };
  app.api.updateLabels(updated);
  assert.equal(app.byClass("oc-status").textContent, "Finished");
  assert.equal(app.root.dataset.state, "complete"); assert.equal(app.completions, 1);
  assert.equal(app.timers.size, 0);
  app.api.destroy(); app.api.updateLabels(labels);
  assert.equal(app.byClass("oc-title").textContent, "Ready");
});

test("语言更新空昵称回退随文案更新，更新文本不解析HTML", () => {
  const app = runtime({ options: { nickname: "" } });
  const labels = Object.fromEntries(keys.map((key) => [key, '<img src=x onerror="alert(1)">' + key]));
  app.api.updateLabels(labels);
  assert.equal(app.byClass("oc-nickname").textContent, labels.creator);
  assert.equal(app.byClass("oc-title").textContent, labels.title);
  assert.equal(app.byClass("oc-brand").textContent, labels.brand);
  assert(!app.nodes.some((node) => node.tag === "img"));
});

test("样式限定组件、语义主题令牌、RTL与窄屏，有限GPU动效不创建全屏弹层", () => {
  assert(css.includes(":dir(rtl) .oc-scene"));
  assert(css.includes("max-width: 560px"));
  assert(css.includes("container-type: inline-size"));
  assert(css.includes("@container onboarding-celebration (max-width: 510px)"));
  assert(css.includes("prefers-reduced-motion: reduce"));
  assert(css.includes("animation-play-state: paused"));
  assert(css.includes('data-state="complete"'));
  assert(!/infinite|position:\s*fixed|z-index:\s*\d|#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css));
  assert(!/(?:margin|padding|inset|border)-(?:left|right)\s*:/.test(css));
  assert(!/\b(?:width|height|top|left|margin|padding)\s*:/.test(css.slice(css.indexOf("@keyframes"), css.indexOf("@media"))));
  for (const line of css.split("\n")) if (line.trim().startsWith(".")) assert(line.trim().startsWith(".onboarding-celebration"));
  assert(!/parent\.document|dialog|fullscreen|download|navigator\.share/.test(source));
});
