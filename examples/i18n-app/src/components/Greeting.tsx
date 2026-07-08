import { useTranslation } from "react-i18next";

export function Greeting() {
  const { t } = useTranslation("app");
  // Dynamic key: the key is a runtime variable, so attribution
  // must come from the first-argument EXPRESSION the transform copies.
  const noteKey = "farewell.note";
  return (
    <section
      style={{
        background: "var(--brand-surface)",
        color: "var(--brand-text)",
        borderRadius: "var(--brand-radius)",
        padding: "24px",
      }}
    >
      <h1 style={{ color: "var(--brand-primary)" }}>{t("greeting.title")}</h1>
      <p>{t("greeting.subtitle")}</p>
      <p data-dyn>{t(noteKey)}</p>
      {/* Plural key: page path must edit both forms, like the
          canvas TextToolOverlay does. */}
      <p data-trips>{t("greeting.trips", { count: 3 })}</p>
    </section>
  );
}

export default Greeting;
