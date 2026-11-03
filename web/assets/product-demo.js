(() => {
  "use strict";
  function mount(root) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const compact = matchMedia("(max-width: 1000px)");
    let visible = !window.IntersectionObserver;
    let suspended = false, disposed = false, covered = false;
    const passwordDemo = root.id === "auth-product-demo";
    const cleanups = [];
    const armPoses = [];
    function drawArm(parent, tone, sleeve, hand, coveredSleeve, coveredHand) {
      const arm = svgNode("g", { class: "demo-pose-arm" }, parent);
      for (const [className, normal, hidden] of [
        [`demo-arm demo-arm-${tone}`, sleeve, coveredSleeve],
        ["demo-hand", hand, coveredHand],
      ]) {
        const node = svgNode("path", { class: className, d: normal }, arm);
        if (passwordDemo) armPoses.push({ node, normal, covered: hidden });
      }
    }
    function svgNode(tag, attributes, parent) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      parent?.append(element);
      return element;
    }
    function listen(target, event, handler) {
      target.addEventListener(event, handler);
      cleanups.push(() => target.removeEventListener(event, handler));
    }
    const scene = document.createElement("div");
    scene.className = "product-demo-scene";
    scene.setAttribute("aria-hidden", "true");
    const svg = svgNode("svg", { viewBox: "80 44 320 208", focusable: "false" }, scene);
    // 两位递送原型的小伙伴是纯装饰插画，不读取真实文件或账户信息。
    svgNode("ellipse", { class: "demo-ground", cx: 240, cy: 235, rx: 152, ry: 9 }, svg);
    const sender = svgNode("g", { class: "demo-character demo-sender" }, svg);
    svgNode("path", { class: "demo-trousers", d: "M119 166L152 166L160 222H144L135 187L128 222H112Z" }, sender);
    svgNode("path", { class: "demo-shoes", d: "M111 219H129V230H102Q100 222 111 219ZM143 219H160L168 230H143Z" }, sender);
    svgNode("path", { class: "demo-shirt demo-shirt-accent", d: "M121 114Q134 108 147 115L165 158L153 174H113L106 141Z" }, sender);
    svgNode("path", { class: "demo-neck", d: "M128 103H140V119Q134 125 128 119Z" }, sender);
    svgNode("path", { class: "demo-hair", d: "M112 86Q106 60 131 59Q158 59 155 87L147 109H119Z" }, sender);
    svgNode("path", { class: "demo-face", d: "M118 80Q131 85 143 74L149 86V98Q146 114 132 113Q116 109 116 94Z" }, sender);
    const senderEyes = svgNode("g", { class: "demo-eyes demo-eyes-sender" }, sender);
    svgNode("circle", { class: "demo-eye", cx: 132, cy: 91, r: 1.6 }, senderEyes);
    svgNode("circle", { class: "demo-eye", cx: 143, cy: 90, r: 1.6 }, senderEyes);
    svgNode("path", { class: "demo-smile", d: "M134 101Q139 105 144 100" }, sender);
    const receiver = svgNode("g", { class: "demo-character demo-receiver" }, svg);
    svgNode("path", { class: "demo-trousers", d: "M326 168H359L370 221H353L343 188L337 221H322Z" }, receiver);
    svgNode("path", { class: "demo-shoes", d: "M321 219H338V230H312Q309 223 321 219ZM352 219H370L379 230H352Z" }, receiver);
    svgNode("path", { class: "demo-hair", d: "M324 83Q319 59 343 57Q366 55 369 83L376 123H322Z" }, receiver);
    svgNode("path", { class: "demo-shirt demo-shirt-neutral", d: "M328 116Q344 109 357 119L369 172H316L316 143Z" }, receiver);
    svgNode("path", { class: "demo-neck", d: "M335 104H348V120Q342 125 335 120Z" }, receiver);
    svgNode("path", { class: "demo-face", d: "M330 79Q343 84 355 73L359 91Q359 111 343 114Q328 112 326 96Z" }, receiver);
    const receiverEyes = svgNode("g", { class: "demo-eyes demo-eyes-receiver" }, receiver);
    svgNode("circle", { class: "demo-eye", cx: 332, cy: 91, r: 1.6 }, receiverEyes);
    svgNode("circle", { class: "demo-eye", cx: 343, cy: 92, r: 1.6 }, receiverEyes);
    svgNode("path", { class: "demo-smile", d: "M331 101Q337 106 342 102" }, receiver);
    // 两页共用递送姿态；捂眼只改变路径，肩部起点固定，袖口与手掌始终相接。
    // 手臂置于脸部之后绘制，确保捂眼时手掌位于眼睛前方。
    drawArm(sender, "accent", "M148 128Q168 151 196 138", "M196 138L207 132",
      "M148 128Q163 106 143 98", "M143 98L143 88");
    drawArm(sender, "accent", "M115 128Q98 148 109 163", "M109 163L115 168",
      "M115 128Q104 106 132 98", "M132 98L132 88");
    drawArm(receiver, "neutral", "M327 129Q307 151 284 142", "M284 142L273 137",
      "M327 129Q311 107 332 98", "M332 98L332 88");
    drawArm(receiver, "neutral", "M357 130Q379 146 364 162", "M364 162L358 166",
      "M357 130Q373 107 343 99", "M343 99L343 89");
    const card = svgNode("g", { class: "demo-delivery" }, svg);
    svgNode("path", { class: "demo-card", d: "M201 91H239L249 101V141H201ZM239 91V101H249" }, card);
    svgNode("circle", { class: "demo-card-sun", cx: 213, cy: 106, r: 3 }, card);
    svgNode("path", { class: "demo-card-art", d: "M209 127L220 115L226 121L232 115L241 127Z" }, card);
    svgNode("path", { class: "demo-spark", d: "M238 65V75M233 70H243" }, svg);
    // 用户明确选择无播放/暂停控件；保留系统减少动画和不可见时的节能暂停。
    root.setAttribute("aria-hidden", "true");
    root.replaceChildren(scene);
    function sync() {
      root.dataset.running = String(!disposed && !covered && !reduced.matches && !compact.matches && !document.hidden && !suspended && visible);
    }
    if (passwordDemo) {
      root.setPasswordCovered = (value) => {
        covered = !disposed && !suspended && value === true;
        root.dataset.passwordCovered = String(covered);
        for (const pose of armPoses) pose.node.setAttribute("d", covered ? pose.covered : pose.normal);
        sync();
      };
      root.setPasswordCovered(false);
      cleanups.push(() => { delete root.setPasswordCovered; });
    }
    listen(reduced, "change", sync);
    listen(compact, "change", sync);
    listen(document, "visibilitychange", sync);
    listen(window, "pagehide", (event) => {
      suspended = true;
      root.setPasswordCovered?.(false);
      sync();
      if (!event.persisted) {
        disposed = true; observer?.disconnect();
        cleanups.forEach((cleanup) => cleanup());
      }
    });
    listen(window, "pageshow", () => { suspended = false; sync(); });
    const observer = window.IntersectionObserver ? new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting); sync();
    }) : null;
    observer?.observe(root);
    sync();
  }
  document.querySelectorAll("[data-product-demo]").forEach(mount);
})();
