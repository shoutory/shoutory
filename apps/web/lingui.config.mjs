import { formatter } from "@lingui/format-po";

// Messages carry explicit dotted ids (`system.not_found.title`); the catalogs are PO files compiled on import.
export default {
  locales: ["en", "ar"],
  sourceLocale: "en",
  catalogs: [{ path: "<rootDir>/src/messages/{locale}", include: ["<rootDir>/src"] }],
  format: formatter({ lineNumbers: false, origins: false }),
};
