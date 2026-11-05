(async () => {
  "use strict";
  const { $, el, button } = UI, page = UI.page();
  const keys = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
  let me = null, detail = null, workspaces = [], pending = null, stage = null, disposed = false, preferenceBusy = false;
  let revision = 0;
  const content = $("#onboarding-content"), status = $("#onboarding-status"), retry = $("#onboarding-retry");
  function notify() {
    if (page.embedded) page.request("onboarding.changed", { version: 1 }).catch((error) => console.warn("Onboarding refresh failed", error));
  }
  function accept(value) {
    if (value?.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.tasks)) throw new Error("INVALID_RESPONSE");
    if (value.totalCount !== keys.length || value.tasks.length !== keys.length ||
      new Set(value.tasks.map((task) => task?.key)).size !== keys.length ||
      !value.tasks.every((task) => keys.includes(task?.key) && typeof task.completed === "boolean") ||
      !Number.isInteger(value.completedCount) || value.completedCount < 0 || value.completedCount > keys.length ||
      value.completedCount !== value.tasks.filter((task) => task.completed).length ||
      value.allComplete !== (value.completedCount === keys.length)) throw new Error("INVALID_RESPONSE");
    detail = value;
    if (!page.embedded) window.OnboardingFeedback?.refresh();
  }
  function failure(error) {
    page.fail(error);
    status.textContent = UI.errorText(error);
    status.classList.add("error");
    retry.replaceChildren(button("onboardingRetry", refresh));
  }
  async function refresh() {
    if (disposed || me?.role === "admin" || preferenceBusy) return;
    if (pending) return pending;
    const currentRevision = revision;
    UI.loading(status); content.setAttribute("aria-busy", "true");
    pending = (async () => {
      try {
        if (!me) me = await API("me");
        if (me.role === "admin") { content.hidden = true; status.textContent = I18n.t("onboardingUnavailable"); retry.replaceChildren(); return; }
        const [value, spaces] = await Promise.all([API("onboarding"), API("workspaces")]);
        if (disposed || currentRevision !== revision) return;
        accept(value); workspaces = spaces;
        status.textContent = ""; status.classList.remove("error"); retry.replaceChildren(); render(); notify();
      } catch (error) { if (!disposed) failure(error); }
      finally { pending = null; content.setAttribute("aria-busy", "false"); }
    })();
    return pending;
  }
  async function collapse() {
    if (preferenceBusy) return;
    preferenceBusy = true; ++revision;
    try {
      accept(await API("onboardingUpdate", { method: "PATCH", body: { dismissed: !detail.dismissed } }));
      status.textContent = ""; retry.replaceChildren(); render(); notify();
    } catch (error) { failure(error); }
    finally { preferenceBusy = false; }
  }
  async function guide(key) {
    if (["create_mcp_key", "mcp_tool_call"].includes(key)) {
      return page.request("shell.navigate", { routeId: "account", params: { accountTab: "keys" } });
    }
    const spaces = await API("workspaces");
    const write = ["create_folder", "upload_file"].includes(key);
    const target = spaces.find((space) => !write || space.canWrite === true);
    if (!target) {
      UI.toast(I18n.t("onboardingOwnSpace"));
      return page.request("shell.navigate", { routeId: "workspace", params: me.role === "editor" ? { action: "create" } : {} });
    }
    return page.request("shell.navigate", { routeId: "workspace", params: { workspaceId: target.id, onboardingTask: key } });
  }
  function render() {
    content.hidden = !detail?.enabled || me?.role === "admin";
    if (content.hidden) { status.textContent = I18n.t("onboardingUnavailable"); return; }
    const summary = el("div", { class: "onboarding-summary" },
      el("bdi", { class: "num", dir: "ltr", text: I18n.t("onboardingProgress", { count: detail.completedCount, total: detail.totalCount }) }),
      el("progress", { max: detail.totalCount, value: detail.completedCount, "aria-label": I18n.t("onboarding") }),
      button(detail.dismissed ? "onboardingExpand" : "onboardingCollapse", collapse), button("onboardingRefresh", refresh));
    const list = el("ol", { class: "onboarding-tasks", id: "onboarding-tasks" });
    list.hidden = detail.dismissed;
    const toggle = summary.querySelector("button");
    toggle.setAttribute("aria-expanded", String(!detail.dismissed)); toggle.setAttribute("aria-controls", "onboarding-tasks");
    for (const key of keys) {
      const task = detail.tasks.find((item) => item.key === key);
      list.append(el("li", { class: "onboarding-task" + (task.completed ? " onboarding-complete" : "") },
        el("div", {}, el("h2", { text: I18n.t("onboarding_" + key) }), el("p", { text: I18n.t("onboardingHint_" + key) })),
        task.completed ? el("span", { class: "badge", text: I18n.t("onboardingDone") }) : button("onboardingGo", () => guide(key))));
    }
    const focused = window.document?.activeElement;
    const restoreToggle = focused && content.contains(focused) && focused === content.querySelector("button");
    content.replaceChildren(summary, list);
    if (restoreToggle) toggle.focus();
    if (workspaces.length && !workspaces.some((space) => space.canWrite === true)) content.append(el("p", { class: "form-note", text: I18n.t("onboardingOwnSpace") }));
    if (detail.allComplete) {
      const launch = button(detail.celebrationSeen ? "onboardingReplay" : "onboardingLaunch", openStage, "primary");
      launch.setAttribute("data-onboarding-launch", "");
      content.append(el("section", { class: "onboarding-unlocked" },
        el("h2", { text: I18n.t("onboardingUnlocked") }), el("p", { class: "muted", text: I18n.t("onboardingUnlockHint") }), launch));
    }
  }
  function openStage() {
    if (!detail?.allComplete || stage) return;
    let component, terminal = false, saving = false, saved = detail.celebrationSeen, dead = false, firstFrame, secondFrame;
    const opened = UI.dialog(I18n.t("onboardingStageTitle"), (node, close) => {
      node.classList.add("onboarding-stage");
      const heading = node.querySelector("h2"), closeButton = button("close", () => close(null), "onboarding-stage-close");
      const canvas = el("div", { class: "onboarding-stage-canvas" });
      const feedback = el("div", { class: "status-line", role: "status", "aria-live": "polite" });
      const saveRetry = button("onboardingRetry", saveSeen); saveRetry.hidden = true;
      async function saveSeen() {
        if (!terminal || saving || saved || dead) return;
        saving = true; saveRetry.disabled = true;
        try {
          const value = await API("onboardingUpdate", { method: "PATCH", body: { celebrationSeen: true } });
          if (dead) return;
          accept(value); saved = true; feedback.textContent = ""; saveRetry.hidden = true; render(); notify();
        } catch (_) {
          if (!dead) { feedback.textContent = I18n.t("onboardingSaveFailed"); saveRetry.hidden = false; }
        } finally { saving = false; saveRetry.disabled = false; }
      }
      const skip = button("onboardingSkip", () => component.skip());
      const replay = button("onboardingReplay", () => { terminal = false; skip.hidden = false; component.replay(); });
      for (const [control, key] of [[closeButton, "close"], [saveRetry, "onboardingRetry"], [skip, "onboardingSkip"], [replay, "onboardingReplay"]]) control.setAttribute("data-i18n-label", key);
      const footer = el("div", { class: "onboarding-stage-footer" }, feedback, el("div", { class: "actions" }, saveRetry, skip, replay));
      node.append(el("header", { class: "onboarding-stage-header" }, heading, closeButton), canvas, footer);
      const labels = () => Object.fromEntries(["eyebrow", "title", "message", "dedication", "creator", "brand", "sceneDescription", "completed", "achievement1", "achievement2", "achievement3", "achievement4", "achievement5", "achievement6"].map((key) => [key, I18n.t("onboardingStage_" + key)]));
      heading.setAttribute("data-i18n", "onboardingStageTitle");
      component = OnboardingCelebration.mount(canvas, { nickname: detail.nickname, labels: labels(), onComplete: () => { if (dead) return; terminal = true; skip.hidden = true; saveSeen(); } });
      const unsubscribeStage = I18n.subscribe(() => {
        component.updateLabels(labels());
        if (!saveRetry.hidden) feedback.textContent = I18n.t("onboardingSaveFailed");
      });
      node.addEventListener("close", () => { dead = true; unsubscribeStage(); component.destroy(); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); stage = null; }, { once: true });
      firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => { if (!dead) node.classList.add("is-visible"); }); });
    }, { initialFocus: ".onboarding-stage-close", returnFocus: "[data-onboarding-launch]" });
    stage = opened;
  }
  const onFocus = () => refresh();
  window.addEventListener("focus", onFocus);
  page.on?.("onboarding.changed", (payload) => { if (payload?.version === 1) refresh(); });
  const unsubscribe = I18n.subscribe(() => { if (detail) render(); });
  window.addEventListener("pagehide", () => { disposed = true; stage?.close(null); unsubscribe(); window.removeEventListener("focus", onFocus); });
  await page.ready;
  try {
    me = await API("me");
    if (me.role === "admin") { status.textContent = I18n.t("onboardingUnavailable"); return; }
    await window.OnboardingFeedback?.connect(page, me);
    await refresh();
  } catch (error) { failure(error); }
  finally { await page.complete(); }
})();
