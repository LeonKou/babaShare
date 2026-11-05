(() => {
  "use strict";
  window.PageBridgeClient = {
    create({ standalone }) {
      let link = null,
        mode = "pending",
        dirty = false, closed = false;
      const session = new URL(location.href).searchParams.get("__frame") || "";
      const listeners = new Map(),
        handlers = new Map();
      const ready = (async () => {
        if (parent === window) {
          mode = "standalone";
          return standalone.context();
        }
        try {
          if (parent.location.origin !== location.origin) {
            mode = "standalone";
            return standalone.context();
          }
          link = BabaShareBridgeEndpoint(
            () => parent,
            () => !closed,
            null, session,
          );
          for (const [type, fns] of listeners)
            for (const fn of fns) link.on(type, fn);
          for (const [type, fn] of handlers) link.handle(type, fn);
          link.handle("page.beforeLeave", () =>
            dirty ? standalone.confirm(I18n.t("unsaved")) : true,
          );
          link.on("context.changed", (ctx) => {
            if (mode === "embedded") I18n.apply(ctx);
          });
          const ctx = await link.request("bridge.hello", {}, 1200);
          if (closed || mode !== "pending") return standalone.context();
          mode = "embedded";
          return I18n.normalizeContext(ctx);
        } catch (e) {
          if (e.name !== "SecurityError" && e.message !== "BRIDGE_TIMEOUT")
            console.warn("Bridge handshake failed", e);
          link?.destroy();
          link = null;
          if (!closed) mode = "standalone";
          return standalone.context();
        }
      })();
      const client = {
        ready,
        emit(type, payload) {
          if (closed) return;
          if (mode === "embedded") link.emit(type, payload);
          else standalone.emit(type, payload);
        },
        request(type, payload) {
          return ready.then(() => {
            if (closed) throw new Error("BRIDGE_CLOSED");
            return mode === "embedded" ? link.request(type, payload) : standalone.request(type, payload);
          });
        },
        on(type, fn) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
          const off = link?.on(type, fn);
          return () => {
            listeners.get(type)?.delete(fn);
            off?.();
          };
        },
        handle(type, fn) {
          if (handlers.has(type)) throw new Error("BRIDGE_HANDLER_EXISTS");
          handlers.set(type, fn);
          if (link) return link.handle(type, fn);
          return () => handlers.delete(type);
        },
        setDirty(value) {
          dirty = Boolean(value);
          if (mode === "embedded") link.emit("shell.dirty", { dirty });
        },
        get dirty() {
          return dirty;
        },
        get embedded() {
          return mode === "embedded";
        },
        destroy() {
          if (closed) return;
          if (mode === "embedded") link.emit("page.leaving", { version: 1 });
          closed = true; mode = "closed";
          link?.destroy();
        },
      };
      window.addEventListener("beforeunload", (event) => {
        if (dirty) {
          event.preventDefault();
          event.returnValue = "";
        }
      });
      window.addEventListener("pagehide", () => client.destroy(), {
        once: true,
      });
      return client;
    },
  };
})();
