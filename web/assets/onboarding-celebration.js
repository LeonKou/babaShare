(() => {
  "use strict";
  const DURATION = 10000;
  const instances = new WeakMap();
  const defaults = {
    eyebrow: "一段新的开始", title: "让作品，启航。",
    message: "那些只存在于你脑海里的东西，现在有了被世界看见的入口。",
    dedication: "这幅启航纪念，属于", creator: "创作者", brand: "babaShare",
    sceneDescription: "两位伙伴把作品折成纸飞机，飞过六颗由成就点亮的星星。",
    completed: "作品已启航。你的纪念画面已呈现。",
    achievement1: "进入空间", achievement2: "建立文件夹", achievement3: "上传作品",
    achievement4: "成功预览作品", achievement5: "创建 MCP Key", achievement6: "成功调用 MCP 工具",
  };

  function mount(container, options = {}) {
    instances.get(container)?.destroy();
    const labels = {};
    function resolveLabels(nextLabels) {
      const missing = [];
      for (const key of Object.keys(defaults)) {
        const supplied = nextLabels?.[key];
        labels[key] = typeof supplied === "string" && supplied.trim() ? supplied : defaults[key];
        if (labels[key] === defaults[key] && supplied !== defaults[key]) missing.push(key);
      }
      if (missing.length) console.warn("[OnboardingCelebration] 缺失文案，使用中文默认值：", missing.join(", "));
    }
    resolveLabels(options.labels);
    const doc = container.ownerDocument || document;
    const win = doc.defaultView || window;
    const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
    const cleanups = [];
    let disposed = false, completed = false, suspended = false;
    let timer = null, remaining = DURATION, startedAt = null;

    function element(tag, className, text, parent) {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      parent?.append(node);
      return node;
    }
    function svgNode(tag, attributes, parent) {
      const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      parent?.append(node);
      return node;
    }
    function path(parent, className, d) { return svgNode("path", { class: className, d }, parent); }
    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    }

    const root = element("section", "onboarding-celebration");
    root.dataset.state = "playing";
    root.dataset.paused = "false";
    root.setAttribute("aria-label", labels.title);
    const heading = element("header", "oc-heading", undefined, root);
    const eyebrow = element("p", "oc-eyebrow", labels.eyebrow, heading);
    const title = element("h2", "oc-title", labels.title, heading);
    const art = element("div", "oc-art", undefined, root);
    const svg = svgNode("svg", { class: "oc-scene", viewBox: "0 0 800 440", role: "img", focusable: "false", "aria-label": labels.sceneDescription + " " + [1, 2, 3, 4, 5, 6].map((i) => labels["achievement" + i]).join(" · ") }, art);
    const scenery = svgNode("g", { class: "oc-scenery" }, svg);
    svgNode("ellipse", { class: "oc-atmosphere", cx: 498, cy: 196, rx: 218, ry: 156 }, scenery);
    svgNode("ellipse", { class: "oc-atmosphere-inner", cx: 498, cy: 196, rx: 156, ry: 112 }, scenery);
    path(scenery, "oc-horizon", "M70 380H730M124 393H316M478 393H670");
    svgNode("ellipse", { class: "oc-shadow", cx: 266, cy: 376, rx: 80, ry: 8 }, scenery);
    svgNode("ellipse", { class: "oc-shadow", cx: 475, cy: 376, rx: 69, ry: 8 }, scenery);
    path(scenery, "oc-distant-line", "M114 246V214H145M655 315H699V270M93 307H124M656 67H686V97");
    const constellation = svgNode("g", { class: "oc-constellation" }, svg);
    path(constellation, "oc-orbit", "M338 278C354 233 372 210 392 194C412 176 426 136 451 120C476 98 508 82 541 84C579 83 618 101 646 122C674 144 692 164 706 188");
    const stars = [[392, 194], [451, 120], [541, 84], [597, 94], [646, 122], [706, 188]];
    const starTitles = [];
    stars.forEach(([x, y], index) => {
      const star = svgNode("g", { class: "oc-star oc-star-" + (index + 1), transform: `translate(${x} ${y})` }, constellation);
      const starTitle = svgNode("title", {}, star);
      starTitle.textContent = labels["achievement" + (index + 1)];
      starTitles.push(starTitle);
      svgNode("circle", { class: "oc-star-halo", r: 18 }, star);
      svgNode("circle", { class: "oc-star-ring", r: 11 }, star);
      path(star, "oc-star-core", "M0 -7L2 -2L7 0L2 2L0 7L-2 2L-7 0L-2 -2Z");
      svgNode("circle", { class: "oc-star-satellite", cx: index % 2 ? -19 : 21, cy: -15, r: 2 }, star);
    });
    [[175, 144], [294, 112], [608, 228], [736, 96], [357, 63], [571, 301]].forEach(([cx, cy]) => {
      svgNode("circle", { class: "oc-dust", cx, cy, r: 1.5 }, scenery);
    });

    // 角色的各层均为原创矢量路径；肤色和衣料使用语义令牌随主题变换。
    const left = svgNode("g", { class: "oc-character oc-maker" }, svg);
    path(left, "oc-trousers", "M233 288L277 288L290 365H269L253 318L246 365H225Z");
    path(left, "oc-shoes", "M224 361H246V374H211Q210 365 224 361ZM268 362H290L302 374H268Z");
    path(left, "oc-shirt oc-shirt-accent", "M237 219Q250 212 268 220L286 280L276 299H228L219 253Z");
    path(left, "oc-seam", "M239 228L246 242L255 235M248 244L255 289M233 275L245 278");
    path(left, "oc-arm-back", "M228 235Q209 256 222 281");
    path(left, "oc-hand-line", "M222 281L231 286");
    path(left, "oc-neck", "M241 204H257V226Q249 231 241 225Z");
    path(left, "oc-hair", "M222 184Q216 155 242 151Q268 148 273 172L267 204L229 211Z");
    path(left, "oc-face", "M229 176Q250 184 262 170L269 185L266 201Q259 218 245 215Q226 213 226 192Z");
    path(left, "oc-hair-detail", "M229 164Q245 157 258 163");
    svgNode("circle", { class: "oc-eye", cx: 249, cy: 191, r: 2 }, left);
    svgNode("circle", { class: "oc-eye", cx: 261, cy: 189, r: 2 }, left);
    path(left, "oc-smile", "M250 202Q256 206 261 200");
    const leftArm = svgNode("g", { class: "oc-fold-arm oc-fold-arm-start" }, left);
    path(leftArm, "oc-arm-front", "M266 234Q284 256 318 256");
    path(leftArm, "oc-hand-line", "M318 256L331 251M324 255L333 257");

    const right = svgNode("g", { class: "oc-character oc-companion" }, svg);
    path(right, "oc-hair", "M450 177Q447 149 474 149Q504 147 508 180L518 235H449Z");
    path(right, "oc-trousers", "M459 290H497L510 364H488L477 322L468 364H447Z");
    path(right, "oc-shoes", "M447 361H469V374H434Q434 365 447 361ZM488 361H510L523 374H488Z");
    path(right, "oc-shirt oc-shirt-neutral", "M462 222Q476 214 493 224L509 296H445L448 249Z");
    path(right, "oc-seam", "M465 230L475 242L486 230M478 243L481 286M451 282H466");
    path(right, "oc-arm-back oc-arm-neutral", "M495 240Q522 261 505 283");
    path(right, "oc-hand-line", "M505 283L496 288");
    path(right, "oc-neck", "M468 207H483V228Q476 233 468 226Z");
    path(right, "oc-face", "M458 176Q480 182 491 170L501 186L498 201Q490 218 477 217Q458 216 455 197Z");
    path(right, "oc-hair-detail", "M457 165Q470 156 485 161");
    svgNode("circle", { class: "oc-eye", cx: 465, cy: 191, r: 2 }, right);
    svgNode("circle", { class: "oc-eye", cx: 478, cy: 193, r: 2 }, right);
    path(right, "oc-smile", "M464 203Q469 209 477 204");
    const rightArm = svgNode("g", { class: "oc-fold-arm oc-fold-arm-end" }, right);
    path(rightArm, "oc-arm-front oc-arm-neutral", "M455 239Q429 262 378 257");
    path(rightArm, "oc-hand-line", "M378 257L364 251M373 256L364 258");

    const documentArt = svgNode("g", { class: "oc-document" }, svg);
    path(documentArt, "oc-paper", "M319 216H363L377 230V273H319ZM363 216V230H377");
    path(documentArt, "oc-paper-line", "M329 238H361M329 246H352M329 257H346");
    const fold = svgNode("g", { class: "oc-fold" }, svg);
    path(fold, "oc-paper", "M310 250L374 226L352 274Z");
    path(fold, "oc-paper-crease", "M310 250L350 250L374 226M350 250L352 274");
    const flight = svgNode("g", { class: "oc-flight" }, svg);
    const plane = svgNode("g", { class: "oc-plane" }, flight);
    svgNode("ellipse", { class: "oc-plane-aura", cx: -14, cy: 4, rx: 58, ry: 31 }, plane);
    path(plane, "oc-plane-under", "M-42 -13L42 -21L-7 28L-14 7Z");
    path(plane, "oc-plane-wing", "M-42 -13L42 -21L-14 7Z");
    path(plane, "oc-plane-wing-light", "M42 -21L7 15L-7 28L-1 4Z");
    path(plane, "oc-plane-crease", "M-14 7L42 -21L-1 4L-7 28");
    path(plane, "oc-plane-trail", "M-64 4H-91M-60 12H-78");

    const keepsake = element("div", "oc-keepsake", undefined, root);
    const message = element("p", "oc-message", labels.message, keepsake);
    const signature = element("div", "oc-signature", undefined, keepsake);
    const owner = element("p", "oc-owner", undefined, signature);
    const dedication = element("span", "oc-dedication", labels.dedication, owner);
    const hasNickname = typeof options.nickname === "string" && options.nickname.trim();
    const nickname = element("bdi", "oc-nickname", hasNickname ? options.nickname : labels.creator, owner);
    nickname.setAttribute("dir", "auto");
    const brand = element("span", "oc-brand", labels.brand, signature);
    const status = element("p", "oc-status", "", root);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    container.append(root);

    function stopClock() {
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      if (startedAt !== null) remaining = Math.max(0, remaining - (win.performance.now() - startedAt));
      startedAt = null;
    }
    function finish() {
      if (disposed || completed) return;
      stopClock();
      completed = true;
      root.dataset.state = "complete";
      root.dataset.paused = "true";
      status.textContent = labels.completed;
      if (typeof options.onComplete === "function") options.onComplete();
    }
    function sync() {
      if (disposed || completed) return;
      if (reduced.matches) { finish(); return; }
      const paused = doc.hidden || suspended;
      root.dataset.paused = String(paused);
      if (paused) stopClock();
      else if (timer === null) {
        startedAt = win.performance.now();
        timer = win.setTimeout(finish, remaining);
      }
    }
    const api = {
      skip: finish,
      updateLabels(nextLabels) {
        if (disposed) return;
        resolveLabels(nextLabels);
        eyebrow.textContent = labels.eyebrow;
        title.textContent = labels.title;
        message.textContent = labels.message;
        dedication.textContent = labels.dedication;
        brand.textContent = labels.brand;
        if (!hasNickname) nickname.textContent = labels.creator;
        root.setAttribute("aria-label", labels.title);
        svg.setAttribute("aria-label", labels.sceneDescription + " " + [1, 2, 3, 4, 5, 6].map((i) => labels["achievement" + i]).join(" · "));
        starTitles.forEach((node, index) => { node.textContent = labels["achievement" + (index + 1)]; });
        if (completed) status.textContent = labels.completed;
      },
      replay() {
        if (disposed) return;
        stopClock();
        completed = false;
        remaining = DURATION;
        status.textContent = "";
        // 在原节点重置 CSS 时间轴，不重建昵称和辅助阅读结构。
        root.dataset.state = "reset";
        void root.offsetWidth;
        root.dataset.state = "playing";
        sync();
      },
      destroy() {
        if (disposed) return;
        disposed = true;
        stopClock();
        cleanups.splice(0).forEach((cleanup) => cleanup());
        root.remove();
        if (instances.get(container) === api) instances.delete(container);
      },
    };
    listen(doc, "visibilitychange", sync);
    listen(reduced, "change", sync);
    listen(win, "pagehide", (event) => {
      if (!event.persisted) api.destroy();
      else { suspended = true; sync(); }
    });
    listen(win, "pageshow", () => { suspended = false; sync(); });
    instances.set(container, api);
    sync();
    return api;
  }
  window.OnboardingCelebration = { mount };
})();
