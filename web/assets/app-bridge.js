(() => {
  "use strict";
  window.AppBridgeHost = {
    create({ iframe, context, handlers = {} }) {
      let link = null,
        connected = false;
      function bind() {
        link?.destroy();
        connected = false;
        link = BabaShareBridgeEndpoint(
          () => iframe.contentWindow,
          () => true,
        );
        link.handle("bridge.hello", () => {
          connected = true;
          return context();
        });
        for (const [type, fn] of Object.entries(handlers))
          link.handle(type, fn);
      }
      bind();
      iframe.addEventListener("load", bind);
      const host = {
        emit(type, payload) {
          if (connected) link.emit(type, payload);
        },
        request(type, payload) {
          return connected
            ? link.request(type, payload)
            : Promise.resolve(true);
        },
        on(type, fn) {
          return link.on(type, fn);
        },
        handle(type, fn) {
          return link.handle(type, fn);
        },
        destroy() {
          iframe.removeEventListener("load", bind);
          link?.destroy();
        },
      };
      window.addEventListener("pagehide", () => host.destroy(), { once: true });
      return host;
    },
  };
})();
