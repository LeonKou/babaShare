(async () => {
  "use strict";
  const { $, el, button, icon, toast, errorText } = UI;
  const iframe = $("#page-frame");
  let user = null,
    workspaces = [],
    active = { routeId: "workspace", params: {} },
    navigating = false,
    host;
  let onboarding = null, onboardingRequest = null;
  async function refreshOnboarding() {
    if (!user || user.role === "admin") return;
    if (onboardingRequest) return onboardingRequest;
    onboardingRequest = API("onboarding").then((value) => {
      const keys = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
      if (value?.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.tasks)) throw new Error("INVALID_RESPONSE");
      if (value.totalCount !== keys.length || value.tasks.length !== keys.length ||
        new Set(value.tasks.map((task) => task?.key)).size !== keys.length ||
        !value.tasks.every((task) => keys.includes(task?.key) && typeof task.completed === "boolean") ||
        !Number.isInteger(value.completedCount) || value.completedCount < 0 || value.completedCount > keys.length ||
        value.completedCount !== value.tasks.filter((task) => task.completed).length ||
        value.allComplete !== (value.completedCount === keys.length)) throw new Error("INVALID_RESPONSE");
      onboarding = value;
      renderNav();
    }).catch(() => { onboarding = null; renderNav(); console.warn("Onboarding status unavailable"); })
      .finally(() => { onboardingRequest = null; });
    return onboardingRequest;
  }
  window.addEventListener("focus", refreshOnboarding);
  UI.settingsControls($("#shell-controls"));
  $("#new-workspace-icon").append(icon("plus"));
  $("#logout-icon").append(icon("logout"));
  async function navigate(payload, skipCheck = false) {
    if (navigating) return false;
    navigating = true;
    try {
      if (!skipCheck && !(await host.request("page.beforeLeave", {})))
        return false;
      if (payload.routeId === "auth") {
        location.href = UI.routeUrl("auth");
        return true;
      }
      if (["users", "settings", "workspace-admin"].includes(payload.routeId) && user?.role !== "admin")
        throw { status: "PERMISSION_DENIED" };
      const url = UI.routeUrl(payload.routeId, payload.params);
      active = payload;
      iframe.src = url;
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
  host = AppBridgeHost.create({
    iframe,
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
  });
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
    const install = await API("install");
    if (install.setupRequired) {
      location.href = UI.routeUrl("auth");
      return;
    }
    user = await API("me");
    workspaces = await API("workspaces");
    await refreshOnboarding();
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
    if (e.httpStatus === 401) return;
    toast(errorText(e), { kind: "error" });
    renderNav();
  }
})();
