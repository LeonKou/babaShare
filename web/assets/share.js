(async () => {
  "use strict";
  const { $, el, button, icon, toast, errorText } = UI;
  const token = location.pathname.startsWith("/baba-share/s/")
    ? decodeURIComponent(location.pathname.split("/")[3] || "")
    : new URL(location.href).searchParams.get("token") || "";
  let share = null;
  let currentFile = "";
  let previewBase = null;
  let loadingSequence = 0;
  const directoryCache = new Map();
  const shell = $("#share-shell");
  const layout = $("#share-layout");
  const sidebar = $("#share-sidebar");
  let immersive = false;
  let fullscreenPending = false;
  let normalTreeCollapsed = false;
  let treeCloseTimer;
  let pointerInTree = false;
  UI.settingsControls($("#share-controls"));
  const toggle = el(
    "button",
    {
      type: "button",
      "aria-label": I18n.t("toggleTree"),
      "aria-controls": "share-sidebar",
      "aria-expanded": "true",
      "data-i18n-label": "toggleTree",
      onclick: () => setTreeOpen(layout.classList.contains("tree-collapsed")),
    },
    icon("tree"),
  );
  $("#share-controls").prepend(toggle);
  const fullscreen = button("fullscreen", enterFullscreen, "", "fullscreen");
  const edge = el(
    "button",
    {
      type: "button",
      class: "share-tree-edge",
      "aria-controls": "share-sidebar",
      "aria-expanded": "false",
      "aria-label": I18n.t("toggleTree"),
      "data-i18n-label": "toggleTree",
      "data-i18n-title": "toggleTree",
      title: I18n.t("toggleTree"),
      onclick: (event) => setTreeOpen(
        event.pointerType === "mouse" && pointerInTree
          ? true
          : layout.classList.contains("tree-collapsed"),
      ),
    },
  );
  edge.hidden = true;
  shell.append(edge);
  $("#preview-actions").append(fullscreen);

  function setTreeOpen(open) {
    clearTimeout(treeCloseTimer);
    if (!open && sidebar.contains(document.activeElement))
      (immersive ? edge : toggle).focus();
    layout.classList.toggle("tree-collapsed", !open);
    sidebar.inert = !open;
    sidebar.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    edge.setAttribute("aria-expanded", String(open));
  }
  function closeTreeLater() {
    clearTimeout(treeCloseTimer);
    if (!immersive) return;
    treeCloseTimer = setTimeout(() => {
      if (!pointerInTree && !sidebar.contains(document.activeElement) && document.activeElement !== edge)
        setTreeOpen(false);
    }, 600);
  }
  for (const target of [edge, sidebar]) {
    target.addEventListener("pointerenter", (event) => {
      if (!immersive || event.pointerType === "touch") return;
      pointerInTree = true;
      setTreeOpen(true);
    });
    target.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      pointerInTree = sidebar.contains(event.relatedTarget) || edge.contains(event.relatedTarget);
      closeTreeLater();
    });
    target.addEventListener("focusin", () => clearTimeout(treeCloseTimer));
    target.addEventListener("focusout", closeTreeLater);
  }
  function setImmersive(active) {
    if (immersive === active) return;
    if (active) normalTreeCollapsed = layout.classList.contains("tree-collapsed");
    immersive = active;
    shell.classList.toggle("share-immersive", active);
    edge.hidden = !active;
    pointerInTree = false;
    setTreeOpen(active ? false : !normalTreeCollapsed);
    (active ? $("#shared-frame") : fullscreen).focus();
  }
  function syncFullscreen() {
    const element = document.fullscreenElement;
    setImmersive(element === shell || !!(element && shell.contains(element)));
  }
  async function enterFullscreen() {
    if (immersive || fullscreenPending) return;
    if (!shell.requestFullscreen) {
      toast(I18n.t("fullscreenUnavailable"));
      return;
    }
    fullscreenPending = true;
    fullscreen.disabled = true;
    try {
      await shell.requestFullscreen();
      syncFullscreen();
    } catch (error) {
      syncFullscreen();
      toast(I18n.t("fullscreenUnavailable"));
    } finally {
      fullscreenPending = false;
      fullscreen.disabled = false;
    }
  }
  // Esc 由浏览器处理，沙箱原型持有焦点时父页也能正确恢复。
  document.addEventListener("fullscreenchange", syncFullscreen);
  function state(title, hint) {
    $("#shared-frame").hidden = true;
    $("#share-state").hidden = false;
    $("#share-state").replaceChildren(
      icon("file"),
      el("h2", { text: I18n.t(title) }),
      el("p", { class: "muted", text: I18n.t(hint) }),
    );
  }
  function selectFile(entry) {
    if (
      !entry.path ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\\x00]/.test(entry.path) ||
      !/\.(html?|png|jpe?g|gif|svg|webp|txt|css|js|json|pdf)$/i.test(entry.name)
    ) {
      toast(I18n.t("previewUnsupported"));
      return;
    }
    currentFile = entry.path;
    $("#shared-frame").src =
      previewBase + entry.path.split("/").map(encodeURIComponent).join("/");
    $("#shared-frame").hidden = false;
    $("#share-state").hidden = true;
    $("#share-current").textContent = entry.path;
    document
      .querySelectorAll("#share-tree button[data-path]")
      .forEach((item) => {
        if (item.dataset.path === entry.path)
          item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      });
    const url = new URL(location.href);
    url.searchParams.set("file", entry.path);
    history.replaceState(null, "", url);
  }
  async function loadDirectory(path, list, nextPage = 1) {
    const cache = directoryCache.get(path) || {
      entries: [],
      pageIndex: 0,
      totalPage: 1,
      totalCount: 0,
    };
    const more = list.querySelector(":scope > .tree-more");
    if (more) more.remove();
    const loading = el("li", { class: "small muted", text: I18n.t("loading") });
    list.append(loading);
    list.setAttribute("aria-busy", "true");
    try {
      const response = await API("shareDetail", {
        query: { token, path, pageIndex: nextPage, pageSize: 50 },
      });
      const listing = response.listing;
      cache.entries =
        nextPage === 1
          ? listing.entries
          : cache.entries.concat(listing.entries);
      cache.pageIndex = listing.pageIndex;
      cache.totalPage = listing.totalPage;
      cache.totalCount = listing.totalCount;
      directoryCache.set(path, cache);
      renderDirectory(path, list);
      return response;
    } catch (error) {
      loading.replaceWith(
        el(
          "li",
          { class: "tree-more" },
          el("p", { class: "error small", text: errorText(error) }),
          button("retry", () => loadDirectory(path, list, nextPage)),
        ),
      );
      throw error;
    } finally {
      loading.remove();
      list.setAttribute("aria-busy", "false");
    }
  }
  function renderDirectory(path, list) {
    const cache = directoryCache.get(path);
    if (!cache) return;
    list.replaceChildren();
    for (const entry of cache.entries) {
      if (entry.kind === "folder") {
        const details = el("details");
        const summary = el("summary", { text: entry.name });
        const children = el("ul");
        let loaded = false;
        details.append(summary, children);
        details.addEventListener("toggle", async () => {
          if (!details.open || loaded) return;
          loaded = true;
          try {
            if (directoryCache.has(entry.path))
              renderDirectory(entry.path, children);
            else await loadDirectory(entry.path, children);
          } catch (error) {
            console.warn("Directory load failed", error.status || error.name);
          }
        });
        list.append(el("li", {}, details));
      } else {
        const item = el(
          "button",
          {
            type: "button",
            "data-path": entry.path,
            onclick: () => selectFile(entry),
          },
          icon(/\.html?$/i.test(entry.name) ? "code" : "file"),
          el("span", { text: entry.name }),
        );
        if (currentFile === entry.path)
          item.setAttribute("aria-current", "page");
        list.append(el("li", {}, item));
      }
    }
    if (cache.pageIndex < cache.totalPage) {
      const more = button("loadMore", () => {
        more.disabled = true;
        loadDirectory(path, list, cache.pageIndex + 1).catch((error) =>
          console.warn("Directory page failed", error.status || error.name),
        );
      });
      list.append(el("li", { class: "tree-more" }, more));
    }
  }
  function render() {
    if (!share) return;
    $("#share-title").textContent = I18n.t("sharedPreview");
    $("#share-folder-title").textContent = I18n.t("shareTree");
    $("#share-expiry").textContent =
      I18n.t("expires") + ": " + UI.date(share.expireTime);
    renderDirectory("", $("#share-tree"));
    document.title = `${I18n.t("sharedPreview")} · babaShare`;
  }
  I18n.subscribe(render);
  I18n.apply(I18n.ctx);
  async function load() {
    const request = ++loadingSequence;
    $("#share-status").textContent = I18n.t("loading");
    $("#share-stage").setAttribute("aria-busy", "true");
    try {
      const response = await loadDirectory("", $("#share-tree"));
      if (request !== loadingSequence) return;
      share = response.share;
      previewBase = response.previewBaseUrl;
      render();
      const initial =
        new URL(location.href).searchParams.get("file") ||
        response.listing.entryPath;
      if (initial)
        selectFile({ name: initial.split("/").pop(), path: initial });
      else state("shareEmpty", "selectFile");
      $("#share-status").textContent = "";
    } catch (error) {
      if (request !== loadingSequence) return;
      $("#share-status").textContent = "";
      state("shareInvalid", "shareNotFound");
      $("#share-state").append(button("retry", load));
      console.warn("Share load failed", error.status || error.name);
    } finally {
      if (request === loadingSequence)
        $("#share-stage").setAttribute("aria-busy", "false");
    }
  }
  await load();
})();
