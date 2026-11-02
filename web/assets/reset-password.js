(() => {
  "use strict";
  const hasFragment = Boolean(location.hash);
  let token = /^#reset=([A-Za-z0-9_-]{43})$/.exec(location.hash || "")?.[1] || null;
  if (location.hash) {
    const clean = new URL(location.href); clean.hash = "";
    history.replaceState(history.state, "", clean);
  }
  window.addEventListener("DOMContentLoaded", () => {
    const { $, field, validate, errorText } = UI;
    const form = $("#reset-form"), submit = $("#reset-submit"), status = $("#reset-status");
    const resetting = hasFragment;
    let busy = false, complete = false, dirty = false, statusKey = "";
    UI.settingsControls($("#reset-settings"));
    function render() {
      const previous = Object.fromEntries(new FormData(form));
      $("#reset-fields").replaceChildren();
      if (resetting) {
        field($("#reset-fields"), { key: "newPassword", name: "password", type: "password", required: true,
          hint: I18n.t("passwordHint"), validator: (value) => value.length >= 6 && value.length <= 256 ? "" : I18n.t("passwordError") }).autocomplete = "new-password";
        field($("#reset-fields"), { key: "passwordConfirm", type: "password", required: true,
          validator: (value) => value === form.elements.namedItem("password").value ? "" : I18n.t("PASSWORD_MISMATCH") }).autocomplete = "new-password";
      } else {
        field($("#reset-fields"), { key: "email", type: "email", required: true,
          hint: I18n.t("emailIdentityHint"), validator: (value) => value.length <= 254 ? "" : I18n.t("emailError") }).setAttribute("dir", "ltr");
      }
      for (const [name, value] of Object.entries(previous)) {
        const input = form.elements.namedItem(name); if (input) input.value = value;
      }
      const title = resetting ? "resetPassword" : "forgotPassword";
      $("#reset-title").textContent = I18n.t(title);
      $("#reset-hint").textContent = I18n.t(resetting ? "resetPasswordHint" : "forgotPasswordHint");
      submit.textContent = I18n.t(busy ? "saving" : resetting ? "resetPassword" : "sendResetEmail");
      submit.disabled = busy || complete || (resetting && !token);
      document.title = I18n.t(title) + " · babaShare";
      if (statusKey) status.textContent = I18n.t(statusKey);
      if (resetting && !token && !complete) {
        status.textContent = I18n.t("PASSWORD_RESET_INVALID"); status.classList.add("error");
      }
    }
    I18n.subscribe(render); I18n.apply(I18n.ctx);
    window.addEventListener("pageshow", (event) => { if (event.persisted) render(); });
    form.addEventListener("input", () => { dirty = true; });
    window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
    window.addEventListener("pagehide", () => { token = null; form.reset(); dirty = false; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || complete || (resetting && !token) || !validate(form)) return;
      busy = true; statusKey = "";
      const restore = UI.buttonBusy(submit, true, "saving");
      form.setAttribute("aria-busy", "true");
      status.classList.remove("error"); status.textContent = I18n.t("saving");
      try {
        const body = Object.fromEntries(new FormData(form));
        if (resetting) body.token = token;
        await API(resetting ? "passwordResetConfirmation" : "passwordResetRequest", { method: "POST", body });
        dirty = false; form.reset();
        statusKey = resetting ? "passwordResetCompleted" : "passwordResetSent";
        if (resetting) { token = null; complete = true; }
        status.textContent = I18n.t(statusKey);
      } catch (error) {
        status.textContent = errorText(error); status.classList.add("error");
      } finally {
        busy = false; restore(); submit.disabled = complete || (resetting && !token);
        form.setAttribute("aria-busy", "false");
      }
    });
  }, { once: true });
})();
