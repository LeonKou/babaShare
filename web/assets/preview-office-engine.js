/* 派生自 office-website 的 socket.ts/server.ts，仅实现本地只读协议；AGPL-3.0。 */
(() => {
  "use strict";
  const sockets = new Map();
  let sequence = 0, closed = false;
  function notify(type, payload) { if (!closed) window.parent.postMessage({ version: 1, type, ...payload }, location.origin); }
  class ReadonlySocket {
    constructor() {
      this.id = "preview-" + ++sequence;
      this.active = true; this.connected = true; this.disconnected = false; this.recovered = false;
      this.listeners = new Map();
      this.io = Object.fromEntries(["setOpenToken", "setSessionToken", "on", "reconnectionAttempts", "reconnectionDelay", "reconnectionDelayMax", "timeout", "transports", "upgrade", "upgradeTransport", "upgradeTimeout"].map((name) => [name, () => {}]));
      sockets.set(this.id, this);
      setTimeout(() => { this.deliver("connect"); notify("office-engine.connect", { socketId: this.id }); }, 0);
    }
    on(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); return this; }
    once(type, fn) { const once = (...args) => { this.off(type, once); fn(...args); }; return this.on(type, once); }
    off(type, fn) { if (!fn) this.listeners.delete(type); else this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn)); return this; }
    removeAllListeners(type) { if (type) this.listeners.delete(type); else this.listeners.clear(); return this; }
    deliver(type, ...args) { (this.listeners.get(type) || []).slice().forEach((fn) => fn(...args)); }
    emit(type, data) {
      if (!this.connected || type !== "message" || data?.type !== "auth") return this;
      notify("office-engine.auth", { socketId: this.id }); return this;
    }
    send(data) { return this.emit("message", data); }
    disconnect() { this.connected = false; this.disconnected = true; this.deliver("disconnect"); this.listeners.clear(); sockets.delete(this.id); return this; }
    close() { return this.disconnect(); }
    connect() { return this; }
    open() { return this; }
    compress() { return this; }
  }
  function allowedResource(value) {
    const url = new URL(value, location.href);
    return (url.origin === location.origin && url.protocol === "blob:") ||
      (url.origin === location.origin && url.pathname.startsWith("/baba-share/vendor/office/") && ["http:", "https:"].includes(url.protocol));
  }
  const nativeFetch = window.fetch.bind(window), NativeXHR = window.XMLHttpRequest;
  window.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "GET" || !allowedResource(request.url)) return Promise.reject(new Error("READONLY_RESOURCE_DENIED"));
    return nativeFetch(request, { credentials: "omit", redirect: "error" });
  };
  window.XMLHttpRequest = class extends NativeXHR {
    open(method, url, ...args) {
      if (String(method).toUpperCase() !== "GET" || !allowedResource(url)) throw new Error("READONLY_RESOURCE_DENIED");
      return super.open(method, url, ...args);
    }
  };
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  // 此脚本预装在引擎自己的 HTML 中；母版和 viewer 不访问引擎内部 DOM。
  const factory = () => new ReadonlySocket();
  Object.defineProperty(window, "io", { configurable: false, get: () => factory, set() {} });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.version !== 1) return;
    if (event.data.type === "office-engine.reply" && typeof event.data.socketId === "string" && event.data.message && typeof event.data.message === "object") {
      sockets.get(event.data.socketId)?.deliver("message", event.data.message);
    }
    if (event.data.type === "office-engine.context") {
      const context = event.data.context;
      if (!["zh-CN", "en-US", "ar-SA"].includes(context?.locale) || !["ltr", "rtl"].includes(context?.dir) || !["light", "dark"].includes(context?.theme)) return;
      document.documentElement.lang = context.locale;
      document.documentElement.dir = context.dir;
      document.documentElement.dataset.mode = context.theme;
    }
    if (event.data.type === "office-engine.dispose") dispose();
  });
  function dispose() { closed = true; sockets.forEach((socket) => socket.disconnect()); sockets.clear(); }
  window.addEventListener("pagehide", dispose, { once: true });
})();
