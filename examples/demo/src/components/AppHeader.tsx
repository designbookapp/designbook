import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { useTheme } from "../providers/ThemeProvider";

const LOCALES = [
  { code: "en-US", label: "EN" },
  { code: "es-419", label: "ES" },
  { code: "fr-FR", label: "FR" },
];

function navClass({ isActive }: { isActive: boolean }) {
  return isActive
    ? "text-sm font-medium text-foreground"
    : "text-sm text-muted-foreground hover:text-foreground";
}

/** Top nav — brand, page links, language picker, density toggle. */
function AppHeader() {
  const { t, i18n } = useTranslation();
  const { brandName, density, setDensity } = useTheme();
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-8 py-4">
        <NavLink to="/" className="text-base font-bold tracking-tight">
          {brandName}
        </NavLink>
        <nav className="flex items-center gap-4">
          <NavLink to="/" end className={navClass}>
            {t("nav.home")}
          </NavLink>
          <NavLink to="/trips" className={navClass}>
            {t("nav.trips")}
          </NavLink>
          <NavLink to="/about" className={navClass}>
            {t("nav.about")}
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDensity(density === "compact" ? "comfortable" : "compact")
            }
          >
            {density === "compact" ? t("nav.comfortable") : t("nav.compact")}
          </button>
          <div className="flex gap-1">
            {LOCALES.map(({ code, label }) => (
              <button
                key={code}
                type="button"
                className={
                  i18n.language === code
                    ? "rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
                    : "rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                }
                onClick={() => i18n.changeLanguage(code)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

export { AppHeader };
