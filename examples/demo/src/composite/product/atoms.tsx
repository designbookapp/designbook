import { StarIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { useFlags } from "../../providers/FlagsProvider";
import { useLanguage } from "../../providers/LanguageProvider";
import { useProduct } from "./context";

/** Generated artwork block — stands in for a product photo. */
function ProductImage({ className }: { className?: string }) {
  const { product } = useProduct();
  return (
    <div
      role="img"
      aria-label={product.name}
      className={cn("h-40 w-full", className)}
      style={{
        background: `linear-gradient(135deg, hsl(${product.hue} 70% 55%), hsl(${(product.hue + 40) % 360} 65% 40%))`,
      }}
    />
  );
}

function ProductTitle({ className }: { className?: string }) {
  const { product } = useProduct();
  return (
    <h3 className={cn("text-base leading-tight font-semibold", className)}>
      {product.name}
    </h3>
  );
}

function ProductTagline({ className }: { className?: string }) {
  const { product } = useProduct();
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      {product.tagline}
    </p>
  );
}

function ProductPrice({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { product, currency } = useProduct();
  const { formatCurrency } = useLanguage();
  return (
    <div className={cn("flex items-baseline gap-1", className)}>
      <span className="text-lg font-semibold">
        {formatCurrency(product.price, currency)}
      </span>
      <span className="text-xs text-muted-foreground">
        {t("product.perPerson")}
      </span>
    </div>
  );
}

function ProductRating({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { product } = useProduct();
  return (
    <div className={cn("flex items-center gap-1 text-sm", className)}>
      <StarIcon className="size-4 fill-current text-amber-500" />
      <span className="font-medium">{product.rating.toFixed(1)}</span>
      <span className="text-muted-foreground">
        {t("product.reviews", { count: product.reviewCount })}
      </span>
    </div>
  );
}

function ProductDuration({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { product } = useProduct();
  return (
    <span className={cn("text-sm text-muted-foreground", className)}>
      {t("product.nights", { count: product.nights })}
    </span>
  );
}

function ProductBadges({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { product } = useProduct();
  const { flags } = useFlags();
  const showNew = Boolean(flags.newCheckout);
  if (product.badges.length === 0 && !showNew) return null;
  return (
    <div className={cn("flex gap-1", className)}>
      {showNew ? <Badge variant="success">New</Badge> : null}
      {product.badges.map((badge) => (
        <Badge
          key={badge}
          variant={badge === "deal" ? "success" : "secondary"}
        >
          {t(`product.badge.${badge}`)}
        </Badge>
      ))}
    </div>
  );
}

export {
  ProductBadges,
  ProductDuration,
  ProductImage,
  ProductPrice,
  ProductRating,
  ProductTagline,
  ProductTitle,
};
