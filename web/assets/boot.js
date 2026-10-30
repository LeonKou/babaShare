(() => {
  const root = document.documentElement;
  root.dataset.accent = "blue";
  try {
    const context = JSON.parse(
      localStorage.getItem("baba-share-context") || "{}",
    );
    if (["zh-CN", "en-US", "ar-SA"].includes(context?.locale)) {
      root.lang = context.locale;
      root.dir = context.locale.split("-")[0] === "ar" ? "rtl" : "ltr";
    }
    if (["dark", "light"].includes(context?.theme))
      root.dataset.mode = context.theme;
    if (["blue", "green", "purple", "red", "orange", "teal"].includes(context?.accent))
      root.dataset.accent = context.accent;
  } catch (error) {
    console.warn("Context unavailable", error.name);
  }
})();
