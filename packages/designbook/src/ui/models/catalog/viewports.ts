import { config } from "@designbook-ui/designbook";
import type { ViewportSize } from "@designbookapp/designbook/config";

const defaultViewports: ViewportSize[] = [
  { id: "desktop", label: "Desktop · 1280", width: 1280 },
  { id: "tablet", label: "Tablet · 768", width: 768 },
  { id: "mobile", label: "Mobile · 390", width: 390 },
];

const viewportSizes: ViewportSize[] = config.viewports?.length
  ? config.viewports
  : defaultViewports;

export { viewportSizes };
export type { ViewportSize };
