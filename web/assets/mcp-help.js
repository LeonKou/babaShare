(() => {
  "use strict";
  const { el, button } = UI;
  // dev-standards:ignore 动态BASE与固定资源后缀拼接；真实HTTP契约由集成测试验证。
  const base = "/api/baba-share/core/v1"; // dev-standards:ignore 标准库动态路由由真实HTTP测试覆盖。
  function instructions(secret) {
    if (!["http:", "https:"].includes(window.location.protocol))
      throw Object.assign(new Error("MCP_UNAVAILABLE"), { status: "mcpUnavailable" });
    const endpoint = new URL(base + "/mcp", window.location.origin).href;
    return [
      "# babaShare MCP",
      I18n.t("mcpUseAuthorize"),
      `URL: ${endpoint}`,
      `BABA_SHARE_MCP_KEY: ${secret}`,
      I18n.t("mcpUseConfigure"),
      I18n.t("mcpUseWindows"),
      I18n.t("mcpUsePosix"),
      I18n.t("mcpUseCodex"),
      "```toml",
      "[mcp_servers.baba-share]",
      `url = ${JSON.stringify(endpoint)}`,
      'bearer_token_env_var = "BABA_SHARE_MCP_KEY"',
      "```",
      I18n.t("mcpUseCodexCli"),
      "```sh",
      `codex mcp add baba-share --url ${JSON.stringify(endpoint)} --bearer-token-env-var BABA_SHARE_MCP_KEY`,
      "```",
      I18n.t("mcpUseOpenCode"),
      "```json",
      JSON.stringify({
        mcp: {
          "baba-share": {
            type: "remote",
            url: endpoint,
            enabled: true,
            oauth: false,
            headers: { Authorization: "Bearer {env:BABA_SHARE_MCP_KEY}" },
          },
        },
      }, null, 2),
      "```",
      I18n.t("mcpUseOther"),
      I18n.t("mcpReadmePermissions"),
      I18n.t("mcpReadmeTools"),
      [
        "workspace_list, workspace_create, workspace_change, workspace_delete",
        "node_list, folder_create, file_read, file_write, file_upload",
        "file_move, folder_move, file_delete, folder_delete",
        "share_list, share_create, share_revoke, member_list, member_change, member_delete",
      ].join("\n"),
      I18n.t("mcpReadmeToolHints"),
      I18n.t("mcpUploadConflict"),
      I18n.t("mcpUseVerify"),
      I18n.t("mcpUseDiagnose"),
    ].join("\n\n");
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      UI.toast(I18n.t("mcpCopied"));
      return true;
    } catch (error) {
      const fallback = UI.dialog(I18n.t("mcpInstructions"), (node, close) => {
        const area = el("textarea", {
          readonly: "", dir: "ltr", autocomplete: "off", spellcheck: "false",
          "aria-label": I18n.t("mcpInstructions"),
        });
        area.value = text;
        node.append(
          el("p", { class: "form-note", text: I18n.t("mcpManual") }), area,
          el("div", { class: "actions" }, button("close", () => close(null))),
        );
        node.addEventListener("close", () => { area.value = ""; }, { once: true });
        queueMicrotask(() => { area.focus(); area.select(); });
      }, { wide: true });
      UI.toast(I18n.t("copyFailed"));
      const cleanup = () => fallback.close(null);
      window.addEventListener("pagehide", cleanup, { once: true });
      try { await fallback.result; }
      finally { window.removeEventListener("pagehide", cleanup); }
      return false;
    } finally {
      text = "";
    }
  }
  async function copyUse(keyId) {
    let response = null, secret = "", text = "";
    try {
      response = await API("mcpKeyContent", { method: "POST", body: { id: keyId } });
      secret = response.key;
      delete response.key;
      text = instructions(secret);
      secret = "";
      return await copy(text);
    } finally {
      if (response) delete response.key;
      response = null;
      secret = "";
      text = "";
    }
  }
  function showCreated(keyId, onError) {
    const shown = UI.dialog(I18n.t("mcpCreated"), (node, close) => {
      const use = UI.copyButton("mcpCopyUse", async () => {
        try { return await copyUse(keyId); }
        catch (error) { onError(error); return false; }
      }, "primary");
      use.setAttribute("aria-describedby", "mcp-created-privacy");
      node.append(
        el("p", { class: "form-note", text: I18n.t("mcpCreatedHint") }),
        el("p", { id: "mcp-created-privacy", class: "form-note", text: I18n.t("mcpCopyPrivacy") }),
        el("div", { class: "actions" }, button("close", () => close(null)), use),
      );
    });
    const cleanup = () => shown.close(null);
    window.addEventListener("pagehide", cleanup, { once: true });
    shown.result.finally(() => window.removeEventListener("pagehide", cleanup));
    return shown.result;
  }
  window.McpHelp = { instructions, copyUse, showCreated };
})();
