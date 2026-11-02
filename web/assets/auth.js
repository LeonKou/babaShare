(async () => {
  "use strict";
  const { $, el, button, field, validate, errorText, settingsControls } = UI;
  const inviteToken = UI.invitationToken();
  let mode = "login",
    state = null, busy = false;
  const form = $("#auth-form"),
    status = $("#auth-status"),
    logoutFailed = new URL(location.href).searchParams.get("logout") === "failed";
  $("#auth-submit").disabled = true;
  settingsControls($("#auth-settings"));
  $("#security-icon").append(UI.icon("shield"));
  function render() {
    const previous = Object.fromEntries(new FormData(form));
    const emailMode = mode === "registration" && state?.emailRegistrationEnabled;
    const title =
        mode === "setup"
          ? "setupTitle"
          : mode === "registration"
            ? "registerTitle"
            : "loginTitle",
      hint =
        mode === "setup"
          ? "setupHint"
          : mode === "registration"
            ? "registerHint"
            : "loginHint";
    $("#auth-title").dataset.i18n = title;
    $("#auth-title").textContent = I18n.t(title);
    $("#auth-hint").dataset.i18n = hint;
    const activeHint = inviteToken ? "inviteLoginHint" : emailMode ? "emailRegisterHint" : hint;
    $("#auth-hint").dataset.i18n = activeHint;
    $("#auth-hint").textContent = I18n.t(activeHint);
    $("#auth-story-title").textContent = I18n.t("authStoryTitle").replaceAll(
      "\\n",
      "\n",
    );
    $("#auth-story-title").style.whiteSpace = "pre-line";
    $("#auth-fields").replaceChildren();
    field($("#auth-fields"), {
      key: "accountName",
      name: "userName",
      type: "text",
      required: true,
      hint: I18n.t(mode === "login" ? "loginAccountHint" : "accountNameHint"),
      validator: (value) => mode === "login"
        ? (value.length <= 254 ? "" : I18n.t("emailError"))
        : /^[A-Za-z0-9_.@-]{3,64}$/.test(value) ? "" : I18n.t("accountNameError"),
    });
    if (emailMode) field($("#auth-fields"), {
      key: "email", name: "email", type: "email", required: true,
      hint: I18n.t("emailIdentityHint"),
      validator: (value) => value.length <= 254 ? "" : I18n.t("emailError"),
    }).setAttribute("dir", "ltr");
    if (mode !== "login")
      field($("#auth-fields"), {
        key: "displayName",
        name: "nickname",
        required: true,
      });
    if (!emailMode) {
      const password = field($("#auth-fields"), {
        key: "password",
        name: "password",
        type: "password",
        required: true,
        hint: mode === "login" ? "" : I18n.t("passwordHint"),
        validator: (value) =>
          mode !== "login" && (value.length < 6 || value.length > 256)
            ? I18n.t("passwordError")
            : "",
      });
      password.autocomplete =
        mode === "login" ? "current-password" : "new-password";
    }
    for (const [name, value] of Object.entries(previous)) {
      const input = form.elements.namedItem(name);
      if (input) input.value = value;
    }
    const key =
      mode === "setup"
        ? "setup"
        : mode === "registration"
          ? emailMode ? "sendActivation" : "register"
          : "login";
    $("#auth-submit").dataset.i18n = key;
    $("#auth-submit").textContent = I18n.t(key);
    $("#auth-switch").replaceChildren();
    if (
      state &&
      !state.setupRequired &&
      !inviteToken &&
      (state.registrationEnabled || mode === "registration")
    )
      $("#auth-switch").append(
        el("span", {
          class: "muted",
          text: I18n.t(mode === "login" ? "noAccount" : "haveAccount"),
        }),
        button(
          mode === "login" ? "register" : "login",
          () => {
            if (busy) return;
            mode = mode === "login" ? "registration" : "login";
            render();
          },
          "ghost",
        ),
      );
    if (mode === "login" && !state?.setupRequired && !inviteToken)
      $("#auth-switch").append(el("a", { href: UI.routeUrl("reset-password"), text: I18n.t("forgotPassword") }));
    document.title = `${I18n.t(key)} · babaShare`;
  }
  I18n.subscribe(render);
  I18n.apply(I18n.ctx);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !state || !validate(form)) return;
    busy = true;
    const restoreSubmit = UI.buttonBusy($("#auth-submit"), true);
    $("#auth-switch").inert = true;
    status.classList.remove("error");
    status.textContent = I18n.t("loading");
    form.setAttribute("aria-busy", "true");
    try {
      const body = Object.fromEntries(new FormData(form));
      const emailMode = mode === "registration" && state.emailRegistrationEnabled;
      await API(emailMode ? "emailRegistration" : mode, { method: "POST", body });
      if (emailMode) {
        status.textContent = I18n.t("activationSent");
        UI.toast(I18n.t("activationSent"), { kind: "success" });
        return;
      }
      location.href = inviteToken && mode === "login"
        ? UI.invitationUrl("invite", inviteToken) : UI.routeUrl("shell");
    } catch (e) {
      const message = mode === "registration" && ["USER_EXISTS", "EMAIL_EXISTS"].includes(e.status)
        ? I18n.t("registrationAccountExists") : errorText(e);
      status.textContent = message;
      status.classList.add("error");
      UI.toast(message, { kind: "error" });
    } finally {
      busy = false;
      restoreSubmit();
      $("#auth-switch").inert = false;
      form.setAttribute("aria-busy", "false");
    }
  });
  try {
    state = await API("install");
    mode = inviteToken ? "login" : state.setupRequired
      ? "setup"
      : new URL(location.href).searchParams.get("mode") === "register" &&
          state.registrationEnabled
        ? "registration"
        : "login";
    status.textContent = logoutFailed ? I18n.t("logoutUnconfirmed") : "";
    render();
    $("#auth-submit").disabled = false;
  } catch (e) {
    status.classList.add("error");
    status.textContent = [
      logoutFailed ? I18n.t("logoutUnconfirmed") : "",
      errorText(e),
    ].filter(Boolean).join(" ");
    $("#auth-submit").disabled = true;
    $("#auth-switch").append(button("retry", () => location.reload()));
  }
})();
