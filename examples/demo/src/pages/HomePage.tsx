import { useDataset } from "@designbookapp/designbook/config";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { buttonVariants } from "../components/ui/button";
import type { DemoData } from "../data/products";
import { ProductProvider } from "../composite/product/context";
import { ProductCard } from "../composite/product/variants/Card";

/** Landing page — hero plus a featured slice of the catalog. */
function HomePage() {
  const { t } = useTranslation();
  const { data } = useDataset<DemoData>();
  const navigate = useNavigate();
  const featured = data.products.slice(0, 3);
  return (
    <div className="flex flex-col gap-10">
      <section className="rounded-xl border bg-card p-10">
        <h1 className="max-w-xl text-3xl font-bold tracking-tight">
          {t("home.heroTitle")}
        </h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          {t("home.heroTagline")}
        </p>
        <Link to="/trips" className={`${buttonVariants()} mt-6`}>
          {t("home.browseTrips")}
        </Link>
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">{t("home.featuredTitle")}</h2>
        <div className="flex flex-wrap gap-4">
          {featured.map((product) => (
            <div
              key={product.id}
              className="cursor-pointer"
              onClick={() => navigate(`/trips/${product.id}`)}
            >
              <ProductProvider product={product} currency={data.currency}>
                <ProductCard />
              </ProductProvider>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export { HomePage };
