// 动态基础路径加固定白名单；标准库路由由 tests/test_security.py 真实HTTP契约测试验证。
(() => {
  "use strict";
  // dev-standards:ignore 动态基础路径配合固定白名单；由真实HTTP契约测试验证标准库路由。
  const base = "/api/baba-share/core/v1"; // dev-standards:ignore 动态基址不是独立接口；真实HTTP契约由tests/test_security.py验证。
  const paths = {
    install: "/visitor/install/detail",
    setup: "/visitor/account/setup",
    registration: "/visitor/account/registration",
    login: "/visitor/session",
    session: "/session",
    me: "/session/detail",
    workspaces: "/workspace/list",
    workspace: "/workspace",
    members: "/member/list",
    member: "/member",
    nodes: "/node/list",
    folder: "/folder",
    file: "/file",
    content: "/file/content",
    upload: "/file/upload",
    ticket: "/preview/ticket",
    mcpKeys: "/mcp-key/list",
    mcpKey: "/mcp-key",
    mcpKeyContent: "/mcp-key/content",
    shares: "/share/list",
    share: "/share",
    shareDetail: "/visitor/share/detail",
    users: "/user/list",
    user: "/user",
    setting: "/setting",
    settings: "/setting/detail",
  };
  window.API = (key, options) => {
    if (!Object.hasOwn(paths, key)) throw new Error("API_NOT_ALLOWED");
    return UI.api(base + paths[key], options);
  };
})();
