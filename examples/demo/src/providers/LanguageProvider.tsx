import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

type LanguageContextValue = {
  locale: string;
  formatCurrency: (amount: number, currency: string) => string;
  formatDate: (date: Date) => string;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(
  undefined,
);

/**
 * Locale-aware formatting derived from the active i18next language, so
 * prices and dates follow the language picker (in the app and on the
 * designbook canvas alike).
 */
function LanguageProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const locale = i18n.language || "en-US";

  const value = useMemo<LanguageContextValue>(
    () => ({
      locale,
      formatCurrency: (amount, currency) =>
        new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(amount),
      formatDate: (date) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date),
    }),
    [locale],
  );

  return <LanguageContext value={value}>{children}</LanguageContext>;
}

function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) {
    throw new Error("useLanguage must be used inside a LanguageProvider.");
  }
  return value;
}

export { LanguageProvider, useLanguage };
