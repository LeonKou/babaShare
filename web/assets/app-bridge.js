(() => {
  "use strict";
  window.AppBridgeHost = {
    create({ iframe, context, handlers = {}, session = "", onState = () => {} }) {
      let connected = false, sender = null, closed = false;
      const retired = new Set();
      const link = BabaShareBridgeEndpoint(
        () => iframe.contentWindow,
        (event) => !closed && typeof event.data.sender === "string" && !retired.has(event.data.sender) && (event.data.type === "bridge.hello" ? Boolean(event.data.requestId) : Boolean(sender) && event.data.sender === sender),
        null, session,
      );
      link.handle("bridge.hello", (_, message) => {
        if (sender && sender !== message.sender) {
          retired.add(sender);
          connected = false;
          link.cancelPending();
        }
        sender = message.sender;
        connected = true;
        onState("connected");
        return I18n.normalizeContext(context());
      });
      link.on("page.state", (payload) => {
        if (!connected || payload?.version !== 1 || !["ready", "error"].includes(payload.state)) return;
        onState(payload.state);
      });
      link.on("page.leaving", (payload) => {
        if (!connected || payload?.version !== 1) return;
        retired.add(sender);
        connected = false; sender = null;
        onState("loading");
      });
      for (const [type, fn] of Object.entries(handlers)) link.handle(type, fn);
      const host = {
        emit(type, payload) {
          if (connected && !closed) link.emit(type, type === "context.changed" ? I18n.normalizeContext(payload) : payload);
        },
        request(type, payload) {
          return connected && !closed ? link.request(type, payload) : Promise.resolve(true);
        },
        on: link.on,
        handle: link.handle,
        destroy() {
          closed = true; connected = false;
          link.destroy();
          window.removeEventListener("pagehide", host.destroy);
        },
      };
      window.addEventListener("pagehide", host.destroy, { once: true });
      return host;
    },
  };
})();
