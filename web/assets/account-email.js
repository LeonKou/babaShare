(async () => {
  "use strict";
  const { $, el, button, errorText } = UI;
  const region = $("#account-email-summary"), actions = $("#account-email-actions"), status = $("#account-email-status");
  let detail = null, busy = false, messageKey = "", focusAction = null;
  function render() {
    const active = document.activeElement;
    if ([...actions.children].includes(active)) focusAction = active.dataset.emailAction;
    else if (active && active !== document.body) focusAction = null;
    actions.replaceChildren();
    if (!detail) return;
    region.replaceChildren(el("p", {}, el("bdi", { dir: "ltr", text: detail.email || I18n.t("emailNotBound") }),
      " · " + I18n.t(detail.emailVerified ? "emailVerified" : "emailUnverified")),
      el("p", { class: "form-note", text: I18n.t({ none: "emailChangeHint", "old-pending": "oldEmailPending", "new-email": "oldEmailVerified", "new-pending": "newEmailPending" }[detail.stage] || "emailChangeHint") }));
    const control = !detail.emailVerified ? button("bindEmail", () => propose(false), "primary") :
      detail.stage === "new-email" ? button("sendNewEmail", () => propose(true), "primary") :
      button("changeEmail", requestChange, "primary");
    control.disabled = busy; control.dataset.emailAction = "change";
    const refresh = button("refreshEmailStatus", load); refresh.disabled = busy; refresh.dataset.emailAction = "refresh";
    const pending = detail.stage === "new-pending";
    actions.append(refresh);
    if (!pending) actions.append(control);
    if (!busy && focusAction) {
      (focusAction === "change" && !pending ? control : refresh).focus();
      focusAction = null;
    }
    if (messageKey) status.textContent = I18n.t(messageKey);
  }
  async function load() {
    if (busy) return;
    busy = true; messageKey = ""; render(); region.setAttribute("aria-busy", "true");
    status.classList.remove("error"); UI.loading(status);
    try { detail = await API("accountEmail"); status.textContent = ""; messageKey = ""; }
    catch (error) { window.AppPage.fail(error); status.textContent = errorText(error); status.classList.add("error"); }
    finally {
      busy = false; region.setAttribute("aria-busy", "false"); render();
      if (!detail) actions.replaceChildren(button("retry", load));
    }
  }
  async function requestChange() {
    if (busy) return;
    busy = true; messageKey = ""; render(); actions.setAttribute("aria-busy", "true");
    status.classList.remove("error"); status.textContent = I18n.t("loading");
    try {
      await API("emailChangeRequest", { method: "POST", body: {} });
      detail.stage = "old-pending"; messageKey = "oldEmailSent";
    } catch (error) { status.textContent = errorText(error); status.classList.add("error"); }
    finally { busy = false; actions.setAttribute("aria-busy", "false"); render(); }
  }
  async function propose(changing) {
    if (busy) return;
    const result = await UI.formDialog(I18n.t(changing ? "sendNewEmail" : "bindEmail"), [
      { key: changing ? "newEmail" : "email", name: "email", type: "email", required: true,
        hint: I18n.t("emailIdentityHint"), validator: (value) => value.length <= 254 ? "" : I18n.t("emailError") },
    ], (values) => API(changing ? "emailChangeProposal" : "emailBindingRequest", { method: "POST", body: { email: values.email } }),
    { saveKey: "sendVerificationEmail", dirty: true, intro: I18n.t("emailSameBrowserHint") });
    if (result) {
      await load(); messageKey = "newEmailSent"; render();
    }
  }
  I18n.subscribe(render);
  window.AccountEmailReady = window.AppPage.ready.then(load);
  await window.AccountEmailReady;
})();
