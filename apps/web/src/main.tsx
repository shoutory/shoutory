import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { activateLocale, detectLocale, storedLocale } from "./i18n/i18n.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
await activateLocale(detectLocale(storedLocale(), navigator.languages));
createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
