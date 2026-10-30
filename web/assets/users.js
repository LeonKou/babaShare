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
    return ["viewer", "editor", "admin"].map((value) => ({
      value,
      label: I18n.t(value),
    }));
  }
  function render() {
    const filtered = users.filter((user) =>
      (user.nickname + " " + user.userName)
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
    $("#user-cards").replaceChildren(
      ...pager.slice(filtered).map((user) =>
        el(
          "article",
          { class: "card" },
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
          el("p", { class: "muted", text: user.userName }),
          el("p", {
            class: "small muted num",
            text: I18n.t("created") + ": " + UI.date(user.createTime),
          }),
          el(
            "footer",
            {},
            button("edit", () => editUser(user)),
            button(
              user.isDisabled ? "enableUser" : "disableUser",
              () => toggleUser(user),
              user.isDisabled ? "" : "danger",
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
            v.length < 10 || v.length > 256 ? I18n.t("passwordError") : "",
        },
        { key: "role", name: "role", value: "viewer", options: roles() },
      ],
      (values) => API("user", { method: "POST", body: values }),
      { saveKey: "create" },
    );
    if (result) await load();
  }
  async function editUser(user) {
    const result = await formDialog(
      I18n.t("edit") + " · " + user.nickname,
      [
        {
          key: "displayName",
          name: "nickname",
          required: true,
          value: user.nickname,
        },
        { key: "role", name: "role", value: user.role, options: roles() },
      ],
      (values) =>
        API("user", { method: "PATCH", body: { id: user.id, ...values } }),
    );
    if (result) await load();
  }
  async function toggleUser(user) {
    if (
      !user.isDisabled &&
      !(await UI.confirm(
        I18n.t("disableAccountConfirm", { name: user.nickname }),
      ))
    )
      return;
    try {
      const updated = await API("user", {
        method: "PATCH",
        body: { id: user.id, isDisabled: !user.isDisabled },
      });
      users = users.map((item) => (item.id === updated.id ? updated : item));
      render();
      toast(I18n.t("success"));
    } catch (e) {
      toast(errorText(e));
    }
  }
  async function load() {
    controller?.abort();
    controller = new AbortController();
    const current = ++requestId;
    $("#user-status").textContent = I18n.t("loading");
    $("#user-status").classList.remove("error");
    $("#user-cards").setAttribute("aria-busy", "true");
    pager.busy(true);
    try {
      const [self, list, settings] = await Promise.all([
        API("me", { signal: controller.signal }),
        API("users", { signal: controller.signal }),
        API("settings", { signal: controller.signal }),
      ]);
      if (current !== requestId) return;
      me = self;
      users = list;
      $("#registration-toggle").checked = settings.registrationEnabled;
      render();
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
  $("#registration-toggle").addEventListener("change", async (event) => {
    const checkbox = event.target;
    checkbox.disabled = true;
    try {
      await API("setting", {
        method: "PATCH",
        body: { registrationEnabled: checkbox.checked },
      });
      toast(I18n.t("registrationSaved"));
    } catch (e) {
      checkbox.checked = !checkbox.checked;
      toast(errorText(e));
    } finally {
      checkbox.disabled = false;
    }
  });
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
