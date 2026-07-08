import { createContext, useContext, type ReactNode } from "react";
import type { Product } from "../../data/products";

type ProductContextValue = {
  product: Product;
  currency: string;
};

const ProductContext = createContext<ProductContextValue | undefined>(
  undefined,
);

/** Provides the product a composite subtree renders — the container/atom split. */
function ProductProvider({
  product,
  currency,
  children,
}: ProductContextValue & { children: ReactNode }) {
  return (
    <ProductContext value={{ product, currency }}>{children}</ProductContext>
  );
}

function useProduct(): ProductContextValue {
  const value = useContext(ProductContext);
  if (!value) {
    throw new Error("useProduct must be used inside a ProductProvider.");
  }
  return value;
}

export { ProductProvider, useProduct };
