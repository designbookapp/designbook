/**
 * Pure plural-family resolution — shared by the canvas and page-tools
 * text paths so both edit the SAME set of plural forms for a keyed claim.
 *
 * DOM-free and instance-free on purpose: it takes a `lookup` callback instead
 * of an i18next instance so it unit-tests without a DOM (see `pluralForms.test.ts`).
 *
 * Key parity note: the canvas's marker postProcessor computes the ACTIVE
 * plural suffix (via `options.count` + `Intl.PluralRules`, only available
 * inside i18next's own pipeline) and marks e.g. `results.count_other`. The
 * page-tools build transform (`__dbMark`) wraps the call from OUTSIDE i18next
 * and only sees the verbatim source key, e.g. `results.count` (no suffix) —
 * see `pageMark.ts`'s `createPageMark`. Both land here as `resolvedKey`, and
 * `stripPluralSuffix` normalizes either shape to the same base key before
 * reconstructing the full form family, so a suffixed OR unsuffixed
 * `resolvedKey` resolves identically. That equivalence is what makes plural
 * editing already at parity between canvas and page paths — it is
 * intentional, not incidental, and the tests below lock it in.
 */

import type { PluralForm } from "@designbookapp/designbook/config";

const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"] as const;

/** Strip a trailing plural suffix (`_one`, `_other`, …) off a resource key, if present. */
function stripPluralSuffix(key: string): string {
  return key.replace(new RegExp(`(${PLURAL_SUFFIXES.join("|")})$`), "");
}

/**
 * Reconstructs the full plural-form family for `resolvedKey` (suffixed or
 * not): strips any suffix to find the base key, then probes every plural
 * suffix via `lookup`. Returns `[]` unless at least TWO forms are present
 * (a lone match is treated as an ordinary key that happens to share a suffix,
 * not a real plural family).
 */
function resolvePluralForms(
  resolvedKey: string,
  lookup: (candidateKey: string) => string | undefined,
): PluralForm[] {
  const baseKey = stripPluralSuffix(resolvedKey);
  const forms: PluralForm[] = [];
  for (const suffix of PLURAL_SUFFIXES) {
    const candidateKey = `${baseKey}${suffix}`;
    const value = lookup(candidateKey);
    if (typeof value === "string") {
      forms.push({ key: candidateKey, suffix, value });
    }
  }
  return forms.length > 1 ? forms : [];
}

export { PLURAL_SUFFIXES, resolvePluralForms, stripPluralSuffix };
