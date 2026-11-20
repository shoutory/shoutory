import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./zod-config.js";
import { App } from "./app.js";
import { CatalogFallback } from "./i18n/catalog-fallback.js";
import { activateLocale, detectLocale, storedLocale } from "./i18n/i18n.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
// A catalog that fails to load shows the fixed-English fallback; the page already has its lang and dir (bootstrap).
const loaded = await activateLocale(detectLocale(storedLocale(), navigator.languages)).then(
  () => true,
  () => false,
);
createRoot(root).render(
  <StrictMode>
    {loaded ? (
      <I18nProvider i18n={i18n}>
        <App />
      </I18nProvider>
    ) : (
      <CatalogFallback />
    )}
  </StrictMode>,
);
