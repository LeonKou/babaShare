(async () => {
  "use strict";
  const { $, el, button, field, validate, errorText, settingsControls } = UI;
  let mode = "login",
    state = null;
  const form = $("#auth-form"),
    status = $("#auth-status");
  settingsControls($("#auth-settings"));
  $("#security-icon").append(UI.icon("shield"));
  function render() {
    const previous = Object.fromEntries(new FormData(form));
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
    $("#auth-hint").textContent = I18n.t(hint);
    $("#auth-story-title").textContent = I18n.t("authStoryTitle").replaceAll(
      "\\n",
      "\n",
    );
    $("#auth-story-title").style.whiteSpace = "pre-line";
    $("#auth-fields").replaceChildren();
    field($("#auth-fields"), {
      key: "accountName",
      name: "userName",
      required: true,
      hint: I18n.t("accountNameHint"),
      validator: (value) =>
        /^[A-Za-z0-9_.@-]{3,64}$/.test(value) ? "" : I18n.t("accountNameError"),
    });
    if (mode !== "login")
      field($("#auth-fields"), {
        key: "displayName",
        name: "nickname",
        required: true,
      });
    const password = field($("#auth-fields"), {
      key: "password",
      name: "password",
      type: "password",
      required: true,
      hint: mode === "login" ? "" : I18n.t("passwordHint"),
      validator: (value) =>
        mode !== "login" && (value.length < 10 || value.length > 256)
          ? I18n.t("passwordError")
          : "",
    });
    password.autocomplete =
      mode === "login" ? "current-password" : "new-password";
    for (const [name, value] of Object.entries(previous)) {
      const input = form.elements.namedItem(name);
      if (input) input.value = value;
    }
    const key =
      mode === "setup"
        ? "setup"
        : mode === "registration"
          ? "register"
          : "login";
    $("#auth-submit").dataset.i18n = key;
    $("#auth-submit").textContent = I18n.t(key);
    $("#auth-switch").replaceChildren();
    if (
      state &&
      !state.setupRequired &&
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
            mode = mode === "login" ? "registration" : "login";
            render();
          },
          "ghost",
        ),
      );
    document.title = `${I18n.t(key)} · babaShare`;
  }
  I18n.subscribe(render);
  I18n.apply(I18n.ctx);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state || !validate(form)) return;
    $("#auth-submit").disabled = true;
    status.classList.remove("error");
    status.textContent = I18n.t("loading");
    form.setAttribute("aria-busy", "true");
    try {
      const body = Object.fromEntries(new FormData(form));
      await API(mode, { method: "POST", body });
      location.href = UI.routeUrl("shell");
    } catch (e) {
      status.textContent = errorText(e);
      status.classList.add("error");
    } finally {
      $("#auth-submit").disabled = false;
      form.setAttribute("aria-busy", "false");
    }
  });
  try {
    state = await API("install");
    mode = state.setupRequired
      ? "setup"
      : new URL(location.href).searchParams.get("mode") === "register" &&
          state.registrationEnabled
        ? "registration"
        : "login";
    status.textContent = "";
    render();
  } catch (e) {
    status.classList.add("error");
    status.textContent = errorText(e);
    $("#auth-submit").disabled = true;
    $("#auth-switch").append(button("retry", () => location.reload()));
  }
})();
