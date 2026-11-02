(() => {
  "use strict";
  const { el, button } = UI;
  window.PagerFocus = function (container) {
    let controls = {}, pending = null, parked = null;
    return {
      capture() {
        const active = document.activeElement;
        const current = Object.keys(controls).find((key) => controls[key] === active);
        if (current) pending = current;
        else if (active !== parked || !container.contains(active)) pending = null;
      },
      restore(nextControls, busy) {
        controls = nextControls;
        if (!pending) return;
        let target = controls[pending];
        if (target?.disabled) target = busy ? container :
          Object.values(controls).find((control) => !control.disabled) || container;
        if (!target) target = container;
        if (target === container) container.setAttribute("tabindex", "-1");
        target.focus();
        parked = target;
        if (!busy) pending = null;
      },
    };
  };
  window.LocalPager = function (container, onChange, { remote = false } = {}) {
    let pageIndex = 1;
    let pageSize = 20;
    let totalCount = 0;
    let busy = false;
    let initialized = false;
    const focus = PagerFocus(container);
    function readUrl() {
      const url = new URL(location.href);
      pageIndex = Math.max(
        1,
        Math.floor(Number(url.searchParams.get("pageIndex")) || 1),
      );
      pageSize = [10, 20, 50].includes(Number(url.searchParams.get("pageSize")))
        ? Number(url.searchParams.get("pageSize"))
        : 20;
    }
    readUrl();
    function write() {
      const url = new URL(location.href);
      url.searchParams.set("pageIndex", pageIndex);
      url.searchParams.set("pageSize", pageSize);
      history.replaceState(null, "", url);
    }
    function render() {
      focus.capture();
      const totalPage = Math.max(1, Math.ceil(totalCount / pageSize));
      if (initialized) pageIndex = Math.min(pageIndex, totalPage);
      const select = el("select", {
        "aria-label": I18n.t("pageSize"),
        disabled: busy ? "" : null,
      });
      for (const value of [10, 20, 50])
        select.append(
          el("option", {
            value,
            text: String(value),
            selected: value === pageSize ? "" : null,
          }),
        );
      select.addEventListener("change", () => {
        pageSize = Number(select.value);
        pageIndex = 1;
        write();
        onChange();
      });
      const previous = button("previous", () => {
        pageIndex--;
        write();
        onChange();
      });
      const next = button("next", () => {
        pageIndex++;
        write();
        onChange();
      });
      previous.disabled = busy || pageIndex <= 1;
      next.disabled = busy || pageIndex >= totalPage;
      container.replaceChildren(
        el(
          "div",
          { class: "row" },
          el("span", { text: I18n.t("items", { total: totalCount }) }),
          el(
            "label",
            { class: "row" },
            el("span", { text: I18n.t("pageSize") }),
            select,
          ),
        ),
        el(
          "div",
          { class: "row" },
          previous,
          el("bdi", {
            dir: "ltr",
            class: "num",
            "aria-current": "page",
            text: I18n.t("page", { page: pageIndex, pages: totalPage }),
          }),
          next,
        ),
      );
      container.setAttribute("aria-busy", String(busy));
      focus.restore({ pageSize: select, previous, next }, busy);
    }
    window.addEventListener("popstate", () => {
      readUrl();
      onChange();
    });
    I18n.subscribe(render);
    return {
      slice(items) {
        totalCount = items.length;
        initialized = true;
        const previousIndex = pageIndex;
        pageIndex = Math.min(
          pageIndex,
          Math.max(1, Math.ceil(totalCount / pageSize)),
        );
        if (pageIndex !== previousIndex) write();
        render();
        return items.slice((pageIndex - 1) * pageSize, pageIndex * pageSize);
      },
      accept(data) {
        totalCount = data.totalCount;
        initialized = true;
        const lastPage = Math.max(1, data.totalPage);
        if (pageIndex > lastPage) {
          pageIndex = lastPage;
          write();
          render();
          return false;
        }
        render();
        return true;
      },
      reset() {
        pageIndex = 1;
        initialized = false;
        write();
      },
      busy(value) {
        busy = value;
        render();
      },
      get pageIndex() {
        return pageIndex;
      },
      get pageSize() {
        return pageSize;
      },
    };
  };
})();
