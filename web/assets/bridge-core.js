(() => {
  "use strict";
  function endpoint(target, accept, onClose) {
    const listeners = new Map();
    const handlers = new Map();
    const pending = new Map();
    let closed = false;
    let sequence = 0;
    function settleError(reason) {
      const error = new Error(reason || "BRIDGE_ERROR");
      error.status = reason;
      return error;
    }
    function send(message) {
      if (closed) throw settleError("BRIDGE_CLOSED");
      const receiver = target();
      if (!receiver) throw settleError("BRIDGE_CLOSED");
      receiver.postMessage(
        { babaShare: true, version: 1, ...message },
        location.origin === "null" ? "*" : location.origin,
      );
    }
    async function receive(event) {
      if (
        event.origin !== location.origin ||
        event.source !== target() ||
        !event.data?.babaShare ||
        event.data.version !== 1 ||
        !accept(event)
      )
        return;
      const message = event.data;
      if (message.replyTo) {
        const promise = pending.get(message.replyTo);
        if (!promise) return;
        clearTimeout(promise.timer);
        pending.delete(message.replyTo);
        if (message.error) promise.reject(settleError(message.error));
        else promise.resolve(message.payload);
        return;
      }
      if (message.requestId) {
        let response;
        try {
          const handler = handlers.get(message.type);
          if (!handler) throw settleError("BRIDGE_UNKNOWN_TYPE");
          response = {
            type: message.type,
            replyTo: message.requestId,
            payload: await handler(message.payload),
          };
        } catch (error) {
          response = {
            type: message.type,
            replyTo: message.requestId,
            error: error.status || error.message || "BRIDGE_ERROR",
          };
        }
        try {
          send(response);
        } catch (error) {
          console.error("Bridge response failed", error);
        }
        return;
      }
      for (const handler of listeners.get(message.type) || []) {
        Promise.resolve()
          .then(() => handler(message.payload))
          .catch((error) => console.error("Bridge callback error", error));
      }
    }
    window.addEventListener("message", receive);
    return {
      emit(type, payload) {
        send({ type, payload });
      },
      request(type, payload, timeout = 3000) {
        if (closed) return Promise.reject(settleError("BRIDGE_CLOSED"));
        return new Promise((resolve, reject) => {
          const requestId = `${Date.now()}-${++sequence}`;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(settleError("BRIDGE_TIMEOUT"));
          }, timeout);
          pending.set(requestId, { resolve, reject, timer });
          try {
            send({ type, payload, requestId });
          } catch (error) {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(error);
          }
        });
      },
      on(type, handler) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
        return () => listeners.get(type)?.delete(handler);
      },
      handle(type, handler) {
        if (handlers.has(type)) throw settleError("BRIDGE_HANDLER_EXISTS");
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
      destroy() {
        if (closed) return;
        closed = true;
        window.removeEventListener("message", receive);
        pending.forEach((promise) => {
          clearTimeout(promise.timer);
          promise.reject(settleError("BRIDGE_CLOSED"));
        });
        pending.clear();
        listeners.clear();
        handlers.clear();
        onClose?.();
      },
    };
  }
  window.BabaShareBridgeEndpoint = endpoint;
})();
