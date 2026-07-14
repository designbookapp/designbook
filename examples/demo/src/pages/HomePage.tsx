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
      <section className="rounded-xl border bg-card p-6 shadow-sm sm:p-8 lg:p-10">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-stretch">
          <div className="flex flex-col justify-center py-2 lg:pr-8">
            <div className="mb-5 h-1 w-16 rounded-full bg-primary" />
            <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              {t("home.heroTitle")}
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
              {t("home.heroTagline")}
            </p>
          </div>

          <aside className="flex flex-col justify-between rounded-lg border bg-background p-5 shadow-sm lg:p-6">
            <div>
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-primary">
                <span className="size-2 rounded-full bg-primary" />
                <span>{t("home.browseTrips")}</span>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                {t("home.heroTagline")}
              </p>
            </div>
            <Link
              to="/trips"
              className={`${buttonVariants({ size: "lg" })} mt-6 w-full`}
            >
              {t("home.browseTrips")}
            </Link>
          </aside>
        </div>
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
