(async () => {
  "use strict";
  const { $, el, button, toast, errorText, formDialog } = UI;
  const bridge = UI.page();
  const form = $("#admin-search");
  const keys = ["userId", "relation", "ownerStatus", "search", "creator"];
  let users = [], rows = [], filters = {}, controller, requestId = 0;
  const pager = LocalPager($("#admin-pagination"), load, { remote: true });
  function renderUsers(value = $("#admin-user").value) {
    $("#admin-user").replaceChildren(
      el("option", { value: "", text: I18n.t("allUsers") }),
      ...users.map((user) => el("option", { value: user.id, text: `${user.nickname} (${user.userName})` })),
    );
    $("#admin-user").value = value;
  }
  function renderFilterSummary() {
    const applied = [];
    const add = (key, value) => applied.push(el("span", {},
      document.createTextNode(`${I18n.t(key)}: `), el("bdi", { text: value }),
    ));
    if (filters.userId) {
      const user = users.find((item) => item.id === filters.userId);
      add("userAssociation", user ? `${user.nickname} (${user.userName})` : filters.userId);
    }
    if (filters.relation && filters.relation !== "any")
      add("associationType", I18n.t(filters.relation === "owner" ? "associationOwner" : "associationMember"));
    if (filters.ownerStatus && filters.ownerStatus !== "all")
      add("ownerStatus", I18n.t(filters.ownerStatus === "system" ? "systemCustody" : "accountOwned"));
    if (filters.search) add("workspaceSearch", filters.search);
    if (filters.creator) add("creatorSearch", filters.creator);
    $("#admin-filter-summary").replaceChildren(
      document.createTextNode(I18n.t(applied.length ? "appliedFilters" : "noAppliedFilters", { count: applied.length })),
      ...applied.flatMap((item) => [document.createTextNode(" · "), item]),
    );
  }
  function openLink(row) {
    return el("a", {
      href: UI.routeUrl("workspace", { workspaceId: row.id }),
      text: I18n.t("openWorkspace"),
      onclick: (event) => {
        if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        bridge.request("shell.navigate", { routeId: "workspace", params: { workspaceId: row.id } })
          .catch((e) => toast(errorText(e), { kind: "error" }));
      },
    });
  }
  function render() {
    renderUsers();
    renderFilterSummary();
    document.title = `${I18n.t("workspace-admin")} · babaShare`;
    $("#admin-cards").replaceChildren(...rows.map((row) => el("article", { class: "card", "data-id": row.id },
      el("header", {}, el("h2", { text: row.workspaceName }), el("span", { class: "badge", text: I18n.t(row.owner ? "accountOwned" : "systemCustody") })),
      el("p", { text: `${I18n.t("owner")}: ${row.owner ? row.owner.nickname + " (" + row.owner.userName + ")" : I18n.t("systemCustody")}` }),
      el("p", { class: "muted", text: `${I18n.t("originalCreator")}: ${row.creatorNickname || I18n.t("unknownCreator")}` }),
      el("details", {},
        el("summary", { text: `${I18n.t("workspaceMembers")} · ${I18n.t("memberSummary", { total: row.memberCount, collaborators: row.collaboratorCount })}` }),
        row.members.length ? el("ul", {}, ...row.members.map((member) => el("li", {},
          el("bdi", { text: member.nickname }),
          document.createTextNode(` · ${I18n.t(member.isOwner ? "owner" : "memberRole_" + member.memberRole)}${member.isDisabled ? " · " + I18n.t("disabled") : ""}`),
        ))) : el("p", { class: "muted", text: I18n.t("noWorkspaceMembers") }),
      ),
      el("footer", {}, openLink(row), button("transferWorkspace", () => transfer(row))),
    )));
    $("#admin-empty").hidden = rows.length > 0;
    if (!rows.length) $("#admin-empty").replaceChildren(UI.empty("emptyManagedSpaces", "managedSpaceEmptyHint"));
  }
  async function transfer(row) {
    const card = Array.from($("#admin-cards").children).find((item) => item.getAttribute("data-id") === row.id);
    const available = (await API("users")).filter((user) => !user.isDisabled && ["editor", "admin"].includes(user.role) && user.id !== row.ownerId);
    if (!available.length) { toast(I18n.t("noTransferRecipient")); return; }
    let dialog;
    const result = await formDialog(I18n.t("transferWorkspace") + " · " + row.workspaceName, [
      { key: "recipient", name: "ownerId", required: true, options: available.map((user) => ({ value: user.id, label: `${user.nickname} (${user.userName})` })) },
    ], (values) => {
      dialog = document.activeElement?.closest("dialog");
      return API("workspaceOwnership", { method: "PATCH", body: { id: row.id, ownerId: values.ownerId } });
    },
    { intro: I18n.t("transferHint"), dirty: true });
    if (result) {
      await load(() => {
        if (!card?.contains(document.activeElement) && !dialog?.contains(document.activeElement)) return null;
        return () => {
          const next = Array.from($("#admin-cards").children).find((item) => item.getAttribute("data-id") === row.id);
          (next?.querySelector("footer button") || $("#admin-filters").querySelector("summary")).focus();
        };
      });
      if (bridge.embedded) await bridge.request("workspace.changed", {});
      toast(I18n.t("success"), { kind: "success" });
    }
  }
  async function load(beforeRender) {
    controller?.abort();
    controller = new AbortController();
    const current = ++requestId;
    UI.loading($("#admin-status"));
    $("#admin-status").classList.remove("error");
    $("#admin-cards").setAttribute("aria-busy", "true");
    form.querySelector('button[type="submit"]').disabled = true;
    pager.busy(true);
    try {
      const page = await API("workspaceAdmin", { signal: controller.signal, query: { ...filters, pageIndex: pager.pageIndex, pageSize: pager.pageSize } });
      if (current !== requestId) return;
      if (!pager.accept(page)) { await load(beforeRender); return; }
      rows = page.data;
      const restoreFocus = typeof beforeRender === "function" ? beforeRender() : null;
      render();
      restoreFocus?.();
      $("#admin-status").textContent = "";
    } catch (e) {
      if (current !== requestId || e.name === "AbortError") return;
      bridge.fail(e);
      $("#admin-empty").hidden = true;
      $("#admin-status").classList.add("error");
      $("#admin-status").textContent = errorText(e);
      $("#admin-status").append(button("retry", load));
    } finally {
      if (current === requestId) {
        pager.busy(false);
        form.querySelector('button[type="submit"]').disabled = false;
        $("#admin-cards").setAttribute("aria-busy", "false");
      }
    }
  }
  function applyFilters() {
    const url = new URL(location.href);
    for (const key of keys) {
      const fallback = key === "relation" ? "any" : key === "ownerStatus" ? "all" : "";
      if (filters[key] && filters[key] !== fallback) url.searchParams.set(key, filters[key]);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, "", url);
    renderFilterSummary();
    pager.reset();
    load();
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    filters = Object.fromEntries(new FormData(form));
    applyFilters();
  });
  $("#admin-reset").addEventListener("click", () => {
    for (const key of keys) form.elements.namedItem(key).value = key === "relation" ? "any" : key === "ownerStatus" ? "all" : "";
    filters = Object.fromEntries(new FormData(form));
    applyFilters();
  });
  function restoreFilters() {
    const url = new URL(location.href);
    filters = {};
    for (const key of keys) {
      const fallback = key === "relation" ? "any" : key === "ownerStatus" ? "all" : "";
      const value = url.searchParams.get(key) ?? fallback;
      filters[key] = value;
      form.elements.namedItem(key).value = value;
    }
    renderFilterSummary();
  }
  restoreFilters();
  window.addEventListener("popstate", () => { restoreFilters(); load(); });
  I18n.subscribe(render);
  await bridge.ready;
  try {
    users = await API("users");
    renderUsers(filters.userId || "");
    await load();
  } catch (e) {
    form.hidden = true;
    $("#admin-status").textContent = errorText(e);
    $("#admin-status").classList.add("error");
    bridge.fail(e);
  } finally { await bridge.complete(); }
})();
