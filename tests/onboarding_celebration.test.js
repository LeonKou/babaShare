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
    getContext() {
      const drawing = { canvas: this, shapes: [], clears: [], transforms: [], colors: [], path: null, x: 0, y: 0 };
      drawings.push(drawing);
      return {
        setTransform(...values) { drawing.transforms.push(values); },
        clearRect(...values) { drawing.clears.push({ at: clock, values }); },
        save() {}, restore() {}, rotate() {},
        translate(x, y) { drawing.x = x; drawing.y = y; },
        set fillStyle(value) { drawing.colors.push(value); },
        fillRect() { drawing.shapes.push({ at: clock, shape: "paper", x: drawing.x, y: drawing.y }); },
        beginPath() { drawing.path = "star"; },
        arc() { drawing.path = "circle"; },
        moveTo() {}, lineTo() {}, closePath() {},
        fill() { drawing.shapes.push({ at: clock, shape: drawing.path, x: drawing.x, y: drawing.y }); },
      };
    }
  }
  const document = Object.assign(new Events(), { hidden });
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  const media = Object.assign(new Events(), { matches: reduced });
  const timers = new Map(), frames = new Map(), drawings = [], warnings = [];
  const colors = ["primary", "success", "warning", "danger", "text"];
  document.body = new Element("body");
  let clock = 0, nextTimer = 0, nextFrame = 0, completions = 0;
  const context = Object.assign(new Events(), {
    document, matchMedia: () => media, performance: { now: () => clock },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { assert.fail("彩蛋不能无限循环"); },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 3,
    getComputedStyle: () => ({ getPropertyValue: (name) => colors[["--color-primary", "--color-success", "--color-warning", "--color-danger", "--color-text-primary"].indexOf(name)] }),
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, { fn, at: clock + 1000 / 60 }); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
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
  return { context, document, media, container, sibling, root, nodes, api, timers, frames, drawings, colors, warnings, mountOptions,
    get completions() { return completions; },
    byClass(name) { return nodes.find((node) => (node.className || node.attrs.class || "").split(" ").includes(name)); },
    advance(ms) {
      const target = clock + ms;
      while (true) {
        const scheduled = [...timers.entries()].map(([id, value]) => ({ id, ...value, collection: timers }))
          .concat([...frames.entries()].map(([id, value]) => ({ id, ...value, collection: frames })))
          .filter((value) => value.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!scheduled) break;
        clock = scheduled.at; scheduled.collection.delete(scheduled.id); scheduled.fn(clock);
      }
      clock = target;
    },
  };
}

test("默认十五秒有限动画，六项成就和双角色矢量主视觉，完成仅回调一次", () => {
  const app = runtime();
  assert.equal(app.root.dataset.state, "playing");
  assert.equal(app.timers.size, 1);
  assert.equal(app.nodes.filter((node) => node.attrs.class?.split(" ").includes("oc-character")).length, 2);
  assert.equal(app.nodes.filter((node) => node.attrs.class?.split(" ").includes("oc-star")).length, 6);
  for (const part of ["oc-face", "oc-hair", "oc-eye", "oc-smile", "oc-trousers", "oc-shoes", "oc-document", "oc-fold", "oc-plane-wing"]) assert(app.byClass(part));
  assert.equal(app.byClass("oc-scene").attrs.role, "img");
  assert.equal(app.byClass("oc-scene").attrs.viewBox, "0 0 800 440");
  app.advance(14999); assert.equal(app.completions, 0);
  app.advance(1); assert.equal(app.completions, 1);
  assert.equal(app.root.dataset.state, "complete");
  assert.equal(app.timers.size, 0);
  assert(app.byClass("oc-status").textContent);
  app.api.skip(); app.advance(100000);
  assert.equal(app.completions, 1);
});

test("跳过、重播均保持原昵称 DOM，重播重置完整十五秒并可再次完成", () => {
  const app = runtime();
  const name = app.byClass("oc-nickname");
  app.advance(3500); app.api.skip();
  assert.equal(app.completions, 1);
  assert.equal(app.timers.size, 0);
  app.api.replay();
  assert.equal(app.root.dataset.state, "playing");
  assert.equal(app.byClass("oc-nickname"), name);
  assert.equal(app.byClass("oc-status").textContent, "");
  app.advance(14999); assert.equal(app.completions, 1);
  app.advance(1); assert.equal(app.completions, 2);
  app.api.replay(); app.advance(2000); app.api.replay(); app.advance(14999);
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
  app.advance(11799); assert.equal(app.completions, 0);
  app.advance(1); assert.equal(app.completions, 1);
  const hidden = runtime({ hidden: true }); hidden.advance(20000);
  assert.equal(hidden.timers.size, 0); assert.equal(hidden.completions, 0);
  hidden.document.hidden = false; hidden.document.fire("visibilitychange");
  hidden.advance(15000); assert.equal(hidden.completions, 1);
});

test("BFCache 暂停恢复，普通卸载与显式销毁清理所有监听与计时，不移除宿主其他子项", () => {
  const app = runtime(); app.advance(2000);
  app.context.fire("pagehide", { persisted: true });
  app.advance(30000); assert.equal(app.completions, 0);
  app.context.fire("pageshow"); app.advance(12999); assert.equal(app.completions, 0);
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
  app.advance(15000); assert.equal(app.completions, 1);
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
  app.advance(11500); assert.equal(app.completions, 1);
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

test("全视口礼花持续多次发射星形、圆形与纸片，十五秒结束并清除RAF和Canvas", () => {
  const app = runtime(), drawing = app.drawings[0], canvas = drawing.canvas;
  assert.deepEqual(app.document.body.children, [canvas]);
  assert.equal(canvas.attrs["aria-hidden"], "true");
  assert.equal(canvas.width, 2880); assert.equal(canvas.height, 1800);
  assert.deepEqual(drawing.transforms[0], [2, 0, 0, 2, 0, 0]);
  app.advance(12000);
  assert.equal(app.completions, 0); assert.equal(app.frames.size, 1);
  assert(drawing.shapes.some((shape) => shape.at > 10000 && shape.x < 60));
  assert(drawing.shapes.some((shape) => shape.at > 10000 && shape.x > 1380), "十秒后仍从屏幕双侧散射");
  assert(drawing.shapes.some((shape) => shape.x > 1440 * 0.25 && shape.x < 1440 * 0.75 && shape.y < 900 * 0.55));
  assert.deepEqual([...new Set(drawing.shapes.map((shape) => shape.shape))].sort(), ["circle", "paper", "star"]);
  assert.deepEqual([...new Set(drawing.colors)].sort(), app.colors.slice().sort());
  const batches = new Map();
  for (const shape of drawing.shapes) batches.set(shape.at, (batches.get(shape.at) || 0) + 1);
  assert(Math.max(...batches.values()) <= 420, "每帧粒子数量有界");
  assert(drawing.clears.length <= 361, "绘制不超过每秒30帧");
  app.advance(3000);
  assert.equal(app.completions, 1); assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0);
  assert.equal(canvas.parentNode, null);
  const count = drawing.shapes.length; app.advance(60000);
  assert.equal(drawing.shapes.length, count); assert.equal(app.completions, 1);
});

test("重复可见性通知不多开礼花，重播取消旧帧和旧定时器，迟到回调不干扰新场次", () => {
  const app = runtime(); app.advance(1000);
  const oldCanvas = app.drawings[0].canvas, staleFrame = [...app.frames.values()][0].fn, staleTimer = [...app.timers.values()][0].fn;
  app.document.fire("visibilitychange"); app.context.fire("pageshow"); app.media.fire("change");
  assert.equal(app.drawings.length, 1); assert.equal(app.frames.size, 1); assert.equal(app.timers.size, 1);
  app.api.replay();
  assert.equal(oldCanvas.parentNode, null); assert.equal(app.document.body.children.length, 1);
  assert.equal(app.drawings.length, 2); assert.equal(app.frames.size, 1); assert.equal(app.timers.size, 1);
  staleFrame(50000); staleTimer();
  assert.equal(app.root.dataset.state, "playing"); assert.equal(app.completions, 0); assert.equal(app.frames.size, 1);
  app.advance(14999); assert.equal(app.completions, 0);
  app.advance(1); assert.equal(app.completions, 1); assert.equal(app.frames.size, 0);
});

test("减少动态仅保留文字且不创建Canvas，暂停隐藏帧、关闭和pagehide完全清理", () => {
  const reduced = runtime({ reduced: true });
  assert.equal(reduced.drawings.length, 0); assert.equal(reduced.frames.size, 0); assert.equal(reduced.timers.size, 0);
  assert(reduced.byClass("oc-message").textContent); assert(reduced.byClass("oc-status").textContent);
  const app = runtime(); app.advance(200);
  const canvas = app.drawings[0].canvas;
  app.document.hidden = true; app.document.fire("visibilitychange");
  assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0); assert.equal(canvas.hidden, true);
  app.document.hidden = false; app.document.fire("visibilitychange");
  assert.equal(app.frames.size, 1); assert.equal(canvas.hidden, false);
  app.media.matches = true; app.media.fire("change");
  assert.equal(canvas.parentNode, null); assert.equal(app.frames.size, 0); assert.equal(app.timers.size, 0);
  for (const event of ["destroy", "pagehide"]) {
    const active = runtime(); active.advance(100);
    if (event === "destroy") active.api.destroy(); else active.context.fire("pagehide", { persisted: false });
    assert.equal(active.frames.size, 0); assert.equal(active.timers.size, 0); assert.equal(active.document.body.children.length, 0);
  }
});

test("视口变化重设Canvas尺寸，主题切换后的新发射读取当前语义配色", () => {
  const app = runtime(), drawing = app.drawings[0];
  app.context.innerWidth = 390; app.context.innerHeight = 844; app.context.devicePixelRatio = 1;
  app.context.fire("resize");
  assert.equal(drawing.canvas.width, 390); assert.equal(drawing.canvas.height, 844);
  app.colors.splice(0, app.colors.length, "新主色", "新成功", "新警告", "新危险", "新文字");
  app.advance(1200);
  assert(drawing.colors.includes("新主色")); assert(drawing.colors.includes("新文字"));
  assert.deepEqual(drawing.clears.at(-1).values, [0, 0, 390, 844]);
});

test("样式限定组件、语义主题令牌、RTL与窄屏，全屏Canvas不阻挡交互", () => {
  assert(css.includes(":dir(rtl) .oc-scene"));
  assert(css.includes("max-width: 560px"));
  assert(css.includes("container-type: inline-size"));
  assert(css.includes("@container onboarding-celebration (max-width: 510px)"));
  assert(css.includes("prefers-reduced-motion: reduce"));
  assert(css.includes("animation-play-state: paused"));
  assert(css.includes('data-state="complete"'));
  assert(!/infinite|#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css));
  assert.match(css, /\.onboarding-celebration-confetti\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*inline-size:\s*100%;[^}]*block-size:\s*100%;[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.onboarding-celebration-confetti, \.onboarding-celebration \.oc-art \{ display: none; \}/);
  assert(!/(?:margin|padding|inset|border)-(?:left|right)\s*:/.test(css));
  assert(!/\b(?:width|height|top|left|margin|padding)\s*:/.test(css.slice(css.indexOf("@keyframes"), css.indexOf("@media"))));
  for (const line of css.split("\n")) if (line.trim().startsWith(".")) assert(line.trim().startsWith(".onboarding-celebration"));
  assert(!/parent\.document|showModal|requestFullscreen|download|navigator\.share/.test(source));
});
