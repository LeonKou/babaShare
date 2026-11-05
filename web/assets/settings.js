(async () => {
  "use strict";
  const { $, el, button, errorText } = UI;
  const bridge = UI.page();
  const form = $("#registration-form"), status = $("#settings-status");
  const registration = $("#registration-toggle"), email = $("#email-registration-toggle");
  const emailRow = $("#email-registration-row"), mailFields = $("#registration-mail-fields");
  const submit = $("#settings-submit"), cancel = $("#settings-cancel"), clearPassword = $("#smtp-clear-password");
  let saved = null, mail = null, busy = false, mailError = null;
  const inputs = {};
  const numberRule = (minimum, maximum, key) => (value) =>
    /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum ? "" : I18n.t(key);
  const configs = [
    { key: "smtpHost", name: "host", required: true },
    { key: "smtpPort", name: "port", type: "number", required: true, validator: numberRule(1, 65535, "smtpPortHint"), hintKey: "smtpPortHint" },
    { key: "smtpSecurity", name: "security", options: [{ value: "ssl", label: "TLS (SSL)" }, { value: "starttls", label: "STARTTLS" }] },
    { key: "smtpUsername", name: "username" },
    { key: "smtpPassword", name: "password", type: "password", hintKey: "smtpPasswordHint" },
    { key: "fromAddress", type: "email", required: true },
    { key: "fromName", required: true },
    { key: "activationHours", type: "number", required: true, validator: numberRule(1, 720, "activationHoursHint"), hintKey: "activationHoursHint" },
  ];
  function showStatus(message, error = false) {
    status.replaceChildren();
    status.textContent = message;
    status.classList[error ? "add" : "remove"]("error");
  }
  function showFeedback(message, state = "info") {
    const feedback = $("#settings-feedback");
    feedback.textContent = message;
    feedback.dataset.state = state;
    if (state === "success" || state === "error") UI.toast(message, { kind: state });
  }
  function quotaSummary() {
    if (!saved) return;
    $("#quota-default-summary").replaceChildren(UI.quotaSummary({ usedFileCount: 0, usedStorageBytes: 0,
      effectiveFileCountLimit: saved.defaultFileCountLimit ?? 0, effectiveStorageBytesLimit: saved.defaultStorageBytesLimit ?? 0 }, { defaults: true }));
  }
  $("#quota-settings-edit").addEventListener("click", async () => {
    if (!saved || busy) return;
    const updated = await UI.formDialog(I18n.t("quotaDefaults"), UI.quotaFields(saved, true),
      (values) => API("setting", { method: "PATCH", body: UI.quotaPayload(values, true) }),
      { intro: I18n.t("quotaDefaultsHint"), dirty: true });
    if (updated) {
      saved.defaultFileCountLimit = updated.defaultFileCountLimit;
      saved.defaultStorageBytesLimit = updated.defaultStorageBytesLimit;
      quotaSummary();
    }
  });
  function summary() {
    if (!saved) return;
    const key = !saved.registrationEnabled ? "registrationOff" : saved.emailRegistrationEnabled ? "registrationEmailOn" : "registrationNormalOn";
    $("#registration-current").textContent = I18n.t("registrationCurrent", { mode: I18n.t(key) });
  }
  function syncMailFields(resetOpen = false) {
    const showMail = registration.checked && email.checked;
    emailRow.hidden = !registration.checked;
    email.disabled = !registration.checked || busy;
    mailFields.hidden = !showMail;
    if (resetOpen || !showMail) mailFields.open = showMail;
    Object.values(inputs).forEach((input) => { input.disabled = !showMail || !mail || busy; });
    clearPassword.disabled = !showMail || !mail || busy;
  }
  function buildFields() {
    $("#smtp-fields").replaceChildren();
    $("#activation-fields").replaceChildren();
    for (const [index, config] of configs.entries()) {
      const name = config.name || config.key;
      inputs[name] = UI.field($(index < 5 ? "#smtp-fields" : "#activation-fields"), {
        ...config, value: mail?.[name] ?? "", hint: config.hintKey ? I18n.t(config.hintKey) : "",
      });
      if (["port", "activationHours"].includes(name)) {
        inputs[name].setAttribute("min", "1");
        inputs[name].setAttribute("max", name === "port" ? "65535" : "720");
        inputs[name].setAttribute("step", "1");
      }
      if (["host", "username", "fromAddress", "port", "activationHours"].includes(name)) inputs[name].setAttribute("dir", "ltr");
    }
  }
  function restore() {
    registration.checked = saved.registrationEnabled;
    email.checked = saved.emailRegistrationEnabled;
    clearPassword.checked = false;
    buildFields(); syncMailFields(true); summary();
    bridge.setDirty(false);
  }
  function setBusy(value) {
    busy = value;
    form.setAttribute("aria-busy", String(value));
    submit.setAttribute("aria-busy", String(value));
    submit.disabled = cancel.disabled = registration.disabled = email.disabled = value;
    syncMailFields();
    submit.textContent = I18n.t(value ? "saving" : "submitSettings");
  }
  async function load() {
    if (busy || (bridge.dirty && !(await UI.confirm(I18n.t("unsaved"))))) return;
    setBusy(true); showStatus(""); UI.loading(status);
    try {
      const me = await API("me");
      if (me.role !== "admin") throw { status: "PERMISSION_DENIED" };
      saved = await API("settings");
      try { mail = await API("mailSettings"); mailError = null; }
      catch (error) { mail = null; mailError = error; }
      restore(); form.hidden = false;
      $("#quota-settings").hidden = false; quotaSummary();
      showStatus(mailError ? (mailError.httpStatus === 404 ? I18n.t("mailSettingsUnavailable") : errorText(mailError)) : "", Boolean(mailError));
      if (mailError) { bridge.fail(mailError); status.append(button("retry", load)); }
    } catch (error) {
      bridge.fail(error);
      showStatus(errorText(error), true); status.append(button("retry", load));
    } finally { setBusy(false); }
  }
  form.addEventListener("input", () => { if (!busy) { bridge.setDirty(true); showFeedback(""); } });
  registration.addEventListener("change", () => { bridge.setDirty(true); showFeedback(""); syncMailFields(true); });
  email.addEventListener("change", () => { bridge.setDirty(true); showFeedback(""); syncMailFields(true); });
  clearPassword.addEventListener("change", () => {
    bridge.setDirty(true);
    if (clearPassword.checked) inputs.password.value = "";
  });
  cancel.addEventListener("click", async () => {
    if (busy || (bridge.dirty && !(await UI.confirm(I18n.t("unsaved"))))) return;
    restore(); showStatus(""); showFeedback("");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !saved) return;
    const body = {};
    if (registration.checked !== saved.registrationEnabled) body.registrationEnabled = registration.checked;
    if (registration.checked && email.checked !== saved.emailRegistrationEnabled) body.emailRegistrationEnabled = email.checked;
    const enablingEmail = registration.checked && email.checked && (!saved.emailRegistrationEnabled || !saved.registrationEnabled);
    const draft = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, ["port", "activationHours"].includes(name) ? Number(input.value) : input.value]));
    const mailChanged = mail && (clearPassword.checked || Object.entries(draft).some(([name, value]) => name === "password" ? Boolean(value) : value !== mail[name]));
    const saveMail = registration.checked && email.checked && mail && (enablingEmail || mailChanged);
    if (enablingEmail && !mail) {
      showStatus(errorText(mailError), true); status.append(button("retry", load));
      showFeedback(errorText(mailError), "error"); return;
    }
    if (saveMail && email.checked) {
      mailFields.open = true;
      if (!UI.validate(form)) { showFeedback(I18n.t("validationFailed"), "error"); return; }
    }
    if (saveMail) {
      body.mailSettings = { ...draft, siteOrigin: location.origin };
      if (clearPassword.checked) {
        setBusy(true);
        let confirmed;
        try { confirmed = await UI.confirm(I18n.t("clearSmtpPasswordConfirm")); }
        finally { setBusy(false); }
        if (!confirmed) return;
        body.mailSettings.clearPassword = true;
        body.mailSettings.password = "";
      }
    }
    setBusy(true); showStatus(""); showFeedback(I18n.t("saving"), "loading");
    try {
      const updated = await API("setting", { method: "PATCH", body });
      saved = { ...saved, registrationEnabled: updated.registrationEnabled, emailRegistrationEnabled: updated.emailRegistrationEnabled };
      if (body.mailSettings) {
        const { password, clearPassword: cleared, ...values } = body.mailSettings;
        mail = { ...mail, ...values, hasPassword: !cleared && (Boolean(password) || mail.hasPassword) };
      }
      restore(); showFeedback(I18n.t("registrationSaved"), "success");
    } catch (error) { showFeedback(errorText(error), "error"); }
    finally { setBusy(false); }
  });
  window.addEventListener("pagehide", () => { if (inputs.password) inputs.password.value = ""; });
  I18n.subscribe(() => {
    summary(); quotaSummary(); document.title = `${I18n.t("settings")} · babaShare`;
    for (const config of configs) {
      const input = inputs[config.name || config.key];
      if (!input) continue;
      const label = input.parentNode?.querySelector("label");
      if (label) label.textContent = I18n.t(config.key) + (config.required ? " *" : "");
      if (config.hintKey) $("#" + input.id + "-hint").textContent = I18n.t(config.hintKey);
    }
    submit.textContent = I18n.t(busy ? "saving" : "submitSettings");
  });
  await bridge.ready;
  await load();
  await bridge.complete();
})();
