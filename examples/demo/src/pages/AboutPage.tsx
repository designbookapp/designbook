import { useTranslation } from "react-i18next";
import { Badge } from "../components/ui/badge";
import { Separator } from "../components/ui/separator";
import { useTheme } from "../providers/ThemeProvider";

/** Text-heavy page — handy for exercising the page text tool. */
function AboutPage() {
  const { t } = useTranslation();
  const { brandName } = useTheme();
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight">
        {t("about.title", { brand: brandName })}
      </h1>
      <p className="mt-4 text-muted-foreground">{t("about.intro")}</p>
      <Separator className="my-6" />
      <div className="flex flex-col gap-6">
        <section>
          <h2 className="font-semibold">{t("about.missionTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("about.missionBody")}
          </p>
        </section>
        <section>
          <h2 className="font-semibold">{t("about.promiseTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("about.promiseBody")}
          </p>
        </section>
        <div className="flex gap-2">
          <Badge>{t("about.badgeGuides")}</Badge>
          <Badge>{t("about.badgeGroups")}</Badge>
          <Badge>{t("about.badgeCancellation")}</Badge>
        </div>
      </div>
    </div>
  );
}

export { AboutPage };
