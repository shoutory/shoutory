// Runs inline in the page head, before first paint, so the theme never flashes and the page has its language and
// direction at once. The stored theme is "dark", "light" or "system" (key "shoutory.theme"); anything else, no value and
// unreadable storage all mean "system". The locale rule is the one of `detectLocale` in i18n/i18n.ts (the stored
// choice, else the first supported browser language, else English); a test keeps the two equal.
(() => {
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // blocked storage is a normal answer: the system preference decides
    }
  };
  const theme = read("shoutory.theme");
  const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";

  const directions = { en: "ltr", ar: "rtl" };
  const supported = (value) => (value === "en" || value === "ar" ? value : null);
  let locale = supported(read("shoutory.locale"));
  for (const tag of locale ? [] : navigator.languages) {
    locale = supported(tag.split("-")[0].toLowerCase());
    if (locale) break;
  }
  locale = locale || "en";
  root.lang = locale;
  root.dir = directions[locale];
})();
