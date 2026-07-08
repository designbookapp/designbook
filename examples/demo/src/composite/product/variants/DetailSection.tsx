import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { Separator } from "../../../components/ui/separator";
import { useTheme } from "../../../providers/ThemeProvider";
import {
  ProductBadges,
  ProductDuration,
  ProductImage,
  ProductPrice,
  ProductRating,
  ProductTagline,
  ProductTitle,
} from "../atoms";

/** Full-width detail hero for a product page. */
function ProductDetailSection() {
  const { t } = useTranslation();
  const { brandName, density } = useTheme();
  return (
    <section
      className={
        density === "compact"
          ? "w-2xl rounded-xl border bg-card p-4"
          : "w-2xl rounded-xl border bg-card p-6"
      }
    >
      <div className="flex gap-6">
        <ProductImage className="h-52 w-64 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductBadges />
          <ProductTitle className="text-2xl" />
          <ProductTagline />
          <div className="flex items-center gap-3">
            <ProductRating />
            <ProductDuration />
          </div>
          <Separator className="my-2" />
          <div className="mt-auto flex items-center justify-between">
            <ProductPrice />
            <Button>{t("product.bookNow")}</Button>
          </div>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        {t("product.operatedBy", { brand: brandName })}
      </p>
    </section>
  );
}

export { ProductDetailSection };
