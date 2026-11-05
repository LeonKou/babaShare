"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (name) => fs.readFileSync(path.join(__dirname, "../web", name), "utf8");

function runtime({ reduced = false, compact = false, observe = true, auth = false, loading = false } = {}) {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
  }
  class Element extends Events {
    constructor(tag) { super(); this.tag = tag; this.dataset = {}; this.attrs = {}; this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
  }
  const document = new Events(), root = new Element("aside"); root.id = auth ? "auth-product-demo" : "test-demo";
  if (loading) root.dataset.loadingDemo = "";
  document.documentElement = { lang: "zh-CN", dataset: { mode: "dark", accent: "blue" } };
  document.hidden = false;
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  document.querySelectorAll = (selector) => selector === "[data-product-demo]" ? [root] : [];
  const small = Object.assign(new Events(), { matches: compact });
  const reduce = Object.assign(new Events(), { matches: reduced });
  const warnings = []; let observer;
  const context = Object.assign(new Events(), {
    document, console: { warn: (...args) => warnings.push(args) },
    matchMedia: (query) => query.includes("reduced") ? reduce : small,
    setTimeout() { assert.fail("展示动画不应使用JS计时器"); },
    setInterval() { assert.fail("展示动画不应使用JS计时器"); },
    requestAnimationFrame() { assert.fail("展示动画不应创建JS逐帧任务"); },
    IntersectionObserver: observe ? class { constructor(fn) { this.fn = fn; observer = this; } observe() {} disconnect() { this.disconnected = true; } } : undefined,
    fetch() { assert.fail("演示不能请求网络"); },
    API() { assert.fail("演示不能调用业务API"); },
  });
  context.window = context;
  for (const key of ["localStorage", "location", "FormData"]) Object.defineProperty(context, key, { get() { assert.fail("演示不应读取 " + key); } });
  vm.createContext(context);
  vm.runInContext(read("assets/i18n.js"), context);
  vm.runInContext(read("assets/product-demo.js"), context);
  const nodes = root.querySelectorAll();
  const byClass = (name) => nodes.find((node) => node.className === name || node.attrs.class === name);
  return { context, document, root, warnings, small, reduce, nodes, byClass, observer,
    visible(value) { observer.fn([{ isIntersecting: value }]); },
  };
}

test("纯装饰SVG可见即自动连续播放，无文字、按钮或交互监听", () => {
  const app = runtime();
  assert.equal(app.root.dataset.running, "false");
  app.visible(true); assert.equal(app.root.dataset.running, "true");
  assert.equal(app.root.children.length, 1);
  assert.equal(app.root.attrs["aria-hidden"], "true");
  assert(!app.nodes.some((node) => ["button", "a", "select", "textarea"].includes(node.tag)));
  assert(!app.nodes.some((node) => node.attrs.tabindex || node.attrs["aria-label"] || node.attrs.title));
  assert(!app.nodes.some((node) => ["h2", "p", "input", "form"].includes(node.tag)));
  assert(!app.nodes.some((node) => node.attrs["aria-live"] || node.dataset.stage));
  assert.equal(app.byClass("product-demo-scene").attrs["aria-hidden"], "true");
  const characters = app.nodes.filter((node) => node.attrs.class?.split(" ").includes("demo-character"));
  assert.equal(characters.length, 2, "场景必须为两位完整角色，而非流程节点");
  for (const character of characters) {
    const parts = character.querySelectorAll();
    for (const part of ["demo-face", "demo-hair", "demo-arm", "demo-hand", "demo-trousers", "demo-shoes", "demo-eye", "demo-smile"])
      assert(parts.some((node) => node.attrs.class?.split(" ").includes(part)), "角色缺少 " + part);
  }
  assert.equal(app.nodes.filter((node) => node.attrs.class === "demo-delivery").length, 1);
  assert(!app.nodes.some((node) => node.tag === "text" || node.textContent));
  assert.equal(app.root.attrs["aria-label"], undefined);
  for (const node of [app.root, ...app.nodes]) assert.equal(node.listeners.size, 0);
  assert.equal(app.nodes.find((node) => node.tag === "svg").attrs.viewBox, "80 44 320 208");
  assert.equal(runtime({ observe: false }).root.dataset.running, "true");
});

test("仅登录插画接受布尔捂眼，四条真实手臂位于脸前且不接收密码", () => {
  const app = runtime({ auth: true }); app.visible(true);
  const arms = app.nodes.filter((node) => node.attrs.class === "demo-pose-arm");
  const settingsArms = runtime().nodes.filter((node) => node.attrs.class === "demo-pose-arm");
  const paths = (arm) => arm.children.map((node) => node.attrs.d);
  assert.equal(arms.length, 4);
  const normal = arms.map(paths);
  assert.deepEqual(normal, settingsArms.map(paths), "登录默认姿态必须与设置页递送姿态完全一致");
  for (const character of app.nodes.filter((node) => node.attrs.class?.split(" ").includes("demo-character"))) {
    const face = character.children.findIndex((node) => node.attrs.class === "demo-face");
    assert.equal(character.children.slice(face + 1).filter((node) => node.attrs.class === "demo-pose-arm").length, 2);
  }
  app.root.setPasswordCovered(true);
  for (const [index, arm] of arms.entries()) {
    const [sleeve, hand] = paths(arm);
    assert.equal(sleeve.match(/^M\d+ \d+/)[0], normal[index][0].match(/^M\d+ \d+/)[0], "肩部在两种姿态中必须固定");
    const wrist = sleeve.match(/(\d+) (\d+)$/);
    assert(hand.startsWith(`M${wrist[1]} ${wrist[2]}L`), "手掌必须连接袖口");
    assert.equal(hand.match(/L(\d+) /)[1], ["143", "132", "332", "343"][index], "手掌必须覆盖对应眼睛");
  }
  assert.equal(app.root.dataset.passwordCovered, "true");
  assert.equal(app.root.dataset.running, "false");
  app.visible(false); app.visible(true);
  assert.equal(app.root.dataset.running, "false");
  app.root.setPasswordCovered(false);
  assert.deepEqual(arms.map(paths), normal, "离开密码框恢复完整递送姿态");
  assert.equal(app.root.dataset.running, "true");
  app.root.setPasswordCovered("fictional-password");
  assert.equal(app.root.dataset.passwordCovered, "false");
  assert(!JSON.stringify(app.root.dataset).includes("fictional-password"));
  const settings = runtime({ observe: false });
  assert.equal(settings.root.setPasswordCovered, undefined);
  assert.equal(settings.root.dataset.passwordCovered, undefined);
  assert.equal(settings.root.dataset.running, "true");
});

test("减少动画仍立即设定捂眼姿态，离开清理状态及接口且不污染自动循环", () => {
  const app = runtime({ auth: true, reduced: true }); app.visible(true);
  app.root.setPasswordCovered(true);
  assert.equal(app.root.dataset.passwordCovered, "true");
  assert.equal(app.root.dataset.running, "false");
  app.reduce.matches = false; app.reduce.fire("change");
  assert.equal(app.root.dataset.running, "false");
  app.context.fire("pagehide", { persisted: true });
  assert.equal(app.root.dataset.passwordCovered, "false");
  app.context.fire("pageshow");
  assert.equal(app.root.dataset.running, "true");
  const setter = app.root.setPasswordCovered;
  app.context.fire("pagehide", { persisted: false });
  assert.equal(app.root.setPasswordCovered, undefined);
  setter(true);
  assert.equal(app.root.dataset.passwordCovered, "false");
  assert.equal(app.root.dataset.running, "false");
  const css = read("assets/product-demo.css");
  assert.match(css, /demo-pose-arm path \{[^}]*transition: d 220ms/);
  assert.doesNotMatch(css, /demo-cover-arm|rotate\(-?155deg\)/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*transition: none/);
  assert.doesNotMatch(css, /data-password-covered[^}]*demo-eye/);
});

test("隐藏、离屏、小屏和BFCache暂停，恢复后自动继续", () => {
  const app = runtime(); app.visible(true);
  app.document.hidden = true; app.document.fire("visibilitychange"); assert.equal(app.root.dataset.running, "false");
  app.document.hidden = false; app.document.fire("visibilitychange"); assert.equal(app.root.dataset.running, "true");
  app.visible(false); assert.equal(app.root.dataset.running, "false");
  app.visible(true); app.visible(true); assert.equal(app.root.dataset.running, "true");
  app.small.matches = true; app.small.fire("change"); assert.equal(app.root.dataset.running, "false");
  app.small.matches = false; app.small.fire("change"); assert.equal(app.root.dataset.running, "true");
  app.context.fire("pagehide", { persisted: true }); assert.equal(app.root.dataset.running, "false");
  app.context.fire("pageshow"); assert.equal(app.root.dataset.running, "true");
  app.visible(false);
  app.context.fire("pagehide", { persisted: true }); app.context.fire("pageshow"); assert.equal(app.root.dataset.running, "false");
  app.visible(true); assert.equal(app.root.dataset.running, "true");
  assert.equal(runtime({ compact: true, observe: false }).root.dataset.running, "false");
});

test("母版加载插画小屏仍搬运三张纸，减动与离屏可靠暂停", () => {
  const app = runtime({ loading: true, compact: true });
  app.visible(true);
  assert.equal(app.root.dataset.running, "true");
  assert.equal(app.nodes.filter((node) => node.attrs.class === "demo-loader-sheet").length, 3);
  assert(!app.nodes.some((node) => ["text", "button", "a", "input"].includes(node.tag)));
  app.visible(false); assert.equal(app.root.dataset.running, "false");
  app.visible(true); assert.equal(app.root.dataset.running, "true");
  app.document.hidden = true; app.document.fire("visibilitychange");
  assert.equal(app.root.dataset.running, "false");
  app.document.hidden = false; app.document.fire("visibilitychange");
  app.reduce.matches = true; app.reduce.fire("change");
  assert.equal(app.root.dataset.running, "false");
  app.reduce.matches = false; app.reduce.fire("change");
  assert.equal(app.root.dataset.running, "true");
  app.context.fire("pagehide", {});
  app.visible(true); assert.equal(app.root.dataset.running, "false");
  assert.equal(runtime({ loading: true, compact: true, reduced: true, observe: false }).root.dataset.running, "false");
});

test("减少动画首屏及动态切换均静态，取消减少动画后自动继续", () => {
  const app = runtime({ reduced: true }); app.visible(true);
  assert.equal(app.root.dataset.running, "false");
  app.reduce.matches = false; app.reduce.fire("change"); assert.equal(app.root.dataset.running, "true");
  app.reduce.matches = true; app.reduce.fire("change"); assert.equal(app.root.dataset.running, "false");
  app.reduce.matches = false; app.reduce.fire("change"); assert.equal(app.root.dataset.running, "true");
  app.document.hidden = true; app.document.fire("visibilitychange");
  app.reduce.matches = true; app.reduce.fire("change");
  app.document.hidden = false; app.document.fire("visibilitychange"); assert.equal(app.root.dataset.running, "false");
});

test("卸载释放监听器和观察器，迟到回调不能重启动画", () => {
  const app = runtime(); app.visible(true); app.context.fire("pagehide", { persisted: false });
  assert.equal(app.root.dataset.running, "false"); assert.equal(app.observer.disconnected, true);
  for (const target of [app.context, app.document, app.small, app.reduce, ...app.nodes])
    assert([...target.listeners.values()].every((entries) => entries.size === 0));
  app.context.fire("pageshow"); app.visible(true); assert.equal(app.root.dataset.running, "false");
});

test("三语、双主题、六色更新不重建场景、不重启动效，无缺失翻译", () => {
  const app = runtime(); app.visible(true);
  const scene = app.root.children[0];
  for (const locale of ["zh-CN", "en-US", "ar-SA"]) for (const theme of ["light", "dark"]) for (const accent of ["blue", "green", "purple", "red", "orange", "teal"]) {
    app.context.I18n.apply({ locale, theme, accent });
    assert.equal(app.root.children[0], scene); assert.equal(app.root.dataset.running, "true");
    assert.equal(app.root.attrs["aria-hidden"], "true");
    assert.equal(app.root.attrs["aria-label"], undefined);
    assert.equal(app.document.documentElement.dir, { "zh-CN": "ltr", "en-US": "ltr", "ar-SA": "rtl" }[locale]);
  }
  assert.equal(app.warnings.length, 0);
});

test("展示无卡片外框、页面仿形或步骤文案，登录栏保持紧凑和页脚", () => {
  const css = read("assets/product-demo.css"), js = read("assets/product-demo.js"), html = read("auth.html");
  assert(css.includes("block-size: clamp(240px, 40vh, 420px); max-block-size: none;"));
  assert(css.includes("justify-content: flex-start"));
  assert(css.includes(".auth-story-with-demo .product-demo { flex: 1; display: grid; align-items: center;"));
  assert(css.includes("@media (min-width: 1001px) and (max-height: 700px)"));
  assert(css.includes("block-size: clamp(160px, 32vh, 224px)"));
  assert(!/184px|product-demo-toggle|demoPause|demoResume/.test(css + js + read("assets/i18n.js")));
  assert(!/\bpaused\b|I18n|"click"|"button"/.test(js));
  assert(css.includes(".auth-story-with-demo .eyebrow { margin-block-end: var(--space-2); }"));
  assert(!/\.product-demo\s*\{[^}]*(?:border:|background:)/.test(css));
  assert(!/product-demo-(?:title|intro|steps|step|description|footer|disclaimer|state)|demo-window|data-stage/.test(css + js));
  assert(!/demoTitle|demoDisclaimer|demoSteps|demoAuto|demoUploadHint/.test(read("assets/i18n.js")));
  assert(!/\.auth-branding[^{}]*\{[^{}]*(?:display:\s*none|visibility:\s*hidden)/.test(css));
  assert(html.includes('class="auth-branding"')); assert(html.includes('data-i18n="poweredBy"'));
  assert(!read("settings.html").includes("auth-story-with-demo"));
});

test("接入只限留白表单页，安全验证居中，高密度页面无演示", () => {
  for (const page of ["settings", "auth", "activate"]) {
    const html = read(page + ".html");
    assert(html.includes("data-product-demo")); assert(html.includes('src="assets/product-demo.js"'));
    assert(html.indexOf("i18n.js") < html.indexOf("product-demo.js"));
    assert(html.includes("assets/product-demo.css"));
    assert(!/demoTitle|demoDisclaimer/.test(html));
  }
  for (const page of ["reset-password", "email-verification"]) {
    assert(read(page + ".html").includes("auth-focused")); assert(!read(page + ".html").includes("product-demo.js"));
  }
  for (const page of ["workspace", "users", "workspace-admin", "account"]) assert(!read(page + ".html").includes("product-demo"));
  const share = read("share.html");
  assert.match(share, /id="share-loading" class="page-loading"/);
  assert.match(share, /class="product-demo page-loading-art" data-product-demo data-loading-demo/);
  assert(share.includes("assets/product-demo.css"));
  assert(share.includes("assets/product-demo.js"));
  assert(share.indexOf("product-demo.js") < share.indexOf("share.js"));
  const css = read("assets/product-demo.css"), js = read("assets/product-demo.js");
  assert(css.includes("prefers-reduced-motion: reduce")); assert(css.includes("animation-play-state: paused"));
  assert(css.includes("animation-play-state: running")); assert(css.includes("10s ease-in-out infinite"));
  assert(css.includes("@keyframes demo-deliver")); assert(css.includes("@keyframes demo-blink"));
  assert(js.includes("demo-character demo-sender")); assert(js.includes("demo-character demo-receiver"));
  for (const part of ["demo-face", "demo-arm", "demo-hand", "demo-trousers", "demo-shoes", "demo-smile"]) assert(js.includes(part));
  assert(!/demo-orbit|demo-person-ring|demo-route|demo-flow/.test(css + js));
  assert(css.includes("@media (max-width: 1000px)")); assert(css.includes(".product-demo { display: none; }"));
  assert(css.slice(css.indexOf("@media (max-width: 1000px)")).includes(".auth-story-with-demo .product-demo { display: none; }"));
  assert(!/(?:#[\da-f]{3,8}\b|rgba?\(|hsla?\(|(?:margin|padding|inset|border)-(?:left|right)\s*:)/i.test(css));
  assert(!/\.value\b|FormData|fetch\(|API\(|innerHTML|setTimeout|setInterval|requestAnimationFrame|mousemove|pointermove/.test(js));
  for (const animation of css.matchAll(/@keyframes[\s\S]*?\}\s*\}/g)) assert(!/\b(?:width|height|top|left|margin|padding)\s*:/.test(animation[0]));
});
