(async () => {
  "use strict";
  const { $, el, button, toast, errorText } = UI;
  const bridge = UI.page();
  const sections = ["profile", "keys", "shares"];
  const tabs = sections.map((section) => $("#account-tab-" + section));
  const panels = sections.map((section) => $("#account-panel-" + section));
  function selectTab(section, { focus = false, persist = false } = {}) {
    const selected = sections.includes(section) ? section : "profile";
    sections.forEach((name, index) => {
      const active = name === selected;
      tabs[index].setAttribute("aria-selected", String(active));
      tabs[index].setAttribute("tabindex", active ? "0" : "-1");
      panels[index].hidden = !active;
      if (active && focus) tabs[index].focus();
    });
    if (persist) {
      const url = new URL(location.href);
      url.searchParams.set("accountTab", selected);
      history.replaceState(history.state, "", url);
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(sections[index], { persist: true }));
    tab.addEventListener("keydown", (event) => {
      let next;
      const direction = { ltr: 1, rtl: -1 }[I18n.ctx.dir];
      if (event.key === "ArrowRight") next = (index + direction + tabs.length) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - direction + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(sections[next], { focus: true, persist: true });
    });
  });
  const readTab = () => new URL(location.href).searchParams.get("accountTab");
  selectTab(readTab());
  window.addEventListener("popstate", () => {
    const section = readTab();
    const selected = sections.includes(section) ? section : "profile";
    const focus = document.activeElement && (tabs.includes(document.activeElement) ||
      panels.some((panel, index) => sections[index] !== selected && panel.contains(document.activeElement)));
    selectTab(selected, { focus });
  });
  let me = null,
    shares = [],
    workspaces = [],
    controller = null,
    requestId = 0;
  const pager = LocalPager($("#share-pagination"), render);
  function render() {
    if (me)
      $("#profile-summary").replaceChildren(
        el("span", {
          class: "avatar large",
          text: me.nickname.slice(0, 1).toUpperCase(),
        }),
        el(
          "div",
          {},
          el("h3", { text: me.nickname }),
          el("p", { class: "muted small", text: me.userName }),
          el(
            "div",
            { class: "row small" },
            el("span", { class: "badge", text: I18n.t(me.role) }),
            el("span", {
              class: "muted num",
              text: I18n.t("joinSince") + ": " + UI.date(me.createTime),
            }),
          ),
        ),
      );
    const visible = pager.slice(shares);
    $("#share-cards").replaceChildren(
      ...visible.map((share) => {
        const workspace = workspaces.find((w) => w.id === share.workspaceId);
        const name =
          share.path.split("/").filter(Boolean).pop() ||
          workspace?.workspaceName ||
          I18n.t("folder");
        const expired = share.expireTime && share.expireTime <= Date.now();
        const link = el("a", {
          href: share.shareUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          text: name,
        });
        return el(
          "article",
          { class: "card" },
          el(
            "header",
            {},
            el("h3", {}, link),
            el("span", {
              class: "badge",
              text: I18n.t(expired ? "expired" : "active"),
            }),
          ),
          el("p", {
            class: "small muted",
            text:
              (workspace?.workspaceName || I18n.t("workspace")) +
              " / " +
              (share.path || I18n.t("allFiles")),
          }),
          el("p", {
            class: "small muted num",
            text: I18n.t("expires") + ": " + UI.date(share.expireTime),
          }),
          el("p", {
            class: "small muted num",
            text: I18n.t("created") + ": " + UI.date(share.createTime),
          }),
          el(
            "footer",
            {},
            UI.copyButton("copyLink", () => UI.copy(share.shareUrl), "", "link"),
            button("delete", () => deleteShare(share), "danger"),
          ),
        );
      }),
    );
    $("#share-empty").hidden = shares.length > 0;
    if (!shares.length)
      $("#share-empty").replaceChildren(UI.empty("noShares", "noSharesHint"));
    document.title = `${I18n.t("account")} · babaShare`;
  }
  async function deleteShare(share) {
    if (!(await UI.confirm(I18n.t("shareDeleteConfirm")))) return;
    try {
      await API("share", { method: "DELETE", query: { id: share.id } });
      shares = shares.filter((s) => s.id !== share.id);
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
    $("#account-status").classList.remove("error");
    $("#account-status").textContent = I18n.t("loading");
    $("#profile-summary").setAttribute("aria-busy", "true");
    $("#share-cards").setAttribute("aria-busy", "true");
    pager.busy(true);
    try {
      const data = await Promise.all([
        API("me", { signal: controller.signal }),
        API("shares", { signal: controller.signal }),
        API("workspaces", { signal: controller.signal }),
      ]);
      if (current !== requestId) return;
      [me, shares, workspaces] = data;
      render();
      $("#account-status").textContent = "";
    } catch (e) {
      if (e.name === "AbortError") return;
      $("#account-status").classList.add("error");
      $("#account-status").textContent = errorText(e);
      $("#account-status").append(button("retry", load));
    } finally {
      if (current === requestId) {
        pager.busy(false);
        $("#profile-summary").setAttribute("aria-busy", "false");
        $("#share-cards").setAttribute("aria-busy", "false");
      }
    }
  }
  let keys = [], keyBusy = false, keysLoaded = false, keyController = null, keyRequest = 0;
  const keyPager = (() => {
    let pageIndex = 1, pageSize = 10, busy = false;
    const read = () => {
      const params = new URL(location.href).searchParams;
      pageIndex = Math.max(1, Math.floor(Number(params.get("mcpPageIndex")) || 1));
      pageSize = [10, 20, 50].includes(Number(params.get("mcpPageSize"))) ? Number(params.get("mcpPageSize")) : 10;
      const filter = params.get("mcpStatus");
      $("#mcp-filter").value = ["active", "expired", "revoked"].includes(filter) ? filter : "all";
    };
    const write = () => {
      const url = new URL(location.href);
      url.searchParams.set("mcpPageIndex", pageIndex);
      url.searchParams.set("mcpPageSize", pageSize);
      url.searchParams.set("mcpStatus", $("#mcp-filter").value);
      history.replaceState(null, "", url);
    };
    read();
    window.addEventListener("popstate", () => { read(); renderKeys(); });
    return {
      slice(items) {
        const pages = Math.max(1, Math.ceil(items.length / pageSize));
        const previousIndex = pageIndex;
        if (keysLoaded) pageIndex = Math.min(pageIndex, pages);
        if (previousIndex !== pageIndex && keysLoaded) write();
        const previous = button("previous", () => { pageIndex--; write(); renderKeys(); });
        const next = button("next", () => { pageIndex++; write(); renderKeys(); });
        previous.disabled = busy || pageIndex <= 1;
        next.disabled = busy || pageIndex >= pages;
        const select = el("select", { "aria-label": I18n.t("pageSize"), disabled: busy ? "" : null });
        for (const size of [10, 20, 50])
          select.append(el("option", { value: size, text: size, selected: size === pageSize ? "" : null }));
        select.addEventListener("change", () => { pageSize = Number(select.value); pageIndex = 1; write(); renderKeys(); });
        $("#mcp-pagination").replaceChildren(
          el("div", { class: "row" }, el("span", { text: I18n.t("items", { total: items.length }) }),
            el("label", { class: "row" }, I18n.t("pageSize"), select)),
          el("div", { class: "row" }, previous,
            el("bdi", { class: "num", dir: "ltr", "aria-current": "page", text: I18n.t("page", { page: pageIndex, pages }) }), next));
        $("#mcp-pagination").setAttribute("aria-busy", String(busy));
        return items.slice((pageIndex - 1) * pageSize, pageIndex * pageSize);
      },
      reset() { pageIndex = 1; write(); },
      busy(value) { busy = value; },
    };
  })();
  const keyState = (key) => key.revokedTime ? "revoked" :
    key.expireTime && key.expireTime <= Date.now() ? "expired" : "active";
  const keyError = (error) => ["MCP_KEY_LIMIT", "MCP_KEY_NOT_EXIST", "MCP_KEY_NOT_RECOVERABLE", "MCP_KEY_INACTIVE", "MCP_KEY_RECOVERY_UNAVAILABLE", "mcpUnavailable", "KEY_ALREADY_CREATED", "REQUEST_CONFLICT"].includes(error?.status)
    ? I18n.t(error.status) : errorText(error);
  function renderKeys() {
    const activeCount = keys.filter((key) => keyState(key) === "active").length;
    $("#mcp-limit").textContent = I18n.t("mcpLimit", { count: activeCount });
    $("#mcp-create").disabled = keyBusy || !keysLoaded || activeCount >= 10;
    $("#mcp-filter").disabled = keyBusy;
    const filter = $("#mcp-filter").value;
    const selected = keys.filter((key) => filter === "all" || keyState(key) === filter);
    $("#mcp-cards").replaceChildren(...keyPager.slice(selected).map((key) => {
      const status = keyState(key);
      const deleteButton = button("delete", () => deleteKey(key), "danger");
      deleteButton.disabled = keyBusy;
      const copyButton = UI.copyButton("mcpCopyUse", () => {
        if (keyBusy || keyState(key) !== "active") return false;
        return McpHelp.copyUse(key.id);
      }, "primary", null, { errorMessage: keyError,
        isDisabled: () => keyBusy || keyState(key) !== "active" });
      copyButton.disabled = keyBusy || status !== "active";
      copyButton.setAttribute("aria-describedby", "mcp-privacy-" + key.id);
      return el("article", { class: "card" },
        el("header", {}, el("h3", { text: key.keyName, dir: "auto" }),
          el("span", { class: "badge", text: I18n.t(status) })),
        el("code", { dir: "ltr", text: key.keyPrefix + "••••••••" }),
        el("p", { class: "small muted" }, I18n.t("created") + ": ",
          el("bdi", { class: "num", dir: "ltr", text: UI.date(key.createTime) })),
        el("p", { class: "small muted" }, I18n.t("expires") + ": ",
          el("bdi", { class: "num", dir: "ltr", text: UI.date(key.expireTime) })),
        key.revokedTime ? el("p", { class: "small muted" }, I18n.t("revoked") + ": ",
          el("bdi", { class: "num", dir: "ltr", text: UI.date(key.revokedTime) })) : null,
        el("p", { id: "mcp-privacy-" + key.id, class: "form-note", text: I18n.t("mcpCopyPrivacy") }),
        status !== "active" ? el("p", { class: "form-note", text: I18n.t("MCP_KEY_INACTIVE") }) : null,
        el("footer", {}, deleteButton, copyButton),
      );
    }));
    $("#mcp-empty").hidden = selected.length > 0 || !keysLoaded;
    if (!selected.length && keysLoaded)
      $("#mcp-empty").replaceChildren(UI.empty("mcpNoKeys", "mcpNoKeysHint"));
  }
  async function loadKeys() {
    keyController?.abort();
    keyController = new AbortController();
    const current = ++keyRequest;
    keyBusy = true;
    $("#mcp-status").classList.remove("error");
    $("#mcp-status").replaceChildren(I18n.t("loading"));
    $("#mcp-cards").setAttribute("aria-busy", "true");
    keyPager.busy(true);
    renderKeys();
    try {
      const result = await API("mcpKeys", { signal: keyController.signal });
      if (current !== keyRequest) return;
      keys = result;
      keysLoaded = true;
      $("#mcp-status").replaceChildren();
    } catch (error) {
      if (error.name === "AbortError" || current !== keyRequest) return;
      $("#mcp-status").classList.add("error");
      $("#mcp-status").replaceChildren(keyError(error), button("retry", loadKeys));
    } finally {
      if (current === keyRequest) {
        keyBusy = false;
        keyPager.busy(false);
        $("#mcp-cards").setAttribute("aria-busy", "false");
        renderKeys();
      }
    }
  }
  async function deleteKey(key) {
    if (keyBusy || !(await UI.confirm(I18n.t("mcpDeleteConfirm", { name: key.keyName })))) return;
    keyBusy = true;
    renderKeys();
    try {
      await API("mcpKey", { method: "DELETE", query: { id: key.id } });
      keys = keys.filter((item) => item.id !== key.id);
      renderKeys();
      await loadKeys();
      toast(I18n.t("success"));
    } catch (error) {
      toast(keyError(error));
    } finally {
      keyBusy = false;
      renderKeys();
    }
  }
  function createKey() {
    if (keyBusy || !keysLoaded) return;
    UI.dialog(I18n.t("mcpCreate"), (node, close) => {
      const form = el("form", { novalidate: "" });
      form.append(el("p", { class: "form-note", text: I18n.t("required") }));
      const name = UI.field(form, { key: "mcpName", name: "keyName", required: true,
        hint: I18n.t("mcpNameHint"), validator: (value) => value.trim().length > 100 ? I18n.t("mcpNameError") : "" });
      name.maxLength = 100;
      const expiry = UI.field(form, { key: "mcpLifetime", name: "expiry", value: "720", options: [
        { value: "24", label: I18n.t("day1") },
        { value: "168", label: I18n.t("day7") },
        { value: "720", label: I18n.t("day30") },
        { value: "forever", label: I18n.t("forever") },
        { value: "custom", label: I18n.t("mcpCustom") },
      ] });
      const hours = UI.field(form, { key: "mcpCustomHours", name: "expireHours", type: "number",
        hint: I18n.t("mcpCustomHint"), validator: (value) => expiry.value === "custom" &&
          (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 87600)
          ? I18n.t("mcpDateError") : "" });
      hours.min = "1";
      hours.max = "87600";
      hours.step = "1";
      hours.disabled = true;
      hours.closest(".field").hidden = true;
      expiry.addEventListener("change", () => {
        hours.disabled = expiry.value !== "custom";
        hours.required = !hours.disabled;
        hours.setAttribute("aria-required", String(!hours.disabled));
        hours.closest(".field").hidden = hours.disabled;
        if (!hours.disabled) hours.focus();
      });
      const state = el("div", { class: "status-line", role: "status", "aria-live": "polite" });
      const save = button("mcpCreate", () => {}, "primary");
      save.type = "submit";
      const cancel = button("cancel", () => close(null));
      form.append(state, el("div", { class: "actions" }, cancel, save));
      const random = new Uint8Array(24);
      crypto.getRandomValues(random);
      let requestId = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
      let submitting = false, attempted = null;
      node.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submitting || !UI.validate(form)) return;
        const expireHours = expiry.value === "forever" ? null :
          Number(expiry.value === "custom" ? hours.value : expiry.value);
        const body = { keyName: name.value.trim(), expireHours, requestId };
        const fingerprint = JSON.stringify([body.keyName, expireHours]);
        if (attempted && attempted !== fingerprint) {
          crypto.getRandomValues(random);
          requestId = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
          body.requestId = requestId;
        }
        attempted = fingerprint;
        submitting = true;
        keyBusy = true;
        save.disabled = cancel.disabled = true;
        state.classList.remove("error");
        state.textContent = I18n.t("creating");
        form.setAttribute("aria-busy", "true");
        renderKeys();
        try {
          const result = await API("mcpKey", { method: "POST", body });
          close(null);
          const keyId = result.id;
          delete result.key;
          keys.unshift(result);
          await McpHelp.showCreated(keyId, (error) => toast(keyError(error)));
          await loadKeys();
        } catch (error) {
          state.classList.add("error");
          state.textContent = keyError(error);
          if (error.status === "KEY_ALREADY_CREATED" || error.status === "MCP_KEY_LIMIT")
            await loadKeys();
        } finally {
          submitting = false;
          keyBusy = false;
          save.disabled = cancel.disabled = false;
          form.setAttribute("aria-busy", "false");
          renderKeys();
        }
      });
      node.append(form);
    });
  }
  $("#mcp-create").addEventListener("click", createKey);
  $("#mcp-filter").addEventListener("change", () => { keyPager.reset(); renderKeys(); });
  I18n.subscribe(() => { render(); renderKeys(); });
  await bridge.ready;
  await Promise.all([load(), loadKeys()]);
})();
