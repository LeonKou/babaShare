(() => {
  "use strict";
  // 在加载公共资源前立即移除地址中的凭据；令牌仅保留在闭包内存中。
  let token = /^#activation=([A-Za-z0-9_-]{43})$/.exec(location.hash || "")?.[1] || null;
  if (location.hash) {
    const clean = new URL(location.href);
    clean.hash = "";
    history.replaceState(history.state, "", clean);
  }
  window.addEventListener("DOMContentLoaded", () => {
    const { $, field, validate, errorText } = UI;
    const form = $("#activation-form"), submit = $("#activation-submit"), status = $("#activation-status");
    let busy = false;
    UI.settingsControls($("#activation-settings"));
    function render() {
      const previous = Object.fromEntries(new FormData(form));
      $("#activation-fields").replaceChildren();
      field($("#activation-fields"), { key: "password", type: "password", required: true,
        hint: I18n.t("passwordHint"), validator: (value) => value.length >= 6 && value.length <= 256 ? "" : I18n.t("passwordError") });
      field($("#activation-fields"), { key: "passwordConfirm", type: "password", required: true,
        validator: (value) => value === form.elements.namedItem("password").value ? "" : I18n.t("PASSWORD_MISMATCH") });
      for (const [name, value] of Object.entries(previous)) {
        const input = form.elements.namedItem(name);
        if (input) input.value = value;
      }
      document.title = I18n.t("activationTitle") + " · babaShare";
      if (!token) {
        status.textContent = I18n.t("ACTIVATION_INVALID");
        status.classList.add("error");
        submit.disabled = true;
      }
    }
    window.addEventListener("pagehide", () => { token = null; form.reset(); });
    I18n.subscribe(render);
    I18n.apply(I18n.ctx);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !token || !validate(form)) return;
      busy = true;
      const restoreSubmit = UI.buttonBusy(submit, true, "saving");
      form.setAttribute("aria-busy", "true");
      status.classList.remove("error");
      status.textContent = I18n.t("saving");
      try {
        await API("emailActivation", { method: "POST", body: { token, ...Object.fromEntries(new FormData(form)) } });
        token = null;
        form.reset();
        status.textContent = I18n.t("activationCompleted");
        location.replace(UI.routeUrl("shell"));
      } catch (error) {
        status.textContent = errorText(error);
        status.classList.add("error");
        UI.toast(errorText(error), { kind: "error" });
      } finally {
        busy = false;
        restoreSubmit();
        submit.disabled = !token;
        form.setAttribute("aria-busy", "false");
      }
    });
  }, { once: true });
})();
