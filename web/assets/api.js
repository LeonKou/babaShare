// 动态基础路径加固定白名单；标准库路由由 tests/test_security.py 真实HTTP契约测试验证。
(() => {
  "use strict";
  // dev-standards:ignore 动态基础路径配合固定白名单；由真实HTTP契约测试验证标准库路由。
  const base = "/api/baba-share/core/v1"; // dev-standards:ignore 动态基址不是独立接口；真实HTTP契约由tests/test_security.py验证。
  const paths = {
    install: "/visitor/install/detail",
    setup: "/visitor/account/setup",
    registration: "/visitor/account/registration",
    emailRegistration: "/visitor/email/registration",
    emailActivation: "/visitor/email/activation",
    passwordResetRequest: "/visitor/password-reset/request",
    passwordResetConfirmation: "/visitor/password-reset/confirmation",
    accountEmail: "/account/email/detail",
    emailChangeRequest: "/account/email-change/request",
    emailChangeVerification: "/account/email-change/verification",
    emailChangeProposal: "/account/email-change/proposal",
    emailChangeConfirmation: "/account/email-change/confirmation",
    emailBindingRequest: "/account/email-binding/request",
    emailBindingConfirmation: "/account/email-binding/confirmation",
    login: "/visitor/session",
    session: "/session",
    me: "/session/detail",
    quota: "/quota/detail",
    onboarding: "/onboarding/detail",
    onboardingUpdate: "/onboarding",
    onboardingPreview: "/onboarding/preview",
    onboardingVisit: "/onboarding/visit",
    workspaces: "/workspace/list",
    workspace: "/workspace",
    workspaceAdmin: "/workspace-admin/list",
    workspaceOwnership: "/workspace/ownership",
    members: "/member/list",
    member: "/member",
    invitations: "/invitation/list",
    invitation: "/invitation",
    invitationMembership: "/invitation/membership",
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
    mailSettings: "/mail-setting/detail",
    mailSetting: "/mail-setting",
    mailTest: "/mail-setting/test",
  };
  window.API = (key, options) => {
    if (!Object.hasOwn(paths, key)) throw new Error("API_NOT_ALLOWED");
    const anonymous = ["install", "setup", "registration", "emailRegistration", "emailActivation", "passwordResetRequest", "passwordResetConfirmation", "login", "shareDetail"];
    return UI.api(base + paths[key], {
      ...options,
      // 退出操作自行在finally导航，失败也必须能离开工作台。
      authRequired:
        !(key === "session" && options?.method === "DELETE") &&
        !(options?.keepPageOnUnauthorized && ["me", "accountEmail", "emailChangeVerification", "emailChangeProposal", "emailChangeConfirmation", "emailBindingConfirmation"].includes(key)) &&
        !anonymous.includes(key),
    });
  };
})();
