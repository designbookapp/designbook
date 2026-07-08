/**
 * `text` model atoms: the small, declarative pieces a text surface
 * or a canvas cell composes over a resolved `TextClaim`. They are intentionally
 * thin — the text surfaces are imperative pointer-driven overlays, so the real
 * shared logic lives in the pipeline (textModel.ts), not here. These exist so a
 * cell (variant × fixture) can render a claim without reaching into a surface,
 * and so hover/label rendering has ONE home.
 *
 * `useTextModel` (re-exported from TextProvider) is the context hook the
 * surfaces use to reach the shared pipeline.
 */

import type { PluralForm, TextClaim } from "@designbookapp/designbook/config";
import { useTextModel } from "./TextProvider";

/** The label shown for a claim on hover — its adapter label, else its key. */
function ClaimKey({ claim }: { claim: TextClaim }) {
  return <>{claim.label ?? claim.key ?? ""}</>;
}

/** A claim's current display value (markers already stripped by the adapter). */
function LocaleValue({ claim }: { claim: TextClaim }) {
  return <>{claim.value}</>;
}

/** One plural sibling of a keyed claim (`_one`, `_other`, …). */
function PluralFormView({ form }: { form: PluralForm }) {
  return <span data-plural-suffix={form.suffix}>{form.value}</span>;
}

/** The fixture/known claims currently on the provider (empty in live use). */
function useClaims(): TextClaim[] {
  return useTextModel().claims;
}

export { ClaimKey, LocaleValue, PluralFormView, useClaims, useTextModel };
