(() => {
  "use strict";
  let match = /^#purpose=(email-change-old|email-change-new|email-binding)&token=([A-Za-z0-9_-]{43})$/.exec(location.hash || "");
  const purpose = match?.[1];
  let token = match?.[2] || null;
  match = null;
  if (location.hash) {
    const clean = new URL(location.href); clean.hash = "";
    history.replaceState(history.state, "", clean);
  }
  window.addEventListener("DOMContentLoaded", async () => {
    const { $, field, errorText } = UI;
    const form = $("#verification-form"), login = $("#verification-login"), submit = $("#verification-submit");
    const loginSubmit = $("#verification-login-submit"), status = $("#verification-status");
    let me = null, busy = false, newEmail = false, complete = false, dirty = false, statusKey = "";
    UI.settingsControls($("#verification-settings"));
    function render() {
      const drafts = [login, form].map((node) => Object.fromEntries(new FormData(node)));
      $("#verification-login-fields").replaceChildren();
      field($("#verification-login-fields"), { key: "accountName", name: "userName", required: true, hint: I18n.t("loginAccountHint") });
      field($("#verification-login-fields"), { key: "password", type: "password", required: true }).autocomplete = "current-password";
      $("#verification-fields").replaceChildren();
      if (newEmail) {
        $("#verification-fields").append(UI.el("p", { class: "form-note", text: I18n.t("required") }));
        field($("#verification-fields"), { key: "newEmail", name: "email", type: "email", required: true,
          hint: I18n.t("emailIdentityHint"), validator: (value) => value.length <= 254 ? "" : I18n.t("emailError") }).setAttribute("dir", "ltr");
      }
      [login, form].forEach((node, index) => {
        for (const [name, value] of Object.entries(drafts[index])) {
          const input = node.elements.namedItem(name); if (input) input.value = value;
        }
      });
      login.hidden = Boolean(me) || complete || (!token && !newEmail);
      form.hidden = !me || complete || (!token && !newEmail);
      submit.textContent = I18n.t(busy ? "saving" : newEmail ? "sendNewEmail" : "confirmEmail");
      submit.disabled = loginSubmit.disabled = busy || complete;
      $("#verification-identity").textContent = me ? I18n.t("verificationSignedIn", { name: me.userName }) : I18n.t("verificationLoginHint");
      document.title = I18n.t("emailVerification") + " · babaShare";
      if (statusKey) status.textContent = I18n.t(statusKey);
    }
    function failed(error) {
      statusKey = ""; status.textContent = errorText(error); status.classList.add("error");
      if (error.httpStatus === 401 || error.status === "AUTH_REQUIRED") {
        me = null;
        if (newEmail) {
          complete = true; newEmail = false; token = null; dirty = false;
          statusKey = "EMAIL_CHANGE_STATE_INVALID";
        }
        render();
      }
    }
    async function loadIdentity() {
      if (busy || !token) return;
      busy = true; render(); status.textContent = I18n.t("loading");
      $("#verification-retry").replaceChildren();
      try {
        me = await API("me", { keepPageOnUnauthorized: true });
        status.textContent = ""; status.classList.remove("error");
      } catch (error) {
        failed(error);
        if (error.httpStatus !== 401 && error.status !== "AUTH_REQUIRED")
          $("#verification-retry").append(UI.button("retry", loadIdentity));
      } finally { busy = false; render(); }
    }
    I18n.subscribe(render); I18n.apply(I18n.ctx);
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      if (!token && !newEmail && !["emailVerifiedCompleted", "newEmailSent"].includes(statusKey)) {
        statusKey = "EMAIL_TOKEN_INVALID"; status.classList.add("error");
      }
      render();
    });
    for (const node of [login, form]) node.addEventListener("input", () => { dirty = true; });
    window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
    window.addEventListener("pagehide", () => { token = null; newEmail = false; complete = true; dirty = false; login.reset(); form.reset(); });
    login.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || complete || (!token && !newEmail) || !UI.validate(login)) return;
      busy = true; const restore = UI.buttonBusy(loginSubmit, true);
      login.setAttribute("aria-busy", "true"); status.classList.remove("error"); status.textContent = I18n.t("loading");
      try {
        await API("login", { method: "POST", body: Object.fromEntries(new FormData(login)) });
        login.reset(); dirty = false;
        me = await API("me", { keepPageOnUnauthorized: true });
        status.textContent = "";
      } catch (error) { failed(error); }
      finally { busy = false; restore(); login.setAttribute("aria-busy", "false"); render(); }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || complete || !me || (!token && !newEmail) || !UI.validate(form)) return;
      busy = true; const restore = UI.buttonBusy(submit, true, "saving");
      form.setAttribute("aria-busy", "true"); statusKey = "";
      status.classList.remove("error"); status.textContent = I18n.t("saving");
      try {
        const routes = { "email-change-old": "emailChangeVerification", "email-change-new": "emailChangeConfirmation", "email-binding": "emailBindingConfirmation" };
        await API(newEmail ? "emailChangeProposal" : routes[purpose], {
          method: "POST", body: newEmail ? Object.fromEntries(new FormData(form)) : { token }, keepPageOnUnauthorized: true,
        });
        dirty = false; form.reset(); token = null;
        if (purpose === "email-change-old" && !newEmail) {
          newEmail = true; statusKey = "oldEmailVerified";
        } else {
          complete = true; statusKey = newEmail ? "newEmailSent" : "emailVerifiedCompleted";
        }
        status.textContent = I18n.t(statusKey);
      } catch (error) { failed(error); }
      finally { busy = false; restore(); form.setAttribute("aria-busy", "false"); render(); }
    });
    if (!token) {
      statusKey = "EMAIL_TOKEN_INVALID"; status.textContent = I18n.t(statusKey); status.classList.add("error");
    } else await loadIdentity();
  }, { once: true });
})();
