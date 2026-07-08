import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en/app.json";
import fr from "../locales/fr/app.json";

// The APP initializes its OWN i18next instance (its own react-i18next). This is
// the copy designbook's i18next adapter must share for text attribution to work.
void i18next.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: "app",
  ns: ["app"],
  resources: {
    en: { app: en },
    fr: { app: fr },
  },
  interpolation: { escapeValue: false },
});

export default i18next;
