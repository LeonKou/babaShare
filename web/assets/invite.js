(async () => {
  "use strict";
  const token = UI.invitationToken();
  const status = UI.$("#invite-status"), actions = UI.$("#invite-actions");
  const settings = UI.el("div", { class: "standalone-controls" });
  UI.settingsControls(settings);
  document.body.prepend(settings);
  let stateKey = "inviteJoining", busy = false;
  function render() {
    I18n.apply(I18n.ctx);
    status.textContent = I18n.t(stateKey);
    document.title = `${I18n.t("invite")} · babaShare`;
  }
  // 此页不属于全局401跳转页；只携带白名单token到固定登录页，不接受returnUrl。
  function login() { location.replace(UI.invitationUrl("auth", token)); }
  async function join() {
    if (busy) return;
    busy = true;
    actions.replaceChildren();
    status.classList.remove("error");
    status.setAttribute("aria-busy", "true");
    stateKey = "inviteJoining";
    render();
    try {
      const result = await API("invitationMembership", { method: "POST", body: { token } });
      stateKey = "inviteJoined";
      const url = UI.routeUrl("workspace", { workspaceId: result.workspaceId });
      actions.append(UI.el("a", { href: url, text: I18n.t("openWorkspace") }));
      location.replace(url);
    } catch (error) {
      if (error.httpStatus === 401) {
        login();
        return;
      }
      status.classList.add("error");
      stateKey = error.status === "INVITATION_INVALID" ? "INVITATION_INVALID" : "unknownError";
      if (error.status !== "INVITATION_INVALID") actions.append(UI.button("retry", join));
    } finally {
      busy = false;
      status.setAttribute("aria-busy", "false");
      render();
    }
  }
  I18n.subscribe(() => { status.textContent = I18n.t(stateKey); });
  if (!token) {
    stateKey = "INVITATION_INVALID";
    status.classList.add("error");
    render();
    return;
  }
  await join();
})();
