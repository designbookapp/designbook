import { useTranslation } from "react-i18next";
import { Greeting } from "./components/Greeting";
import { Farewell } from "./components/Farewell";

export function App() {
  const { i18n } = useTranslation("app");
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "40px auto",
        display: "grid",
        gap: 24,
      }}
    >
      <button onClick={() => i18n.changeLanguage(i18n.language === "en" ? "fr" : "en")}>
        Toggle language (app) — {i18n.language}
      </button>
      <Greeting />
      <Farewell />
    </main>
  );
}

export default App;
