(() => {
  "use strict";
  const routes = {
    workspace: "workspace.html",
    account: "account.html",
    users: "users.html",
    auth: "auth.html",
    shell: "index.html",
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
    share:
      "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 11l6-4m-6 6 6 4",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-8a4 4 0 0 1 0 8",
    user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    search: "M21 21l-5-5m2-6a7 7 0 1 0-14 0 7 7 0 0 0 14 0Z",
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
  function button(key, action, cls = "", iconName) {
    return el(
      "button",
      {
        type: "button",
        class: cls,
        onclick: action,
        "data-i18n": iconName ? null : key,
        "aria-label": I18n.t(key),
      },
      ...(iconName
        ? [icon(iconName), el("span", { "data-i18n": key, text: I18n.t(key) })]
        : [I18n.t(key)]),
    );
  }
  function toast(message) {
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
    node.textContent = message;
    clearTimeout(node.dismiss);
    node.dismiss = setTimeout(() => (node.textContent = ""), 5000);
  }
  let dialogSequence = 0;
  function dialog(title, build, { wide = false, preview = false } = {}) {
    const trigger = document.activeElement;
    const headingId = "dialog-title-" + ++dialogSequence;
    const node = el("dialog", {
      class: preview ? "preview" : wide ? "editor" : "",
      "aria-labelledby": headingId,
    });
    const heading = el("h2", { id: headingId, text: title });
    node.append(heading);
    let resolve;
    const result = new Promise((r) => (resolve = r));
    const close = (value) => {
      node.close();
      resolve(value);
    };
    build(node, close);
    node.addEventListener(
      "close",
      () => {
        resolve(null);
        node.remove();
        if (trigger?.isConnected) trigger.focus();
      },
      { once: true },
    );
    document.body.append(node);
    node.showModal();
    const first = node.querySelector(
      "input:not([type=hidden]),textarea,select,button",
    );
    first?.focus();
    return { node, close, result };
  }
  function confirmDialog(message) {
    return dialog(I18n.t("confirmTitle"), (node, close) => {
      node.append(
        el("p", { text: message }),
        el(
          "div",
          { class: "actions" },
          button("cancel", () => close(false)),
          button("confirm", () => close(true), "primary"),
        ),
      );
    }).result.then(Boolean);
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
    },
  ) {
    const id = `field-${name}`;
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
      (x) => x.validate && !x.validate(),
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
    { wide = false, saveKey = "save", dirty = false, intro = "" } = {},
  ) {
    return dialog(
      title,
      (node, close) => {
        const form = el("form", { novalidate: "" });
        form.append(el("p", { class: "form-note", text: I18n.t("required") }));
        if (intro) form.append(el("p", { class: "form-note", text: intro }));
        for (const config of fields) field(form, config);
        const status = el("div", {
          class: "status-line",
          role: "status",
          "aria-live": "polite",
        });
        const save = button(saveKey, () => {}, "primary");
        save.type = "submit";
        const cancel = button("cancel", async () => {
          if (!dirty || !changed || (await confirmDialog(I18n.t("unsaved"))))
            close(null);
        });
        form.append(status, el("div", { class: "actions" }, cancel, save));
        let changed = false;
        form.addEventListener("input", () => {
          changed = true;
          if (dirty) window.AppPage?.setDirty(true);
        });
        if (dirty) {
          node.addEventListener("cancel", (event) => {
            if (changed) {
              event.preventDefault();
              confirmDialog(I18n.t("unsaved")).then((ok) => {
                if (ok) close(null);
              });
            }
          });
          node.addEventListener(
            "close",
            () => window.AppPage?.setDirty(false),
            { once: true },
          );
        }
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!validate(form)) return;
          save.disabled = true;
          status.textContent = I18n.t("saving");
          form.setAttribute("aria-busy", "true");
          try {
            const values = Object.fromEntries(new FormData(form));
            const value = await submit(values);
            changed = false;
            close(value ?? true);
          } catch (e) {
            status.textContent = errorText(e);
            status.classList.add("error");
          } finally {
            save.disabled = false;
            form.setAttribute("aria-busy", "false");
          }
        });
        node.append(form);
      },
      { wide },
    ).result;
  }
  const errorMap = {
    RESOURCE_CONFLICT: "conflict",
    USER_EXISTS: "conflict",
    PATH_CONFLICT: "conflict",
    PATH_CASE_CONFLICT: "conflict",
    FOREIGN_CONTENT: "permissionDenied",
    READ_ONLY: "permissionDenied",
    ORIGIN_DENIED: "permissionDenied",
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
    EMAIL_EXISTS: "conflict",
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
  async function api(path, { method = "GET", query = {}, body, signal } = {}) {
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
      throw e;
    }
    return data;
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
    const select = el("select", { "aria-label": I18n.t("language") });
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
    container.append(select, theme);
    I18n.subscribe((ctx) => (select.value = ctx.locale));
  }
  function page() {
    const adapter = {
      context: () => I18n.ctx,
      confirm: confirmDialog,
      emit(type, payload) {
        if (type === "shell.toast") toast(payload.message);
        if (type === "shell.title")
          document.title = `${payload.title} · babaShare`;
      },
      async request(type, payload) {
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
          toast(payload.message);
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
          el("a", { href: routeUrl("shell"), text: "babaShare" }),
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
          .catch((e) => toast(errorText(e)));
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
            node.requestFullscreen?.().catch((e) => toast(errorText(e)));
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
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(I18n.t("copied"));
    } catch (e) {
      await dialog(I18n.t("copyLink"), (node, close) => {
        const input = el("input", {
          value: text,
          readonly: "",
          "aria-label": I18n.t("link"),
        });
        node.append(
          el("p", { class: "form-note", text: I18n.t("copyManual") }),
          input,
          el(
            "div",
            { class: "actions" },
            button("close", () => close(null)),
          ),
        );
        input.addEventListener("focus", () => input.select());
        queueMicrotask(() => input.select());
      }).result;
    }
  }
  window.UI = {
    $,
    el,
    icon,
    button,
    toast,
    dialog,
    confirm: confirmDialog,
    field,
    validate,
    formDialog,
    errorText,
    api,
    routeUrl,
    settingsControls,
    page,
    date,
    size,
    empty,
    preview,
    nameValidator,
    copy,
  };
})();
