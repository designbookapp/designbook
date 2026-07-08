import { useDataset } from "@designbookapp/designbook/config";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import type { DemoData } from "../data/products";
import { ProductProvider } from "../composite/product/context";
import { ProductDetailSection } from "../composite/product/variants/DetailSection";

/** Detail page for a single trip, addressed by product id. */
function TripDetailPage() {
  const { t } = useTranslation();
  const { data } = useDataset<DemoData>();
  const { id } = useParams();
  const product = data.products.find((p) => p.id === id);
  if (!product) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground">{t("detail.notFound")}</p>
        <Link to="/trips" className="text-sm text-primary hover:underline">
          {t("detail.backToTrips")}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-4">
      <Link to="/trips" className="text-sm text-primary hover:underline">
        {t("detail.backToTrips")}
      </Link>
      <ProductProvider product={product} currency={data.currency}>
        <ProductDetailSection />
      </ProductProvider>
    </div>
  );
}

export { TripDetailPage };
