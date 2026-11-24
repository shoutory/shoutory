// Runs inline in the page head, before first paint, so the theme never flashes. It repeats `detectLocale` of
// i18n/i18n.ts because an inline script imports nothing; a test keeps the two equal.
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
