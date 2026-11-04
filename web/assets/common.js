(() => {
  "use strict";
  const routes = {
    workspace: "workspace.html",
    "workspace-admin": "workspace-admin.html",
    account: "account.html",
    onboarding: "onboarding.html",
    users: "users.html",
    settings: "settings.html",
    auth: "auth.html",
    "reset-password": "reset-password.html",
    "email-verification": "email-verification.html",
    shell: "index.html",
    invite: "invite.html",
  };
  const $ = (s, p = document) => p.querySelector(s);
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat())
      if (child !== null && child !== undefined)
        node.append(
          typeof child === "string" || typeof child === "number"
            ? document.createTextNode(String(child))
            : child,
        );
    return node;
  }
  const paths = {
    folder: "M3 7V4h6l2 3h10v13H3Z",
    file: "M6 3h8l4 4v14H6ZM14 3v5h5",
    code: "m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14",
    plus: "M12 5v14M5 12h14",
    upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
    download: "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5",
    share:
      "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 11l6-4m-6 6 6 4",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-8a4 4 0 0 1 0 8",
    user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    search: "M21 21l-5-5m2-6a7 7 0 1 0-14 0 7 7 0 0 0 14 0Z",
    eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm13 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
    eyeOff: "m3 3 18 18M10 5.2A11 11 0 0 1 12 5c7 0 10 7 10 7a18 18 0 0 1-3 4M6 6.5A18 18 0 0 0 2 12s3 7 10 7a12 12 0 0 0 5.5-1.5M10 10a3 3 0 0 0 4 4",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2",
    arrow: "m9 5 7 7-7 7",
    logout: "M9 3H3v18h6m6-14 5 5-5 5m-8-5h13",
    link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
    close: "m6 6 12 12M6 18 18 6",
    more: "M5 11h.01M12 11h.01M19 11h.01",
    shield: "m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5Zm-4 9 3 3 5-5",
    fullscreen: "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6",
    tree: "M4 4h16M4 12h16M4 20h16",
    edit: "m15 3 6 6-12 12H3v-6ZM12 6l6 6",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "icon");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(svg.namespaceURI, "path");
    p.setAttribute("d", paths[name] || paths.file);
    svg.append(p);
    return svg;
  }
  function button(key, action, cls = "", iconName, { managed = true, showBusy = false } = {}) {
    let busy = false;
    const control = el(
      "button",
      {
        type: "button",
        class: cls,
        onclick: (event) => {
          if (!managed) return action(event);
          if (busy || control.disabled) return;
          const wasDisabled = Boolean(control.disabled);
          let result;
          try { result = action(event); }
          catch (error) { toast(errorText(error), { kind: "error" }); return; }
          if (!result || typeof result.then !== "function") return result;
          busy = true;
          const restore = showBusy ? buttonBusy(control, true) : () => {};
          return Promise.resolve(result).catch((error) => toast(errorText(error), { kind: "error" }))
            .finally(() => { busy = false; restore(); if (showBusy) control.disabled = wasDisabled; });
        },
        "data-i18n": iconName ? null : key,
        "aria-label": I18n.t(key),
      },
      ...(iconName
        ? [icon(iconName), el("span", { "data-i18n": key, text: I18n.t(key) })]
        : [I18n.t(key)]),
    );
    return control;
  }
  function buttonBusy(control, value, key = "processing") {
    if (!value) return;
    const children = Array.from(control.childNodes || control.children || []), disabled = Boolean(control.disabled);
    const translation = control.getAttribute("data-i18n");
    control.removeAttribute("data-i18n");
    control.replaceChildren(el("span", { "data-i18n": key, text: I18n.t(key) }));
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
    return () => {
      control.replaceChildren(...children);
      if (translation) { control.setAttribute("data-i18n", translation); control.textContent = I18n.t(translation); }
      control.disabled = disabled;
      control.setAttribute("aria-busy", "false");
    };
  }
  function toast(message, { kind = "info", local = false } = {}) {
    if (!["info", "success", "error"].includes(kind)) kind = "info";
    const dialogs = document.querySelectorAll("dialog[open]");
    if (!local && !dialogs.length && !document.fullscreenElement && window.AppPage?.embedded) {
      return window.AppPage.request("shell.toast", { message, kind })
        .catch((error) => { console.warn("Toast bridge failed", error); toast(message, { kind, local: true }); });
    }
    let node = $("#global-toast");
    if (!node) {
      node = el("div", {
        id: "global-toast",
        class: "toast",
        role: "status",
        "aria-live": "polite",
      });
      document.body.append(node);
    }
    const host = dialogs[dialogs.length - 1] || document.fullscreenElement || document.body;
    if (node.parentNode !== host) host.append(node);
    node.dataset.kind = kind;
    node.setAttribute("aria-atomic", "true");
    node.textContent = message;
    clearTimeout(node.dismiss);
    node.dismiss = setTimeout(() => (node.textContent = ""), kind === "error" ? 12000 : 8000);
  }
  function closeCardMenus(target) {
    document.querySelectorAll("details.card-action-menu[open]").forEach((menu) => {
      if (!menu.contains(target)) menu.removeAttribute("open");
    });
  }
  function positionCardMenu(menu) {
    const popover = menu.querySelector(".card-action-popover"), summary = menu.querySelector("summary");
    if (!popover || !summary) return;
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
    const width = viewport?.width || document.documentElement.clientWidth;
    const height = viewport?.height || window.innerHeight;
    const edge = 8, rect = summary.getBoundingClientRect();
    popover.style.maxInlineSize = Math.max(0, width - edge * 2) + "px";
    popover.style.maxBlockSize = Math.max(0, height - edge * 2) + "px";
    const size = popover.getBoundingClientRect();
    const below = Math.max(0, y + height - edge - rect.bottom);
    const above = Math.max(0, rect.top - y - edge);
    const upward = below < size.height && above > below;
    const available = upward ? above : below;
    popover.style.maxBlockSize = available + "px";
    const menuHeight = Math.min(size.height, available);
    const endAligned = { ltr: rect.right - size.width, rtl: rect.left }[I18n.ctx.dir];
    // 使用物理视口坐标，与getBoundingClientRect一致；RTL仅影响末端锚点。
    popover.style.left = Math.max(x + edge, Math.min(endAligned, x + width - edge - size.width)) + "px";
    popover.style.top = Math.max(y + edge, Math.min(upward ? rect.top - menuHeight : rect.bottom, y + height - edge - menuHeight)) + "px";
  }
  window.addEventListener("toggle", (event) => {
    const menu = event.target;
    if (!menu.matches?.("details.card-action-menu[open]")) return;
    closeCardMenus(menu);
    positionCardMenu(menu);
  }, true);
  function dismissCardMenus() {
    document.querySelectorAll("details.card-action-menu[open]").forEach((menu) => {
      if (menu.contains(document.activeElement)) menu.querySelector("summary")?.focus();
      menu.removeAttribute("open");
    });
  }
  window.addEventListener("scroll", (event) => {
    if (!event.target?.closest?.(".card-action-popover")) dismissCardMenus();
  }, true);
  window.addEventListener("resize", dismissCardMenus);
  window.visualViewport?.addEventListener("resize", dismissCardMenus);
  window.visualViewport?.addEventListener("scroll", dismissCardMenus);
  window.addEventListener("pointerdown", (event) => closeCardMenus(event.target));
  window.addEventListener("focusin", (event) => closeCardMenus(event.target));
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = event.target?.closest?.("details.card-action-menu[open]");
    if (!menu) return;
    event.preventDefault();
    menu.removeAttribute("open");
    menu.querySelector("summary")?.focus();
  });
  const compositionForms = new WeakMap();
  function inputForm(target) {
    if (target?.tagName !== "INPUT" || target.closest('.monaco-editor,[contenteditable]:not([contenteditable="false"])')) return null;
    return target.form || target.closest("form");
  }
  function compositionState(form) {
    if (!compositionForms.has(form)) compositionForms.set(form, { composing: false, endedAt: -Infinity, blockSubmit: false });
    return compositionForms.get(form);
  }
  window.addEventListener("compositionstart", (event) => {
    const form = inputForm(event.target);
    if (form) Object.assign(compositionState(form), { composing: true, endedAt: -Infinity });
  }, true);
  window.addEventListener("compositionend", (event) => {
    const form = inputForm(event.target);
    if (form) Object.assign(compositionState(form), { composing: false, endedAt: Date.now() });
  }, true);
  window.addEventListener("keydown", (event) => {
    const form = inputForm(event.target);
    if (!form) return;
    const state = compositionState(form);
    const confirming = event.isComposing || event.keyCode === 229 || state.composing || Date.now() - state.endedAt < 50;
    state.blockSubmit = (event.key === "Enter" || event.keyCode === 229) && confirming;
    // 不取消输入法按键的默认行为，只在表单提交阶段拦截候选确认。
    if (!confirming) state.endedAt = -Infinity;
  }, true);
  window.addEventListener("keyup", (event) => {
    const form = inputForm(event.target);
    if (form && (event.key === "Enter" || event.keyCode === 229))
      Object.assign(compositionState(form), { blockSubmit: false, endedAt: -Infinity });
  }, true);
  window.addEventListener("pointerdown", (event) => {
    const form = event.target?.closest?.("form");
    if (form) Object.assign(compositionState(form), { blockSubmit: false, endedAt: -Infinity });
  }, true);
  window.addEventListener("submit", (event) => {
    const state = compositionForms.get(event.target);
    if (state && (state.composing || state.blockSubmit || Date.now() - state.endedAt < 50)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  function usableFocus(node) {
    if (!node?.isConnected || node === document.body || node === document.documentElement || node.disabled || node.matches?.(":disabled") ||
        node.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
    if (node.getClientRects && !node.getClientRects().length) return false;
    const style = window.getComputedStyle?.(node);
    return style?.visibility !== "hidden" && style?.visibility !== "collapse";
  }
  function focusTarget(node) {
    if (!usableFocus(node)) return false;
    if (!node.matches?.("input,textarea,select,button,a[href],[tabindex]")) node.setAttribute("tabindex", "-1");
    node.focus();
    return document.activeElement === node;
  }
  function restoreDialogFocus(trigger, fallback) {
    if (focusTarget(trigger)) return;
    const explicit = typeof fallback === "function" ? fallback() : typeof fallback === "string" ? $(fallback) : fallback;
    const open = [...document.querySelectorAll("dialog[open]")].pop();
    const candidates = open
      ? [...open.querySelectorAll("input,textarea,select,button,[tabindex]")]
      : [explicit, $("main h1"), $("main"), $("h1")];
    candidates.some(focusTarget);
  }
  let dialogSequence = 0, drawerCount = 0, drawerOverflow = "";
  function dialog(title, build, { wide = false, preview = false, drawer = false, initialFocus, returnFocus } = {}) {
    const trigger = document.activeElement;
    const headingId = "dialog-title-" + ++dialogSequence;
    const node = el("dialog", {
      class: drawer ? "form-drawer" + (wide ? " editor" : "") : preview ? "preview" : wide ? "editor" : "",
      "aria-labelledby": headingId,
    });
    const heading = el("h2", { id: headingId, text: title });
    node.append(heading);
    let resolve;
    const result = new Promise((r) => (resolve = r));
    const close = (value) => {
      resolve(value);
      node.close();
    };
    build(node, close);
    node.addEventListener(
      "close",
      () => {
        resolve(null);
        const notice = $("#global-toast");
        if (notice?.parentNode === node) {
          const remaining = [...document.querySelectorAll("dialog[open]")].filter((item) => item !== node);
          (remaining[remaining.length - 1] || document.fullscreenElement || document.body).append(notice);
        }
        node.remove();
        if (drawer && --drawerCount === 0) document.body.style.overflow = drawerOverflow;
        restoreDialogFocus(trigger, returnFocus);
      },
      { once: true },
    );
    document.body.append(node);
    node.showModal();
    if (drawer && drawerCount++ === 0) {
      drawerOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const notice = $("#global-toast");
    if (notice?.textContent) node.append(notice);
    const initial = typeof initialFocus === "function" ? initialFocus(node) :
      typeof initialFocus === "string" ? node.querySelector(initialFocus) : initialFocus;
    if (!focusTarget(initial)) {
      const first = [...node.querySelectorAll("input:not([type=hidden]),textarea,select,button")].find(usableFocus);
      if (!focusTarget(first)) focusTarget(node);
    }
    return { node, close, result };
  }
  function confirmDialog(message, { initialFocus = "cancel", returnFocus } = {}) {
    return dialog(I18n.t("confirmTitle"), (node, close) => {
      const cancel = button("cancel", () => close(false));
      const confirm = button("confirm", () => close(true), "primary");
      cancel.setAttribute("data-confirm-action", "cancel");
      confirm.setAttribute("data-confirm-action", "confirm");
      node.append(
        el("p", { text: message }),
        el("div", { class: "actions" }, cancel, confirm),
      );
    }, { initialFocus: initialFocus === "confirm" ? '[data-confirm-action="confirm"]' : '[data-confirm-action="cancel"]', returnFocus }).result.then(Boolean);
  }
  function field(
    form,
    {
      key,
      name = key,
      type = "text",
      value = "",
      required = false,
      hint = "",
      options,
      validator,
      readOnly = false,
      className = "",
    },
  ) {
    const id = `field-${name}`;
    if (readOnly) {
      const text = el("p", { id, class: className, text: value, "aria-labelledby": `${id}-label`, "aria-describedby": hint ? `${id}-hint` : null });
      form.append(el("div", { class: "field" },
        el("span", { id: `${id}-label`, text: I18n.t(key) }), text,
        hint ? el("small", { id: `${id}-hint`, text: hint }) : null));
      return text;
    }
    const input = options
      ? el("select", { id, name })
      : el(type === "textarea" ? "textarea" : "input", {
          id,
          name,
          type: type === "textarea" ? null : type,
          value: type === "textarea" ? null : value,
          required: required ? "" : null,
          "aria-required": required ? "true" : null,
          autocomplete: type === "password" ? "new-password" : null,
        });
    if (type === "textarea") input.value = value;
    if (options)
      for (const opt of options)
        input.append(
          el("option", {
            value: opt.value,
            text: opt.label,
            selected: opt.value === String(value) ? "" : null,
          }),
        );
    if (options?.some((option) => String(option.value) === String(value))) input.value = String(value);
    if (className) input.className = className;
    const error = el("small", { id: `${id}-error`, class: "field-error" });
    const hints = [];
    if (hint) hints.push(el("small", { id: `${id}-hint`, text: hint }));
    input.setAttribute(
      "aria-describedby",
      [...hints.map((h) => h.id), error.id].join(" "),
    );
    const validate = () => {
      let message = "";
      if (required && !input.value.trim()) message = I18n.t("requiredError");
      else if (type === "email" && input.value && !input.validity.valid)
        message = I18n.t("emailError");
      else if (validator) message = validator(input.value) || "";
      error.textContent = message;
      input.setAttribute("aria-invalid", String(Boolean(message)));
      return !message;
    };
    input.addEventListener("blur", validate);
    input.addEventListener("input", () => {
      if (input.getAttribute("aria-invalid") === "true") validate();
    });
    input.validate = validate;
    form.append(
      el(
        "div",
        { class: "field" },
        el("label", { for: id, text: I18n.t(key) + (required ? " *" : "") }),
        input,
        ...hints,
        error,
      ),
    );
    return input;
  }
  function validate(form) {
    const invalid = [...form.elements].filter(
      (x) => !x.disabled && x.validate && !x.validate(),
    );
    if (invalid.length) {
      invalid[0].scrollIntoView({ block: "nearest" });
      invalid[0].focus();
      return false;
    }
    return true;
  }
  function formDialog(
    title,
    fields,
    submit,
    { wide = false, saveKey = "save", dirty = true, intro = "" } = {},
  ) {
    return dialog(
      title,
      (node, close) => {
        const form = el("form", { novalidate: "", class: "form-drawer-form" });
        const body = el("div", { class: "form-drawer-body" });
        body.append(el("p", { class: "form-note", "data-i18n": "required", text: I18n.t("required") }));
        if (intro) body.append(el("p", { class: "form-note", text: intro }));
        let group = body;
        for (const config of fields) {
          if (config.group) {
            group = el("fieldset", { class: "form-group" }, el("legend", { text: I18n.t(config.group) }));
            body.append(group);
          }
          field(group, config);
        }
        node.addEventListener("close", () => {
          for (const input of form.elements)
            if (input.getAttribute("type") === "password") input.value = "";
        }, { once: true });
        const status = el("div", {
          class: "status-line",
          role: "status",
          "aria-live": "polite",
        });
        let submitting = false, changed = false, confirming = false;
        const previousDirty = Boolean(window.AppPage?.dirty);
        const requestClose = async () => {
          if (submitting || confirming) return;
          confirming = true;
          try {
            if (!dirty || !changed || (await confirmDialog(I18n.t("unsaved")))) close(null);
          } finally { confirming = false; }
        };
        node.addEventListener("cancel", (event) => {
          event.preventDefault();
          requestClose();
        });
        const back = button("back", requestClose, "form-drawer-back");
        const dismiss = button("close", requestClose, "form-drawer-close", "close");
        back.setAttribute("data-i18n-label", "back");
        dismiss.setAttribute("data-i18n-label", "close");
        const heading = node.querySelector("h2");
        const parentTitle = $("main h1")?.textContent || $("h1")?.textContent;
        const crumbs = el("ol", {},
          ...(parentTitle ? [el("li", {}, el("button", { type: "button", text: parentTitle, onclick: requestClose }))] : []),
          el("li", { "aria-current": "page", text: title }));
        const breadcrumb = el("nav", { class: "crumbs form-drawer-crumbs", "aria-label": I18n.t("breadcrumb"), "data-i18n-label": "breadcrumb" }, crumbs);
        node.append(breadcrumb, el("header", { class: "form-drawer-header" }, back, heading, dismiss));
        const save = button(saveKey, () => {}, "primary");
        save.type = "submit";
        const cancel = button("cancel", requestClose);
        const exits = [back, dismiss, cancel, ...crumbs.querySelectorAll("button")];
        const footer = el("div", { class: "form-feedback" }, status, el("div", { class: "actions" }, cancel, save));
        form.append(body, footer);
        const markChanged = () => {
          changed = true;
          if (dirty) window.AppPage?.setDirty(true);
        };
        form.addEventListener("input", markChanged);
        form.addEventListener("change", markChanged);
        if (dirty) node.addEventListener("close", () => window.AppPage?.setDirty(previousDirty), { once: true });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (submitting) return;
          if (!validate(form)) {
            status.textContent = I18n.t("validationFailed");
            status.classList.add("error");
            return;
          }
          submitting = true;
          const restoreSave = buttonBusy(save, true, "saving");
          exits.forEach((control) => { control.disabled = true; });
          status.classList.remove("error");
          status.textContent = I18n.t("saving");
          form.setAttribute("aria-busy", "true");
          const values = Object.fromEntries(new FormData(form));
          const editable = [...form.elements].filter((input) => input !== save && input !== cancel && !input.disabled);
          editable.forEach((input) => { input.disabled = true; });
          try {
            const value = await submit(values);
            changed = false;
            if (dirty) window.AppPage?.setDirty(previousDirty);
            close(value ?? true);
            toast(I18n.t("success"), { kind: "success" });
          } catch (e) {
            status.textContent = errorText(e);
            status.classList.add("error");
          } finally {
            submitting = false;
            restoreSave();
            editable.forEach((input) => { input.disabled = false; });
            exits.forEach((control) => { control.disabled = false; });
            form.setAttribute("aria-busy", "false");
          }
        });
        node.append(form);
      },
      { wide, drawer: true, initialFocus: (node) => [...node.querySelectorAll("input:not([type=hidden]),textarea,select")].find(usableFocus) },
    ).result;
  }
  const errorMap = {
    ONBOARDING_INCOMPLETE: "ONBOARDING_INCOMPLETE",
    ONBOARDING_VISIT_REQUIRED: "ONBOARDING_VISIT_REQUIRED",
    PREVIEW_NOT_READY: "PREVIEW_NOT_READY",
    QUOTA_INVALID: "QUOTA_INVALID",
    FILE_COUNT_QUOTA_EXCEEDED: "FILE_COUNT_QUOTA_EXCEEDED",
    STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
    EMAIL_VERIFICATION_REQUIRED: "EMAIL_VERIFICATION_REQUIRED",
    MAIL_NOT_CONFIGURED: "MAIL_NOT_CONFIGURED",
    MAIL_SEND_FAILED: "MAIL_SEND_FAILED",
    MAIL_TEST_CANCELLED: "MAIL_TEST_CANCELLED",
    SMTP_SECRET_UNAVAILABLE: "SMTP_SECRET_UNAVAILABLE",
    SMTP_PASSWORD_ENVIRONMENT: "SMTP_PASSWORD_ENVIRONMENT",
    REGISTRATION_THROTTLED: "REGISTRATION_THROTTLED",
    ACTIVATION_INVALID: "ACTIVATION_INVALID",
    PASSWORD_MISMATCH: "PASSWORD_MISMATCH",
    INVITATION_INVALID: "INVITATION_INVALID",
    INVITATION_ALREADY_CREATED: "INVITATION_ALREADY_CREATED",
    REQUEST_CONFLICT: "REQUEST_CONFLICT",
    RESOURCE_CONFLICT: "conflict",
    USER_EXISTS: "userAccountExists",
    SELF_DISABLE_FORBIDDEN: "SELF_DISABLE_FORBIDDEN",
    PATH_CONFLICT: "conflict",
    PATH_CASE_CONFLICT: "conflict",
    FOREIGN_CONTENT: "permissionDenied",
    READ_ONLY: "permissionDenied",
    ORIGIN_DENIED: "originDenied",
    UNSAFE_PATH: "invalidFile",
    PATH_KIND_INVALID: "invalidInput",
    FOLDER_NOT_EXIST: "notFound",
    FILE_NOT_EXIST: "notFound",
    ROUTE_NOT_EXIST: "notFound",
    ENTRY_NOT_EXIST: "shareEmpty",
    PREVIEW_EXPIRED: "shareNotFound",
    SETUP_COMPLETED: "setupComplete",
    LOGIN_THROTTLED: "rateLimit",
    TEXT_TOO_LARGE: "uploadTooLarge",
    NOT_TEXT_FILE: "invalidFile",
    AUTH_REQUIRED: "loginRequired",
    UNAUTHORIZED: "loginRequired",
    FORBIDDEN: "permissionDenied",
    PERMISSION_DENIED: "permissionDenied",
    NOT_FOUND: "notFound",
    USER_NOT_EXIST: "notFound",
    WORKSPACE_NOT_EXIST: "notFound",
    NODE_NOT_EXIST: "notFound",
    SHARE_NOT_EXIST: "shareNotFound",
    SHARE_EXPIRED: "shareNotFound",
    SHARE_REVOKED: "shareNotFound",
    SHARE_INVALID: "shareNotFound",
    LOGIN_FAILED: "loginFailed",
    INVALID_CREDENTIALS: "loginFailed",
    ACCOUNT_DISABLED: "accountDisabled",
    USER_DISABLED: "accountDisabled",
    REGISTRATION_CLOSED: "registrationClosed",
    REGISTRATION_DISABLED: "registrationClosed",
    SETUP_COMPLETE: "setupComplete",
    ALREADY_INITIALIZED: "setupComplete",
    CONFLICT: "conflict",
    NAME_CONFLICT: "conflict",
    EMAIL_EXISTS: "EMAIL_EXISTS",
    MAIL_ORIGIN_REQUIRED: "MAIL_ORIGIN_REQUIRED",
    EMAIL_SESSION_MISMATCH: "EMAIL_SESSION_MISMATCH",
    EMAIL_CHANGED: "EMAIL_CHANGED",
    EMAIL_UNCHANGED: "EMAIL_UNCHANGED",
    EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
    PASSWORD_RESET_INVALID: "PASSWORD_RESET_INVALID",
    EMAIL_TOKEN_INVALID: "EMAIL_TOKEN_INVALID",
    EMAIL_IDENTITY_MISMATCH: "EMAIL_IDENTITY_MISMATCH",
    EMAIL_CHANGE_STATE_INVALID: "EMAIL_CHANGE_STATE_INVALID",
    MAIL_THROTTLED: "MAIL_THROTTLED",
    USER_EXIST: "conflict",
    NODE_EXIST: "conflict",
    PARAM_INVALID: "invalidInput",
    INVALID_INPUT: "invalidInput",
    LAST_ADMIN: "lastAdmin",
    LAST_ADMIN_REQUIRED: "lastAdmin",
    PAYLOAD_TOO_LARGE: "uploadTooLarge",
    UPLOAD_TOO_LARGE: "uploadTooLarge",
    INVALID_PATH: "invalidFile",
    FILE_TYPE_NOT_ALLOWED: "invalidFile",
    MEMBER_EXISTS: "memberExists",
    RATE_LIMITED: "rateLimit",
    INTERNAL_ERROR: "unknownError",
  };
  function errorText(e) {
    if (e?.name === "TypeError") return I18n.t("networkError");
    return I18n.t(errorMap[e?.status] || "unknownError");
  }
  let sessionNavigation = null;
  function sessionExpired() {
    if (sessionNavigation) return sessionNavigation;
    const protectedPage =
      new URL(".", routeUrl("shell")).pathname === location.pathname ||
      ["shell", "workspace", "workspace-admin", "account", "onboarding", "users", "settings"].some(
        (routeId) => new URL(routeUrl(routeId)).pathname === location.pathname,
      );
    if (!protectedPage) return Promise.resolve(false);
    sessionNavigation = Promise.resolve().then(async () => {
      if (window.AppPage) {
        window.AppPage.setDirty(false);
        try {
          return await window.AppPage.request("shell.sessionExpired", {});
        } catch (e) {
          console.warn("Session navigation failed", e);
        }
      }
      location.replace(routeUrl("auth"));
      return true;
    });
    return sessionNavigation;
  }
  async function api(
    path,
    { method = "GET", query = {}, body, signal, authRequired = false } = {},
  ) {
    const url = new URL(path, location.href);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null)
        url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (response.status === 204) return {};
    let data;
    try {
      data = await response.json();
    } catch (e) {
      if (response.ok) throw new Error("INVALID_RESPONSE");
      data = {
        status:
          response.status === 401
            ? "AUTH_REQUIRED"
            : response.status === 403
              ? "FORBIDDEN"
              : "INTERNAL_ERROR",
      };
    }
    if (!response.ok) {
      const e = new Error(data.status);
      e.status = data.status;
      e.httpStatus = response.status;
      if (authRequired && response.status === 401) await sessionExpired();
      throw e;
    }
    return data;
  }
  function invitationToken() {
    const fragment = location.hash || "";
    const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(fragment);
    if (fragment) {
      const clean = new URL(location.href);
      clean.hash = "";
      history.replaceState(history.state, "", clean);
    }
    return match ? match[1] : null;
  }
  function invitationUrl(routeId, token) {
    if (!["invite", "auth"].includes(routeId) || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("ROUTE_NOT_ALLOWED");
    const url = new URL(routeUrl(routeId));
    url.hash = "invite=" + token;
    return url.href;
  }
  function routeUrl(routeId, params = {}) {
    if (!Object.hasOwn(routes, routeId)) throw new Error("ROUTE_NOT_ALLOWED");
    const base = new URL(
      "../" + routes[routeId],
      document.querySelector('script[src$="common.js"]').src,
    );
    if (location.protocol === "file:") {
      if (base.protocol !== "file:") throw new Error("ROUTE_NOT_ALLOWED");
    } else if (
      !["http:", "https:"].includes(base.protocol) ||
      base.origin !== location.origin
    )
      throw new Error("ROUTE_NOT_ALLOWED");
    for (const [k, v] of Object.entries(params))
      if (v !== null && v !== undefined) base.searchParams.set(k, String(v));
    return base.href;
  }
  function settingsControls(container) {
    const select = el("select", {
      "aria-label": I18n.t("language"),
      "data-i18n-label": "language",
    });
    for (const [value, label] of [
      ["zh-CN", "简体中文"],
      ["en-US", "English"],
      ["ar-SA", "العربية"],
    ])
      select.append(el("option", { value, text: label }));
    select.value = I18n.ctx.locale;
    select.addEventListener("change", () => {
      I18n.apply({ ...I18n.ctx, locale: select.value });
      I18n.persist();
    });
    const theme = el(
      "button",
      {
        type: "button",
        "aria-label": I18n.t("theme"),
        "data-i18n-label": "theme",
        class: "icon-button",
      },
      icon("sun"),
    );
    theme.addEventListener("click", () => {
      I18n.apply({
        ...I18n.ctx,
        theme: I18n.ctx.theme === "dark" ? "light" : "dark",
      });
      I18n.persist();
    });
    const accent = el("select", {
      "aria-label": I18n.t("accent"),
      "data-i18n-label": "accent",
    });
    for (const value of I18n.accents) {
      const key = "accent" + value[0].toUpperCase() + value.slice(1);
      accent.append(el("option", { value, "data-i18n": key, text: I18n.t(key) }));
    }
    accent.value = I18n.ctx.accent;
    accent.addEventListener("change", () => {
      I18n.apply({ ...I18n.ctx, accent: accent.value });
      I18n.persist();
    });
    container.append(select, accent, theme);
    I18n.subscribe((ctx) => {
      select.value = ctx.locale;
      accent.value = ctx.accent;
    });
  }
  function page() {
    const adapter = {
      context: () => I18n.ctx,
      confirm: confirmDialog,
      emit(type, payload) {
        if (type === "shell.toast") toast(payload.message, { kind: payload.kind, local: true });
        if (type === "shell.title")
          document.title = `${payload.title} · babaShare`;
      },
      async request(type, payload) {
        if (type === "shell.sessionExpired") {
          location.replace(routeUrl("auth"));
          return true;
        }
        if (type === "shell.confirm") return confirmDialog(payload.message);
        if (type === "shell.navigate") {
          if (
            window.AppPage?.dirty &&
            !(await confirmDialog(I18n.t("unsaved")))
          )
            return false;
          location.href = routeUrl(payload.routeId, payload.params);
          return true;
        }
        if (type === "shell.toast") {
          toast(payload.message, { kind: payload.kind, local: true });
          return true;
        }
        if (type === "shell.title") {
          document.title = `${payload.title} · babaShare`;
          return true;
        }
        throw new Error("BRIDGE_UNKNOWN_TYPE");
      },
    };
    const bridge = PageBridgeClient.create({ standalone: adapter });
    bridge.ready.then((ctx) => {
      I18n.apply(ctx);
      if (!bridge.embedded) {
        const controls = el("div", { class: "standalone-controls" });
        controls.append(
          el("a", { href: routeUrl("shell"), text: "babaShare", onclick: (event) => {
            if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            return bridge.request("shell.navigate", { routeId: "shell", params: {} })
              .catch((error) => toast(errorText(error)));
          } }),
        );
        settingsControls(controls);
        document.body.prepend(controls);
      }
    });
    document.querySelectorAll('.crumbs a[href="index.html"]').forEach((link) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        bridge
          .request("shell.navigate", { routeId: "workspace", params: {} })
          .catch((e) => toast(errorText(e), { kind: "error" }));
      }),
    );
    window.AppPage = bridge;
    return bridge;
  }
  function date(value) {
    if (!value) return I18n.t("forever");
    const d = new Date(value),
      p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function quotaValue(mode, value, unit = "B") {
    if (mode === "inherit") return null;
    if (mode === "unlimited") return 0;
    const text = String(value).trim();
    if (text.length > 128) throw { status: "QUOTA_INVALID" };
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    const multiplier = { B: 1n, MiB: 1048576n, GiB: 1073741824n }[unit];
    if (mode !== "custom" || !match || !multiplier || (unit === "B" && match[2])) throw { status: "QUOTA_INVALID" };
    const scale = 10n ** BigInt((match[2] || "").length);
    const numerator = BigInt(match[1] + (match[2] || "")) * multiplier;
    if (numerator % scale || numerator / scale > BigInt(Number.MAX_SAFE_INTEGER) || numerator === 0n) throw { status: "QUOTA_INVALID" };
    return Number(numerator / scale);
  }
  function quotaFields(quota = {}, defaults = false) {
    return ["FileCount", "StorageBytes"].flatMap((kind) => {
      const storage = kind === "StorageBytes", name = (defaults ? "default" + kind : kind[0].toLowerCase() + kind.slice(1)) + "Limit";
      const value = quota[name], mode = value == null && !defaults ? "inherit" : value > 0 ? "custom" : "unlimited";
      const unit = storage && value > 0 && value % 1073741824 === 0 ? "GiB" : storage && value > 0 && value % 1048576 === 0 ? "MiB" : "B";
      const fields = [
        { group: storage ? "quotaStorage" : "quotaFiles", key: "quotaMode", name: name + "Mode", value: mode, options: [...(defaults ? [] : [{ value: "inherit", label: I18n.t("quotaInherit") }]), { value: "unlimited", label: I18n.t("quotaUnlimited") }, { value: "custom", label: I18n.t("quotaCustom") }] },
        { key: storage ? "quotaStorage" : "quotaFiles", name, className: "num", value: value > 0 ? String(value / ({ B: 1, MiB: 1048576, GiB: 1073741824 }[unit])) : "", hint: I18n.t("quotaValueHint"), validator: (text) => {
          try { quotaValue($("#field-" + name + "Mode").value, text, storage ? $("#field-" + name + "Unit").value : "B"); return ""; }
          catch (_) { return I18n.t("QUOTA_INVALID"); }
        } },
      ];
      if (storage) fields.push({ key: "quotaUnit", name: name + "Unit", value: unit, options: ["MiB", "GiB", "B"].map((item) => ({ value: item, label: item })), hint: I18n.t("quotaUnitHint") });
      return fields;
    });
  }
  function quotaPayload(values, defaults = false) {
    return Object.fromEntries(["FileCount", "StorageBytes"].map((kind) => {
      const name = (defaults ? "default" + kind : kind[0].toLowerCase() + kind.slice(1)) + "Limit";
      return [name, quotaValue(values[name + "Mode"], values[name], kind === "StorageBytes" ? values[name + "Unit"] : "B")];
    }));
  }
  function quotaSummary(quota, { defaults = false } = {}) {
    if (!quota) return null;
    const bytes = (value) => value >= 1073741824 ? `${(value / 1073741824).toFixed(2)} GiB` : value >= 1048576 ? `${(value / 1048576).toFixed(2)} MiB` : `${value} B`;
    const limit = (value, storage) => value === 0 ? I18n.t("quotaUnlimited") : storage ? bytes(value) : String(value);
    return el("div", { class: "small muted", "aria-label": I18n.t(defaults ? "quotaDefaults" : "quotaUsage") },
      ...[["quotaFiles", quota.usedFileCount, quota.effectiveFileCountLimit, false], ["quotaStorage", quota.usedStorageBytes, quota.effectiveStorageBytesLimit, true]].map(([key, used, total, storage]) =>
        el("p", {}, I18n.t(key) + ": ", el("bdi", { dir: "ltr", class: "num", text: defaults ? limit(total, storage) : `${storage ? bytes(used) : used} / ${limit(total, storage)}` }))));
  }
  function size(value) {
    if (!value) return "—";
    if (value < 1024) return value + " B";
    if (value < 1048576) return (value / 1024).toFixed(1) + " KB";
    return (value / 1048576).toFixed(1) + " MB";
  }
  function empty(title, hint, action) {
    return el(
      "div",
      { class: "empty" },
      icon("folder"),
      el("h2", { text: I18n.t(title) }),
      el("p", { class: "muted", text: I18n.t(hint) }),
      action || null,
    );
  }
  function preview(title, url) {
    const result = dialog(
      title,
      (node, close) => {
        node.replaceChildren();
        const frame = el("iframe", {
          class: "preview-frame",
          src: url,
          title: I18n.t("filePreview"),
          sandbox: "allow-scripts",
          allow: "fullscreen",
          allowfullscreen: "",
        });
        const full = button(
          "fullscreen",
          () => {
            node.requestFullscreen?.().catch((e) => toast(errorText(e), { kind: "error" }));
          },
          "",
          "fullscreen",
        );
        node.append(
          el(
            "div",
            { class: "preview-content" },
            el(
              "header",
              { class: "preview-bar" },
              el("strong", {
                id: node.getAttribute("aria-labelledby"),
                text: title,
              }),
              el(
                "div",
                { class: "actions" },
                full,
                button("close", () => close(null), "", "close"),
              ),
            ),
            frame,
            el("div", {
              class: "preview-bar small muted",
              text: I18n.t("previewHint"),
            }),
          ),
        );
      },
      { preview: true },
    );
    return result.result;
  }
  function nameValidator(value) {
    return !value.trim() ||
      /[\\/\x00-\x1f]/.test(value) ||
      [".", ".."].includes(value.trim())
      ? I18n.t("invalidName")
      : "";
  }
  function copyButton(key, action, cls = "", iconName, { errorMessage = errorText, isDisabled = () => false } = {}) {
    let busy = false, resetTimer;
    const control = button(key, async () => {
      if (busy || control.disabled) return;
      busy = true;
      clearTimeout(resetTimer);
      const show = (state, label) => {
        control.dataset.copyState = state;
        control.setAttribute("data-i18n-label", label);
        control.setAttribute("aria-label", I18n.t(label));
        feedback.setAttribute("data-i18n", label);
        feedback.textContent = I18n.t(label);
      };
      show("loading", "copying");
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
      let copied = false;
      try { copied = await action() !== false; }
      catch (error) { toast(errorMessage(error), { kind: "error" }); }
      finally {
        busy = false;
        control.disabled = isDisabled();
        control.setAttribute("aria-busy", "false");
        show(copied ? "success" : "failure", copied ? "copySuccess" : "copyRetry");
        resetTimer = setTimeout(() => {
          delete control.dataset.copyState;
          control.setAttribute("data-i18n-label", key);
          control.setAttribute("aria-label", I18n.t(key));
        }, 2500);
      }
    }, cls, iconName, { managed: false });
    const label = el("span", { class: "copy-label" });
    label.append(...Array.from(control.childNodes));
    if (!iconName) label.setAttribute("data-i18n", key);
    const feedback = el("span", { class: "copy-result", "aria-hidden": "true" });
    const reserve = el("span", { class: "copy-reserve", "data-i18n": "copyRetry",
      "aria-hidden": "true", text: I18n.t("copyRetry") });
    control.replaceChildren(label, feedback, reserve);
    control.removeAttribute("data-i18n");
    control.setAttribute("data-i18n-label", key);
    control.classList.add("copy-feedback");
    return control;
  }
  async function copy(text, { successKey = "copied", titleKey = "copyLink", manualKey = "copyManual", multiline = false } = {}) {
    try {
      await navigator.clipboard.writeText(text);
      toast(I18n.t(successKey), { kind: "success" });
      return true;
    } catch (error) {
      const fallback = dialog(I18n.t(titleKey), (node, close) => {
        const input = el(multiline ? "textarea" : "input", {
          readonly: "", dir: "ltr", autocomplete: "off", spellcheck: "false",
          "aria-label": I18n.t(titleKey),
        });
        input.value = text;
        node.append(
          el("p", { class: "form-note", text: I18n.t(manualKey) }),
          input,
          el("div", { class: "actions" }, button("close", () => close(null))),
        );
        node.addEventListener("close", () => { input.value = ""; }, { once: true });
        input.addEventListener("focus", () => input.select());
        queueMicrotask(() => { input.focus(); input.select(); });
      }, { wide: multiline });
      toast(I18n.t("copyFailed"), { kind: "error" });
      const cleanup = () => fallback.close(null);
      window.addEventListener("pagehide", cleanup, { once: true });
      try { await fallback.result; }
      finally { window.removeEventListener("pagehide", cleanup); }
      return false;
    } finally { text = ""; }
  }
  window.UI = {
    $,
    el,
    icon,
    button,
    buttonBusy,
    toast,
    dialog,
    confirm: confirmDialog,
    field,
    validate,
    formDialog,
    errorText,
    api,
    sessionExpired,
    routeUrl,
    invitationToken,
    invitationUrl,
    settingsControls,
    page,
    date,
    size,
    quotaValue,
    quotaFields,
    quotaPayload,
    quotaSummary,
    empty,
    preview,
    nameValidator,
    copy,
    copyButton,
  };
})();
