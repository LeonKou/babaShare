(() => {
  "use strict";
  const MB = 1024 * 1024;
  const codeLanguages = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", css: "css", scss: "scss", less: "less",
    py: "python", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    go: "go", rs: "rust", rb: "ruby", php: "php", sh: "shell", bash: "shell", ps1: "powershell",
    sql: "sql", xml: "xml", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    dockerfile: "dockerfile", makefile: "makefile", vue: "html", svelte: "html",
  };
  const imageTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
  const audioTypes = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" };
  const videoTypes = { mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime" };
  function classify(name) {
    const base = String(name).split(/[\\/]/).pop().toLowerCase(), ext = base.includes(".") ? base.split(".").pop() : base;
    if (["html", "htm"].includes(ext)) return { kind: "html", limit: 16 * MB };
    if (imageTypes[ext]) return { kind: "image", mime: imageTypes[ext], limit: 32 * MB };
    if (audioTypes[ext]) return { kind: "audio", mime: audioTypes[ext], limit: 128 * MB };
    if (videoTypes[ext]) return { kind: "video", mime: videoTypes[ext], limit: 128 * MB };
    if (ext === "pdf") return { kind: "pdf", mime: "application/pdf", limit: 64 * MB };
    if (["md", "markdown", "mdown", "mkd", "mkdn"].includes(ext)) return { kind: "markdown", limit: 2 * MB };
    if (["txt", "text", "log", "csv", "tsv", "rst", "nfo", "conf", "cfg", "properties"].includes(ext) || ["readme", "license", "licence", "notice", "changelog"].includes(base)) return { kind: "text", limit: 2 * MB };
    if (codeLanguages[ext] || codeLanguages[base]) return { kind: "code", language: codeLanguages[ext] || codeLanguages[base], limit: 2 * MB };
    if (/^(docx?|xlsx?|pptx?|od[tpst]|rtf|wps|et|dps)$/.test(ext)) return { kind: "office", limit: Infinity };
    return { kind: "unsupported", limit: 0 };
  }
  function fileUrl(value) {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || !/^\/baba-share\/preview\/(s|p)\//.test(url.pathname) || !["http:", "https:"].includes(url.protocol)) throw new Error("ROUTE_NOT_ALLOWED");
    return url;
  }
  async function readBytes(url, limit, signal) {
    const response = await fetch(url, { credentials: "omit", redirect: "error", signal });
    if (!response.ok) throw new Error(response.status === 404 ? "FILE_NOT_EXIST" : "PREVIEW_READ_FAILED");
    if (Number(response.headers.get("Content-Length")) > limit) {
      await response.body?.cancel();
      throw new Error("PREVIEW_TOO_LARGE");
    }
    if (!response.body) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > limit) throw new Error("PREVIEW_TOO_LARGE");
      return bytes;
    }
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) { await reader.cancel(); throw new Error("PREVIEW_TOO_LARGE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.length; });
    return bytes.buffer;
  }
  function markdown(text) {
    const article = UI.el("article", { class: "file-preview-markdown", tabindex: "0", "aria-label": I18n.t("previewMarkdown") });
    function inline(node, value, depth = 0) {
      if (depth >= 8) { node.append(UI.el("span", { text: value })); return; }
      // 所有原文均作为文本节点处理，不接受原始HTML，也不加载Markdown图片。
      const tokens = /\\[\\`*_[\]{}()#+.!>~-]|`+[^`\n]*`+|!?\[[^\[\]\n]{0,2048}\]\([^\s)]{0,2048}(?:\s+"[^"\n]{0,2048}")?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_/g;
      let offset = 0, match;
      while ((match = tokens.exec(value))) {
        if (match.index > offset) node.append(UI.el("span", { text: value.slice(offset, match.index) }));
        const token = match[0];
        if (token[0] === "\\") node.append(UI.el("span", { text: token.slice(1) }));
        else if (token[0] === "`") node.append(UI.el("code", { text: token.replace(/^`+|`+$/g, "") }));
        else if (token[0] === "[") {
          const link = /^\[([^\]]*)\]\(([^\s)]*)(?:\s+"([^"\n]*)")?\)$/.exec(token);
          let target;
          try {
            const candidate = new URL(link[2], location.href);
            if (/^(https?:|mailto:)$/.test(candidate.protocol) && (/^(https?:|mailto:)/i.test(link[2]) || link[2].startsWith("#"))) target = candidate.href;
          } catch { /* 无效链接保留原文。 */ }
          if (target) {
            const anchor = UI.el("a", { href: target, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer" });
            if (link[3]) anchor.setAttribute("title", link[3]);
            inline(anchor, link[1], depth + 1); node.append(anchor);
          } else node.append(UI.el("span", { text: token }));
        } else if (token.startsWith("![")) node.append(UI.el("span", { text: token }));
        else {
          const double = /^(\*\*|__|~~)/.test(token), tag = token.startsWith("~~") ? "del" : double ? "strong" : "em";
          const child = UI.el(tag); inline(child, token.slice(double ? 2 : 1, double ? -2 : -1), depth + 1); node.append(child);
        }
        offset = tokens.lastIndex;
      }
      if (offset < value.length) node.append(UI.el("span", { text: value.slice(offset) }));
    }
    const cells = (line) => line.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    const tableRule = (line) => line && line.includes("|") && cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
    const listItem = (line) => /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    const fence = (line) => /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    function blocks(parent, lines, depth = 0) {
      if (depth >= 12) { parent.append(UI.el("pre", { text: lines.join("\n") })); return; }
      for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        const marker = fence(line), heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
        if (marker) {
          const body = [], closing = new RegExp("^\\s{0,3}" + marker[1][0] + "{" + marker[1].length + ",}\\s*$");
          i++;
          while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
          if (i < lines.length) i++;
          parent.append(UI.el("pre", { dir: "ltr" }, UI.el("code", { text: body.join("\n") }))); continue;
        }
        if (heading) { const node = UI.el("h" + Math.min(heading[1].length + 1, 6)); inline(node, heading[2]); parent.append(node); i++; continue; }
        if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1])) {
          const node = UI.el(lines[i + 1].trim()[0] === "=" ? "h2" : "h3"); inline(node, line); parent.append(node); i += 2; continue;
        }
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { parent.append(UI.el("hr")); i++; continue; }
        if (/^\s{0,3}>/.test(line)) {
          const quote = UI.el("blockquote"), body = [];
          while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
          blocks(quote, body, depth + 1); parent.append(quote); continue;
        }
        const first = listItem(line);
        if (first) {
          const ordered = /^\d/.test(first[2]), list = UI.el(ordered ? "ol" : "ul");
          if (ordered) list.setAttribute("start", String(parseInt(first[2], 10)));
          while (i < lines.length) {
            const item = listItem(lines[i]);
            if (!item || item[1].length !== first[1].length || /^\d/.test(item[2]) !== ordered) break;
            const body = [item[3]], indent = item[1].length + item[2].length + 1; i++;
            while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && (listItem(lines[i])?.[1].length ?? Infinity) > first[1].length) body.push(lines[i++].slice(indent));
            const li = UI.el("li"); blocks(li, body, depth + 1); list.append(li);
          }
          parent.append(list); continue;
        }
        if (line.includes("|") && tableRule(lines[i + 1])) {
          const headers = cells(line), rules = cells(lines[i + 1]);
          const table = UI.el("table"), head = UI.el("thead"), row = UI.el("tr"), body = UI.el("tbody");
          headers.forEach((value) => { const cell = UI.el("th", { scope: "col" }); inline(cell, value); row.append(cell); });
          head.append(row); table.append(head, body); i += 2;
          while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
            const values = cells(lines[i++]), tr = UI.el("tr");
            headers.forEach((_, index) => {
              const cell = UI.el("td");
              if (rules[index]?.startsWith(":")) cell.setAttribute("class", rules[index].endsWith(":") ? "markdown-align-center" : "markdown-align-start");
              else if (rules[index]?.endsWith(":")) cell.setAttribute("class", "markdown-align-end");
              inline(cell, values[index] || ""); tr.append(cell);
            }); body.append(tr);
          }
          parent.append(UI.el("div", { class: "file-preview-markdown-table", role: "region", tabindex: "0", "aria-label": I18n.t("previewMarkdown") }, table)); continue;
        }
        const paragraph = [line]; i++;
        while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !/^\s{0,3}(#{1,6}\s|>|([-*_])(?:\s*\2){2,}\s*$)/.test(lines[i]) && !listItem(lines[i]) && !tableRule(lines[i + 1])) paragraph.push(lines[i++]);
        const node = UI.el("p"); inline(node, paragraph.join("\n")); parent.append(node);
      }
    }
    blocks(article, text.replace(/\r\n?/g, "\n").split("\n"));
    return article;
  }
  function create(host) {
    const { el } = UI;
    const root = el("section", { class: "file-preview", tabindex: "-1", "aria-label": I18n.t("filePreview"), "data-i18n-label": "filePreview" });
    const status = el("div", { class: "status-line", role: "status", "aria-live": "polite" });
    const download = el("a", { class: "file-preview-download", text: I18n.t("previewDownload"), "data-i18n": "previewDownload", download: "" });
    const content = el("div", { class: "file-preview-body" });
    download.hidden = true;
    const receiptStatus = el("div", { class: "status-line", role: "status", "aria-live": "polite" });
    root.append(status, download, content, receiptStatus);
    let receipt = null, receiptRetry = null;
    host.append(root);
    let generation = 0, controller = null, blobUrl = null, media = null, frame = null, unsubscribe = null, messageHandler = null, timer = null, disposed = false;
    function clear() {
      ++generation;
      receipt = null;
      receiptStatus.textContent = "";
      receiptRetry?.remove(); receiptRetry = null;
      controller?.abort(); controller = null;
      clearTimeout(timer); timer = null;
      if (messageHandler) window.removeEventListener("message", messageHandler);
      messageHandler = null;
      unsubscribe?.(); unsubscribe = null;
      if (frame) {
        if (["code", "office"].includes(frame.dataset.trusted)) frame.contentWindow?.postMessage({ type: "preview-" + frame.dataset.trusted + ".dispose", version: 1 }, location.origin);
        frame.src = "about:blank"; frame = null;
      }
      if (media) { media.pause(); media.removeAttribute("src"); media.load(); media = null; }
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      content.replaceChildren();
    }
    function setStatus(key) { status.hidden = false; status.setAttribute("data-i18n", key); status.textContent = I18n.t(key); }
    function loaded() { status.hidden = true; status.textContent = ""; status.removeAttribute("data-i18n"); root.setAttribute("aria-busy", "false"); }
    function showError(key) { setStatus(key); status.classList.add("error"); download.hidden = !download.href; root.setAttribute("aria-busy", "false"); }
    async function load(entry) {
      if (disposed) return;
      clear();
      const current = generation;
      const format = classify(entry.name);
      let completed = false, failed = false, receiptBusy = false, receiptDone = false;
      let onboardingTicket = typeof entry.onboardingTicket === "string" ? entry.onboardingTicket : null;
      const complete = () => {
        if (current !== generation || disposed || failed || completed) return;
        completed = true;
        loaded();
        if (!onboardingTicket || !window.API) return;
        receipt = async () => {
          if (receiptBusy || receiptDone || failed || current !== generation || disposed) return;
          receiptBusy = true;
          if (receiptRetry) receiptRetry.disabled = true;
          try {
            await API("onboardingPreview", { method: "POST", body: { ticket: onboardingTicket }, signal: controller.signal });
            receiptDone = true; onboardingTicket = null;
            if (current !== generation || disposed) return;
            receiptStatus.textContent = "";
            receiptRetry?.remove(); receiptRetry = null;
            if (window.AppPage?.embedded) window.AppPage.request("onboarding.changed", { version: 1 }).catch((error) => console.warn("Onboarding refresh failed", error));
          } catch (error) {
            if (current !== generation || disposed || error.name === "AbortError") return;
            receiptStatus.textContent = I18n.t("onboardingReceiptFailed");
            if (!receiptRetry) { receiptRetry = UI.button("onboardingRetry", () => receipt?.()); root.append(receiptRetry); }
          } finally { receiptBusy = false; if (receiptRetry) receiptRetry.disabled = false; }
        };
        receipt();
      };
      const fail = (key) => {
        if (current !== generation || disposed) return;
        failed = true; onboardingTicket = null; receipt = null;
        receiptRetry?.remove(); receiptRetry = null; receiptStatus.textContent = "";
        showError(key);
      };
      controller = new AbortController();
      download.hidden = true;
      download.removeAttribute("href");
      status.classList.remove("error"); setStatus("loading"); root.setAttribute("aria-busy", "true");
      try {
        const url = fileUrl(entry.url), target = new URL(url);
        target.searchParams.set("download", "1"); download.href = target.href; download.download = entry.name;
        if (format.kind === "unsupported") { showError("previewUnsupported"); return; }
        if (Number(entry.size) > format.limit) { showError("PREVIEW_TOO_LARGE"); return; }
        if (format.kind === "html") {
          await readBytes(url, format.limit, controller.signal);
          if (current !== generation || disposed) return;
          frame = el("iframe", { class: "preview-frame", title: I18n.t("filePreview"), "data-i18n-title": "filePreview", sandbox: "allow-scripts", allow: "fullscreen", allowfullscreen: "", referrerpolicy: "no-referrer" });
          frame.addEventListener("load", complete);
          frame.addEventListener("error", () => fail("previewReadFailed"));
          frame.src = url.href; content.append(frame); return;
        }
        const bytes = await readBytes(url, format.limit, controller.signal);
        if (current !== generation || disposed) return;
        if (format.kind === "office") {
          frame = el("iframe", { class: "preview-frame", title: I18n.t("previewOffice"), "data-i18n-title": "previewOffice", sandbox: "allow-scripts allow-same-origin", src: "/baba-share/preview-office.html", referrerpolicy: "no-referrer" });
          frame.dataset.trusted = "office";
          const child = frame;
          let delivered = false;
          const sendContext = () => { if (disposed || failed || current !== generation) return; child.contentWindow?.postMessage({ type: "preview-office.context", version: 1, context: { ...I18n.ctx } }, location.origin); };
          messageHandler = (event) => {
            if (event.origin !== location.origin || event.source !== child.contentWindow || event.data?.version !== 1 || current !== generation || disposed || failed) return;
            if (event.data.type === "preview-office.ready" && !delivered) {
              delivered = true;
              child.contentWindow.postMessage({ type: "preview-office.load", version: 1, bytes, name: entry.name, context: { ...I18n.ctx } }, location.origin, [bytes]);
            }
            if (event.data.type === "preview-office.loaded" && delivered) { clearTimeout(timer); complete(); }
            if (event.data.type === "preview-office.error") { clearTimeout(timer); fail("previewRendererFailed"); }
          };
          window.addEventListener("message", messageHandler);
          unsubscribe = I18n.subscribe(sendContext);
          timer = setTimeout(() => { fail("previewRendererFailed"); }, 120000);
          content.append(frame); return;
        }
        if (["code", "text", "markdown"].includes(format.kind)) {
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { showError("previewEncodingUnsupported"); return; }
          if (text.includes("\u0000")) { showError("previewEncodingUnsupported"); return; }
          if (format.kind === "code") {
            frame = el("iframe", { class: "preview-frame", title: I18n.t("previewCode"), "data-i18n-title": "previewCode", sandbox: "allow-scripts allow-same-origin", src: "/baba-share/preview-code.html", referrerpolicy: "no-referrer" });
            frame.dataset.trusted = "code";
            const child = frame;
            let delivered = false;
            const send = () => { if (disposed || failed || current !== generation) return; child.contentWindow?.postMessage({ type: "preview-code.load", version: 1, text, language: format.language, context: { ...I18n.ctx }, label: I18n.t("previewCode"), hint: I18n.t("previewCodeKeyboard") }, location.origin); };
            messageHandler = (event) => {
              if (event.origin !== location.origin || event.source !== child.contentWindow || event.data?.version !== 1 || current !== generation || disposed || failed) return;
              if (event.data.type === "preview-code.ready" && !delivered) { delivered = true; send(); }
              if (event.data.type === "preview-code.loaded" && delivered) { clearTimeout(timer); complete(); }
              if (event.data.type === "preview-code.error") { clearTimeout(timer); fail("previewRendererFailed"); }
            };
            window.addEventListener("message", messageHandler);
            unsubscribe = I18n.subscribe(send);
            timer = setTimeout(() => { fail("previewRendererFailed"); }, 30000);
            content.append(frame); return;
          }
          content.append(format.kind === "markdown" ? markdown(text) : el("pre", { class: "file-preview-text", text, tabindex: "0", dir: "auto", "aria-label": I18n.t("filePreview") }));
          complete();
        } else {
          blobUrl = URL.createObjectURL(new Blob([bytes], { type: format.mime }));
          if (format.kind === "image") {
            const image = el("img", { class: "file-preview-image", src: blobUrl, alt: entry.name });
            image.addEventListener("load", complete);
            image.addEventListener("error", () => fail("previewRendererFailed")); content.append(image);
          } else if (format.kind === "pdf") {
            frame = el("iframe", { class: "preview-frame", src: blobUrl, title: I18n.t("filePreview"), "data-i18n-title": "filePreview", referrerpolicy: "no-referrer" });
            // 浏览器原生PDF查看器无可信渲染完成协议，不把iframe load作为任务成功凭据。
            frame.addEventListener("load", () => { if (current === generation && !disposed) loaded(); });
            content.append(frame);
          } else {
            media = el(format.kind, { class: "file-preview-media", controls: "", preload: "metadata", src: blobUrl, "aria-label": entry.name });
            media.addEventListener("loadeddata", complete);
            media.addEventListener("canplay", complete);
            media.addEventListener("error", () => fail("previewMediaUnsupported")); content.append(media);
          }
        }
      } catch (error) {
        if (current !== generation || disposed || error.name === "AbortError") return;
        fail(error.message === "PREVIEW_TOO_LARGE" ? "PREVIEW_TOO_LARGE" : error.message === "FILE_NOT_EXIST" ? "FILE_NOT_EXIST" : "previewReadFailed");
      }
    }
    function stop() { if (disposed) return; disposed = true; ++generation; controller?.abort(); clearTimeout(timer); receipt = null; }
    function dispose() { stop(); clear(); root.remove(); window.removeEventListener("pagehide", dispose); }
    window.addEventListener("pagehide", dispose);
    return { root, load, stop, dispose, focus: () => { (frame || media || (!download.hidden && download) || content.querySelector("[tabindex]") || root).focus(); } };
  }
  function open(name, url, options = {}) {
    let viewer, enterFrame, revealFrame, exitTimer, closing = false;
    const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dialog = UI.dialog(name, (node, close) => {
      node.classList.add("file-preview-page");
      const surface = UI.el("section", { class: "file-preview-page-content" });
      const finish = () => close(null);
      const requestClose = () => {
        if (closing) return;
        closing = true;
        viewer.stop();
        cancelAnimationFrame(enterFrame); cancelAnimationFrame(revealFrame);
        node.classList.remove("is-visible");
        if (reducedMotion()) finish();
        else exitTimer = setTimeout(finish, 320);
      };
      const back = UI.button("close", requestClose, "file-preview-close");
      back.setAttribute("data-i18n-label", "close");
      const heading = node.querySelector("h2");
      heading.setAttribute("title", name);
      surface.append(UI.el("header", { class: "file-preview-page-header" }, heading, back));
      node.append(surface);
      viewer = create(surface);
      node.addEventListener("cancel", (event) => { event.preventDefault(); requestClose(); });
      node.addEventListener("transitionend", (event) => {
        if (closing && event.target === node && event.propertyName === "transform") finish();
      });
    }, { initialFocus: ".file-preview-close" });
    const cleanup = () => {
      cancelAnimationFrame(enterFrame); cancelAnimationFrame(revealFrame); clearTimeout(exitTimer);
      window.removeEventListener("pagehide", leave);
      viewer.dispose();
    };
    const leave = () => dialog.close(null);
    dialog.node.addEventListener("close", cleanup, { once: true });
    window.addEventListener("pagehide", leave);
    viewer.load({ name, url, ...options });
    // 等待初始离屏状态绘制，避免首次打开跳过滑入动画。
    enterFrame = requestAnimationFrame(() => {
      revealFrame = requestAnimationFrame(() => { if (!closing) dialog.node.classList.add("is-visible"); });
    });
    return dialog.result.finally(cleanup);
  }
  window.FilePreview = { classify, readBytes, create, open };
})();
