(async () => {
  "use strict";
  const { $, el, button, icon, toast, formDialog, errorText } = UI;
  const page = UI.page();
  let me = null,
    workspaces = [],
    workspace = null,
    members = [],
    entries = [],
    path = "",
    requestId = 0,
    controller = null,
    query = "",
    sort = "name",
    ascending = true,
    uploading = false,
    alwaysOverwrite = false;
  const pager = LocalPager($("#file-pagination"), loadFiles, { remote: true });
  const isHtml = (name) => /\.html?$/i.test(name);
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const parentPath = (value) =>
    value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";
  function notifyChanged() {
    page.request("workspace.changed", {}).catch((e) => {
      if (page.embedded) console.error(e);
    });
  }
  function updateUrl() {
    const url = new URL(location.href);
    if (workspace) url.searchParams.set("workspaceId", workspace.id);
    else url.searchParams.delete("workspaceId");
    url.searchParams.set("path", path);
    query
      ? url.searchParams.set("search", query)
      : url.searchParams.delete("search");
    url.searchParams.set("sort", sort);
    url.searchParams.set("order", ascending ? "asc" : "desc");
    history.replaceState(null, "", url);
  }
  function readUrl() {
    const u = new URL(location.href);
    path = u.searchParams.get("path") || "";
    query = u.searchParams.get("search") || "";
    sort = ["name", "size", "updateTime"].includes(u.searchParams.get("sort"))
      ? u.searchParams.get("sort")
      : "name";
    ascending = u.searchParams.get("order") !== "desc";
    $("#search-input").value = query;
  }
  async function openFolder(next) {
    path = next;
    pager.reset();
    updateUrl();
    await loadFiles();
  }
  function crumbs() {
    const ol = el("ol");
    ol.append(
      el(
        "li",
        {},
        buttonText(I18n.t("workspaces"), () => {
          workspace = null;
          alwaysOverwrite = false;
          path = "";
          renderChrome();
          updateUrl();
        }),
      ),
    );
    if (!workspace) {
      ol.lastChild.replaceChildren(
        document.createTextNode(I18n.t("workspaces")),
      );
      ol.lastChild.setAttribute("aria-current", "page");
    } else {
      const parts = path ? path.split("/") : [];
      const chain = [
        { name: workspace.workspaceName, path: "" },
        ...parts.map((name, index) => ({
          name,
          path: parts.slice(0, index + 1).join("/"),
        })),
      ];
      if (chain.length > 5) {
        const details = el("details"),
          summary = el("summary", { text: "…" });
        details.append(
          summary,
          ...chain
            .slice(0, -3)
            .map((c) => buttonText(c.name, () => openFolder(c.path))),
        );
        ol.append(el("li", {}, details));
        chain.splice(0, chain.length - 3);
      }
      chain.forEach((c, index) => {
        const li = el("li");
        if (index === chain.length - 1) {
          li.textContent = c.name;
          li.setAttribute("aria-current", "page");
        } else li.append(buttonText(c.name, () => openFolder(c.path)));
        ol.append(li);
      });
    }
    $("#breadcrumbs").replaceChildren(ol);
  }
  function buttonText(text, action, cls = "ghost") {
    return el("button", { type: "button", class: cls, text, onclick: action });
  }
  async function createWorkspace() {
    const result = await formDialog(
      I18n.t("newWorkspace"),
      [{ key: "workspaceName", required: true }],
      (v) => API("workspace", { method: "POST", body: v }),
      { saveKey: "create" },
    );
    if (result) {
      workspaces = await API("workspaces");
      notifyChanged();
      await selectWorkspace(result.id);
    }
  }
  async function selectWorkspace(id) {
    if (workspace?.id !== id) alwaysOverwrite = false;
    workspace = workspaces.find((w) => w.id === id) || null;
    path = "";
    pager.reset();
    renderChrome();
    updateUrl();
    if (workspace) await Promise.all([loadFiles(), loadMembers()]);
  }
  function renderChrome() {
    crumbs();
    const picking = !workspace;
    $("#workspace-picker").hidden = !picking;
    $("#file-browser").hidden = picking;
    $("#members-panel").hidden = picking;
    $("#workspace-layout").style.gridTemplateColumns = !picking
      ? ""
      : "minmax(0,1fr)";
    $("#workspace-title").textContent = workspace
      ? path.split("/").filter(Boolean).pop() || workspace.workspaceName
      : I18n.t("workspaces");
    $("#workspace-subtitle").textContent = workspace
      ? workspace.canWrite
        ? workspace.description || I18n.t("workspaceHint")
        : I18n.t("viewOnlyHint")
      : I18n.t("workspaceHint");
    $("#workspace-role").hidden = picking;
    if (workspace)
      $("#workspace-role").textContent = I18n.t(
        workspace.ownerId === me?.id
          ? "owner"
          : workspace.canWrite
            ? "editor"
            : "viewer",
      );
    $("#workspace-head-actions").replaceChildren();
    if (picking && me?.role !== "viewer")
      $("#workspace-head-actions").append(
        button("newWorkspace", createWorkspace, "primary", "plus"),
      );
    if (workspace?.canWrite)
      $("#workspace-head-actions").append(
        button("share", shareFolder, "primary", "share"),
      );
    $("#file-actions").replaceChildren();
    if (workspace?.canWrite)
      $("#file-actions").append(
        button("newFolder", newFolder, "", "plus"),
        button("newHtml", newHtml, "", "code"),
        uploadMenu(),
      );
    $("#drop-zone").hidden = !workspace?.canWrite;
    $("#workspace-cards").replaceChildren(
      ...workspaces.map((w) =>
        el(
          "article",
          { class: "card" },
          el(
            "header",
            {},
            el("h2", { text: w.workspaceName }),
            el("span", {
              class: "badge",
              text: I18n.t(w.canWrite ? "editor" : "viewer"),
            }),
          ),
          el("p", {
            class: "muted",
            text: w.description || I18n.t("workspaceHint"),
          }),
          el("p", { class: "small muted num", text: UI.date(w.createTime) }),
          el(
            "footer",
            {},
            button("openWorkspace", () => selectWorkspace(w.id)),
          ),
        ),
      ),
    );
    if (picking && !workspaces.length)
      $("#workspace-cards").append(
        UI.empty(
          "emptyWorkspaces",
          "emptyWorkspacesHint",
          me?.role !== "viewer"
            ? button("newWorkspace", createWorkspace, "primary")
            : null,
        ),
      );
    renderMembers();
  }
  function uploadMenu() {
    const details = el("details", { class: "upload-menu" });
    const overwrite = el("input", { type: "checkbox", id: "upload-always-overwrite" });
    overwrite.checked = alwaysOverwrite;
    overwrite.addEventListener("change", () => { alwaysOverwrite = overwrite.checked; });
    details.append(
      el("summary", { "aria-label": I18n.t("upload"), text: I18n.t("upload") }),
      el(
        "div",
        { class: "menu-popover" },
        button(
          "upload",
          () => {
            $("#upload-input").click();
            details.open = false;
          },
          "",
          "upload",
        ),
        button(
          "uploadFolder",
          () => {
            $("#directory-input").click();
            details.open = false;
          },
          "",
          "folder",
        ),
        el("label", { for: "upload-always-overwrite" }, overwrite,
          el("span", { text: I18n.t("uploadAlwaysOverwrite") })),
      ),
    );
    return details;
  }
  function renderFiles() {
    if (!workspace) return;
    const rows = entries;
    $("#file-list").replaceChildren(
      ...rows.map((entry) => {
        const html = isHtml(entry.name),
          folder = entry.kind === "folder";
        const name = el(
          "button",
          {
            type: "button",
            class: "name-button",
            onclick: () =>
              folder ? openFolder(entry.path) : previewFile(entry),
          },
          el(
            "span",
            { class: "filetype" },
            icon(folder ? "folder" : html ? "code" : "file"),
          ),
          el("span", { text: entry.name }),
        );
        const actions = el("div", { class: "actions" });
        if (!folder)
          actions.append(
            iconButton("preview", () => previewFile(entry), "fullscreen"),
          );
        if (entry.canWrite) {
          if (html)
            actions.append(iconButton("edit", () => editFile(entry), "edit"));
          const menu = el("details", { class: "row-menu" });
          menu.append(
            el("summary", { "aria-label": I18n.t("actions"), text: "…" }),
            el(
              "div",
              { class: "menu-popover" },
              button("rename", () => {
                menu.open = false;
                renameEntry(entry);
              }),
              button(
                "delete",
                () => {
                  menu.open = false;
                  deleteEntry(entry);
                },
                "danger",
              ),
            ),
          );
          actions.append(menu);
        }
        return el(
          "tr",
          {},
          el("td", {}, name),
          el("td", {
            class: "small muted",
            text: I18n.t(folder ? "folder" : html ? "html" : "file"),
          }),
          el("td", {
            class: "small muted num",
            text: folder ? "—" : UI.size(entry.size),
          }),
          el("td", {
            class: "small muted num",
            text: UI.date(entry.updateTime),
          }),
          el("td", {}, actions),
        );
      }),
    );
    $("#file-table-wrap").hidden = rows.length === 0;
    $("#file-empty").hidden = rows.length !== 0;
    if (!rows.length)
      $("#file-empty").replaceChildren(
        UI.empty("emptyFiles", "emptyFilesHint"),
      );
    for (const [id, key] of [
      ["sort-name", "name"],
      ["sort-size", "size"],
      ["sort-time", "updateTime"],
    ]) {
      const th = $("#" + id).parentElement;
      th.setAttribute(
        "aria-sort",
        sort === key ? (ascending ? "ascending" : "descending") : "none",
      );
    }
    crumbs();
    $("#workspace-title").textContent =
      path.split("/").filter(Boolean).pop() || workspace.workspaceName;
  }
  function iconButton(key, action, name) {
    return el(
      "button",
      {
        type: "button",
        class: "ghost",
        "aria-label": I18n.t(key),
        title: I18n.t(key),
        onclick: () =>
          Promise.resolve(action()).catch((e) => toast(errorText(e))),
      },
      icon(name),
    );
  }
  async function loadFiles() {
    if (!workspace) return;
    controller?.abort();
    controller = new AbortController();
    const current = ++requestId;
    $("#file-status").classList.remove("error");
    $("#file-status").textContent = I18n.t("loadingFiles");
    $("#file-browser").setAttribute("aria-busy", "true");
    pager.busy(true);
    try {
      const data = await API("nodes", {
        query: {
          workspaceId: workspace.id,
          path,
          pageIndex: pager.pageIndex,
          pageSize: pager.pageSize,
          search: query,
          sort,
          order: ascending ? "asc" : "desc",
        },
        signal: controller.signal,
      });
      if (current !== requestId) return;
      if (!pager.accept(data)) {
        await loadFiles();
        return;
      }
      entries = data.entries;
      renderFiles();
      $("#file-status").textContent = "";
      updateUrl();
    } catch (e) {
      if (e.name === "AbortError") return;
      if (current !== requestId) return;
      $("#file-status").textContent = errorText(e);
      $("#file-status").classList.add("error");
    } finally {
      if (current === requestId) {
        pager.busy(false);
        $("#file-browser").setAttribute("aria-busy", "false");
      }
    }
  }
  async function loadMembers() {
    if (!workspace) return;
    try {
      members = await API("members", { query: { workspaceId: workspace.id } });
      renderMembers();
    } catch (e) {
      toast(errorText(e));
    }
  }
  function renderMembers() {
    $("#member-list").replaceChildren();
    if (!workspace) return;
    $("#member-count").textContent = String(members.length);
    for (const member of members)
      $("#member-list").append(memberRow(member, member.isOwner));
    $("#member-actions").replaceChildren();
    if (workspace.canManage && workspace.canWrite)
      $("#member-actions").append(button("invite", inviteMember, "", "plus"));
  }
  function memberRow(member, isOwner) {
    const row = el(
      "li",
      {},
      el("span", {
        class: "avatar",
        text: member.nickname.slice(0, 1).toUpperCase(),
      }),
      el(
        "div",
        { class: "member-info" },
        el("strong", { text: member.nickname }),
        el("small", {
          text: I18n.t(
            isOwner
              ? "owner"
              : member.role === "viewer"
                ? "viewer"
                : member.collaborate
                  ? "editor"
                  : "noCollaborate",
          ),
        }),
      ),
    );
    if (!isOwner && workspace.canManage && workspace.canWrite) {
      const details = el("details", { class: "row-menu" });
      details.append(
        el("summary", { "aria-label": I18n.t("actions"), text: "…" }),
        el(
          "div",
          { class: "menu-popover" },
          button("edit", () => {
            details.open = false;
            editMember(member);
          }),
          button(
            "remove",
            () => {
              details.open = false;
              removeMember(member);
            },
            "danger",
          ),
        ),
      );
      row.append(details);
    }
    return row;
  }
  async function inviteMember() {
    const result = await formDialog(
      I18n.t("invite"),
      [
        { key: "accountName", name: "userName", required: true },
        {
          key: "role",
          name: "collaborate",
          value: "false",
          options: [
            { value: "false", label: I18n.t("noCollaborate") },
            { value: "true", label: I18n.t("collaborate") },
          ],
        },
      ],
      (v) =>
        API("member", {
          method: "POST",
          body: {
            workspaceId: workspace.id,
            userName: v.userName,
            collaborate: v.collaborate === "true",
          },
        }),
      { saveKey: "invite", intro: I18n.t("inviteHint") },
    );
    if (result) await loadMembers();
  }
  async function editMember(member) {
    const result = await formDialog(
      I18n.t("edit"),
      [
        {
          key: "role",
          name: "collaborate",
          value: String(member.collaborate),
          options: [
            { value: "false", label: I18n.t("noCollaborate") },
            { value: "true", label: I18n.t("collaborate") },
          ],
        },
      ],
      (v) =>
        API("member", {
          method: "PATCH",
          body: {
            workspaceId: workspace.id,
            userId: member.userId,
            collaborate: v.collaborate === "true",
          },
        }),
    );
    if (result) await loadMembers();
  }
  async function removeMember(member) {
    if (await UI.confirm(I18n.t("removeMemberConfirm"))) {
      try {
        await API("member", {
          method: "DELETE",
          query: { workspaceId: workspace.id, userId: member.userId },
        });
        await loadMembers();
      } catch (e) {
        toast(errorText(e));
      }
    }
  }
  async function newFolder() {
    const result = await formDialog(
      I18n.t("newFolder"),
      [
        {
          key: "name",
          required: true,
          hint: I18n.t("nameHint"),
          validator: UI.nameValidator,
        },
      ],
      (v) =>
        API("folder", {
          method: "POST",
          body: { workspaceId: workspace.id, path: join(path, v.name.trim()) },
        }),
      { saveKey: "create" },
    );
    if (result) await loadFiles();
  }
  async function newHtml() {
    const result = await formDialog(
      I18n.t("newHtml"),
      [
        {
          key: "name",
          required: true,
          value: "index.html",
          hint: I18n.t("htmlHint"),
          validator: (v) =>
            UI.nameValidator(v) || (!isHtml(v) ? I18n.t("htmlHint") : ""),
        },
        {
          key: "content",
          name: "content",
          type: "textarea",
          value:
            '<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New page</title></head>\n<body>\n  <h1>Hello, babaShare.</h1>\n</body>\n</html>',
        },
      ],
      (v) =>
        API("content", {
          method: "PUT",
          body: {
            workspaceId: workspace.id,
            path: join(path, v.name.trim()),
            content: v.content,
          },
        }),
      { wide: true, saveKey: "create", dirty: true },
    );
    if (result) await loadFiles();
  }
  async function editFile(entry) {
    try {
      const data = await API("content", {
        query: { workspaceId: workspace.id, path: entry.path },
      });
      const result = await formDialog(
        I18n.t("edit") + " · " + entry.name,
        [
          {
            key: "content",
            name: "content",
            type: "textarea",
            value: data.content,
          },
        ],
        (v) =>
          API("content", {
            method: "PUT",
            body: {
              workspaceId: workspace.id,
              path: entry.path,
              content: v.content,
            },
          }),
        { wide: true, dirty: true },
      );
      if (result) await loadFiles();
    } catch (e) {
      toast(errorText(e));
    }
  }
  async function renameEntry(entry) {
    const result = await formDialog(
      I18n.t("rename"),
      [
        {
          key: "newName",
          name: "name",
          required: true,
          value: entry.name,
          hint: I18n.t("nameHint"),
          validator: UI.nameValidator,
        },
      ],
      (v) =>
        API(entry.kind, {
          method: "PATCH",
          body: {
            workspaceId: workspace.id,
            path: entry.path,
            newPath: join(parentPath(entry.path), v.name.trim()),
          },
        }),
    );
    if (result) await loadFiles();
  }
  async function deleteEntry(entry) {
    if (await UI.confirm(I18n.t("deleteConfirm", { name: entry.name }))) {
      try {
        await API(entry.kind, {
          method: "DELETE",
          query: { workspaceId: workspace.id, path: entry.path },
        });
        await loadFiles();
      } catch (e) {
        toast(errorText(e));
      }
    }
  }
  async function previewFile(entry) {
    if (
      !isHtml(entry.name) &&
      !/\.(png|jpe?g|gif|svg|webp|txt|css|js|json|pdf)$/i.test(entry.name)
    ) {
      toast(I18n.t("previewUnsupported"));
      return;
    }
    try {
      const ticket = await API("ticket", {
        method: "POST",
        body: { workspaceId: workspace.id, path: parentPath(entry.path) },
      });
      const url = new URL(
        encodeURIComponent(entry.name),
        ticket.previewBaseUrl,
      );
      await UI.preview(entry.name, url.href);
    } catch (e) {
      toast(errorText(e));
    }
  }
  async function shareFolder() {
    const result = await formDialog(
      I18n.t("shareTitle"),
      [
        {
          key: "expiry",
          name: "expireHours",
          value: "168",
          options: [
            { value: "24", label: I18n.t("day1") },
            { value: "168", label: I18n.t("day7") },
            { value: "720", label: I18n.t("day30") },
            { value: "0", label: I18n.t("forever") },
          ],
        },
      ],
      (v) =>
        API("share", {
          method: "POST",
          body: {
            workspaceId: workspace.id,
            path,
            expireHours: Number(v.expireHours),
          },
        }),
      { saveKey: "share", intro: I18n.t("shareHint") },
    );
    if (result)
      UI.dialog(I18n.t("shareCreated"), (node, close) => {
        node.append(
          el("p", { class: "form-note", text: I18n.t("shareHint") }),
          el("label", { for: "share-created-link", text: I18n.t("link") }),
          el("input", {
            id: "share-created-link",
            value: result.shareUrl,
            readonly: "",
            class: "share-link",
          }),
          el("p", {
            class: "small muted num",
            text: I18n.t("expires") + ": " + UI.date(result.expireTime),
          }),
          el(
            "div",
            { class: "actions" },
            button("close", () => close(null)),
            button(
              "copyLink",
              () => UI.copy(result.shareUrl),
              "primary",
              "link",
            ),
          ),
        );
      });
  }
  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  function uploadConflictChoice(conflicts) {
    return UI.dialog(I18n.t("uploadConflictTitle"), (node, close) => {
      node.append(
        el("p", { text: I18n.t("uploadConflictHint") }),
        el("ul", {}, ...conflicts.map((item) =>
          el("li", {}, el("bdi", { dir: "auto", text: item.path })))),
        el("p", { class: "form-note", text: I18n.t("uploadRenameWarning") }),
        el("div", { class: "actions" },
          button("cancel", () => close(null)),
          button("uploadKeepBoth", () => close("rename")),
          button("uploadOverwrite", () => close("overwrite"), "primary")),
      );
    }, { wide: true }).result;
  }
  async function uploadFiles(files) {
    if (uploading || !workspace?.canWrite) return;
    if (!files.length) {
      toast(I18n.t("dropEmpty"));
      return;
    }
    uploading = true;
    $("#drop-zone").setAttribute("aria-busy", "true");
    let failed = false, completed = false;
    const destination = { workspaceId: workspace.id, path,
      conflictPolicy: alwaysOverwrite ? "overwrite" : "ask" };
    try {
      const payload = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        $("#file-status").textContent = I18n.t("uploading", {
          current: i + 1,
          total: files.length,
        });
        payload.push({
          path: file.relativePath || file.webkitRelativePath || file.name,
          contentBase64: await fileBase64(file),
        });
      }
      const body = { ...destination, files: payload, requestId: crypto.randomUUID() };
      let result = await API("upload", { method: "POST", body });
      if (result.requiresConfirmation) {
        const policy = await uploadConflictChoice(result.conflicts);
        if (!policy) return;
        result = await API("upload", { method: "POST", body: { ...body, conflictPolicy: policy } });
      }
      completed = !result.requiresConfirmation;
      if (completed) toast(I18n.t("uploadDone"));
    } catch (e) {
      failed = true;
      toast(errorText(e));
    } finally {
      uploading = false;
      $("#drop-zone").setAttribute("aria-busy", "false");
      if (completed) {
        $("#upload-input").value = "";
        $("#directory-input").value = "";
      }
      await loadFiles();
      if (failed) {
        $("#file-status").textContent = I18n.t("uploadFailed");
        $("#file-status").classList.add("error");
      }
    }
  }
  $("#file-search").addEventListener("submit", (event) => {
    event.preventDefault();
    query = $("#search-input").value;
    pager.reset();
    updateUrl();
    loadFiles();
  });
  for (const [id, key] of [
    ["sort-name", "name"],
    ["sort-size", "size"],
    ["sort-time", "updateTime"],
  ])
    $("#" + id).addEventListener("click", () => {
      ascending = sort === key ? !ascending : true;
      sort = key;
      pager.reset();
      updateUrl();
      loadFiles();
    });
  for (const id of ["upload-input", "directory-input"])
    $("#" + id).addEventListener("change", (event) =>
      uploadFiles([...event.target.files]),
    );
  $("#drop-icon").append(icon("upload"));
  const drop = $("#drop-zone");
  for (const event of ["dragenter", "dragover"])
    drop.addEventListener(event, (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
  for (const event of ["dragleave", "drop"])
    drop.addEventListener(event, (e) => {
      e.preventDefault();
      drop.classList.remove("dragging");
    });
  async function readEntry(entry, prefix = "") {
    if (entry.isFile) {
      return new Promise((resolve, reject) =>
        entry.file((file) => {
          Object.defineProperty(file, "relativePath", {
            value: prefix + file.name,
          });
          resolve([file]);
        }, reject),
      );
    }
    if (entry.isDirectory) {
      const reader = entry.createReader(),
        all = [];
      for (;;) {
        const batch = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch)
          all.push(...(await readEntry(child, prefix + entry.name + "/")));
      }
      return all;
    }
    return [];
  }
  drop.addEventListener("drop", async (event) => {
    try {
      const items = [...event.dataTransfer.items];
      const roots = items
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean);
      const files = roots.length
        ? (await Promise.all(roots.map((entry) => readEntry(entry)))).flat()
        : [...event.dataTransfer.files];
      await uploadFiles(files);
    } catch (e) {
      toast(errorText(e));
    }
  });
  window.addEventListener("popstate", () => {
    readUrl();
    loadFiles();
  });
  I18n.subscribe(() => {
    renderChrome();
    renderFiles();
  });
  await page.ready;
  try {
    me = await API("me");
    workspaces = await API("workspaces");
    const id = new URL(location.href).searchParams.get("workspaceId");
    workspace = workspaces.find((w) => w.id === id) || null;
    readUrl();
    renderChrome();
    if (workspace) await Promise.all([loadFiles(), loadMembers()]);
  } catch (e) {
    $("#workspace-status").textContent = errorText(e);
    $("#workspace-status").classList.add("error");
    if (e.httpStatus === 401)
      $("#workspace-status").append(
        button("login", () =>
          page.request("shell.navigate", { routeId: "auth" }),
        ),
      );
  }
})();
