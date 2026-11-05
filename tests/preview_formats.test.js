"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/assets/preview.js"), "utf8");
function environment(fetcher = async () => response("sample"), { fakeTimers = false } = {}) {
  const events = new Map(), revoked = [], sent = [], nodes = [], animationFrames = new Map(), timers = new Map();
  let nextFrame = 0, nextTimer = 0, reducedMotion = false;
  class Element {
    constructor(tag, attrs = {}) {
      this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.dataset = {}; this.textContent = attrs.text || ""; this.events = new Map(); this.hidden = false; this.src = attrs.src || "";
      const classes = new Set((attrs.class || "").split(" ").filter(Boolean));
      this.classList = { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) };
      this.contentWindow = { postMessage: (...args) => sent.push(args) }; nodes.push(this);
    }
    append(...items) {
      for (const item of items) {
        if (item.parentNode) item.parentNode.children = item.parentNode.children.filter((child) => child !== item);
        item.parentNode = this; this.children.push(item);
      }
    }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    querySelector(selector) { return this.children.find((item) => item.tag === selector) || this.children.map((item) => item.querySelector(selector)).find(Boolean); }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(type, fn) { this.events.set(type, fn); }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
    pause() { this.paused = true; }
    load() { this.unloaded = true; }
  }
  class TestURL extends URL { static createObjectURL() { return "blob:http://localhost/fixed"; } static revokeObjectURL(value) { revoked.push(value); } }
  const context = {
    console, URL: TestURL, AbortController, TextDecoder, Uint8Array, Blob,
    setTimeout: fakeTimers ? (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; } : setTimeout,
    clearTimeout: fakeTimers ? (id) => timers.delete(id) : clearTimeout,
    location: new URL("http://localhost/baba-share/workspace.html"), fetch: fetcher,
    UI: {
      el: (tag, attrs, ...items) => { const node = new Element(tag, attrs); node.append(...items); return node; },
      button: (key, action, cls = "") => { const node = new Element("button", { type: "button", class: cls, text: key }); node.action = action; return node; },
      dialog: (name, build, options) => {
        const node = new Element("dialog"); node.append(new Element("h2", { text: name }));
        let resolve;
        const result = new Promise((done) => { resolve = done; });
        const close = () => { node.closed = true; node.events.get("close")?.(); resolve(null); };
        build(node, close); node.dialogOptions = options;
        return { node, result, close };
      },
      toast: () => {},
    },
    I18n: { t: (key) => key, ctx: { locale: "zh-CN", dir: "ltr", theme: "dark" }, subscribe: () => () => {} },
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame: (callback) => { animationFrames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => animationFrames.delete(id),
    addEventListener: (type, fn) => events.set(type, fn), removeEventListener: (type, fn) => { if (events.get(type) === fn) events.delete(type); },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return {
    ...context.FilePreview, context, Element, nodes, revoked, sent, events, animationFrames, timers,
    reduceMotion: () => { reducedMotion = true; },
    renderFrame: () => { const pending = [...animationFrames.values()]; animationFrames.clear(); pending.forEach((callback) => callback()); },
  };
}
function response(text, header = "") {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return { ok: true, headers: { get: () => header }, body: { async cancel() {}, getReader() { let first = true; return { async read() { if (!first) return { done: true }; first = false; return { value: bytes, done: false }; }, async cancel() {}, releaseLock() {} }; } } };
}
const url = "http://localhost/baba-share/preview/s/token/test";
test("按扩展名分类，Office不伪装HTML，未知格式可下载", () => {
  const app = environment();
  for (const [name, kind] of [["index.HTML", "html"], ["x.svg", "image"], ["x.mp4", "video"], ["x.mp3", "audio"], ["x.pdf", "pdf"], ["x.md", "markdown"], ["x.txt", "text"], ["x.ts", "code"], ["x.py", "code"], ["Dockerfile", "code"], ["x.docx", "office"], ["x.ppt", "office"], ["x.exe", "unsupported"], ["html.exe", "unsupported"]]) assert.equal(app.classify(name).kind, kind, name);
  assert.equal(app.classify("example.tsx").language, "typescript");
  for (const ext of ["md", "markdown", "mdown", "mkd", "mkdn"]) assert.equal(app.classify("sample." + ext).kind, "markdown");
  for (const name of ["x.text", "x.txt", "x.nfo", "x.conf", "x.cfg", "x.properties", "README", "LICENSE", "NOTICE", "CHANGELOG"]) assert.equal(app.classify(name).kind, "text", name);
});
test("Content-Length及真实流大小均有界，超限拒绝读取", async () => {
  await assert.rejects(environment(async () => response("small", "10000")).readBytes(url, 5), /PREVIEW_TOO_LARGE/);
  await assert.rejects(environment(async () => response("123456")).readBytes(url, 5), /PREVIEW_TOO_LARGE/);
  assert.equal((await environment(async () => response("12345")).readBytes(url, 5)).byteLength, 5);
});
test("纯文本及Markdown中HTML不执行且不请求远端资源", async () => {
  const app = environment(async () => response('# Heading\n<img src=x onerror=alert(1)>\n![x](https://example.test/x)\n```js\n<script>evil()</script>\n```'));
  const view = app.create(new app.Element("host"));
  await view.load({ name: "untrusted.md", url });
  assert.equal(app.nodes.some((node) => ["script", "img"].includes(node.tag)), false);
  assert(app.nodes.some((node) => node.textContent.includes("<img")));
  assert(app.nodes.some((node) => node.textContent.includes("<script>evil()")));
  view.dispose();
});
test("Markdown常用结构按安全DOM呈现，成功后无工具栏及常驻提示", async () => {
  const sample = '# Heading\n\n**bold** and *italic* and ~~deleted~~ and `inline`\n\n- one\n  - nested\n- two\n\n3. ordered\n\n> quote\n> continued\n\n| Name | Value |\n| --- | ---: |\n| a | 1 |\n\n[Safe](https://example.test/docs) [Mail](mailto:test@example.test) [Unsafe](javascript:alert) [Private](/api/private)\n\n~~~js\nconst x = 1;\n~~~';
  const app = environment(async () => response(sample)), view = app.create(new app.Element("host"));
  await view.load({ name: "sample.markdown", url });
  for (const tag of ["h2", "strong", "em", "del", "code", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "th", "td", "pre"]) assert(app.nodes.some((node) => node.tag === tag), tag);
  const links = app.nodes.filter((node) => node.tag === "a" && !node.classList.contains("file-preview-download"));
  assert.equal(links.length, 2);
  assert.equal(links[0].attrs.rel, "noopener noreferrer");
  assert.equal(links[0].attrs.referrerpolicy, "no-referrer");
  assert.equal(app.nodes.find((node) => node.classList.contains("status-line")).hidden, true);
  assert.equal(app.nodes.find((node) => node.classList.contains("file-preview-download")).hidden, true);
  assert.equal(app.nodes.some((node) => node.classList.contains("file-preview-toolbar")), false);
  assert.equal(app.nodes.find((node) => node.tag === "ol").attrs.start, "3");
  view.dispose();
});
test(".text保留原文且错误态显示可下载入口", async () => {
  const app = environment(async () => response("<b>**raw**</b>")), view = app.create(new app.Element("host"));
  await view.load({ name: "sample.text", url });
  assert.equal(app.nodes.find((node) => node.tag === "pre").textContent, "<b>**raw**</b>");
  await view.load({ name: "archive.zip", url });
  assert.equal(app.nodes.find((node) => node.classList.contains("file-preview-download")).hidden, false);
  assert.equal(app.nodes.find((node) => node.classList.contains("status-line")).hidden, false);
  view.dispose();
});
test("HTML只使用opaque沙箱，可信Monaco固定入口独立授权", async () => {
  const app = environment();
  const view = app.create(new app.Element("host"));
  await view.load({ name: "index.html", url });
  const htmlFrame = app.nodes.find((node) => node.tag === "iframe");
  assert.equal(htmlFrame.attrs.sandbox, "allow-scripts");
  await view.load({ name: "test.js", url });
  assert.equal(htmlFrame.src, "about:blank");
  const codeFrame = app.nodes.filter((node) => node.tag === "iframe").at(-1);
  assert.equal(codeFrame.src, "/baba-share/preview-code.html");
  assert.equal(codeFrame.attrs.sandbox, "allow-scripts allow-same-origin");
  const handler = app.events.get("message");
  handler({ origin: "https://evil.test", source: codeFrame.contentWindow, data: { type: "preview-code.ready", version: 1 } });
  assert.equal(app.sent.length, 0);
  handler({ origin: "http://localhost", source: codeFrame.contentWindow, data: { type: "preview-code.ready", version: 1 } });
  assert.equal(app.sent[0][0].text, "sample");
  assert.equal("url" in app.sent[0][0], false);
  view.dispose();
  assert.equal(app.events.has("message"), false);
  assert(app.sent.some((message) => message[0].type === "preview-code.dispose"));
});
test("PDF保留原生blob预览，不加载Office或误报渲染回执，关闭释放资源", async () => {
  const app = environment(async () => response("%PDF-1.4\nsynthetic PDF bytes")), view = app.create(new app.Element("host"));
  app.context.API = async () => assert.fail("原生PDF没有可信渲染回执");
  await view.load({ name: "report.pdf", url, onboardingTicket: "memory-only" });
  const frame = app.nodes.find((node) => node.tag === "iframe");
  assert.equal(app.classify("report.PDF").mime, "application/pdf");
  assert.equal(app.classify("report.pdf").limit, 64 * 1024 * 1024);
  assert.equal(frame.src, "blob:http://localhost/fixed");
  assert.equal(app.nodes.some((node) => node.src === "/baba-share/preview-office.html"), false);
  assert.equal(app.events.has("message"), false);
  frame.events.get("load")();
  assert.equal(app.nodes.find((node) => node.classList.contains("status-line")).hidden, true);
  view.dispose();
  assert.equal(frame.src, "about:blank");
  assert.deepEqual(app.revoked, ["blob:http://localhost/fixed"]);
});
test("切换与销毁暂停音视频、撤销blob且清空iframe", async () => {
  const app = environment(), view = app.create(new app.Element("host"));
  await view.load({ name: "movie.mp4", url });
  const media = app.nodes.find((node) => node.tag === "video");
  await view.load({ name: "photo.svg", url });
  assert.equal(media.paused, true); assert.equal(media.unloaded, true); assert.equal(app.revoked.length, 1);
  view.dispose(); view.dispose();
  assert.equal(app.revoked.length, 2);
});
test("过期请求不能覆盖新预览，关闭立即abort", async () => {
  let finish, signal;
  const app = environment((_, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); });
  const view = app.create(new app.Element("host"));
  const old = view.load({ name: "old.txt", url });
  await view.load({ name: "new.zip", url });
  assert.equal(signal.aborted, true);
  finish(response("old content")); await old;
  assert.equal(app.nodes.some((node) => node.tag === "pre"), false);
  view.dispose();
});
test("UTF-8之外或二进制文本拒绝渲染，Office使用固定本地入口", async () => {
  const app = environment(async () => response(new Uint8Array([255, 0]))), view = app.create(new app.Element("host"));
  await view.load({ name: "binary.txt", url });
  assert(app.nodes.some((node) => node.textContent === "previewEncodingUnsupported"));
  await view.load({ name: "report.docx", url });
  assert(app.nodes.some((node) => node.src === "/baba-share/preview-office.html"));
  await view.load({ name: "archive.zip", url });
  assert(app.nodes.some((node) => node.textContent === "previewUnsupported"));
  view.dispose();
});
test("拒绝站外及非预览URL，不读取任意站点API", async () => {
  let calls = 0;
  const app = environment(async () => { calls++; return response("x"); }), view = app.create(new app.Element("host"));
  await view.load({ name: "x.js", url: "https://evil.test/x.js" });
  await view.load({ name: "x.js", url: "http://localhost/api/private" });
  assert.equal(calls, 0);
  view.dispose();
});
test("Office桥只向可信窗口交付文件一次，拒绝伪造消息并正确释放", async () => {
  const app = environment(), view = app.create(new app.Element("host"));
  await view.load({ name: "report.docx", url });
  const frame = app.nodes.find((node) => node.tag === "iframe"), handler = app.events.get("message");
  assert.equal(frame.attrs.sandbox, "allow-scripts allow-same-origin");
  handler({ origin: "http://localhost", source: {}, data: { type: "preview-office.ready", version: 1 } });
  handler({ origin: "null", source: frame.contentWindow, data: { type: "preview-office.ready", version: 1 } });
  assert.equal(app.sent.length, 0);
  const ready = { origin: "http://localhost", source: frame.contentWindow, data: { type: "preview-office.ready", version: 1 } };
  handler(ready); handler(ready);
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0][0].name, "report.docx");
  assert.equal("url" in app.sent[0][0], false);
  assert.equal(app.sent[0][2].length, 1);
  handler({ origin: "http://localhost", source: frame.contentWindow, data: { type: "preview-office.loaded", version: 1 } });
  view.dispose();
  assert(app.sent.some((message) => message[0].type === "preview-office.dispose"));
  assert.equal(app.events.has("message"), false);
});
test("Office无额外预览大小门槛，其他格式仍保留读取上限", async () => {
  let calls = 0;
  const large = new Uint8Array(33 * 1024 * 1024);
  const app = environment(async () => { calls++; return response(large, String(large.byteLength)); }), view = app.create(new app.Element("host"));
  await view.load({ name: "huge.docx", size: large.byteLength, url });
  assert.equal(calls, 1);
  assert.equal(app.classify("huge.docx").limit, Infinity);
  const frame = app.nodes.find((node) => node.tag === "iframe");
  app.events.get("message")({ origin: "http://localhost", source: frame.contentWindow, data: { type: "preview-office.ready", version: 1 } });
  assert.equal(app.sent[0][0].bytes.byteLength, large.byteLength);
  await view.load({ name: "huge.text", size: large.byteLength, url });
  assert.equal(calls, 1);
  assert(app.nodes.some((node) => node.textContent === "PREVIEW_TOO_LARGE"));
  view.dispose();
});
test("内容区预览初始绘制后滑入，关闭完成后才释放并保留原生焦点管理", async () => {
  const app = environment(), result = app.open("movie.mp4", url);
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = app.nodes.find((node) => node.tag === "dialog"), media = app.nodes.find((node) => node.tag === "video");
  assert(dialog.classList.contains("file-preview-page"));
  assert.equal(dialog.dialogOptions.initialFocus, ".file-preview-close");
  assert.equal(dialog.classList.contains("is-visible"), false);
  app.renderFrame();
  assert.equal(dialog.classList.contains("is-visible"), false);
  app.renderFrame();
  assert.equal(dialog.classList.contains("is-visible"), true);
  assert.equal(dialog.events.has("keydown"), false);
  let canceled = false;
  dialog.events.get("cancel")({ preventDefault() { canceled = true; } });
  assert.equal(canceled, true);
  assert.equal(dialog.classList.contains("is-visible"), false);
  assert.equal(dialog.closed, undefined);
  assert.equal(media.paused, undefined);
  dialog.events.get("transitionend")({ target: media, propertyName: "transform" });
  assert.equal(dialog.closed, undefined);
  dialog.events.get("transitionend")({ target: dialog, propertyName: "transform" });
  await result;
  assert.equal(dialog.closed, true);
  assert.equal(media.paused, true);
  assert.equal(app.revoked.length, 1);
  assert.equal(app.animationFrames.size, 0);
  assert.equal(app.events.has("pagehide"), false);
});
test("减少动画直接关闭，标题行只保留紧凑关闭入口", async () => {
  const app = environment(); app.reduceMotion();
  const result = app.open("index.html", url);
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = app.nodes.find((node) => node.tag === "dialog");
  assert.equal(app.nodes.filter((node) => node.tag === "button").length, 1);
  assert.equal(app.nodes.some((node) => node.classList.contains("file-preview-toolbar")), false);
  app.nodes.find((node) => node.classList.contains("file-preview-close")).action();
  await result;
  assert.equal(dialog.closed, true);
  assert.equal(app.animationFrames.size, 0);
  assert.equal(app.nodes.find((node) => node.tag === "iframe").src, "about:blank");
});
test("预览关闭动画缺失时限时退出，页面离开也清理请求", async () => {
  const app = environment();
  const result = app.open("index.html", url);
  await new Promise((resolve) => setImmediate(resolve));
  app.nodes.find((node) => node.classList.contains("file-preview-close")).action();
  await result;
  assert.equal(app.nodes.find((node) => node.tag === "dialog").closed, true);
  const second = environment(), pending = second.open("index.html", url);
  await new Promise((resolve) => setImmediate(resolve));
  second.events.get("pagehide")(); await pending;
  assert.equal(second.animationFrames.size, 0);
  assert.equal(second.nodes.find((node) => node.tag === "iframe").src, "about:blank");
});
test("预览页覆盖当前内容视口，无居中尺寸与背景留白，支持RTL及减少动画", () => {
  const css = fs.readFileSync(path.join(__dirname, "../web/assets/preview.css"), "utf8");
  assert.match(css, /dialog\.file-preview-page\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
  for (const property of ["max-inline-size", "max-block-size", "max-width", "max-height"]) assert.match(css, new RegExp(property + ":\\s*none;"));
  assert.match(css, /margin:\s*0;\s*padding:\s*0;\s*border:\s*0;/);
  assert.match(css, /html\[dir="rtl"\] dialog\.file-preview-page\s*\{\s*transform:\s*translateX\(-100%\)/);
  assert.match(css, /html\[dir="rtl"\] dialog\.file-preview-page\.is-visible\s*\{\s*transform:\s*translateX\(0\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(source, /parent\.document|top\.document|addEventListener\("keydown"/);
});
test("预览任务只在图片真实load成功后回执一次，失败与取消不回执", async () => {
  for (const outcome of ["load", "error", "cancel"]) {
    const app = environment(), calls = [];
    app.context.API = async (...args) => { calls.push(args); return {}; };
    const view = app.create(new app.Element("host"));
    await view.load({ name: "image.png", url, onboardingTicket: "memory-only" });
    const image = app.nodes.find((node) => node.tag === "img");
    assert.equal(calls.length, 0);
    if (outcome === "cancel") view.dispose();
    else image.events.get(outcome)();
    image.events.get("load")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, outcome === "load" ? 1 : 0);
    if (calls.length) { assert.equal(calls[0][0], "onboardingPreview"); assert.equal(calls[0][1].body.ticket, "memory-only"); }
    view.dispose();
  }
});
test("媒体真实metadata后回执，canplay重复事件与错误后的事件不重复记账", async () => {
  const app = environment(), calls = [];
  app.context.API = async (...args) => { calls.push(args); return {}; };
  const view = app.create(new app.Element("host"));
  await view.load({ name: "clip.mp4", url, onboardingTicket: "memory-only" });
  const media = app.nodes.find((node) => node.tag === "video");
  assert.equal(calls.length, 0);
  media.events.get("loadeddata")(); media.events.get("canplay")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1); view.dispose();
});
test("可信预览消息验证来源、版本及握手次序，恶意上传HTML消息不回执", async () => {
  for (const kind of ["code", "office"]) {
    const app = environment(), calls = [];
    app.context.API = async (...args) => { calls.push(args); return {}; };
    const view = app.create(new app.Element("host"));
    await view.load({ name: kind === "code" ? "sample.js" : "sample.docx", url, onboardingTicket: "memory-only" });
    const frame = app.nodes.find((node) => node.tag === "iframe"), handler = app.events.get("message");
    const event = { origin: "http://localhost", source: frame.contentWindow, data: { type: "preview-" + kind + ".loaded", version: 1 } };
    handler(event); assert.equal(calls.length, 0);
    handler({ ...event, data: { ...event.data, type: "preview-" + kind + ".ready" } });
    handler({ ...event, origin: "null" }); handler({ ...event, source: {} }); handler({ ...event, data: { ...event.data, version: 2 } });
    assert.equal(calls.length, 0);
    handler(event); handler(event); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1); view.dispose();
  }
  const app = environment(), calls = [];
  app.context.API = async (...args) => { calls.push(args); return {}; };
  const view = app.create(new app.Element("host"));
  await view.load({ name: "untrusted.html", url, onboardingTicket: "memory-only" });
  assert.equal(app.events.has("message"), false); assert.equal(calls.length, 0); view.dispose();
});
test("预览读取或渲染失败不回执，回执网络错误保留显式重试且不保存ticket", async () => {
  const app = environment(), calls = [];
  app.context.API = async (...args) => { calls.push(args); if (calls.length === 1) throw new Error("offline"); return {}; };
  const view = app.create(new app.Element("host"));
  await view.load({ name: "sample.txt", url, onboardingTicket: "memory-only" });
  await new Promise((resolve) => setImmediate(resolve));
  const retry = app.nodes.find((node) => node.tag === "button" && node.textContent === "onboardingRetry");
  assert(retry); await retry.action(); await retry.action(); assert.equal(calls.length, 2); view.dispose();
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.(?:log|warn|error)\([^\n]*ticket/i);
  const broken = environment(async () => ({ ok: false, status: 404 }));
  broken.context.API = async () => assert.fail("读取失败不应回执");
  const failed = broken.create(new broken.Element("host"));
  await failed.load({ name: "sample.txt", url, onboardingTicket: "memory-only" }); failed.dispose();
});
test("空状态和成功回执不占位，回执失败可见并可重试清理翻译标记", async () => {
  const app = environment(), view = app.create(new app.Element("host"));
  const statuses = app.nodes.filter((node) => node.classList.contains("status-line"));
  assert.equal(statuses.length, 2);
  assert(statuses.every((node) => node.hidden && node.textContent === ""));
  let attempts = 0;
  app.context.API = async () => { if (++attempts === 1) throw new Error("offline"); return {}; };
  await view.load({ name: "sample.txt", url, onboardingTicket: "memory" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses[0].hidden, true);
  assert.equal(statuses[0].attrs["data-i18n"], undefined);
  assert.equal(statuses[1].hidden, false);
  assert.equal(statuses[1].textContent, "onboardingReceiptFailed");
  assert.equal(statuses[1].attrs["data-i18n"], "onboardingReceiptFailed");
  await app.nodes.find((node) => node.textContent === "onboardingRetry").action();
  assert.equal(attempts, 2);
  assert(statuses.every((node) => node.hidden && node.textContent === ""));
  assert.equal(statuses[1].attrs["data-i18n"], undefined);
  await view.load({ name: "next.txt", url });
  assert(statuses.every((node) => node.hidden && node.textContent === ""));
  view.dispose();
  const css = fs.readFileSync(path.join(__dirname, "../web/assets/preview.css"), "utf8");
  assert.match(css, /\.file-preview > \.status-line:empty\s*\{\s*display: none;/);
});
test("可见预览错误及重试在成功后完全退场，不残留加载或空行", async () => {
  let attempts = 0;
  const app = environment(async () => ++attempts === 1 ? { ok: false, status: 404 } : response("ready"));
  const states = [], view = app.create(new app.Element("host"), { externalLoading: true, retry: true, onState: (state) => states.push(state) });
  await view.load({ name: "sample.txt", url });
  const statuses = app.nodes.filter((node) => node.classList.contains("status-line"));
  assert.equal(statuses[0].hidden, false);
  assert.equal(statuses[0].textContent, "FILE_NOT_EXIST");
  assert.equal(statuses[1].hidden, true);
  const retry = app.nodes.find((node) => node.classList.contains("file-preview-retry"));
  await retry.action();
  assert.deepEqual(states, ["loading", "error", "loading", "ready"]);
  assert(statuses.every((node) => node.hidden && node.textContent === ""));
  assert.equal(statuses[0].attrs["data-i18n"], undefined);
  assert.equal(retry.removed, true);
  assert.equal(view.root.attrs["aria-busy"], "false");
  view.dispose();
});
test("HTML必须主HTTP成功再创建iframe，读取失败与迟到load不回执", async () => {
  for (const ok of [true, false]) {
    let reads = 0, calls = 0;
    const app = environment(async () => { reads++; return ok ? response("<!doctype html><p>ok</p>") : { ok: false, status: 404 }; });
    app.context.API = async () => { calls++; return {}; };
    const view = app.create(new app.Element("host"));
    await view.load({ name: "index.html", url, onboardingTicket: "memory" });
    assert.equal(reads, 1); assert.equal(calls, 0);
    const frame = app.nodes.find((node) => node.tag === "iframe");
    if (!ok) assert.equal(frame, undefined);
    else { frame.events.get("error")(); frame.events.get("load")(); }
    assert.equal(calls, 0); view.dispose();
  }
});
test("关闭滑出动画开始即冻结预览回执，迟到图片或可信消息都不计", async () => {
  for (const name of ["image.png", "sample.js"]) {
    const app = environment(), calls = [];
    app.context.API = async (...args) => { calls.push(args); return {}; };
    const pending = app.open(name, url, { onboardingTicket: "memory" });
    await new Promise((resolve) => setImmediate(resolve));
    const frame = app.nodes.find((node) => node.tag === "iframe"), handler = app.events.get("message");
    app.nodes.find((node) => node.classList.contains("file-preview-close")).action();
    if (frame) {
      handler({ origin: "http://localhost", source: frame.contentWindow, data: { version: 1, type: "preview-code.ready" } });
      handler({ origin: "http://localhost", source: frame.contentWindow, data: { version: 1, type: "preview-code.loaded" } });
      assert.equal(app.sent.length, 0);
    } else app.nodes.find((node) => node.tag === "img").events.get("load")();
    assert.equal(calls.length, 0);
    await pending;
  }
});
test("可信渲染失败后迟到ready不再交付bytes或text，元数据不算成功", async () => {
  const app = environment(), view = app.create(new app.Element("host"));
  app.context.API = async () => assert.fail("失败后不得回执");
  await view.load({ name: "report.docx", url, onboardingTicket: "memory" });
  const frame = app.nodes.find((node) => node.tag === "iframe"), handler = app.events.get("message");
  for (const type of ["preview-office.error", "preview-office.ready", "preview-office.loaded"]) handler({ origin: "http://localhost", source: frame.contentWindow, data: { version: 1, type } });
  assert.equal(app.sent.filter((message) => message[0].type === "preview-office.load").length, 0);
  assert.equal(app.sent[0][0].type, "preview-office.dispose"); view.dispose();
  assert.doesNotMatch(source, /addEventListener\("loadedmetadata", complete\)/);
});
test("外部插画加载只在真实渲染完成后结束，旧文件事件不能结束新加载", async () => {
  const app = environment(), states = [];
  const view = app.create(new app.Element("host"), { externalLoading: true, retry: true, onState: (state) => states.push(state) });
  await view.load({ name: "first.png", url });
  const image = app.nodes.find((node) => node.tag === "img");
  const body = app.nodes.find((node) => node.classList.contains("file-preview-body"));
  assert.deepEqual(states, ["loading"]);
  assert.equal(body.classList.contains("file-preview-pending"), true);
  assert.equal(app.nodes.find((node) => node.classList.contains("status-line")).hidden, true);
  await view.load({ name: "next.js", url });
  image.events.get("load")();
  assert.deepEqual(states, ["loading", "loading"]);
  const frame = app.nodes.find((node) => node.tag === "iframe"), handler = app.events.get("message");
  const send = (type) => handler({ origin: "http://localhost", source: frame.contentWindow, data: { version: 1, type: "preview-code." + type } });
  frame.events.get("load")?.(); send("loaded");
  assert.equal(body.classList.contains("file-preview-pending"), true);
  send("ready"); assert.deepEqual(states, ["loading", "loading"]);
  send("loaded"); send("loaded");
  assert.deepEqual(states, ["loading", "loading", "ready"]);
  assert.equal(body.classList.contains("file-preview-pending"), false);
  view.dispose();
});
test("读取及渲染超时均终止插画、释放资源、可重试且拒绝迟到完成", async () => {
  for (const name of ["index.html", "photo.png", "clip.mp4", "report.pdf", "code.js", "report.docx"]) {
    const app = environment(undefined, { fakeTimers: true }), states = [];
    const view = app.create(new app.Element("host"), { externalLoading: true, retry: true, onState: (state) => states.push(state) });
    await view.load({ name, url });
    const rendered = app.nodes.find((node) => ["iframe", "img", "video"].includes(node.tag));
    assert.equal(app.timers.size, 1);
    assert.equal([...app.timers.values()][0].delay, name.endsWith("docx") ? 120000 : 30000);
    [...app.timers.values()][0].fn();
    assert.deepEqual(states, ["loading", "error"]);
    assert.equal(app.timers.size, 0);
    assert.equal(view.root.attrs["aria-busy"], "false");
    if (rendered.tag === "iframe") assert.equal(rendered.src, "about:blank");
    for (const type of ["load", "loadeddata", "canplay"]) rendered.events.get(type)?.();
    assert.deepEqual(states, ["loading", "error"]);
    const retry = app.nodes.find((node) => node.classList.contains("file-preview-retry"));
    await retry.action();
    assert.deepEqual(states, ["loading", "error", "loading"]);
    view.dispose(); assert.equal(app.timers.size, 0);
  }
  let finish, signal;
  const app = environment((_, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); }, { fakeTimers: true }), states = [];
  const view = app.create(new app.Element("host"), { onState: (state) => states.push(state), retry: true });
  const pending = view.load({ name: "slow.md", url });
  [...app.timers.values()][0].fn();
  assert.equal(signal.aborted, true); assert.deepEqual(states, ["loading", "error"]);
  finish(response("late markdown")); await pending;
  assert.equal(app.nodes.some((node) => node.tag === "article"), false);
  view.dispose();
});
test("Markdown与不支持格式同步结束外部加载，PDF仅结束展示而不回执", async () => {
  const app = environment(), states = [], view = app.create(new app.Element("host"), { externalLoading: true, onState: (state) => states.push(state) });
  app.context.API = async () => assert.fail("PDF没有可信回执");
  await view.load({ name: "DEPLOYMENT.md", url });
  assert.deepEqual(states, ["loading", "ready"]);
  await view.load({ name: "archive.zip", url });
  assert.deepEqual(states, ["loading", "ready", "loading", "error"]);
  await view.load({ name: "report.pdf", url, onboardingTicket: "memory" });
  assert.equal(states.at(-1), "loading");
  app.nodes.find((node) => node.tag === "iframe").events.get("load")();
  assert.equal(states.at(-1), "ready");
  view.dispose();
});
function shareEnvironment({ fileMode = false, metadataPending = false } = {}) {
  let finish, metadataResolve;
  const app = environment(() => new Promise((resolve) => { finish = resolve; }), { fakeTimers: true });
  const ids = new Map();
  for (const id of ["share-shell", "share-layout", "share-sidebar", "share-controls", "preview-actions", "share-stage", "share-preview-area", "share-loading", "share-status", "shared-frame", "share-state", "share-current", "share-tree", "share-title", "share-folder-title", "share-expiry", "share-navigation", "share-file-type"])
    ids.set(id, new app.Element("div"));
  for (const node of ids.values()) {
    node.classList.toggle = (name, force) => { const value = force ?? !node.classList.contains(name); if (value) node.classList.add(name); else node.classList.remove(name); return value; };
    node.prepend = (...items) => node.children.unshift(...items);
    node.contains = () => false;
    node.querySelectorAll = () => [];
  }
  Object.assign(app.context.UI, { $: (selector) => ids.get(selector.slice(1)), settingsControls() {}, icon: () => new app.Element("svg"), date: () => "date", errorText: () => "error" });
  Object.assign(app.context.I18n, { apply() {} });
  app.context.location = new URL("http://localhost/baba-share/s/token" + (fileMode ? "?view=file&file=DEPLOYMENT.md" : ""));
  app.context.history = { replaceState() {} };
  app.context.document = { querySelectorAll: () => [], addEventListener() {}, activeElement: null, title: "" };
  const listing = { share: { expireTime: 1 }, previewBaseUrl: "/baba-share/preview/s/token/", listing: { entries: [{ name: "DEPLOYMENT.md", path: "DEPLOYMENT.md", kind: "file" }], pageIndex: 1, totalPage: 1, totalCount: 1 } };
  app.context.API = () => metadataPending ? new Promise((resolve) => { metadataResolve = resolve; }) : Promise.resolve(listing);
  const started = vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/assets/share.js"), "utf8"), app.context);
  return { app, ids, started, resolveFile: (text) => finish(response(text)), resolveMetadata: () => metadataResolve(listing) };
}
test("分享正常及沉浸单文件模式持续显示插画至选中文件完成，无双重加载文本", async () => {
  for (const fileMode of [false, true]) {
    const { app, ids, started, resolveFile } = shareEnvironment({ fileMode });
    await started;
    assert.equal(ids.get("share-loading").hidden, false);
    assert.equal(ids.get("share-preview-area").attrs["aria-busy"], "true");
    assert.equal(ids.get("share-status").textContent, "loading");
    const status = app.nodes.find((node) => node.classList.contains("status-line"));
    assert.equal(status.hidden, true); assert.equal(status.textContent, "");
    assert.equal(ids.get("share-shell").classList.contains("share-file-view"), fileMode);
    resolveFile("# deployment"); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ids.get("share-loading").hidden, true);
    assert.equal(ids.get("share-preview-area").attrs["aria-busy"], "false");
    assert.equal(ids.get("share-status").textContent, "pageReady");
    app.events.get("pagehide")();
  }
});
test("分享目录超时停止插画并提供重试，迟到元数据不启动文件预览", async () => {
  const { app, ids, started, resolveMetadata } = shareEnvironment({ metadataPending: true });
  assert.equal(ids.get("share-loading").hidden, false);
  [...app.timers.values()][0].fn();
  assert.equal(ids.get("share-loading").hidden, true);
  assert.equal(ids.get("share-preview-area").attrs["aria-busy"], "false");
  assert(ids.get("share-state").children.some((node) => node.tag === "button"));
  resolveMetadata(); await started;
  assert.equal(app.nodes.some((node) => node.classList.contains("file-preview")), false);
});
test("固定Monaco版本本地部署且保留许可，无Node运行依赖", () => {
  const root = path.join(__dirname, "../web"), code = fs.readFileSync(path.join(root, "assets/preview-code.js"), "utf8");
  for (const file of ["vendor/monaco/vs/loader.js", "vendor/monaco/vs/editor/editor.main.js", "vendor/monaco/vs/base/worker/workerMain.js", "vendor/monaco/LICENSE", "vendor/monaco/ThirdPartyNotices.txt"]) assert(fs.existsSync(path.join(root, file)), file);
  assert.match(code, /readOnly: true, domReadOnly: true/);
  assert.match(code, /event\.origin !== location\.origin/);
  assert.match(code, /event\.source !== window\.parent/);
  assert.doesNotMatch(source + code, /https?:\/\/(?:cdn|unpkg|cdnjs|officeapps)/);
});
