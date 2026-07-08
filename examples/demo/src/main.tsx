import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initI18n } from "./i18n";
import "./index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

initI18n().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
