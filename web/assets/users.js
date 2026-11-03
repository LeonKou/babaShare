(async () => {
  "use strict";
  const { $, el, button, formDialog, toast, errorText } = UI;
  const bridge = UI.page();
  let users = [],
    me = null,
    query = "",
    controller = null,
    requestId = 0;
  const pager = LocalPager($("#user-pagination"), render);
  function roles() {
    return ["editor", "admin"].map((value) => ({
      value,
      label: I18n.t(value),
    }));
  }
  function render() {
    const filtered = users.filter((user) =>
      (user.nickname + " " + user.userName + " " + (user.email || ""))
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
    $("#user-cards").replaceChildren(
      ...pager.slice(filtered).map((user) =>
        el(
          "article",
          { class: "card", "data-id": user.id },
          el(
            "header",
            {},
            el(
              "div",
              { class: "row" },
              el("span", {
                class: "avatar",
                text: user.nickname.slice(0, 1).toUpperCase(),
              }),
              el("h2", { text: user.nickname }),
            ),
            el("span", {
              class: "badge",
              text: I18n.t(user.isDisabled ? "disabled" : user.role),
            }),
          ),
          el("p", { class: "muted", text: user.userName, dir: "auto" }),
          el("p", { class: "small muted" }, I18n.t("email") + ": ",
            el("bdi", { dir: "ltr", text: user.email || I18n.t("emailNotBound") }),
            " · " + I18n.t(user.emailVerified ? "emailVerified" : "emailUnverified")),
          el("p", {
            class: "small muted num",
            text: I18n.t("created") + ": " + UI.date(user.createTime),
          }),
          UI.quotaSummary(user.quota),
          user.id === me?.id
            ? el("small", { class: "muted", text: I18n.t("SELF_DISABLE_FORBIDDEN"), title: I18n.t("SELF_DELETE_FORBIDDEN") })
            : null,
          el(
            "footer",
            {},
            button("edit", () => editUser(user)),
            el("a", {
              href: UI.routeUrl("workspace-admin", { userId: user.id, relation: "any" }),
              text: I18n.t("userWorkspaces"),
              onclick: (event) => {
                if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                bridge.request("shell.navigate", { routeId: "workspace-admin", params: { userId: user.id, relation: "any" } }).catch((e) => toast(errorText(e), { kind: "error" }));
              },
            }),
            user.id === me?.id ? null : el("details", { class: "card-action-menu", name: "user-card-actions" },
              el("summary", { "aria-label": I18n.t("actions"), "data-i18n-label": "actions", title: I18n.t("actions"), "data-i18n-title": "actions", text: "…" }),
              el("div", { class: "card-action-popover" },
                button(user.isDisabled ? "enableUser" : "disableUser", () => toggleUser(user), user.isDisabled ? "" : "danger", null, { showBusy: true }),
                button("deleteAccount", () => deleteUser(user), "danger", null, { showBusy: true }),
              ),
            ),
          ),
        ),
      ),
    );
    $("#user-empty").hidden = filtered.length > 0;
    if (!filtered.length)
      $("#user-empty").replaceChildren(UI.empty("emptyUsers", "userHint"));
    $("#user-actions").replaceChildren(
      button("createUser", createUser, "primary", "plus"),
    );
    document.title = `${I18n.t("users")} · babaShare`;
  }
  async function createUser() {
    const result = await formDialog(
      I18n.t("createUser"),
      [
        {
          key: "accountName",
          name: "userName",
          required: true,
          hint: I18n.t("accountNameHint"),
          validator: (v) =>
            /^[A-Za-z0-9_.@-]{3,64}$/.test(v) ? "" : I18n.t("accountNameError"),
        },
        { key: "displayName", name: "nickname", required: true },
        {
          key: "password",
          type: "password",
          required: true,
          hint: I18n.t("passwordHint"),
          validator: (v) =>
            v.length < 6 || v.length > 256 ? I18n.t("passwordError") : "",
        },
        { key: "role", name: "role", value: "editor", options: roles() },
      ],
      (values) => API("user", { method: "POST", body: values }),
      { saveKey: "create" },
    );
    if (result) await load();
  }
  async function editUser(user) {
    const card = Array.from($("#user-cards").children).find((item) => item.getAttribute("data-id") === user.id);
    const trigger = card?.querySelector("footer button");
    const isSelf = user.id === me?.id;
    const pending = formDialog(
      I18n.t("edit") + " · " + user.nickname,
      [
        {
          group: "userAccountDetails",
          key: "loginAccount",
          name: "userName",
          required: true,
          value: user.userName,
          hint: I18n.t("userAccountHint"),
          validator: (value) => {
            const [local, domain, ...extra] = value.split("@");
            const email = !extra.length && domain && value.length <= 254 &&
              local.length >= 1 && local.length <= 64 &&
              /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) &&
              !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
              domain.length <= 253 && domain.includes(".") &&
              domain.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
            return /^[A-Za-z0-9_.@-]{3,64}$/.test(value) || email ? "" : I18n.t("userAccountError");
          },
        },
        {
          key: "displayName",
          name: "nickname",
          required: true,
          value: user.nickname,
          validator: (value) => !value.trim() ? I18n.t("requiredError") : value.length > 64 ? I18n.t("userNicknameError") : "",
        },
        { key: "email", name: "email", value: user.email || I18n.t("emailNotBound"), readOnly: true, hint: I18n.t("adminEmailReadOnlyHint") },
        { key: "emailVerificationStatus", name: "emailVerified", value: I18n.t(user.emailVerified ? "emailVerified" : "emailUnverified"), readOnly: true },
        { key: "role", name: "role", value: user.role, options: roles() },
        {
          key: "userStatus",
          name: "isDisabled",
          value: isSelf ? I18n.t(user.isDisabled ? "disabled" : "enabled") : String(user.isDisabled),
          readOnly: isSelf,
          options: [
            { value: "false", label: I18n.t("enabled") },
            { value: "true", label: I18n.t("disabled") },
          ],
          hint: I18n.t(isSelf ? "SELF_DISABLE_FORBIDDEN" : "userStatusHint"),
        },
        {
          group: "userSecurity",
          key: "newPassword",
          name: "password",
          type: "password",
          hint: I18n.t("userPasswordHint"),
          validator: (value) => value && (value.length < 6 || value.length > 256) ? I18n.t("passwordError") : "",
        },
        ...UI.quotaFields(user.quota),
        { group: "userAudit", key: "created", name: "createTime", value: UI.date(user.createTime), readOnly: true, className: "num" },
        { key: "userUpdated", name: "updateTime", value: UI.date(user.updateTime), readOnly: true, className: "num" },
      ],
      (values) => {
        const body = { ...UI.quotaPayload(values), id: user.id, userName: values.userName, nickname: values.nickname, role: values.role, isDisabled: isSelf ? user.isDisabled : values.isDisabled === "true" };
        if (values.password) body.password = values.password;
        return API("user", { method: "PATCH", body });
      },
      { dirty: true, intro: I18n.t("userEditHint") },
    );
    const dialog = document.activeElement?.closest("dialog");
    const result = await pending;
    if (result) await load(() => {
      if (document.activeElement !== trigger && !dialog?.contains(document.activeElement)) return null;
      return () => {
        const current = Array.from($("#user-cards").children).find((item) => item.getAttribute("data-id") === user.id);
        (current?.querySelector("footer button") || $("#user-query")).focus();
      };
    });
  }
  async function deleteUser(user) {
    const cards = Array.from($("#user-cards").children);
    const index = cards.findIndex((card) => card.getAttribute("data-id") === user.id);
    const card = cards[index];
    const neighbors = [...cards.slice(index + 1), ...cards.slice(0, index).reverse()].map((item) => item.getAttribute("data-id"));
    const summary = card?.querySelector("summary");
    if (card?.contains(document.activeElement)) {
      summary?.focus();
      summary?.parentElement.removeAttribute("open");
    }
    if (!(await UI.confirm(I18n.t("deleteAccountConfirm", { name: user.nickname })))) return;
    const dialog = document.activeElement?.closest("dialog");
    try {
      await API("user", { method: "DELETE", query: { id: user.id } });
      await load(() => {
        if (!card?.contains(document.activeElement) && !dialog?.contains(document.activeElement)) return null;
        return () => {
          const current = Array.from($("#user-cards").children);
          const next = neighbors.map((id) => current.find((item) => item.getAttribute("data-id") === id)).find(Boolean) || current[Math.min(index, current.length - 1)];
          (next?.querySelector("summary,button,a[href]") || $("#user-query")).focus();
        };
      });
      if (bridge.embedded) await bridge.request("workspace.changed", {});
      toast(I18n.t("accountDeleted"), { kind: "success" });
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    }
  }
  async function toggleUser(user) {
    const card = Array.from($("#user-cards").children).find((item) => item.getAttribute("data-id") === user.id);
    const trigger = card?.querySelector("details button");
    const summary = card?.querySelector("summary");
    if (document.activeElement === trigger) summary?.focus();
    if (
      !user.isDisabled &&
      !(await UI.confirm(
        I18n.t("disableAccountConfirm", { name: user.nickname }),
      ))
    )
      return;
    const dialog = document.activeElement?.closest("dialog");
    try {
      const updated = await API("user", {
        method: "PATCH",
        body: { id: user.id, isDisabled: !user.isDisabled },
      });
      const restoreFocus = document.activeElement === trigger || document.activeElement === summary || dialog?.contains(document.activeElement);
      users = users.map((item) => (item.id === updated.id ? updated : item));
      render();
      if (restoreFocus) {
        const current = Array.from($("#user-cards").children).find((item) => item.getAttribute("data-id") === user.id);
        const action = current?.querySelector("details button");
        if (action) action.closest("details").setAttribute("open", "");
        (action || current?.querySelector("summary,button,a[href]") || $("#user-query")).focus();
      }
      toast(I18n.t("success"), { kind: "success" });
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    }
  }
  async function load(beforeRender) {
    controller?.abort();
    controller = new AbortController();
    const current = ++requestId;
    $("#user-status").textContent = I18n.t("loading");
    $("#user-status").classList.remove("error");
    $("#user-cards").setAttribute("aria-busy", "true");
    pager.busy(true);
    try {
      const [self, list] = await Promise.all([
        API("me", { signal: controller.signal }),
        API("users", { signal: controller.signal }),
      ]);
      if (current !== requestId) return;
      me = self;
      users = list;
      const restoreFocus = typeof beforeRender === "function" ? beforeRender() : null;
      render();
      restoreFocus?.();
      $("#user-status").textContent = "";
    } catch (e) {
      if (e.name === "AbortError") return;
      $("#user-status").classList.add("error");
      $("#user-status").textContent = errorText(e);
      $("#user-status").append(button("retry", load));
    } finally {
      if (current === requestId) {
        pager.busy(false);
        $("#user-cards").setAttribute("aria-busy", "false");
      }
    }
  }
  $("#user-search").addEventListener("submit", (event) => {
    event.preventDefault();
    query = $("#user-query").value;
    pager.reset();
    render();
  });
  I18n.subscribe(render);
  await bridge.ready;
  await load();
})();
