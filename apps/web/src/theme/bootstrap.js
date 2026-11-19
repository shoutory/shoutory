// Runs inline in the page head, before first paint, so the theme never flashes. The stored choice is "dark", "light"
// or "system" (key "shoutory.theme"); anything else, no value and unreadable storage all mean "system".
(() => {
  let stored = null;
  try {
    stored = localStorage.getItem("shoutory.theme");
  } catch {
    stored = null; // blocked storage is a normal answer: the system preference decides
  }
  const dark =
    stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
