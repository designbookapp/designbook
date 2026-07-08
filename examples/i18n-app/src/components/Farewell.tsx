import { useTranslation } from "react-i18next";

export function Farewell() {
  const { t } = useTranslation("app");
  return (
    <section
      style={{
        background: "var(--brand-surface)",
        color: "var(--brand-text)",
        borderRadius: "var(--brand-radius)",
        padding: "24px",
      }}
    >
      <h2 style={{ color: "var(--brand-primary)" }}>{t("farewell.title")}</h2>
      <p>{t("farewell.note")}</p>
    </section>
  );
}

export default Farewell;
