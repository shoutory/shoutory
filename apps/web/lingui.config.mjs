import { formatter } from "@lingui/format-po";

export default {
  locales: ["en", "ar"],
  sourceLocale: "en",
  catalogs: [{ path: "<rootDir>/src/messages/{locale}", include: ["<rootDir>/src"] }],
  format: formatter({ lineNumbers: false, origins: false }),
};
