/**
 * Dogfood config helper (R spec — self-host, see docs/specs/r-ui-reorg.md).
 *
 * Shared visual frame for a "model cell" — a canvas entry that wraps one of
 * `src/ui/models/<model>`'s Provider fed its `fixtures.ts` data, rendering a
 * handful of the model's atoms. Purely presentational; imports only pure
 * components, so it's safe to import eagerly from anywhere (including the
 * catalog cell, which otherwise must avoid eager `@designbook-ui` imports —
 * see CatalogModelCell.tsx).
 */
import type { ReactNode } from "react";
import { Badge } from "@designbook-ui/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@designbook-ui/components/ui/card";

function ModelCellFrame({
  title,
  model,
  children,
}: {
  title: string;
  model: string;
  children: ReactNode;
}) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            {model}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export { ModelCellFrame };
