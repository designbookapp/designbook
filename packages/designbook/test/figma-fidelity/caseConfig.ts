/**
 * The fidelity case matrix (docs/specs/figma-sync-testing.md "Style matrix").
 * Pure data + derivations — no Figma, no browser, no fs. The runner
 * (`run.ts`) walks `CASES`; the pure logic here (id → entryId → route) is unit
 * tested.
 *
 * P1 ships the first slice (5 cases, tier 1 only). The remaining matrix rows
 * land in P2 with the pixel tier; add them to `CASES` with `pixel: true` and a
 * `cases/<id>/Case.tsx` component.
 */

/** Which comparison tiers apply to a case (spec's H / P / V columns). */
type CaseTiers = {
  /** Tier 1 — deterministic annotated-HTML equality (gates exit code). */
  html: boolean;
  /** Tier 2 — browser-vs-Figma pixel diff (informational). */
  pixel: boolean;
  /** Tier 3 — agent vision, eligible on `--vision` (triage only). */
  vision: boolean;
};

type FidelityCase = {
  /** Stable slug: directory name (`cases/<id>/`), report key, component key. */
  id: string;
  tiers: CaseTiers;
  /** Per-case pixel mismatch threshold override (%), else the run default. */
  pixelThreshold?: number;
  /** One-line human note shown in the report. */
  note?: string;
};

/** The designbook set the fidelity cases register under (fidelity.config.tsx). */
const SET_ID = "fidelity";

/**
 * P1 first slice: one case per fundamental annotation surface — static fill,
 * text, autolayout alignment, absolute positioning, token attribution.
 */
const CASES: FidelityCase[] = [
  {
    id: "solid-bg",
    tiers: { html: true, pixel: true, vision: false },
    note: "Fixed-size div, background-color + opacity.",
  },
  {
    id: "text-basic",
    tiers: { html: true, pixel: true, vision: true },
    note: "Font family/size/weight/color/line-height/letter-spacing/align.",
  },
  {
    id: "flex-justify-align",
    tiers: { html: true, pixel: true, vision: false },
    note: "Column of rows exercising justify + align-items.",
  },
  {
    id: "absolute-badges",
    tiers: { html: true, pixel: true, vision: true },
    note: "Relative wrapper + two absolute corner badges (ProductCard pattern).",
  },
  {
    id: "token-colors",
    tiers: { html: true, pixel: true, vision: false },
    note: "bg/text/border bound to theme tokens (data-token-*).",
  },
];

/** The designbook registry/entry id for a case (`fidelity.<id>`). */
function caseEntryId(caseId: string): string {
  return `${SET_ID}.${caseId}`;
}

/** The workbench hash route that opens a case in the canvas. */
function caseRoute(caseId: string): string {
  return `#/component/${caseEntryId(caseId)}`;
}

/** The `[data-db-entry]` selector value for a case's serializer root. */
function caseEntrySelector(caseId: string): string {
  return caseEntryId(caseId);
}

/** Cases eligible for a tier — used to filter the run and the vision pass. */
function casesForTier(
  cases: FidelityCase[],
  tier: keyof CaseTiers,
): FidelityCase[] {
  return cases.filter((entry) => entry.tiers[tier]);
}

export {
  CASES,
  SET_ID,
  caseEntryId,
  caseRoute,
  caseEntrySelector,
  casesForTier,
};
export type { FidelityCase, CaseTiers };
