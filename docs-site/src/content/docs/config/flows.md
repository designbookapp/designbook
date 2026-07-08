---
title: Flows & wireframes
description: The Flow, FlowScreen, and FlowPreview types for arranging screens into user journeys.
---

Flows arrange **screens** into a user journey shown alongside your component sets. A screen
renders either a real registered component or a lightweight wireframe, so you can lay out an
end-to-end path even where some screens aren't built yet.

## `Flow`

```ts
type Flow = {
  id: string;
  title: string;
  screens: FlowScreen[];
};
```

## `FlowScreen`

```ts
type FlowScreen = {
  id: string;
  label: string;
  description: string;
  registryId?: string;
  previews?: FlowPreview[];
  wireframeKind?: WireframeKind;
  wireframeStrings?: string[];
};
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique screen id within the flow. |
| `label` | `string` | Screen title. |
| `description` | `string` | One-line description shown with the screen. |
| `registryId` | `string` | `"setId.ComponentKey"` — renders the real registered component. |
| `previews` | `FlowPreview[]` | Ordered alternative renderings shown for this screen. |
| `wireframeKind` | `WireframeKind` | Sketch a screen with a built-in wireframe when there's no real component. |
| `wireframeStrings` | `string[]` | Labels to place into the wireframe. |

A screen with a `registryId` renders the real component; otherwise it falls back to a
wireframe from `wireframeKind` / `wireframeStrings`.

## `WireframeKind`

```ts
type WireframeKind = "hero" | "list" | "cards" | "form" | "summary" | "bar";
```

## `FlowPreview`

Each `previews` entry is one rendering of the screen — combine a wireframe and the real
component to show them side by side.

```ts
type FlowPreview = {
  rendererId?: string;
  wireframeKind?: WireframeKind;
  wireframeStrings?: string[];
};
```

## Example

From the demo config's booking funnel:

```tsx
flows: [
  {
    id: "booking",
    title: "Shop/Booking funnel",
    screens: [
      {
        id: "search-results",
        label: "Search results",
        description: "Trip search results with filters.",
        registryId: "search.ResultsList",
        previews: [
          { wireframeKind: "bar", wireframeStrings: ["Filters", "Sort by price", "Dates"] },
          { rendererId: "search.ResultsList" },
        ],
      },
      {
        id: "product-details",
        label: "Trip details",
        description: "Trip detail page with booking call-to-action.",
        registryId: "product.ProductDetailSection",
      },
      {
        id: "checkout",
        label: "Checkout",
        description: "Traveller details and payment.",
        wireframeKind: "form",
        wireframeStrings: ["Traveller details", "Payment", "Confirm"],
      },
    ],
  },
],
```
