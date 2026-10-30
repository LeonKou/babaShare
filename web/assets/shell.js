(async () => {
  "use strict";
  const { $, el, button, icon, toast, formDialog, errorText } = UI;
  const iframe = $("#page-frame");
  let user = null,
    workspaces = [],
    active = { routeId: "workspace", params: {} },
    navigating = false,
    host;
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
      const url = UI.routeUrl(payload.routeId, payload.params);
      active = payload;
      iframe.src = url;
      document.title = `${I18n.t(payload.routeId === "workspace" ? "workspace" : payload.routeId)} · babaShare`;
      renderNav();
      const shellUrl = new URL(location.href);
      shellUrl.searchParams.set("route", payload.routeId);
      shellUrl.searchParams.delete("workspaceId");
      if (payload.params?.workspaceId)
        shellUrl.searchParams.set("workspaceId", payload.params.workspaceId);
      history.replaceState(null, "", shellUrl);
      return true;
    } catch (e) {
      toast(errorText(e));
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
        toast(payload.message);
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
      icon(workspace ? "folder" : routeId === "users" ? "users" : "user"),
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
    if (user?.role === "admin")
      $("#account-nav").append(navItem("users", "users"));
    $("#new-workspace").hidden = user?.role === "viewer";
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
  $("#new-workspace").addEventListener("click", async () => {
    const result = await formDialog(
      I18n.t("newWorkspace"),
      [
        {
          key: "workspaceName",
          name: "workspaceName",
          required: true,
          validator: (value) =>
            value.trim().length > 100 ? I18n.t("invalidInput") : "",
        },
      ],
      (values) => API("workspace", { method: "POST", body: values }),
      { saveKey: "create" },
    );
    if (result) {
      workspaces = await API("workspaces");
      renderNav();
      await navigate({
        routeId: "workspace",
        params: { workspaceId: result.id },
      });
    }
  });
  $("#logout").addEventListener("click", async () => {
    try {
      if (!(await host.request("page.beforeLeave", {}))) return;
    } catch (e) {
      toast(errorText(e));
      return;
    }
    let failed = false;
    try {
      await API("session", { method: "DELETE" });
    } catch (e) {
      failed = e.httpStatus !== 401;
      if (failed) toast(errorText(e));
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
    const url = new URL(location.href),
      routeId = ["workspace", "account", "users"].includes(
        url.searchParams.get("route"),
      )
        ? url.searchParams.get("route")
        : "workspace";
    const workspaceId =
      url.searchParams.get("workspaceId") || workspaces[0]?.id;
    await navigate(
      {
        routeId,
        params: routeId === "workspace" && workspaceId ? { workspaceId } : {},
      },
      true,
    );
  } catch (e) {
    if (e.httpStatus === 401) return;
    toast(errorText(e));
    renderNav();
  }
})();
