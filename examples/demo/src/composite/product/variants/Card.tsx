import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "../../../components/ui/card";
import {
  ProductBadges,
  ProductDuration,
  ProductImage,
  ProductPrice,
  ProductRating,
  ProductTagline,
  ProductTitle,
} from "../atoms";

/** Compact product card used in result grids. */
function ProductCard() {
  const { t } = useTranslation();
  return (
    <Card className="w-80 gap-4 p-4">
      <div className="relative">
        <ProductImage />
        <ProductBadges className="absolute top-2 left-2" />
      </div>
      <CardHeader className="pt-0 gap-3 px-0">
        <ProductTitle />
        <ProductTagline />
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <ProductRating />
        <ProductDuration />
      </CardContent>
      <CardFooter className="justify-between">
        <ProductPrice />
        <Button size="sm">{t("product.viewTrip")}</Button>
      </CardFooter>
    </Card>
  );
}

export { ProductCard };
