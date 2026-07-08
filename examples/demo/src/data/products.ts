import type { PreviewDataset } from "@designbookapp/designbook/config";

type Product = {
  id: string;
  name: string;
  tagline: string;
  price: number;
  rating: number;
  reviewCount: number;
  nights: number;
  badges: Array<"deal" | "popular" | "new">;
  /** Hue for the generated preview artwork — no image assets needed. */
  hue: number;
};

type DemoData = {
  currency: string;
  products: Product[];
};

const summerProducts: Product[] = [
  {
    id: "coastal-trail",
    name: "Coastal Trail Escape",
    tagline: "Seven days of cliff walks, coves, and seafood shacks.",
    price: 1290,
    rating: 4.7,
    reviewCount: 182,
    nights: 7,
    badges: ["deal", "popular"],
    hue: 205,
  },
  {
    id: "vineyard-loop",
    name: "Vineyard Loop",
    tagline: "Cycle between hilltop villages and family-run cellars.",
    price: 940,
    rating: 4.5,
    reviewCount: 96,
    nights: 5,
    badges: ["new"],
    hue: 120,
  },
  {
    id: "desert-stars",
    name: "Desert Stars Camp",
    tagline: "Dune hikes by day, telescope sessions by night.",
    price: 1580,
    rating: 4.9,
    reviewCount: 240,
    nights: 6,
    badges: ["popular"],
    hue: 35,
  },
];

const winterProducts: Product[] = [
  {
    id: "aurora-lodge",
    name: "Aurora Lodge",
    tagline: "Glass-roof cabins under the northern lights.",
    price: 2150,
    rating: 4.8,
    reviewCount: 311,
    nights: 4,
    badges: ["popular"],
    hue: 265,
  },
  {
    id: "alpine-traverse",
    name: "Alpine Traverse",
    tagline: "Hut-to-hut snowshoe crossing with mountain guides.",
    price: 1720,
    rating: 4.6,
    reviewCount: 128,
    nights: 8,
    badges: ["deal"],
    hue: 195,
  },
];

const datasets: PreviewDataset<DemoData>[] = [
  {
    id: "summer-sale",
    label: "Summer sale",
    data: { currency: "USD", products: summerProducts },
  },
  {
    id: "winter-escapes",
    label: "Winter escapes",
    data: { currency: "EUR", products: winterProducts },
  },
];

export { datasets };
export type { DemoData, Product };
