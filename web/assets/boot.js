try {
  const context = JSON.parse(
    localStorage.getItem("baba-share-context") || "{}",
  );
  if (["zh-CN", "en-US", "ar-SA"].includes(context.locale)) {
    document.documentElement.lang = context.locale;
    document.documentElement.dir =
      context.locale.split("-")[0] === "ar" ? "rtl" : "ltr";
  }
  if (["dark", "light"].includes(context.theme))
    document.documentElement.dataset.mode = context.theme;
} catch (error) {
  console.warn("Context unavailable", error.name);
}
