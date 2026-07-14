/**
 * Dogfood cell for `models/text` (R spec item 4). Wraps `TextProvider` in its
 * fixture (`data`) mode and renders the `ClaimKey`/`LocaleValue` atoms over the
 * fixture's three canonical claims (keyed, plural, literal) — proving the
 * Provider+atoms+fixtures pattern renders in a canvas cell with no live app or
 * adapter runtime.
 */
import { useMemo } from "react";
import { ClaimKey, LocaleValue } from "@designbook-ui/models/text/atoms";
import { createTextFixture } from "@designbook-ui/models/text/fixtures";
import { TextProvider } from "@designbook-ui/models/text/TextProvider";
import { ModelCellFrame } from "./ModelCellFrame";

function TextModelCell() {
  const fixture = useMemo(() => createTextFixture(), []);
  return (
    <TextProvider data={fixture.data}>
      <ModelCellFrame title="Claims (keyed, plural, literal)" model="models/text">
        <ul className="space-y-1.5 text-sm">
          {fixture.data.claims.map((claim, index) => (
            <li
              key={index}
              className="flex items-center justify-between gap-3 rounded-md border px-2 py-1"
            >
              <span className="truncate font-mono text-xs text-muted-foreground">
                <ClaimKey claim={claim} />
              </span>
              <span className="truncate font-medium">
                <LocaleValue claim={claim} />
              </span>
            </li>
          ))}
        </ul>
      </ModelCellFrame>
    </TextProvider>
  );
}

export default TextModelCell;
