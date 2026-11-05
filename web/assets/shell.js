(async () => {
  "use strict";
  const { $, el, button, icon, toast, errorText } = UI;
  let iframe = $("#page-frame"), frameTimer, frameEpoch = 0, frameUrl = "", frameLoaded = false, frameReady = false, frameFailed = false, disposed = false;
  const main = $(".app-main"), loading = $("#page-loading"), failure = $("#page-load-error"), announcement = $("#page-announcement");
  let startupState = "loading";
  const startupController = new AbortController();
  const startupActive = () => !disposed && startupState === "loading";
  function pending() {
    if (disposed || startupState === "failed") return;
    frameLoaded = false; frameReady = false; frameFailed = false;
    main.setAttribute("aria-busy", "true");
    iframe.classList.add("page-pending"); iframe.inert = true;
    iframe.setAttribute("aria-hidden", "true");
    loading.hidden = false; failure.hidden = true;
    announcement.setAttribute("data-i18n", "loading"); announcement.textContent = I18n.t("loading");
    clearTimeout(frameTimer);
    const epoch = frameEpoch;
    frameTimer = setTimeout(() => { if (!disposed && epoch === frameEpoch) frameFailure("pageLoadTimeout"); }, 20000);
  }
  function frameFailure(key = "pageLoadError") {
    if (frameFailed || disposed) return;
    frameFailed = true;
    if (startupState === "loading") { startupState = "failed"; startupController.abort(); }
    clearTimeout(frameTimer);
    host?.destroy();
    main.setAttribute("aria-busy", "false"); loading.hidden = true;
    iframe.classList.add("page-pending"); iframe.inert = true; iframe.setAttribute("aria-hidden", "true");
    failure.hidden = false;
    failure.replaceChildren(el("p", { "data-i18n": key, text: I18n.t(key) }), button("retry", () => startupState === "ready" ? navigate(active, true) : location.reload()));
    announcement.removeAttribute("data-i18n"); announcement.textContent = "";
  }
  function showFrameWhenReady() {
    if (disposed || frameFailed || !frameLoaded || !frameReady) return;
    clearTimeout(frameTimer);
    main.setAttribute("aria-busy", "false"); loading.hidden = true; failure.hidden = true;
    iframe.classList.remove("page-pending"); iframe.inert = false;
    iframe.removeAttribute("aria-hidden");
    announcement.setAttribute("data-i18n", "pageReady"); announcement.textContent = I18n.t("pageReady");
  }
  function frameState(state) {
    if (disposed || frameFailed || startupState !== "ready") return;
    if (state === "loading") { pending(); return; }
    if (state === "error") { frameFailure(); return; }
    if (state !== "ready") return;
    frameReady = true;
    showFrameWhenReady();
  }
  let user = null,
    workspaces = [],
    active = { routeId: "workspace", params: {} },
    navigating = false,
    host;
  let onboarding = null, onboardingRequest = null, onboardingRefreshAgain = false;
  const taskFeedback = OnboardingFeedback.create();
  async function refreshOnboarding() {
    if (disposed || startupState === "failed" || !user || user.role === "admin") return;
    if (onboardingRequest) { onboardingRefreshAgain = true; return onboardingRequest; }
    onboardingRequest = API("onboarding", startupState === "loading" ? { signal: startupController.signal } : undefined).then((value) => {
      if (disposed || startupState === "failed") return;
      const keys = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
      if (value?.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.tasks)) throw new Error("INVALID_RESPONSE");
      if (value.totalCount !== keys.length || value.tasks.length !== keys.length ||
        new Set(value.tasks.map((task) => task?.key)).size !== keys.length ||
        !value.tasks.every((task) => keys.includes(task?.key) && typeof task.completed === "boolean") ||
        !Number.isInteger(value.completedCount) || value.completedCount < 0 || value.completedCount > keys.length ||
        value.completedCount !== value.tasks.filter((task) => task.completed).length ||
        value.allComplete !== (value.completedCount === keys.length)) throw new Error("INVALID_RESPONSE");
      onboarding = value;
      taskFeedback.accept(value);
      renderNav();
    }).catch(() => { if (disposed || startupState === "failed") return; onboarding = null; renderNav(); console.warn("Onboarding status unavailable"); })
      .finally(() => {
        onboardingRequest = null;
        if (onboardingRefreshAgain) { onboardingRefreshAgain = false; return refreshOnboarding(); }
      });
    return onboardingRequest;
  }
  window.addEventListener("focus", refreshOnboarding);
  UI.settingsControls($("#shell-controls"));
  $("#new-workspace-icon").append(icon("plus"));
  $("#logout-icon").append(icon("logout"));
  async function navigate(payload, skipCheck = false) {
    if (disposed || startupState !== "ready" || navigating) return false;
    navigating = true;
    try {
      if (!skipCheck && !(await host.request("page.beforeLeave", {})))
        return false;
      if (disposed || startupState !== "ready") return false;
      if (payload.routeId === "auth") {
        location.href = UI.routeUrl("auth");
        return true;
      }
      if (["users", "settings", "workspace-admin"].includes(payload.routeId) && user?.role !== "admin")
        throw { status: "PERMISSION_DENIED" };
      if (!["workspace", "account", "onboarding", "users", "settings", "workspace-admin"].includes(payload.routeId)) throw new Error("ROUTE_NOT_ALLOWED");
      const url = new URL(UI.routeUrl(payload.routeId, payload.params));
      const session = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-");
      url.searchParams.set("__frame", session);
      frameUrl = url.href;
      active = payload;
      host?.destroy();
      const previous = iframe, epoch = ++frameEpoch;
      iframe = previous.cloneNode(false);
      iframe.removeAttribute("src");
      iframe.setAttribute("data-i18n-title", payload.routeId);
      iframe.title = I18n.t(payload.routeId);
      pending();
      host = createHost(session, (state) => { if (epoch === frameEpoch) frameState(state); });
      iframe.addEventListener("error", () => { if (epoch === frameEpoch) frameFailure(); });
      // 只认本次目标文档的load；克隆frame清除src后可能产生about:blank load。
      iframe.addEventListener("load", () => {
        if (epoch !== frameEpoch || frameFailed) return;
        try {
          const loaded = new URL(iframe.contentWindow.location.href), target = new URL(frameUrl);
          if (loaded.origin !== target.origin || loaded.pathname !== target.pathname || loaded.searchParams.get("__frame") !== session) return;
        } catch { return; }
        frameLoaded = true;
        iframe.dataset.loaded = "true";
        showFrameWhenReady();
      });
      iframe.src = url.href;
      previous.replaceWith(iframe);
      document.title = `${I18n.t(payload.routeId === "workspace" ? "workspace" : payload.routeId)} · babaShare`;
      renderNav();
      const shellUrl = new URL(location.href);
      shellUrl.searchParams.set("route", payload.routeId);
      for (const key of ["workspaceId", "userId", "relation", "ownerStatus", "creator", "search"])
        shellUrl.searchParams.delete(key);
      for (const key of ["workspaceId", "userId", "relation", "ownerStatus", "creator", "search"])
        if (payload.params?.[key]) shellUrl.searchParams.set(key, payload.params[key]);
      history.replaceState(null, "", shellUrl);
      return true;
    } catch (e) {
      toast(errorText(e), { kind: "error" });
      return false;
    } finally {
      navigating = false;
    }
  }
  function createHost(session, onState) { return AppBridgeHost.create({
    iframe, session, onState,
    context: () => I18n.ctx,
    handlers: {
      "shell.toast": (payload) => {
        toast(payload.message, { kind: payload.kind, local: true });
        return true;
      },
      "shell.confirm": (payload) => UI.confirm(payload.message),
      "shell.navigate": navigate,
      "shell.sessionExpired": () => UI.sessionExpired(),
      "shell.title": (payload) => {
        document.title = `${payload.title} · babaShare`;
        return true;
      },
      "shell.dirty": () => true,
      "workspace.changed": async () => {
        workspaces = await API("workspaces");
        renderNav();
        await refreshOnboarding();
        return true;
      },
      "onboarding.changed": async (payload) => {
        if (payload?.version !== 1) return false;
        await refreshOnboarding();
        return true;
      },
    },
  }); }
  window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
  host = createHost("", frameState);
  pending();
  window.addEventListener("pagehide", () => { disposed = true; startupController.abort(); ++frameEpoch; clearTimeout(frameTimer); host.destroy(); }, { once: true });
  $("#brand-home").addEventListener("click", (event) => {
    if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    return navigate({ routeId: "workspace", params: {} });
  });
  function navItem(key, routeId, params = {}, workspace) {
    const b = el(
      "button",
      {
        type: "button",
        class: "menu-item",
        title: workspace?.workspaceName || I18n.t(key),
        "aria-label": workspace?.workspaceName || I18n.t(key),
        onclick: () => navigate({ routeId, params }),
      },
      icon(workspace ? "folder" : routeId === "users" ? "users" : routeId === "settings" ? "shield" : "user"),
      el("span", { text: workspace?.workspaceName || I18n.t(key) }),
    );
    if (
      active.routeId === routeId &&
      (!workspace || active.params?.workspaceId === workspace.id)
    )
      b.setAttribute("aria-current", "page");
    return b;
  }
  function renderNav() {
    $("#workspace-nav").replaceChildren(
      ...workspaces.map((w) =>
        navItem("workspace", "workspace", { workspaceId: w.id }, w),
      ),
    );
    if (!workspaces.length)
      $("#workspace-nav").append(navItem("allFiles", "workspace"));
    $("#account-nav").replaceChildren(navItem("account", "account"));
    if (user && user.role !== "admin" && onboarding?.enabled !== false) {
      const entry = navItem("onboarding", "onboarding");
      if (onboarding && !onboarding.dismissed) {
        const label = onboarding.allComplete ? I18n.t("onboardingUnlocked") : I18n.t("onboardingProgress", { count: onboarding.completedCount, total: onboarding.totalCount });
        entry.append(el("bdi", { class: "small num", dir: "ltr", text: I18n.t("onboardingProgress", { count: onboarding.completedCount, total: onboarding.totalCount }) }));
        entry.setAttribute("title", label);
        entry.setAttribute("aria-label", I18n.t("onboarding") + " · " + label);
      }
      $("#account-nav").append(entry);
    }
    if (user?.role === "admin")
      $("#account-nav").append(navItem("users", "users"), navItem("workspace-admin", "workspace-admin"), navItem("settings", "settings"));
    $("#new-workspace").hidden = !["admin", "editor"].includes(user?.role);
    $("#shell-account").replaceChildren(
      el("span", {
        class: "avatar",
        text: (user?.nickname || "?").slice(0, 1).toUpperCase(),
      }),
      el(
        "div",
        {},
        el("strong", { text: user?.nickname || "" }),
        el("span", {
          class: "small muted",
          text: user ? I18n.t(user.role) : "",
        }),
      ),
    );
    const titleKey =
      active.routeId === "workspace" ? "workspaces" : active.routeId;
    $(".topbar-title strong").textContent = I18n.t(titleKey);
  }
  I18n.subscribe((ctx) => {
    host.emit("context.changed", ctx);
    renderNav();
  });
  $("#new-workspace").addEventListener("click", () => {
    if (!user || !["admin", "editor"].includes(user.role)) return;
    return navigate({ routeId: "workspace", params: { action: "create" } });
  });
  let loggingOut = false;
  $("#logout").addEventListener("click", async () => {
    if (loggingOut) return;
    loggingOut = true;
    const restoreLogout = UI.buttonBusy($("#logout"), true);
    try {
      if (!(await host.request("page.beforeLeave", {}))) { loggingOut = false; restoreLogout(); return; }
    } catch (e) {
      toast(errorText(e), { kind: "error" });
      loggingOut = false; restoreLogout();
      return;
    }
    let failed = false;
    try {
      await API("session", { method: "DELETE" });
    } catch (e) {
      failed = e.httpStatus !== 401;
      if (failed) toast(errorText(e), { kind: "error" });
    } finally {
      location.replace(UI.routeUrl("auth", failed ? { logout: "failed" } : {}));
    }
  });
  I18n.apply(I18n.ctx);
  try {
    const install = await API("install", { signal: startupController.signal });
    if (!startupActive()) return;
    if (install.setupRequired) {
      location.href = UI.routeUrl("auth");
      return;
    }
    const currentUser = await API("me", { signal: startupController.signal });
    if (!startupActive()) return;
    user = currentUser;
    const currentWorkspaces = await API("workspaces", { signal: startupController.signal });
    if (!startupActive()) return;
    workspaces = currentWorkspaces;
    await refreshOnboarding();
    if (!startupActive()) return;
    startupState = "ready";
    const url = new URL(location.href),
      routeId = ["workspace", "account", "onboarding", "users", "settings", "workspace-admin"].includes(
        url.searchParams.get("route"),
      )
        ? url.searchParams.get("route")
        : "workspace";
    const workspaceId =
      url.searchParams.get("workspaceId") || workspaces[0]?.id;
    await navigate(
      {
        routeId,
        params: routeId === "workspace" && workspaceId ? { workspaceId } : routeId === "workspace-admin"
          ? Object.fromEntries(["userId", "relation", "ownerStatus", "creator", "search"].filter((key) => url.searchParams.has(key)).map((key) => [key, url.searchParams.get(key)])) : {},
      },
      true,
    );
  } catch (e) {
    if (disposed || startupState === "failed" || e.httpStatus === 401) return;
    toast(errorText(e), { kind: "error" });
    frameFailure();
    renderNav();
  }
})();
