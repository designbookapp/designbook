import { useDataset } from "@designbookapp/designbook/config";
import { useTranslation } from "react-i18next";
import type { DemoData } from "../../../data/products";
import { ProductProvider } from "../../product/context";
import { ProductCard } from "../../product/variants/Card";

/** Search results grid — renders a card per product in the active dataset. */
function ResultsList() {
  const { t } = useTranslation();
  const { data } = useDataset<DemoData>();
  return (
    <div className="flex w-fit flex-col gap-4">
      <div className="flex items-baseline justify-between gap-8">
        <h2 className="text-xl font-semibold">{t("results.title")}</h2>
        <span className="text-sm text-muted-foreground">
          {t("results.count", { count: data.products.length })}
        </span>
      </div>
      <div className="flex flex-wrap gap-4">
        {data.products.map((product) => (
          <ProductProvider
            key={product.id}
            product={product}
            currency={data.currency}
          >
            <ProductCard />
          </ProductProvider>
        ))}
      </div>
    </div>
  );
}

export { ResultsList };
